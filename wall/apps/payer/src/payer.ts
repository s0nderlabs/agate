// BOTS-SPEC 4.3 to 4.5: daily claims, the final sweep and the budget (MS 6.6, audit S-M2).
// For each series with open positions, every tick: kPrev from previewSync (days applied by anyone count), due when
// kPrev >= lastClaimK + claimEveryDays (or kPrev == N and the sweep is not done); the D1 hold (MS 6.6 v2, fixed by the
// audit P-H1) keeps our bot from forcing ANY day the call would apply that the wall has not provided, or any
// later day that would cross its last resort before the call lands (recheck R1-L1), checked again right before each
// claimMany. Candidates come from one preview with MS 4.5's exact integers:
// daily = true and claimable >= $0.01; in the sweep (kPrev == N) claimable >= $0.01, or q >= 1 token and claimable > 0.
// Across every due series of every factory: largest claimable first (ties: lower id, then lower series address),
// as many as the day's budget pays (a strict prefix), after a reserve for the lister's next listing (audit P-L2, kept
// while the lister owes anything: recheck R1-H1; out of the floor's headroom only since Oct 5); when pacing is what
// cuts it, only whole batches (each series' next 50 ids or all it has left, in the order of their largest candidate:
// recheck R2-L1), if the day can still pay the first one (recheck R1-L2). Then
// per series: one sync(kPrev - kState) (in chunks that fit the LIMIT table when the whole is refused GAS_CAP; when no
// chunk fits, claimMany carries the sync itself: audit P-M1), then claimMany batches of at most 50 ids, each checked
// by its simulation's total against the offchain sum (PAYER_DRIFT), a reverting batch bisected by simulation
// (PAYER_BAD_ID), a total of 0 never sent. No per-owner cap (MS 6.6).
import type { Address, Hex } from "viem";
import { type AlertSink, RpcDown } from "@agate/watcher";
import type { PayerConfig } from "./config.ts";
import { agateSeriesAbi, CENT, claimable as claimableOf, type ExtraReads, forcedDay, indexCalls, type LimitTable, type MarketReads, type PlanningSender, type ScanEvent, scanKey, type SendResult, type SendSpec, U } from "@agate/market";
import type { Pos, Positions, SeriesInfo } from "./positions.ts";
import type { StateStore } from "./state.ts";

export interface Candidate {
  series: string; // lowercase
  id: bigint;
  claimable: bigint;
  q: bigint;
}

/** One position's selection rule (model payer_should_claim). */
export function qualifies(p: { daily: boolean; q: bigint }, c: bigint, sweep: boolean, threshold: bigint = CENT): boolean {
  return sweep ? c >= threshold || (p.q >= U && c > 0n) : p.daily && c >= threshold;
}

/** Candidates of one series from one preview (k, S): model payer_pick without a budget. */
export function pick(series: string, positions: readonly Pos[], k: number, S: bigint, terms: { n: number; floor: bigint; cap: bigint }, o: { threshold?: bigint; isBad?: (id: bigint) => boolean } = {}): Candidate[] {
  const sweep = k === terms.n;
  const out: Candidate[] = [];
  for (const p of positions) {
    if (!p.open || o.isBad?.(p.id)) continue;
    const c = claimableOf(p.side, p.q, p.paid, k, S, terms);
    if (qualifies(p, c, sweep, o.threshold ?? CENT)) out.push({ series: series.toLowerCase(), id: p.id, claimable: c, q: p.q });
  }
  return out;
}

/** Largest claimable first; ties by the lower id, then the lower series address. */
export function sortCandidates(cs: readonly Candidate[]): Candidate[] {
  return [...cs].sort((a, b) => (a.claimable !== b.claimable ? (a.claimable > b.claimable ? -1 : 1) : a.id !== b.id ? (a.id < b.id ? -1 : 1) : a.series < b.series ? -1 : a.series > b.series ? 1 : 0));
}

/** BOTS-SPEC 4.5: the strict prefix of `sorted` the budget pays. A series' first id carries its sync (if any) and a
 *  new batch; each further id the marginal cost of one more id in its batch, a new batch every maxIds. */
export function selectWithinBudget(sorted: readonly Candidate[], o: { budgetWei: bigint | null; syncCostWei: (series: string) => bigint; claimCostWei: (n: number) => bigint; maxIds: number }): Candidate[] {
  if (o.budgetWei === null) return [...sorted];
  const counts = new Map<string, number>();
  let spent = 0n;
  const out: Candidate[] = [];
  for (const c of sorted) {
    const n = counts.get(c.series) ?? 0;
    const inBatch = n % o.maxIds;
    const marginal = (n === 0 ? o.syncCostWei(c.series) : 0n) + o.claimCostWei(inBatch + 1) - (inBatch === 0 ? 0n : o.claimCostWei(inBatch));
    if (spent + marginal > o.budgetWei) break;
    spent += marginal;
    counts.set(c.series, n + 1);
    out.push(c);
  }
  return out;
}

/** (Recheck R1-L2, per series since recheck R2-L1) The whole batches of `sorted`: each series' candidates (in the
 *  sorted order) cut into batches of maxIds, the last one all that is left, so no claimMany is a partial batch (a
 *  partial one pays the fixed gas of a transaction for fewer ids). Ordered by each batch's largest candidate. */
export function seriesBatches(sorted: readonly Candidate[], maxIds: number): { series: string; first: boolean; items: Candidate[] }[] {
  const per = new Map<string, Candidate[]>();
  const at = new Map<Candidate, number>();
  sorted.forEach((c, i) => {
    at.set(c, i);
    const xs = per.get(c.series) ?? [];
    xs.push(c);
    per.set(c.series, xs);
  });
  const out: { series: string; first: boolean; items: Candidate[] }[] = [];
  for (const [series, xs] of per) chunks(xs, maxIds).forEach((items, i) => out.push({ series, first: i === 0, items }));
  return out.sort((a, b) => at.get(a.items[0]!)! - at.get(b.items[0]!)!);
}

export function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Calldata gas bounds for the cost model (ids below 2^24): claimMany 344 + 164 per id, sync(uint256) 204. */
export const CLAIM_CALLDATA = (n: number) => 344 + 164 * n;
export const SYNC_CALLDATA = 204;

export interface BudgetView {
  allowance(): bigint;
  headroom(): bigint;
  spent(what: string): void;
  /** what the day can still spend once pacing has freed all of it (Budget.dayLeft); absent: claims never wait (R1-L2) */
  dayLeft?(): bigint;
}

export interface PayerDeps {
  reads: MarketReads & ExtraReads;
  sender: PlanningSender;
  /** `epoch` changes when the scan starts over (MarketScanner.reset): its event list is then a new one */
  scanner: { sync(): Promise<number>; all(): readonly ScanEvent[]; readonly caughtUp: boolean; readonly tip: bigint | null; readonly epoch?: number };
  positions: Positions;
  state: StateStore;
  limits: LimitTable;
  config: Pick<PayerConfig, "claimThresholdU" | "maxIdsPerCall" | "claimEveryDays">;
  budget?: BudgetView;
  /** wei kept back from the claims for the lister's next listing at this fee (audit P-L2); 0 when nothing waits */
  reserveWei?: (maxFeePerGas: bigint) => bigint;
  alerts?: AlertSink;
  log: (event: string, data: Record<string, unknown>) => void;
  stopping?: () => boolean;
}

interface View {
  info: SeriesInfo;
  kState: number;
  kPrev: number;
  S: bigint;
  needSync: boolean;
  sweep: boolean;
  candidates: Candidate[];
  badQualifying: number;
}

export interface PayerReport {
  scanned: number;
  series: number;
  due: number;
  held: string[];
  candidates: number;
  selected: number;
  paidIds: number;
  paidU: bigint;
  closed: number;
  sends: number;
  budgetLeft: number;
}

type BatchOutcome = "paid" | "budget" | "failed" | "held";

export class Payer {
  private scanEpoch: number;
  constructor(readonly d: PayerDeps) {
    d.positions.onPayoutChanged = (series, id, key) => d.state.payoutChanged(series, id, key);
    this.scanEpoch = d.scanner.epoch ?? 0;
  }

  private say(event: string, data: Record<string, unknown>): void {
    this.d.log(event, data);
  }

  private stop(): boolean {
    return this.d.stopping?.() === true;
  }

  /** `splits`: a GAS_CAP refusal is answered by two smaller batches, so the sender logs it instead of alerting. */
  private claimSpec(info: SeriesInfo, ids: readonly bigint[], c: number, splits = false): SendSpec {
    return { to: info.series, abi: agateSeriesAbi, functionName: "claimMany", args: [ids], shape: "series.claimMany", c, n: ids.length, ...(splits ? { splitsOnCap: true } : {}), label: `claimMany ${info.symbol} x${ids.length}` };
  }

  /** Pulls the scan, then one payer round. RpcDown propagates (the tick logs it and tries again). */
  async tick(t: bigint): Promise<PayerReport> {
    const rep: PayerReport = { scanned: 0, series: 0, due: 0, held: [], candidates: 0, selected: 0, paidIds: 0, paidU: 0n, closed: 0, sends: 0, budgetLeft: 0 };
    rep.scanned = await this.d.scanner.sync();
    const epoch = this.d.scanner.epoch ?? 0;
    if (epoch !== this.scanEpoch) {
      // the scan started over (a chain reset under the cursor): the old positions, series and marks belong to a chain
      // that is gone (reads on its series would revert every tick), and the new event list starts at index 0
      this.scanEpoch = epoch;
      this.d.positions.reset();
      this.d.state.reset();
      this.say("positions_reset", { why: "the scan started over", epoch });
    }
    this.d.positions.apply(this.d.scanner.all());
    if (!this.d.scanner.caughtUp) {
      this.say("scan_catching_up", { tip: this.d.scanner.tip?.toString() ?? null });
      return rep;
    }
    const st = this.d.state;
    const list = this.d.positions.withOpen().filter((s) => st.data.series[s.series]?.sweepDone !== true);
    rep.series = list.length;
    if (list.length === 0) return rep;
    const raw = await Promise.all(
      list.map(async (info) => {
        const [s, p] = await Promise.all([this.d.reads.state(info.series), this.d.reads.previewSync(info.series)]);
        return { info, s, p };
      }),
    );
    const views: View[] = [];
    for (const { info, s, p } of raw) {
      const mark = st.data.series[info.series] ?? { lastClaimK: 0, sweepDone: false };
      const every = this.d.config.claimEveryDays[info.factoryName] ?? 1;
      const sweep = p.k === info.n;
      const due = (p.k < info.n && p.k >= mark.lastClaimK + every) || (sweep && !mark.sweepDone);
      if (!due) continue;
      const needSync = p.k > s.k;
      // claimMany syncs too: even with nothing to apply now, a day that crosses its last resort before it lands would
      // be forced (R1-L1), so the D1 check runs whether or not a sync is needed
      if (await this.forceHeld(info, s.k, p.k, t)) {
        rep.held.push(info.symbol);
        continue;
      }
      this.d.alerts?.clearWhere((a) => (a.code as string) === "PAYER_FORCE_HELD" && a.id.endsWith(`:${info.series.toLowerCase()}`));
      rep.due++;
      const isBad = (id: bigint) => st.isBad(info.series, id);
      const open = this.d.positions.open(info.series);
      const candidates = pick(info.series, open, p.k, p.sum, info, { threshold: this.d.config.claimThresholdU, isBad });
      const badQualifying = pick(info.series, open.filter((x) => isBad(x.id)), p.k, p.sum, info, { threshold: this.d.config.claimThresholdU }).length;
      views.push({ info, kState: s.k, kPrev: p.k, S: p.sum, needSync, sweep, candidates, badQualifying });
    }
    // due series without a candidate are done for this round
    for (const v of views) if (v.candidates.length === 0) this.done(v);
    const all = sortCandidates(views.flatMap((v) => v.candidates));
    rep.candidates = all.length;
    if (all.length === 0) {
      st.save();
      return rep;
    }
    const byS = new Map<string, View>(views.map((v) => [v.info.series, v]));
    const selected = await this.select(all, byS);
    rep.selected = selected.length;
    rep.budgetLeft = all.length - selected.length;
    if (selected.length < all.length) {
      this.d.budget?.spent(`${all.length - selected.length} of ${all.length} claims`);
      this.say("budget_left_claims", { waiting: all.length - selected.length, of: all.length });
    }
    const groups = new Map<string, bigint[]>();
    for (const c of selected) {
      const g = groups.get(c.series) ?? [];
      g.push(c.id);
      groups.set(c.series, g);
    }
    let budgetOut = false;
    for (const [series, ids] of groups) {
      if (this.stop() || budgetOut) break;
      const v = byS.get(series)!;
      if (v.needSync) {
        const out = await this.syncUp(v, rep);
        if (out === "budget") {
          budgetOut = true;
          continue;
        }
        // a sync refused for any reason but its gas cap: the claims would revert the same way (and a bisection would
        // mark every id bad), so the series waits for the next tick
        if (out === "failed") continue;
        // "capped": no sync chunk fits the LIMIT table; claimMany carries the sync itself with its own c and LIMIT row
      }
      let allPaid = true;
      for (const batch of chunks(ids, this.d.config.maxIdsPerCall)) {
        if (this.stop()) {
          allPaid = false;
          break;
        }
        const out = await this.claimBatch(v, batch, t, rep);
        if (out !== "paid") allPaid = false;
        if (out === "budget") {
          budgetOut = true;
          break;
        }
        if (out === "held") break;
      }
      const left = v.candidates.length - ids.length;
      if (allPaid && left === 0) this.done(v);
      st.save();
    }
    return rep;
  }

  /** A round that left no candidate of v: the day is claimed (or the sweep done when no bad id still qualifies). */
  private done(v: View): void {
    const m = this.d.state.mark(v.info.series);
    if (v.sweep) {
      if (v.badQualifying === 0) m.sweepDone = true;
    } else m.lastClaimK = Math.max(m.lastClaimK, v.kPrev);
  }

  /** MS 6.6 (v2, finding D1; audit P-H1, recheck R1-L1): any day a sync-bearing call from kState would FORCE by the
   *  time it lands while the wall has not provided it (not closed, or closed and not final yet; head unreadable counts
   *  as held). Every day the call would apply is checked, not only the oldest: while the wall catches up after a long
   *  outage, closing the oldest day must not let the call force the later ones; and so is every later day within the
   *  margin of its last resort (kPrev's day first), which the call's own sync would force if it crossed meanwhile. */
  private async forceHeld(info: SeriesInfo, kState: number, kPrev: number, t: bigint): Promise<boolean> {
    const held = await forcedDay(this.d.reads, info, kState, kPrev, t);
    if (held === null) return false;
    this.d.alerts?.raise({ code: "PAYER_FORCE_HELD", severity: "action", key: info.series, gpuId: info.gpuId, day: held.day, message: `payer: ${info.symbol} would force day ${held.day} (past its last resort) while the wall has not provided it (${held.why}; index head ${held.head ?? "unreadable"}); nothing sent for this series` });
    this.say("force_held", { series: info.series, symbol: info.symbol, day: held.day, head: held.head, why: held.why, kState, kPrev });
    return true;
  }

  /** The separate sync of 4.3, in chunks when the whole is refused GAS_CAP (audit P-M1): c halves until a chunk fits,
   *  the next chunk starts at the size that fit. "capped": not even sync(1) fits (PAYER_SYNC_CAPPED, action: the LIMIT
   *  table is Ethereum-priced until AGATE_MARKET_GAS_LIMITS carries the Monad measurement); the claims then carry the
   *  sync themselves. "failed": refused for another reason. A dry run plans the claims too (2.3 step 7). */
  private async syncUp(v: View, rep: PayerReport): Promise<"ok" | "budget" | "capped" | "failed"> {
    let kState = v.kState;
    let fits = Number.MAX_SAFE_INTEGER;
    const sid = `:${v.info.series.toLowerCase()}`;
    while (kState < v.kPrev) {
      let c = Math.min(v.kPrev - kState, fits);
      let res: SendResult;
      for (;;) {
        // a refused chunk above 1 halves (no GAS_CAP alert for it); sync(1) over the cap alerts (and PAYER_SYNC_CAPPED)
        res = await this.d.sender.send({ to: v.info.series, abi: agateSeriesAbi, functionName: "sync", args: [BigInt(c)], shape: "series.sync", c, ...(c > 1 ? { splitsOnCap: true } : {}), label: `sync ${v.info.symbol} ${c}` });
        if (res.sent) rep.sends++;
        if (res.ok || res.error !== "GAS_CAP" || c <= 1) break;
        c = Math.ceil(c / 2);
      }
      if (res.error === "DRY_RUN") return "ok";
      if (!res.ok) {
        this.say("sync_not_sent", { series: v.info.series, symbol: v.info.symbol, c, error: res.error });
        if (res.error === "BUDGET") return "budget";
        if (res.error === "GAS_CAP") {
          this.d.alerts?.raise({ code: "PAYER_SYNC_CAPPED", severity: "action", key: v.info.series, message: `payer: ${v.info.symbol}: even sync(1) is over its gas cap (the LIMIT table is Ethereum-priced; set AGATE_MARKET_GAS_LIMITS from the Monad measurement, MS 10.4 step 7); its claims carry the sync themselves meanwhile` });
          return "capped";
        }
        return "failed";
      }
      if (c < v.kPrev - kState || fits !== Number.MAX_SAFE_INTEGER) this.say("sync_chunked", { series: v.info.series, symbol: v.info.symbol, c });
      fits = c;
      kState += c;
      this.d.alerts?.clearWhere((a) => (a.code as string) === "PAYER_SYNC_CAPPED" && a.id.endsWith(sid));
    }
    return "ok";
  }

  /** The floor's headroom less the lister's reserve. Since Oct 5 a listing is a safety send (only the floor holds it),
   *  so the reserve comes out of the headroom alone: taken from the paced allowance it would only hold the claims back. */
  private headroomLeft(maxFeePerGas: bigint): bigint {
    const h = this.d.budget!.headroom();
    const reserve = this.d.reserveWei?.(maxFeePerGas) ?? 0n;
    return h > reserve ? h - reserve : 0n;
  }

  /** What the claims may spend now: the paced allowance, and the floor's headroom less the lister's reserve. */
  private room(maxFeePerGas: bigint): bigint {
    const a = this.d.budget!.allowance();
    const h = this.headroomLeft(maxFeePerGas);
    return a < h ? a : h;
  }

  /** (R1-L2) The most the claims can still reach today by waiting: the day's whole budget left, and the floor's
   *  headroom less the lister's reserve. null: the budget cannot say (no deferral). */
  private reach(maxFeePerGas: bigint): bigint | null {
    const b = this.d.budget!;
    if (!b.dayLeft) return null;
    const left = b.dayLeft();
    const h = this.headroomLeft(maxFeePerGas);
    return left < h ? left : h;
  }

  private async select(all: readonly Candidate[], byS: Map<string, View>): Promise<Candidate[]> {
    const b = this.d.budget;
    if (!b) return [...all];
    const { maxFeePerGas } = await this.d.sender.fees();
    const room = this.room(maxFeePerGas);
    const lim = this.d.limits;
    const plan = (limit: number, cd: number) => (BigInt(limit + 21_000 + cd) * 6n + 4n) / 5n; // ceil(1.2 x tx gas)
    const claimCost = (n: number) => plan(lim.limitFor("series.claimMany", 0, n), CLAIM_CALLDATA(n)) * maxFeePerGas;
    const syncCost = (s: string) => {
      const v = byS.get(s)!;
      return v.needSync ? plan(lim.limitFor("series.sync", v.kPrev - v.kState), SYNC_CALLDATA) * maxFeePerGas : 0n;
    };
    const maxIds = this.d.config.maxIdsPerCall;
    const sel = selectWithinBudget(all, { budgetWei: room, syncCostWei: syncCost, claimCostWei: claimCost, maxIds });
    if (sel.length === all.length) return sel;
    // R1-L2: when pacing (not the floor, not the day's end) is what cuts the claims, a partial batch now pays each
    // transaction's fixed gas for a few ids (one id costs about twice the gas per id of 50). Send only whole batches.
    // R2-L1: whole per series, not per prefix: with several series interleaved in the claimable order, the first
    // prefix in which every series' share was whole was nearly the whole list, so the largest position waited as long
    // as the smallest. Each series' next batch (maxIdsPerCall ids, or all it has left) goes as soon as it fits, the
    // batches in the order of their largest candidate, stopping at the first that does not fit (no smaller one jumps
    // ahead of it). Not when the day can never pay that first batch (the floor, or the day's budget left): then what
    // fits goes out, as before.
    const reach = this.reach(maxFeePerGas);
    if (reach === null || reach <= room) return sel;
    const batches = seriesBatches(all, maxIds);
    const cost = (x: (typeof batches)[number]) => (x.first ? syncCost(x.series) : 0n) + claimCost(x.items.length);
    const first = batches[0]!;
    if (cost(first) > reach) return sel;
    let spent = 0n;
    const out: Candidate[] = [];
    for (const x of batches) {
      const c = cost(x);
      if (spent + c > room) break;
      spent += c;
      out.push(...x.items);
    }
    if (out.length !== sel.length) this.say("claims_whole_batches", { fits: sel.length, sent: out.length, firstWhole: first.items.length, of: all.length, roomWei: room.toString(), reachWei: reach.toString() });
    return sortCandidates(out);
  }

  private qualifiesNow(info: SeriesInfo, id: bigint, c: bigint, sweep: boolean): boolean {
    const p = this.d.positions.get(info.series, id);
    return !!p && p.open && qualifies(p, c, sweep, this.d.config.claimThresholdU);
  }

  /** Simulations only: the ids whose claim reverts the batch (a payee whose transfer reverts, MS 4.5). */
  private async bisect(info: SeriesInfo, ids: readonly bigint[], c: number): Promise<bigint[]> {
    const sim = await this.d.sender.simulate(this.claimSpec(info, ids, c));
    if (sim.ok) return [];
    if (ids.length === 1) return [...ids];
    const mid = Math.ceil(ids.length / 2);
    return [...(await this.bisect(info, ids.slice(0, mid), c)), ...(await this.bisect(info, ids.slice(mid), c))];
  }

  private async claimBatch(v: View, idsIn: readonly bigint[], t: bigint, rep: PayerReport): Promise<BatchOutcome> {
    const info = v.info;
    const r = this.d.reads;
    let ids = [...idsIn];
    const [s, p] = await Promise.all([r.state(info.series), r.previewSync(info.series)]);
    // D1 again right before the send (P-H1): a day may have crossed its last resort since the views, and claimMany
    // syncs everything previewSync counts, and any day that crosses before it lands (R1-L1)
    if (await this.forceHeld(info, s.k, p.k, t)) return "held";
    const c = indexCalls(info, s.k, p.k, t);
    const sweep = p.k === info.n;
    const offchain = (xs: readonly bigint[]) => xs.reduce((a, id) => {
      const pos = this.d.positions.get(info.series, id);
      return pos && pos.open ? a + claimableOf(pos.side, pos.q, pos.paid, p.k, p.sum, info) : a;
    }, 0n);
    let plan = await this.d.sender.plan(this.claimSpec(info, ids, c, ids.length > 1));
    if (!plan.ok && plan.error === "GAS_CAP" && ids.length > 1) {
      // over the cap (the LIMIT table is Ethereum-priced until the testnet deploy re-measures on Monad): two smaller batches
      const mid = Math.ceil(ids.length / 2);
      const a = await this.claimBatch(v, ids.slice(0, mid), t, rep);
      if (a === "budget" || a === "held") return a;
      const b = await this.claimBatch(v, ids.slice(mid), t, rep);
      return a === "paid" && b === "paid" ? "paid" : b === "budget" || b === "held" ? b : "failed";
    }
    if (!plan.ok && plan.error !== "GAS_CAP" && !(plan.error ?? "").startsWith("estimate:")) {
      const bad = await this.bisect(info, ids, c);
      if (bad.length > 0) {
        const from = scanKey((this.d.scanner.tip ?? -1n) + 1n, 0); // a PayoutChanged after the scanned tip clears it
        for (const id of bad) this.d.state.setBad(info.series, id, from);
        this.d.state.save();
        this.d.alerts?.raise({ code: "PAYER_BAD_ID", severity: "info", key: info.series, message: `payer: ${info.symbol}: ${bad.length} position(s) whose claim reverts (${bad.join(", ")}) are skipped until their payout changes`, data: { ids: bad.map(String) } });
        // they qualified (they were candidates): the sweep is not done while one of them still does, as the next
        // round's count of bad qualifying ids would say
        v.badQualifying += bad.length;
        ids = ids.filter((id) => !bad.includes(id));
        if (ids.length === 0) return "failed";
        plan = await this.d.sender.plan(this.claimSpec(info, ids, c));
      }
    }
    if (!plan.ok) {
      this.say("claim_not_planned", { series: info.series, symbol: info.symbol, ids: ids.length, error: plan.error });
      return "failed";
    }
    let total = plan.result as bigint;
    const sum = offchain(ids);
    if (total !== sum) {
      this.d.alerts?.raise({ code: "PAYER_DRIFT", severity: "info", key: info.series, message: `payer: ${info.symbol}: claimMany of ${ids.length} ids would pay ${total} u, the scanned positions say ${sum} u; re-reading them`, data: { onchain: total.toString(), offchain: sum.toString(), ids: ids.length } });
      const fresh = await Promise.all(ids.map(async (id) => ({ id, pos: await r.position(info.series, id), cl: await r.claimable(info.series, id) })));
      for (const f of fresh) this.d.positions.refresh(info.series, f.id, f.pos ? { paid: f.pos.paid, payee: f.pos.payee, daily: f.pos.daily } : null);
      ids = fresh.filter((f) => f.pos !== null && f.cl !== null && this.qualifiesNow(info, f.id, f.cl, sweep)).map((f) => f.id);
      if (ids.length === 0) return "paid";
      plan = await this.d.sender.plan(this.claimSpec(info, ids, c));
      if (!plan.ok) return "failed";
      total = plan.result as bigint;
    }
    if (total === 0n) return "paid"; // never send a claim that pays nothing
    const b = this.d.budget;
    // only the budget's own cut stops the round: ids dropped by the bisection (marked bad) or by the drift re-read (no
    // longer qualifying) leave the day's budget untouched, so the remaining batches and series still go this tick
    let cut = false;
    if (b) {
      for (;;) {
        const room = this.room(plan.maxFeePerGas!);
        if (plan.costMaxWei! <= room) break;
        let n2 = Number((BigInt(ids.length) * room) / plan.costMaxWei!);
        if (n2 >= ids.length) n2 = ids.length - 1;
        if (n2 <= 0) {
          b.spent(`a claimMany of ${ids.length} ids on ${info.symbol}`);
          return "budget";
        }
        ids = ids.slice(0, n2);
        cut = true;
        plan = await this.d.sender.plan(this.claimSpec(info, ids, c));
        if (!plan.ok) return "failed";
      }
    }
    const res = await this.d.sender.send(this.claimSpec(info, ids, c));
    if (res.sent) rep.sends++;
    if (!res.ok || !res.sent) {
      this.say("claim_not_sent", { series: info.series, symbol: info.symbol, ids: ids.length, error: res.error });
      return res.error === "BUDGET" ? "budget" : "failed";
    }
    const got = this.d.positions.applyReceipt(info.series as Address, res.logs ?? []);
    rep.paidIds += got.claimed;
    rep.paidU += got.paidU;
    rep.closed += got.closed;
    this.d.state.save();
    this.say("claimed", { series: info.series, symbol: info.symbol, ids: ids.length, k: p.k, c, paidU: got.paidU.toString(), closed: got.closed, tx: res.txHash as Hex, gasLimit: res.gasLimit?.toString(), costWei: res.costWei?.toString() });
    return cut ? "budget" : "paid";
  }
}
