// BOTS-SPEC 3.9: the market maker's tick over MarketReads and a Sender. Reads everything from the chain each tick
// (chain time, balances, books, its own orders by s_orders, series views, the index walk), reconciles its order list,
// marks and checks the loss limit, decides per book (3.5), funds the due books (3.4), sends sequentially (each send
// simulated first by the sender), winds down and settles (3.7), then heartbeats.
// Audit fixes in here: the band of a newer public index value (M-H1, fair.ts), the D1 hold before settle
// (M-H2), condition 2 as an urgent requote under the day's budget with a safety cancel of the crossed orders only as
// its fallback (M-M2, M-L2), the pending id scan kept after any send that may have gone out (M-M3), a mark that
// never switches the loss limit off (M-M4), one dollar for every configured factory (M-L1), recovery and orphan
// books beyond the quotable months (M-L4), a state file of another chain set aside (P-M3), and a settle refused
// GAS_CAP preceded by sync chunks (P-M1). Since recheck R2-M1 the band also holds the attester's possible select and,
// with the wall two or more days behind, all of [F, C] (MM_INDEX_BEHIND); since the code review a one-shot CLI
// tick places nothing and a dry run moves no MON alert.
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Abi, type Address, erc20Abi } from "viem";
import { appendLine, RpcDown, writeAtomic } from "@agate/watcher";
import { agateSeriesAbi, type Budget, type Deployments, type FactoryEntry, forcedDay, KURU_STATE, kuruMarginAccountAbi, kuruOrderBookAbi, type L2Book, LOT, type MarketReads, MAX_UINT256, type PreviewReads, type Sender, type SendResult, type SendSpec, type SeriesTerms, SIDE, type SpendGuard, U, VENUE, ZERO_ADDRESS as ZERO } from "@agate/market";
import { othersBest, type OwnOrder, parseBatchLogs } from "./book.ts";
import { bookConfig, type MmConfig, stopBeforeEnd } from "./config.ts";
import { type Decision, decide, NEVER_QUOTED, order, type QuotedRec } from "./decide.ts";
import { FairBook, LAG_UNBOUNDED, type Pending } from "./fair.ts";
import { exposure, type Inventory, markSeries, planDollars, planTokens, redeemable } from "./inventory.ts";
import { type Band, clampCrossing, cutAsks, gate, type Ladder, ladderProblem, lockOf, targetLadder } from "./ladder.ts";
import { emptyState, identityDiffers, makerIdentity, type MmState, StateFile } from "./state.ts";

export const ROLE = "marketmaker";
export const SCAN_BATCH = 500;
/** Months before the current one whose books a recovery without state.json scans (M-L4). */
export const RECOVER_MONTHS_BACK = 2;
export type Request = "UNKILL" | "CANCEL_ALL" | "WITHDRAW_ALL" | "REBASE";

export class MakerConfigError extends Error {}

/** The part of the wall's AlertSink the maker uses (a structural subset, so tests can pass their own). */
export interface Alerts {
  raise(x: { code: string; severity: "info" | "action"; message: string; key?: string; data?: unknown }): unknown;
  clearWhere(pred: (a: { code: string; id: string }) => boolean): void;
}

export interface MmDeps {
  reads: MarketReads & Partial<PreviewReads>;
  sender: Sender;
  deployments: Deployments;
  config: MmConfig;
  dir: string; // <home>/market/marketmaker
  alerts?: Alerts;
  /** the shared MON budget (2.6), built without alerts: the maker raises MM_KEY_LOW and MM_BUDGET_SPENT itself; absent
   *  in a dry run (it needs no MON and must not freeze the day's budget file) */
  budget?: Budget;
  /** AGATE_DRY_RUN=1: nothing is signed (the sender), and the day's alerts are not moved (no MM_KEY_LOW) */
  dryRun?: boolean;
  nowMs: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
  heartbeat?: { beat(at: number, lastAction: string): void };
}

export interface SeriesCtx {
  series: Address;
  factory: string;
  entry: FactoryEntry;
  terms: SeriesTerms;
  token: Address;
  market: Address | null; // the recorded KURU_V1 market
  quotable: boolean; // an open month with a KURU_V1 market
  canUse: boolean;
  k: number; // previewSync
  sum: bigint;
  stateK: number;
  Tw: bigint;
  Tm: bigint;
  Sh: bigint;
  fair: bigint | null;
  /** the band the ladder is placed around (M-H1); null with fair */
  lo: bigint | null;
  hi: bigint | null;
  pending: Pending[];
  /** (R2-M1) ended days the index wall has not closed (today - head); >= 2: the band is all of [F, C]'s fairs */
  lag: number | null;
  stopAt: number;
  endTs: number;
}

export interface MarketCtx {
  market: Address;
  s: SeriesCtx;
  current: boolean; // the series' recorded market (false: replaced, wind it down)
  kuruState: number | null;
  book: L2Book;
  orders: OwnOrder[];
}

export interface TickReport {
  t: number;
  value: bigint | null;
  pnl: bigint | null;
  killed: string | null;
  decisions: { market: Address; d: Decision; target: Ladder }[];
  sends: { label: string; shape: string; ok: boolean; sent: boolean; error?: string }[];
}

interface Plan {
  m: MarketCtx;
  d: Decision;
  target: Ladder;
  inv: Inventory;
  closed: { bids: boolean; asks: boolean };
}

const lc = (a: string) => a.toLowerCase();
const EMPTY: Ladder = { bids: [], asks: [] };
const askTokens = (orders: readonly OwnOrder[]) => orders.filter((o) => !o.isBuy).reduce((s, o) => s + o.remaining * LOT, 0n);
const bidLock = (orders: readonly OwnOrder[]) => orders.filter((o) => o.isBuy).reduce((s, o) => s + lockOf({ price: o.price, size: o.remaining }), 0n);
const bandOf = (s: SeriesCtx): Band => ({ lo: s.lo ?? s.fair!, hi: s.hi ?? s.fair! });

export class MarketMaker implements SpendGuard {
  state: MmState;
  private readonly file: StateFile;
  private readonly fair: FairBook;
  private readonly terms = new Map<string, { terms: SeriesTerms; token: Address }>();
  private readonly approved = new Set<string>();
  private readonly lastRequoteMs = new Map<string, number>();
  private readonly budgetAlerted = new Set<string>();
  private ctx: { t: number; balance: bigint } = { t: 0, balance: 0n };
  private initialized = false;
  private stopDaily = false;
  report: TickReport = { t: 0, value: null, pnl: null, killed: null, decisions: [], sends: [] };

  constructor(readonly d: MmDeps) {
    // M-L1: the maker funds, marks, approves and withdraws in the deployments file's dollar only
    for (const name of d.config.factories) {
      const e = d.deployments.factories[name];
      if (e && lc(e.dollar) !== lc(d.deployments.dollar)) throw new MakerConfigError(`factory ${name} settles in another dollar than the deployments file's (${d.deployments.dollar}), which is the only one the maker holds: leave it out of the maker's factories`);
    }
    this.file = new StateFile(join(d.dir, "state.json"));
    const id = makerIdentity(d.deployments);
    const loaded = this.file.load();
    const differs = loaded ? identityDiffers(id, loaded.identity) : null;
    if (loaded && differs !== null) {
      // another chain's or deployment's state (P-M3): set aside, start as if it were missing (3.10's full scan)
      const aside = join(d.dir, `state.stale-${Date.now()}.json`);
      renameSync(this.file.path, aside);
      this.state = emptyState();
      this.say("state_reset", { why: `state.json belongs to another chain or deployment (${differs} differ)`, keptAs: aside });
    } else this.state = loaded ?? emptyState();
    this.state.identity = id;
    this.fair = new FairBook(d.reads);
  }

  get maker(): Address {
    return this.d.sender.from;
  }
  get ma(): Address {
    return this.d.deployments.kuru.marginAccount;
  }
  killPath(): string {
    return join(this.d.dir, "KILL");
  }
  requestPath(name: Request): string {
    return join(this.d.dir, name);
  }

  private say(event: string, data: Record<string, unknown> = {}): void {
    this.d.log?.(event, data);
  }
  private save(): void {
    this.file.save(this.state);
  }

  // ------------------------------------------------------------------ budget hooks (wired into the sender)

  private budgetRefused(): void {
    this.stopDaily = true;
    const day = this.d.budget?.today?.day ?? "";
    if (this.budgetAlerted.has(day)) return;
    this.budgetAlerted.add(day);
    this.d.alerts?.raise({ code: "MM_BUDGET_SPENT", severity: "info", key: day, message: `${ROLE}: the day's MON budget or its pacing stopped a requote (${day})` });
  }

  /** The sender's spend guard (2.6): the floor always, the day's budget and its pacing unless safety. */
  canSpend(costMaxWei: bigint, safety: boolean): { ok: true } | { ok: false; why: string } {
    const b = this.d.budget;
    if (!b) return { ok: true };
    const r = b.canSpend(costMaxWei, safety);
    if (!r.ok && r.why === "BUDGET") this.budgetRefused();
    return r;
  }

  /** A receipt's cost (gasLimit x effectiveGasPrice: Monad bills the limit), counted into the day. */
  record(costWei: bigint, safety: boolean): void {
    const before = this.ctx.balance;
    this.ctx.balance = before > costWei ? before - costWei : 0n;
    this.d.budget?.record(costWei, safety);
  }

  // ------------------------------------------------------------------ sends

  private stopping = false;
  /** SIGINT / SIGTERM: the send in flight finishes, no further send starts. */
  stop(): void {
    this.stopping = true;
  }

  private async send(s: SendSpec): Promise<SendResult> {
    if (this.stopping) return { ok: false, sent: false, error: "stopping" };
    let r: SendResult;
    try {
      r = await this.d.sender.send(s);
    } catch (e) {
      r = { ok: false, sent: true, error: `send threw: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` };
      this.d.sender.resetNonce();
    }
    this.report.sends.push({ label: s.label ?? s.functionName, shape: s.shape, ok: r.ok, sent: r.sent, ...(r.error ? { error: r.error } : {}) });
    this.say(r.ok ? "send_ok" : "send_failed", { label: s.label ?? s.functionName, shape: s.shape, sent: r.sent, tx: r.txHash, gasLimit: r.gasLimit, error: r.error });
    return r;
  }

  private async approve(token: Address, spender: Address, safety: boolean): Promise<boolean> {
    const key = `${lc(token)}:${lc(spender)}`;
    if (this.approved.has(key)) return true;
    const a = await this.d.reads.allowance(token, this.maker, spender);
    if (a >= MAX_UINT256 / 2n) {
      this.approved.add(key);
      return true;
    }
    const r = await this.send({ to: token, abi: erc20Abi as Abi, functionName: "approve", args: [spender, MAX_UINT256], shape: "erc20.approve", safety, label: `approve ${token.slice(0, 10)} to ${spender.slice(0, 10)}` });
    if (r.ok) this.approved.add(key);
    return r.ok;
  }

  // ------------------------------------------------------------------ discovery and reads

  private async seriesInfo(series: Address): Promise<{ terms: SeriesTerms; token: Address }> {
    const k = lc(series);
    let v = this.terms.get(k);
    if (!v) {
      const [terms, token] = await Promise.all([this.d.reads.terms(series), this.d.reads.token(series)]);
      v = { terms, token };
      this.terms.set(k, v);
    }
    return v;
  }

  private factoryByAddress(addr: Address): FactoryEntry | null {
    for (const f of Object.values(this.d.deployments.factories)) if (lc(f.factory) === lc(addr)) return f;
    return null;
  }

  /** A series the maker knows of (held, or behind an orphan book) as a context that quotes nothing; null when this
   *  chain cannot read it (logged), so one stale entry never stops the tick. */
  private async passiveCtx(series: Address, factoryName: string | null, t: number): Promise<SeriesCtx | null> {
    const r = this.d.reads;
    try {
      const info = await this.seriesInfo(series);
      const entry = (factoryName ? this.d.deployments.factories[factoryName] : undefined) ?? this.factoryByAddress(info.terms.factory);
      if (!entry) return null;
      const [{ market, venue }, canUse] = await Promise.all([r.marketOf(entry.factory, series), r.routerCanUse(entry.factory, series)]);
      return await this.seriesCtx(series, entry.name, entry, venue === VENUE.KURU_V1 ? market : null, false, venue === VENUE.KURU_V1 && canUse, t);
    } catch (e) {
      if (e instanceof RpcDown) throw e;
      this.say("series_unreadable", { series, error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
      return null;
    }
  }

  /** 3.1: every open month's KURU_V1 market of the configured factories, plus the series the maker still holds. */
  async discover(t: number): Promise<SeriesCtx[]> {
    // the reads of one step go out together, so a multicall-batching client sends them as one aggregate3
    const r = this.d.reads;
    const entries = this.d.config.factories.map((name) => this.d.deployments.factories[name]).filter((e): e is FactoryEntry => !!e);
    const heads = await Promise.all(entries.map(async (entry) => ({ entry, m: await r.currentMonth(entry.factory), gpus: await r.gpuIds(entry.factory) })));
    const slots = heads.flatMap(({ entry, m, gpus }) => gpus.flatMap((gpu) => [m, m + 1].map((month) => ({ entry, gpu, month }))));
    const listed = await Promise.all(slots.map(async (x) => ({ ...x, series: await r.seriesOf(x.entry.factory, x.gpu, x.month) })));
    const open = await Promise.all(
      listed
        .filter((x) => lc(x.series) !== lc(ZERO))
        .map(async (x) => {
          const [{ market, venue }, canUse] = await Promise.all([r.marketOf(x.entry.factory, x.series), r.routerCanUse(x.entry.factory, x.series)]);
          return { ...x, market, venue, canUse };
        }),
    );
    const quotable = open.filter((x) => x.venue === VENUE.KURU_V1);
    const held = Object.values(this.state.series).filter((h) => !quotable.some((x) => lc(x.series) === lc(h.series)));
    const heldCtx = await Promise.all(held.map((h) => this.passiveCtx(h.series, h.factory, t)));
    const live = await Promise.all(quotable.map((x) => this.seriesCtx(x.series, x.entry.name, x.entry, x.market, true, x.canUse, t)));
    const out = new Map<string, SeriesCtx>();
    for (const s of [...live, ...heldCtx]) if (s && !out.has(lc(s.series))) out.set(lc(s.series), s);
    return [...out.values()];
  }

  private async seriesCtx(series: Address, factory: string, entry: FactoryEntry, market: Address | null, quotable: boolean, canUse: boolean, t: number): Promise<SeriesCtx> {
    const r = this.d.reads;
    const { terms, token } = await this.seriesInfo(series);
    const [ps, st, Tw, Tm, Sh] = await Promise.all([r.previewSync(series), r.state(series), r.erc20Balance(token, this.maker), r.marginBalance(this.ma, this.maker, token), r.shortOf(series, this.maker)]);
    const endTs = Number(terms.startTs) + terms.n * terms.day;
    const stopAt = endTs - stopBeforeEnd(bookConfig(this.d.config, factory), terms.day);
    const f = await this.fair.fair(terms.index, terms.gpuId, { t: BigInt(t), startDay: terms.startDay, startTs: terms.startTs, day: terms.day, n: terms.n, floor: terms.floor, cap: terms.cap, k: ps.k, sum: ps.sum });
    if (f) this.state.lastFair[lc(series)] = f.fair;
    return { series, factory, entry, terms, token, market, quotable, canUse, k: ps.k, sum: ps.sum, stateK: st.k, Tw, Tm, Sh, fair: f?.fair ?? null, lo: f?.lo ?? null, hi: f?.hi ?? null, pending: f?.pending ?? [], lag: f?.lag ?? null, stopAt, endTs };
  }

  /** The maker's active orders on a market: the ids it believes in, plus (after a send that may have gone out) every id
   *  above the counter read before it, each checked by Kuru's own rule (s_orders and the price point's head). */
  private async reconcile(market: Address): Promise<OwnOrder[]> {
    const k = lc(market);
    const known = this.state.orders[k] ?? [];
    const byId = new Map(known.map((o) => [o.id, o]));
    const ids = new Set(known.map((o) => o.id));
    const pend = this.state.pending[k];
    if (pend) {
      const top = await this.d.reads.kuruOrderIdCounter(market);
      for (let id = pend.counterBefore + 1n; id <= top; id++) ids.add(id);
    }
    const out: OwnOrder[] = [];
    const list = [...ids].sort((a, b) => (a < b ? -1 : 1));
    for (let i = 0; i < list.length; i += SCAN_BATCH) {
      for (const o of await this.d.reads.kuruOrders(market, list.slice(i, i + SCAN_BATCH))) {
        if (o.status !== "ACTIVE" || lc(o.owner) !== lc(this.maker)) continue;
        const was = byId.get(o.id);
        out.push({ id: o.id, isBuy: o.isBuy, price: o.price, size: was?.size ?? o.remaining, remaining: o.remaining });
      }
    }
    if (pend) {
      // the unconfirmed send landed if the maker has orders above the counter it read before it
      const fresh = out.filter((o) => o.id > pend.counterBefore);
      if (fresh.length > 0 && pend.fair !== null) {
        const bid = fresh.filter((o) => o.isBuy).sort((a, b) => (a.price > b.price ? -1 : 1))[0];
        const ask = fresh.filter((o) => !o.isBuy).sort((a, b) => (a.price < b.price ? -1 : 1))[0];
        this.state.quoted[k] = { fair: pend.fair, ...(pend.lo !== undefined ? { lo: pend.lo } : {}), ...(pend.hi !== undefined ? { hi: pend.hi } : {}), at: pend.at, topBid: bid ? { id: bid.id, size: bid.size } : null, topAsk: ask ? { id: ask.id, size: ask.size } : null };
      }
      delete this.state.pending[k];
      this.say("reconciled", { market, scannedFrom: pend.counterBefore + 1n, active: out.length, landed: fresh.length });
    }
    this.state.orders[k] = out;
    return out;
  }

  /** 3.10, state.json missing or unreadable: every s_orders id from 1 to s_orderIdCounter, batches of 500. */
  async rebuild(markets: readonly { market: Address; series: Address }[]): Promise<void> {
    for (const { market, series } of markets) {
      const top = await this.d.reads.kuruOrderIdCounter(market);
      const out: OwnOrder[] = [];
      for (let lo = 1n; lo <= top; lo += BigInt(SCAN_BATCH)) {
        const ids: bigint[] = [];
        for (let id = lo; id < lo + BigInt(SCAN_BATCH) && id <= top; id++) ids.push(id);
        for (const o of await this.d.reads.kuruOrders(market, ids)) {
          if (o.status === "ACTIVE" && lc(o.owner) === lc(this.maker)) out.push({ id: o.id, isBuy: o.isBuy, price: o.price, size: o.remaining, remaining: o.remaining });
        }
      }
      this.state.orders[lc(market)] = out;
      this.state.markets[lc(market)] = lc(series);
      this.say("rebuilt", { market, active: out.length, scanned: top });
    }
  }

  /** Every KURU_V1 market of the configured factories from RECOVER_MONTHS_BACK months ago to next month (M-L4: a book
   *  of a past month can still hold orders if its wind-down cancel failed), with the series where the maker holds
   *  anything marked held, so they are wound down and settled. */
  private async recoverable(): Promise<{ market: Address; series: Address }[]> {
    const r = this.d.reads;
    const out: { market: Address; series: Address }[] = [];
    for (const name of this.d.config.factories) {
      const entry = this.d.deployments.factories[name];
      if (!entry) continue;
      const [m, gpus] = await Promise.all([r.currentMonth(entry.factory), r.gpuIds(entry.factory)]);
      for (const gpu of gpus) {
        for (let month = m - RECOVER_MONTHS_BACK; month <= m + 1; month++) {
          const series = await r.seriesOf(entry.factory, gpu, month);
          if (lc(series) === lc(ZERO)) continue;
          const { market, venue } = await r.marketOf(entry.factory, series);
          if (venue === VENUE.KURU_V1) out.push({ market, series });
          const { token } = await this.seriesInfo(series);
          const [Tw, Tm, Sh] = await Promise.all([r.erc20Balance(token, this.maker), r.marginBalance(this.ma, this.maker, token), r.shortOf(series, this.maker)]);
          if (Tw + Tm + Sh > 0n && !this.state.series[lc(series)]) this.state.series[lc(series)] = { series, factory: entry.name, market: venue === VENUE.KURU_V1 ? market : null, token };
        }
      }
    }
    return out;
  }

  /** Before the first tick: with no state file, the full id scan of every market the maker may have used. */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (this.file.load() !== null) return;
    await this.rebuild(await this.recoverable());
    this.save();
  }

  // ------------------------------------------------------------------ kill switch and requests

  killReason(): string | null {
    if (!existsSync(this.killPath())) return null;
    try {
      return readFileSync(this.killPath(), "utf8").trim() || "kill";
    } catch {
      return "kill";
    }
  }

  private noteKill(reason: string, t: number): void {
    if (this.state.killed?.reason === reason) return;
    this.state.killed = { reason, at: t };
    this.d.alerts?.raise({ code: "MM_KILLED", severity: "action", key: ROLE, message: `${ROLE}: kill switch engaged (${reason}): every order cancelled, nothing placed until unkill` });
    this.save();
  }

  private takeRequest(name: Request): boolean {
    const p = this.requestPath(name);
    if (!existsSync(p)) return false;
    rmSync(p, { force: true });
    return true;
  }

  // ------------------------------------------------------------------ the tick

  /** One tick. `oneShot`: a CLI request run here because no maker process holds the lock; nothing will manage what it
   *  places (Kuru orders never expire), so it places, mints and deposits nothing: cancels, the crossed orders' cancel,
   *  wind-down and the state requests only (review finding, Oct 3). The next `run` quotes. */
  async tick(o: { oneShot?: boolean } = {}): Promise<TickReport> {
    await this.init();
    const r = this.d.reads;
    const cfg = this.d.config;
    const t = Number(await r.blockTime());
    this.report = { t, value: null, pnl: null, killed: null, decisions: [], sends: [] };
    this.fair.reset();
    this.stopDaily = false;
    const balance = await r.monBalance(this.maker);
    this.ctx = { t, balance };
    this.d.budget?.tick(BigInt(t), balance);
    if (!this.d.dryRun) {
      if (balance < cfg.lowBalanceWei) this.d.alerts?.raise({ code: "MM_KEY_LOW", severity: "action", key: this.maker, message: `${ROLE}: the maker key holds ${balance} wei, under ${cfg.lowBalanceMon} MON` });
      else this.d.alerts?.clearWhere((a) => a.code === "MM_KEY_LOW");
    }

    // requests from the CLI (files next to the state; the running process is the only writer of state.json)
    const cancelAll = this.takeRequest("CANCEL_ALL");
    const withdrawAll = this.takeRequest("WITHDRAW_ALL");
    const rebase = this.takeRequest("REBASE");
    if (this.takeRequest("UNKILL")) rmSync(this.killPath(), { force: true });

    // discovery and reads
    const series = await this.discover(t);
    const dollar = this.d.deployments.dollar;
    const [walletD0, marginD] = await Promise.all([r.erc20Balance(dollar, this.maker), r.marginBalance(this.ma, this.maker, dollar)]);
    let walletD = walletD0;
    const markets: MarketCtx[] = await Promise.all(series.filter((s) => s.market !== null).map((s) => this.marketCtx(s.market!, s, true)));
    const seen = new Set<string>(markets.map((m) => lc(m.market)));
    // a book the maker still has orders on that its series no longer names (a replaced market, or a past month's book
    // whose wind-down cancel failed: M-L4): wind it down
    for (const [m, list] of Object.entries(this.state.orders)) {
      if (seen.has(m) || list.length === 0) continue;
      const of = this.state.markets[m];
      let s = series.find((x) => lc(x.series) === of);
      if (!s && of) {
        const ctx = await this.passiveCtx(of as Address, null, t);
        if (ctx) {
          series.push(ctx);
          s = ctx;
        }
      }
      if (!s) {
        this.say("orphan_orders", { market: m, orders: list.length });
        continue;
      }
      seen.add(m);
      markets.push(await this.marketCtx(m as Address, s, false));
    }

    // mark and loss limit (3.8), kill switch
    const value = this.mark(series, markets, walletD, marginD);
    let killReason = this.killReason();
    if (killReason === null && this.state.killed) {
      // the KILL file is gone: unkill. A cleared loss kill re-arms maxLossU under the value now (a person decided).
      if (this.state.killed.reason === "loss") this.state.lossArm = value - cfg.maxLossU;
      this.state.killed = null;
      this.d.alerts?.clearWhere((a) => a.code === "MM_KILLED" || a.code === "MM_LOSS_LIMIT");
      this.say("unkilled", {});
    }
    if (this.state.baseline === null || rebase) {
      this.state.baseline = value;
      this.state.lossArm = null;
      if (rebase) {
        // a rebase follows a float top-up: every book is requoted once with the new dollars
        this.state.quoted = {};
        this.say("rebased", { value });
      }
    }
    const limit = this.state.lossArm ?? this.state.baseline - cfg.maxLossU;
    this.report.value = value;
    this.report.pnl = value - this.state.baseline;
    if (killReason === null && value < limit) {
      killReason = "loss";
      writeAtomic(this.killPath(), "loss");
      this.d.alerts?.raise({ code: "MM_LOSS_LIMIT", severity: "action", key: ROLE, message: `${ROLE}: pnl ${value - this.state.baseline} u under the loss limit (maxLossU ${cfg.maxLossU}): kill switch engaged` });
    }
    if (killReason !== null) this.noteKill(killReason, t);
    this.report.killed = killReason;

    // float (3.4)
    const floatLow = walletD + marginD < cfg.dollarLowU;
    if (floatLow) this.d.alerts?.raise({ code: "MM_FLOAT_LOW", severity: "action", key: this.maker, message: `${ROLE}: wallet plus margin dollars ${walletD + marginD} u under dollarLowU ${cfg.dollarLowU}; top up from the deployer, then rebase` });
    else this.d.alerts?.clearWhere((a) => a.code === "MM_FLOAT_LOW");

    // decisions (3.5)
    const plans: Plan[] = [];
    for (const m of markets) {
      const s = m.s;
      const bc = bookConfig(cfg, s.factory);
      const inv: Inventory = { Tw: s.Tw, Tm: s.Tm, Tr: askTokens(markets.filter((x) => x.s === s).flatMap((x) => x.orders)), Sh: s.Sh };
      let cancelOnly: string | null = null;
      if (killReason !== null) cancelOnly = `kill (${killReason})`;
      else if (cancelAll) cancelOnly = "cancel-all";
      else if (!m.current) cancelOnly = "replaced market";
      else if (!s.quotable) cancelOnly = "not an open month";
      else if (t >= s.stopAt) cancelOnly = "wind-down";
      else if (!s.canUse) cancelOnly = "routerCanUse false";
      else if (m.kuruState !== KURU_STATE.ACTIVE) cancelOnly = "market not active";
      if (m.kuruState !== KURU_STATE.ACTIVE) this.d.alerts?.raise({ code: "MM_MARKET_PAUSED", severity: "info", key: m.market, message: `${ROLE}: market ${m.market} is not ACTIVE (state ${m.kuruState ?? "unreadable"})` });
      else this.d.alerts?.clearWhere((a) => a.code === "MM_MARKET_PAUSED" && a.id.endsWith(`:${lc(m.market)}`));
      if (m.kuruState === KURU_STATE.HARD_PAUSED) {
        // Kuru refuses even cancels: the order list stays and the book is cancelled once the market is back
        plans.push({ m, d: { act: "none", why: "hard paused" }, target: EMPTY, inv, closed: { bids: false, asks: false } });
        continue;
      }
      if (s.fair === null && s.quotable && m.current && t < s.stopAt) this.d.alerts?.raise({ code: "MM_NO_INDEX", severity: "action", key: s.series, message: `${ROLE}: no final index value in the 32-day walk for ${s.terms.gpuId} (series ${s.series}); not quoting it` });
      else this.d.alerts?.clearWhere((a) => a.code === "MM_NO_INDEX" && a.id.endsWith(`:${lc(s.series)}`));
      // R2-M1 (b): the wall two or more ended days behind (the closer down, or a countersign slower than a day): the
      // band spans every value those days can take, so the book quotes only outside all of them until it catches up
      if (s.fair !== null && s.lag !== null && s.lag >= LAG_UNBOUNDED && s.quotable && m.current && t < s.stopAt) this.d.alerts?.raise({ code: "MM_INDEX_BEHIND", severity: "action", key: s.series, message: `${ROLE}: the index wall has ${s.lag} ended days of ${s.terms.gpuId} not closed (series ${s.series}); quoting only outside every value they can take until it catches up` });
      else this.d.alerts?.clearWhere((a) => a.code === "MM_INDEX_BEHIND" && a.id.endsWith(`:${lc(s.series)}`));
      let target: Ladder = EMPTY;
      let bidsClosed = false;
      let asksClosed = false;
      if (cancelOnly === null && s.fair !== null) {
        const raw = targetLadder(s.fair, s.terms.floor, s.terms.cap, bc, bandOf(s));
        const clamped = clampCrossing(raw, othersBest(m.book, m.orders), s.terms.floor, s.terms.cap);
        const g = gate(clamped, exposure(inv), BigInt(bc.maxNetTokens) * U);
        target = g.ladder;
        bidsClosed = g.bidsClosed;
        asksClosed = g.asksClosed;
        if (bidsClosed || asksClosed || g.bidsCut || g.asksCut) {
          const what = [bidsClosed ? "closed the bids" : g.bidsCut ? "cut the bids" : "", asksClosed ? "closed the asks" : g.asksCut ? "cut the asks" : ""].filter(Boolean).join(" and ");
          this.d.alerts?.raise({ code: "MM_INVENTORY_CAP", severity: "info", key: s.series, message: `${ROLE}: the inventory gate ${what} of ${s.series} (exposure ${exposure(inv)} base units, maxNetTokens ${bc.maxNetTokens})` });
        } else this.d.alerts?.clearWhere((a) => a.code === "MM_INVENTORY_CAP" && a.id.endsWith(`:${lc(s.series)}`));
        if ((s.pending.length > 0 || (s.lag ?? 0) >= LAG_UNBOUNDED) && (s.lo !== s.fair || s.hi !== s.fair)) this.say("band", { series: s.series, fair: s.fair, lo: s.lo, hi: s.hi, lag: s.lag, pendingDay: s.pending[0]?.day ?? null, pendingValue: s.pending[0]?.value ?? null, source: s.pending[0]?.source ?? null, pending: s.pending.map((p) => ({ day: p.day, value: p.value, source: p.source })) });
      }
      const quoted = this.state.quoted[lc(m.market)] ?? null;
      let d = decide(
        { market: m.market, t, nowMs: this.d.nowMs(), fair: s.fair, ...(s.lo !== null ? { lo: s.lo } : {}), ...(s.hi !== null ? { hi: s.hi } : {}), floor: s.terms.floor, cap: s.terms.cap, orders: m.orders, quoted, target, bidsClosed, asksClosed, cancelOnly, lastRequoteMs: this.lastRequoteMs.get(lc(m.market)) ?? null },
        { requoteMoveU: bc.requoteMoveU, replenishBelowPct: bc.replenishBelowPct, staleS: bc.staleS, minRequoteS: bc.minRequoteS },
      );
      // after a rebuild (no quoted record) a book with orders is requoted once to a ladder the maker knows (cond 6)
      if (d.act === "none" && d.why === undefined && quoted === null && m.orders.length > 0 && target.bids.length + target.asks.length > 0)
        d = { act: "requote", cond: 6, safety: false, why: "restart: no quoted record", priority: NEVER_QUOTED };
      plans.push({ m, d, target, inv, closed: { bids: bidsClosed, asks: asksClosed } });
      this.report.decisions.push({ market: m.market, d, target });
    }

    // funding (3.4) and sends: the safety cancels and the urgent requotes first, then the daily budget, the largest
    // fair move first. Only condition 1's cancels and the fallback cancel of crossed orders are safety actions (M-M2):
    // every placement, mint and deposit is the day's budget's.
    let due = order(plans).filter((p) => p.d.act !== "none");
    if (o.oneShot) {
      // no process will manage a ladder placed now: the requotes wait for `run`; a crossed order still goes (safety)
      const held = due.filter((p) => p.d.act === "requote");
      for (const p of held) await this.cancelCrossed(p);
      if (held.length > 0) this.say("one_shot_no_quotes", { books: held.map((p) => p.m.market), note: "a one-shot request places, mints and deposits nothing; `run` quotes" });
      due = due.filter((p) => p.d.act !== "requote");
    }
    const requotes = due.filter((p) => p.d.act === "requote");
    let mintCosts = 0n;
    const tokenPlans = new Map<MarketCtx, ReturnType<typeof planTokens>>();
    for (const p of requotes) {
      const s = p.m.s;
      const bc = bookConfig(cfg, s.factory);
      const tp = planTokens(p.target.asks, p.inv, { cap: s.terms.cap, maxPairsBase: BigInt(bc.maxPairsTokens) * U, walletDollars: walletD - mintCosts });
      tokenPlans.set(p.m, tp);
      mintCosts += tp.mintCost;
    }
    const dollarBooks = requotes.map((p) => ({ market: lc(p.m.market), bids: p.target.bids, currentBidLock: bidLock(p.m.orders) }));
    const dp = planDollars(dollarBooks, { marginDollars: marginD, walletDollars: walletD, mintCosts, bufferU: cfg.dollarBufferU });
    // if the deposit does not land: only what the pool holds (the margin balance and each book's own freed locks)
    const dp0 = planDollars(dollarBooks, { marginDollars: marginD, walletDollars: 0n, mintCosts: 0n, bufferU: 0n });
    let dollarsOk = true;
    if (dp.deposit > 0n) {
      dollarsOk = false;
      if (await this.approve(dollar, this.ma, false)) {
        const res = await this.send({ to: this.ma, abi: kuruMarginAccountAbi as Abi, functionName: "deposit", args: [this.maker, dollar, dp.deposit], shape: "kuru.deposit", safety: false, label: `deposit ${dp.deposit} u` });
        if (res.ok) {
          walletD -= dp.deposit;
          dollarsOk = true;
        }
      }
    }
    for (const p of due) {
      if (p.d.act === "cancel") {
        await this.batch(p.m, EMPTY, true, null, p.d, p.closed, null);
        continue;
      }
      const urgent = p.d.act === "requote" && p.d.urgent === true;
      if (this.budgetOut()) {
        if (urgent) await this.cancelCrossed(p);
        continue;
      }
      const s = p.m.s;
      const tp = tokenPlans.get(p.m)!;
      const bids = (dollarsOk ? dp : dp0).bids.get(lc(p.m.market)) ?? [];
      let asks = tp.asks;
      const haveT = () => s.Tm + askTokens(p.m.orders);
      if (tp.mintQ > 0n) {
        let minted = false;
        if (await this.approve(dollar, s.series, false)) {
          const res = await this.send({ to: s.series, abi: agateSeriesAbi as Abi, functionName: "mint", args: [tp.mintQ, this.maker], shape: "series.mint", safety: false, label: `mint ${tp.mintQ} of ${s.series.slice(0, 10)}` });
          if (res.ok) {
            minted = true;
            s.Tw += tp.mintQ;
            s.Sh += tp.mintQ;
            walletD -= tp.mintCost;
            this.hold(s, p.m.market);
          }
        }
        if (!minted) asks = cutAsks(asks, (haveT() + s.Tw) / LOT);
      }
      const needT = asks.reduce((x, a) => x + a.size, 0n) * LOT;
      if (needT > haveT() && !this.stopDaily) {
        const dep = needT - haveT() <= s.Tw ? needT - haveT() : s.Tw;
        let deposited = false;
        if (dep > 0n && (await this.approve(s.token, this.ma, false))) {
          const res = await this.send({ to: this.ma, abi: kuruMarginAccountAbi as Abi, functionName: "deposit", args: [this.maker, s.token, dep], shape: "kuru.deposit", safety: false, label: `deposit ${dep} of ${s.token.slice(0, 10)}` });
          if (res.ok) {
            deposited = true;
            s.Tw -= dep;
            s.Tm += dep;
          }
        }
        if (!deposited || needT > haveT()) asks = cutAsks(asks, haveT() / LOT);
      } else if (needT > haveT()) asks = cutAsks(asks, haveT() / LOT);
      if (this.stopDaily) {
        if (urgent) await this.cancelCrossed(p);
        continue;
      }
      if (bids.length + asks.length === 0 && p.m.orders.length === 0) continue;
      const target: Ladder = { bids, asks };
      const problem = ladderProblem(target, s.fair!, s.terms.floor, s.terms.cap, othersBest(p.m.book, p.m.orders), bandOf(s));
      if (problem) {
        this.say("ladder_refused", { market: p.m.market, problem });
        if (urgent) await this.cancelCrossed(p); // M-L2: never leave crossed orders resting
        continue;
      }
      const res = await this.batch(p.m, target, false, s.fair, p.d, p.closed, bandOf(s));
      // the requote did not go out (the budget, a simulation revert, the floor): the crossed orders still go (safety)
      if (urgent && !res.ok && !res.sent && res.error !== "stopping" && res.error !== "DRY_RUN") await this.cancelCrossed(p);
    }

    // wind-down and settlement (3.7)
    await this.windDown(series, markets, t, withdrawAll && killReason !== null, floatLow);
    if (withdrawAll && killReason === null) this.say("withdraw_all_refused", { why: "the kill switch is off" });

    this.save();
    this.d.heartbeat?.beat(t, this.report.sends.length > 0 ? `${this.report.sends.length} sends` : "idle");
    return this.report;
  }

  /** The day's budget (or its pacing) has nothing left for a non-safety send this tick. */
  private budgetOut(): boolean {
    if (this.stopDaily) return true;
    if (this.d.budget && this.d.budget.allowance() === 0n) {
      this.budgetRefused();
      return true;
    }
    return false;
  }

  /** Condition 2's fallback (M-M2, M-L2): a safety batch that cancels only the crossed orders and places nothing. */
  private async cancelCrossed(p: Plan): Promise<void> {
    if (p.d.act !== "requote" || p.d.urgent !== true) return;
    const live = new Set(p.m.orders.map((o) => o.id));
    const ids = p.d.crossed.filter((id) => live.has(id));
    if (ids.length === 0) return;
    await this.batch(p.m, EMPTY, true, null, p.d, p.closed, null, ids);
  }

  private async marketCtx(market: Address, s: SeriesCtx, current: boolean): Promise<MarketCtx> {
    const [kuruState, book, orders] = await Promise.all([this.d.reads.kuruMarketState(market), this.d.reads.kuruBook(market), this.reconcile(market)]);
    return { market, s, current, kuruState, book, orders };
  }

  private hold(s: SeriesCtx, market: Address | null): void {
    if (market) this.state.markets[lc(market)] = lc(s.series);
    if (this.state.series[lc(s.series)]) return;
    this.state.series[lc(s.series)] = { series: s.series, factory: s.factory, market: s.market, token: s.token };
  }

  /** 3.8: wallet + margin dollars + the bids' locks + each series at its own fair. A series whose index walk finds no
   *  final value is marked at its last known fair, else at the worst case of [F, C], so the loss limit never stops for
   *  every book because one GPU's writers failed (M-M4); MM_MARK_FALLBACK (info) names it. */
  private mark(series: readonly SeriesCtx[], markets: readonly MarketCtx[], walletD: bigint, marginD: bigint): bigint {
    let v = walletD + marginD;
    for (const m of markets) v += bidLock(m.orders);
    for (const s of series) {
      const T = s.Tw + s.Tm + askTokens(markets.filter((m) => m.s === s).flatMap((m) => m.orders));
      const fallbackId = `:${lc(s.series)}`;
      if (T === 0n && s.Sh === 0n) {
        this.d.alerts?.clearWhere((a) => a.code === "MM_MARK_FALLBACK" && a.id.endsWith(fallbackId));
        continue;
      }
      if (s.fair !== null) {
        v += markSeries(T, s.Sh, s.fair, s.terms.cap);
        this.d.alerts?.clearWhere((a) => a.code === "MM_MARK_FALLBACK" && a.id.endsWith(fallbackId));
        continue;
      }
      const last = this.state.lastFair[lc(s.series)];
      let at: string;
      if (last !== undefined) {
        v += markSeries(T, s.Sh, last, s.terms.cap);
        at = `its last fair value ${last}`;
      } else {
        // T x f + Sh x (C - f) is linear in f: its least over [F, C] is at an end
        const atF = markSeries(T, s.Sh, s.terms.floor, s.terms.cap);
        const atC = markSeries(T, s.Sh, s.terms.cap, s.terms.cap);
        v += atF < atC ? atF : atC;
        at = "the worst case of [F, C]";
      }
      this.d.alerts?.raise({ code: "MM_MARK_FALLBACK", severity: "info", key: s.series, message: `${ROLE}: no final index value in the walk for series ${s.series}: marked at ${at} so the loss limit keeps running` });
    }
    return v;
  }

  /** One batchUpdate: cancels every active order of the book (or only `cancelOnly` ids), then places the target
   *  (post-only). The pending id scan stays until the next tick's reconciliation whatever the result (M-M3): a send
   *  reported failed may still have landed, and the scan from counterBefore is cheap. */
  private async batch(m: MarketCtx, target: Ladder, safety: boolean, fair: bigint | null, d: Decision, closed: { bids: boolean; asks: boolean }, band: Band | null, cancelOnly?: readonly bigint[]): Promise<SendResult> {
    const k = lc(m.market);
    const old = m.orders;
    const cancelIds = cancelOnly ? old.filter((o) => cancelOnly.includes(o.id)).map((o) => o.id) : old.map((o) => o.id);
    const cancelled = old.filter((o) => cancelIds.includes(o.id));
    const kept = old.filter((o) => !cancelIds.includes(o.id));
    const adds = target.bids.length + target.asks.length;
    if (cancelIds.length === 0 && adds === 0) return { ok: true, sent: false };
    // a scan still owed for an earlier send of this book (one that may have landed) keeps its lower counter, so this
    // send never hides that one's orders from the next reconciliation (M-M3)
    const prev = this.state.pending[k];
    const now = await this.d.reads.kuruOrderIdCounter(m.market);
    const counterBefore = prev && prev.counterBefore < now ? prev.counterBefore : now;
    this.state.pending[k] =
      adds === 0 && prev
        ? { ...prev, counterBefore }
        : { counterBefore, at: this.ctx.t, fair: adds === 0 ? null : fair, ...(adds > 0 && band ? { lo: band.lo, hi: band.hi } : {}) };
    this.state.markets[k] = lc(m.s.series);
    this.save();
    const res = await this.send({
      to: m.market,
      abi: kuruOrderBookAbi as Abi,
      functionName: "batchUpdate",
      args: [target.bids.map((b) => Number(b.price)), target.bids.map((b) => b.size), target.asks.map((a) => Number(a.price)), target.asks.map((a) => a.size), cancelIds.map((id) => Number(id)), true],
      shape: "kuru.batchUpdate",
      adds,
      cancels: cancelIds.length,
      safety,
      label: `${adds === 0 ? (cancelOnly ? "cancel crossed" : "cancel") : "requote"} ${m.market.slice(0, 10)} (${d.act === "none" ? "" : d.why})`,
    });
    this.lastRequoteMs.set(k, this.d.nowMs());
    if (res.ok && res.sent) {
      const fx = parseBatchLogs(res.logs ?? [], m.market, this.maker);
      this.state.orders[k] = [...kept, ...fx.created];
      delete this.state.pending[k];
      this.state.failures[k] = 0;
      this.d.alerts?.clearWhere((a) => a.code === "MM_SEND_FAILED" && a.id.endsWith(`:${k}`));
      if (adds === 0) {
        // a full cancel forgets the quote; a cancel of the crossed orders keeps it, so the re-placement is condition 3
        // or 4 under the day's budget
        if (!cancelOnly) delete this.state.quoted[k];
      } else {
        const bestBid = fx.created.filter((o) => o.isBuy).sort((a, b) => (a.price > b.price ? -1 : 1))[0];
        const bestAsk = fx.created.filter((o) => !o.isBuy).sort((a, b) => (a.price < b.price ? -1 : 1))[0];
        const q: QuotedRec = { fair: fair ?? 0n, ...(band ? { lo: band.lo, hi: band.hi } : {}), at: this.ctx.t, topBid: bestBid ? { id: bestBid.id, size: bestBid.size } : null, topAsk: bestAsk ? { id: bestAsk.id, size: bestAsk.size } : null, closed };
        this.state.quoted[k] = q;
        this.hold(m.s, m.market);
      }
      // cancel first: the cancelled asks' tokens came back to the margin account, the new asks' are locked
      m.s.Tm += askTokens(cancelled) - target.asks.reduce((x, a) => x + a.size * LOT, 0n);
      m.orders = this.state.orders[k]!;
      this.save();
      appendLine(join(this.d.dir, "quotes.jsonl"), {
        t: this.ctx.t,
        market: m.market,
        series: m.s.series,
        fair,
        ...(band && (band.lo !== fair || band.hi !== fair) ? { lo: band.lo, hi: band.hi } : {}),
        why: d.act === "none" ? "" : d.why,
        cancelled: cancelIds.length,
        bids: target.bids.map((b) => [b.price, b.size]),
        asks: target.asks.map((a) => [a.price, a.size]),
        tx: res.txHash,
      });
      return res;
    }
    // a guard's refusal (dry run, the day's budget, the MON floor) or a stop is not a failed send
    const benign = res.error === "DRY_RUN" || !!res.error?.startsWith("BUDGET") || res.error === "FLOOR" || res.error === "stopping" || !!res.error?.startsWith("key busy");
    if (!benign) {
      const n = (this.state.failures[k] ?? 0) + 1;
      this.state.failures[k] = n;
      if (n >= 3) this.d.alerts?.raise({ code: "MM_SEND_FAILED", severity: "action", key: m.market, message: `${ROLE}: ${n} failed sends in a row on ${m.market} (last: ${res.error ?? "unknown"})` });
    }
    this.save();
    return res;
  }

  /** MS 6.6 D1 for the maker's settle (M-H2): never force a day the wall has not provided. true: held. */
  private async settleHeld(s: SeriesCtx, t: number): Promise<boolean> {
    const fid = `:${lc(s.series)}`;
    if (s.k <= s.stateK) {
      this.d.alerts?.clearWhere((a) => a.code === "MM_FORCE_HELD" && a.id.endsWith(fid));
      return false;
    }
    const held = await forcedDay(this.d.reads, s.terms, s.stateK, s.k, BigInt(t));
    if (held === null) {
      this.d.alerts?.clearWhere((a) => a.code === "MM_FORCE_HELD" && a.id.endsWith(fid));
      return false;
    }
    this.d.alerts?.raise({ code: "MM_FORCE_HELD", severity: "action", key: s.series, message: `${ROLE}: settling ${s.series} would force day ${held.day} past its last resort while the wall has not provided it (${held.why}; index head ${held.head ?? "unreadable"}); not settling until it has` });
    this.say("settle_held", { series: s.series, day: held.day, head: held.head, why: held.why });
    return true;
  }

  /** P-M1: a settle refused GAS_CAP (its sync over the LIMIT table) is preceded by sync chunks that fit, halving c until
   *  one does; then settle has nothing left to sync. Safety, as every wind-down step. */
  private async syncChunks(s: SeriesCtx): Promise<void> {
    let fits = Number.MAX_SAFE_INTEGER; // the largest c that went through: the next chunk starts there
    while (s.stateK < s.k) {
      let c = Math.min(s.k - s.stateK, fits);
      let res: SendResult;
      for (;;) {
        // a chunk above 1 halves on GAS_CAP (logged, no alert); sync(1) over the cap alerts
        res = await this.send({ to: s.series, abi: agateSeriesAbi as Abi, functionName: "sync", args: [BigInt(c)], shape: "series.sync", c, ...(c > 1 ? { splitsOnCap: true } : {}), safety: true, label: `sync ${c} of ${s.series.slice(0, 10)}` });
        if (res.ok || res.error !== "GAS_CAP" || c <= 1) break;
        c = Math.ceil(c / 2);
      }
      if (!res.ok) return;
      fits = c;
      s.stateK += c;
    }
  }

  /** 3.7: past stopAt (the decisions cancelled the book) withdraw the series token from the margin account and redeem
   *  pairs; once k == N settle both sides (not while the D1 hold applies); drop a series that holds nothing.
   *  withdraw-all (kill on) also withdraws every token and the dollar. Low dollars redeem idle pairs. Every step is a
   *  safety action. */
  private async windDown(series: readonly SeriesCtx[], markets: readonly MarketCtx[], t: number, withdrawAll: boolean, floatLow: boolean): Promise<void> {
    for (const s of series) {
      const resting = markets.some((m) => m.s === s && m.orders.length > 0);
      const past = t >= s.stopAt;
      const final = s.k >= s.terms.n;
      if ((past || final || withdrawAll) && !resting && s.Tm > 0n) {
        const res = await this.send({ to: this.ma, abi: kuruMarginAccountAbi as Abi, functionName: "withdraw", args: [s.Tm, s.token], shape: "kuru.withdraw", safety: true, label: `withdraw ${s.Tm} of ${s.token.slice(0, 10)}` });
        if (res.ok) {
          s.Tw += s.Tm;
          s.Tm = 0n;
        }
      }
      if (!final && ((past && !resting) || floatLow)) {
        const q = redeemable(s.Tw, s.Sh);
        if (q > 0n) {
          const res = await this.send({ to: s.series, abi: agateSeriesAbi as Abi, functionName: "redeem", args: [q, this.maker], shape: "series.redeem", safety: true, label: `redeem ${q} of ${s.series.slice(0, 10)}` });
          if (res.ok) {
            s.Tw -= q;
            s.Sh -= q;
          }
        }
      }
      if (final && !resting && (s.Tw > 0n || s.Sh > 0n) && !(await this.settleHeld(s, t))) {
        for (const [side, q] of [
          [SIDE.LONG, s.Tw],
          [SIDE.SHORT, s.Sh],
        ] as const) {
          if (q <= 0n) continue;
          // with days to sync, a settle over its cap is answered by sync chunks (P-M1): logged, not a GAS_CAP alert
          const spec = (): SendSpec => ({ to: s.series, abi: agateSeriesAbi as Abi, functionName: "settle", args: [side, q, this.maker], shape: "series.settle", c: Math.max(0, s.k - s.stateK), ...(s.k > s.stateK ? { splitsOnCap: true } : {}), safety: true, label: `settle ${side === SIDE.LONG ? "long" : "short"} ${q} of ${s.series.slice(0, 10)}` });
          let res = await this.send(spec());
          if (!res.ok && res.error === "GAS_CAP" && s.k > s.stateK) {
            await this.syncChunks(s);
            if (s.stateK >= s.k) res = await this.send(spec());
          }
          if (res.ok) {
            if (side === SIDE.LONG) s.Tw = 0n;
            else s.Sh = 0n;
            s.stateK = s.k;
          }
        }
      }
      if (this.state.series[lc(s.series)] && final && !resting && s.Tw === 0n && s.Tm === 0n && s.Sh === 0n) {
        delete this.state.series[lc(s.series)];
        delete this.state.lastFair[lc(s.series)];
        this.d.alerts?.clearWhere((a) => (a.code === "MM_FORCE_HELD" || a.code === "MM_MARK_FALLBACK") && a.id.endsWith(`:${lc(s.series)}`));
        if (!this.state.settled.includes(lc(s.series))) this.state.settled.push(lc(s.series));
        this.d.alerts?.raise({ code: "MM_SETTLED", severity: "info", key: s.series, message: `${ROLE}: series ${s.series} fully settled and dropped` });
        this.say("settled", { series: s.series });
      }
    }
    if (withdrawAll) {
      const dollar = this.d.deployments.dollar;
      const md = await this.d.reads.marginBalance(this.ma, this.maker, dollar);
      if (md > 0n) await this.send({ to: this.ma, abi: kuruMarginAccountAbi as Abi, functionName: "withdraw", args: [md, dollar], shape: "kuru.withdraw", safety: true, label: `withdraw ${md} u` });
    }
  }
}

