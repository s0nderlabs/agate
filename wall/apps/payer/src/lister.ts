// BOTS-SPEC 4.2: every tick, for each factory of the deployments file, list the current and the next month of every
// GPU the moment previewListing stops reverting, then create its Kuru V1 market (createMarket, anyone, MS 3.4).
// previewListing answers exactly when list would succeed (MS 3.3), so the lister needs no clock rule of its own.
// list and createMarket are idempotent on chain (AlreadyListed, MarketAlreadySet show in the simulation and are
// skipped), so a restart or a second lister costs nothing. The pilot factory (kuruRouter 0) lists only.
import type { Address, Hex } from "viem";
import { alertId, type AlertSink, RpcDown } from "@agate/watcher";
import { agateFactoryAbi, errorName, type ExtraReads, type FactoryEntry, firstDayOf, type MarketReads, REVERTED_ONCHAIN, type Sender, type SendResult, VENUE, ZERO_ADDRESS } from "@agate/market";
import type { StateStore } from "./state.ts";

export const RETRY_S = 3_600;

export function monthLabel(m: number): string {
  return `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}`;
}

export interface ListerDeps {
  reads: MarketReads & ExtraReads;
  sender: Sender;
  factories: readonly FactoryEntry[];
  state: StateStore;
  alerts?: AlertSink;
  log: (event: string, data: Record<string, unknown>) => void;
  /** true once SIGINT or SIGTERM asked to stop: no further send */
  stopping?: () => boolean;
}

export interface ListerReport {
  listed: string[];
  created: string[];
  /** months whose previewListing says NotReady (their anchor days are not final yet) */
  waiting: string[];
  /** (recheck R1-H1) what the lister still has to send: every month of its window that is not listed (whatever the
   *  reason: NotReady, a list the spend guard refused, a retry, a race), except one that can never list; and every
   *  listed series of a factory with a Kuru router whose market is still NONE. While any is owed (or a factory's pass
   *  failed, `errors`), the claims keep one listing's cost of the floor's headroom back for the lister (BOTS-SPEC 4.5;
   *  since Oct 5 a listing is a safety send, so the floor is all that can hold it). */
  owed: string[];
  /** factories whose pass failed with an error other than RpcDown (lister_error): what they owe is unknown */
  errors: number;
  sends: number;
}

/** The newest gas limit the sender planned for each lister send (a send the guard refused carries it too): the reserve
 *  covers at least that, so a LIMIT row below the chain's real estimate cannot leave the listing short of the floor's
 *  headroom (R1-H1). */
export interface ListerGas {
  list: bigint;
  createMarket: bigint;
}

/** A decoded revert (or one viem could not decode): the chain refused; anything else is a guard or the RPC. */
export function isRefusal(error: string | undefined): boolean {
  const e = error ?? "";
  return /^(estimate: )?([A-Z][A-Za-z0-9_]*\(|revert 0x)/.test(e) || /revert/i.test(e);
}

/** A send that went out and was not seen to revert (sender.ts): BROADCAST_UNCONFIRMED (the broadcast's outcome is
 *  unknown) or NONCE_STUCK (unmined through every replacement; it may still land). Not a refusal: the next tick's
 *  view shows whether it landed, and only a receipt with a revert status is one. */
export const unconfirmed = (res: SendResult) => res.sent && !res.ok && res.error !== REVERTED_ONCHAIN;

const listKey = (factory: Address, gpuId: Hex, month: number) => `${factory.toLowerCase()}:${gpuId.toLowerCase()}:${month}`;

export class Lister {
  readonly gasSeen: ListerGas = { list: 0n, createMarket: 0n };
  constructor(readonly d: ListerDeps) {}

  private say(event: string, data: Record<string, unknown>): void {
    this.d.log(event, data);
  }

  private clear(code: string, o: { gpuId?: Hex; key: string }): void {
    const id = alertId({ code, ...(o.gpuId ? { gpuId: o.gpuId } : {}), key: o.key });
    this.d.alerts?.clearWhere((a) => a.id === id);
  }

  /** When month X should be listable at the latest: the last anchor (the day before the 1st of X - 1) closed and
   *  final, plus slack; never before the GPU's first record could be final. null: the index has no record yet. */
  async expectedAt(f: FactoryEntry, gpuId: Hex, month: number): Promise<bigint | null> {
    const r = this.d.reads;
    const fr = await r.indexFirstRecordDay(f.index, gpuId);
    if (!fr.exists) return null;
    const ck = await r.indexClocks(f.index);
    const tPend = BigInt(Math.max(ck.tPend, f.tPend));
    const grace = BigInt(ck.closeGrace);
    const slack = BigInt(Math.max(Math.floor(ck.day / 4), 600));
    const [anchor, first] = await Promise.all([r.indexDayStart(f.index, firstDayOf(month - 1)), r.indexDayStart(f.index, fr.day + 1)]);
    const a = anchor + grace + tPend + slack;
    const b = first + grace + tPend + slack;
    return a > b ? a : b;
  }

  async tick(t: bigint): Promise<ListerReport> {
    const rep: ListerReport = { listed: [], created: [], waiting: [], owed: [], errors: 0, sends: 0 };
    for (const f of this.d.factories) {
      try {
        await this.factory(f, t, rep);
      } catch (e) {
        if (e instanceof RpcDown) throw e;
        rep.errors++;
        this.say("lister_error", { factory: f.name, error: (e as Error).message.split("\n")[0] });
      }
    }
    return rep;
  }

  /** Oct 5 (BOTS-SPEC 2.6 v6): a listing send is a safety action. It ignores the day's budget and its pacing, never the
   *  floor, and its cost still counts in the day's spend. A month opens once per GPU (each send simulated first;
   *  AlreadyListed and MarketAlreadySet end it), so this is a few MON a month. On Oct 5 a 1.27 MON day, paced, refused
   *  the three November listings (about 0.6 MON each with the market) for hours; the 1st of each month would do the
   *  same. A send whose last try reverted onchain (`key` in budgetBound) goes back to the day's budget: on Monad a
   *  revert bills the whole gas limit, and the hourly retries of one that keeps reverting must stay bounded. */
  private async send(fn: "list" | "createMarket", f: FactoryEntry, args: readonly unknown[], label: string, rep: ListerReport, key: string): Promise<SendResult | null> {
    if (this.d.stopping?.()) return null;
    rep.sends++;
    const safety = !this.d.state.data.budgetBound.includes(key);
    const res = await this.d.sender.send({ to: f.factory, abi: agateFactoryAbi, functionName: fn, args, shape: fn === "list" ? "factory.list" : "factory.createMarket", label, safety });
    if (res.gasLimit !== undefined && res.gasLimit > 0n) this.gasSeen[fn] = res.gasLimit;
    return res;
  }

  private async factory(f: FactoryEntry, t: bigint, rep: ListerReport): Promise<void> {
    const r = this.d.reads;
    const st = this.d.state.data;
    const [m, gpus, kr] = await Promise.all([r.currentMonth(f.factory), r.gpuIds(f.factory), r.kuruRouterOf(f.factory)]);
    // a month that left the window (m - 1 and before) is never asked again: its alerts' condition is gone. A market
    // refusal is keyed by its series, so it carries its factory and month in data (recheck R2-L4)
    const fk = f.factory.toLowerCase();
    const past = new RegExp(`:${fk}-(\\d+)$`);
    this.d.alerts?.clearWhere((a) => ["LISTER_STUCK", "LISTER_REFUSED"].includes(a.code as string) && Number(past.exec(a.id)?.[1] ?? m) < m);
    this.d.alerts?.clearWhere((a) => {
      const x = (a as { data?: { factory?: unknown; month?: unknown } }).data;
      return (a.code as string) === "LISTER_MARKET_REFUSED" && x?.factory === fk && typeof x.month === "number" && x.month < m;
    });
    // a retry time already passed means nothing (the next try is due): dropped, so a market refusal of a month that left
    // the window does not stay in state.json for ever
    for (const tbl of [st.retryAt, st.marketRetryAt]) for (const [k, at] of Object.entries(tbl)) if (at <= Number(t)) delete tbl[k];
    const pairs = gpus.flatMap((g) => [m, m + 1].map((month) => ({ g, month })));
    const unowe = (x: string) => {
      const i = rep.owed.lastIndexOf(x);
      if (i >= 0) rep.owed.splice(i, 1);
    };
    const series = await Promise.all(pairs.map((p) => r.seriesOf(f.factory, p.g, p.month)));
    for (let i = 0; i < pairs.length; i++) {
      const { g, month } = pairs[i]!;
      let s = series[i]!;
      const key = listKey(f.factory, g, month);
      const alertKey = `${f.factory.toLowerCase()}-${month}`;
      const label = await r.labelOf(f.factory, g);
      const what = `${f.name} ${label} ${monthLabel(month)}`;
      if (s.toLowerCase() === ZERO_ADDRESS) {
        if (st.neverList.includes(key)) continue;
        // inside the hour after a refusal no spend can list it (recheck R2-L2): not owed, so the claims keep no reserve
        // for it (LISTER_REFUSED already asks a person to look); owed again from its retry on
        if ((st.retryAt[key] ?? 0) > Number(t)) continue;
        // from here on the month is in the window and not listed: owed until its slot is filled (R1-H1)
        rep.owed.push(what);
        const chk = await r.previewListing(f.factory, g, month);
        if (chk.ok) {
          const res = await this.send("list", f, [g, month], `list ${what}`, rep, key);
          if (!res) return;
          if (res.ok && res.sent) {
            rep.listed.push(what);
            unowe(what);
            this.say("listed", { factory: f.name, gpu: label, month: monthLabel(month), tx: res.txHash });
            this.clear("LISTER_STUCK", { gpuId: g, key: alertKey });
            this.clear("LISTER_REFUSED", { gpuId: g, key: alertKey });
            delete st.retryAt[key];
            this.unbind(key);
            this.d.state.save();
            s = await r.seriesOf(f.factory, g, month);
          } else {
            const name = errorName(res.error);
            if (!res.sent && name === "AlreadyListed") {
              this.clear("LISTER_REFUSED", { gpuId: g, key: alertKey });
              unowe(what);
              s = await r.seriesOf(f.factory, g, month); // another lister was first: go on to its market
            } else if ((!res.sent && (name === "NotReady" || name === "MonthNotOpen" || !isRefusal(res.error))) || unconfirmed(res)) {
              // a race, a guard (GAS_CAP, budget, floor, dry run), the RPC, or a send whose outcome is not known yet
              // (BROADCAST_UNCONFIRMED, or NONCE_STUCK: the sender raised its own alert; the next tick's view shows
              // whether it landed): next tick, no lister alert
              this.say("list_skipped", { what, error: res.error });
              if (!res.sent && (name === "BUDGET" || name === "FLOOR")) await this.budgetStuck(f, g, month, what, alertKey, t, name);
              continue;
            } else {
              unowe(what); // nothing to keep back for it inside the retry hour (R2-L2)
              if (res.sent) this.bind(key); // reverted onchain: its retries are the day's budget's
              this.refused(f, g, month, label, alertKey, key, t, res.sent ? `reverted onchain (${res.txHash})` : (res.error ?? "refused"));
              continue;
            }
          }
        } else {
          const name = errorName(chk.error);
          if (name === "NotReady") {
            rep.waiting.push(what);
            const at = await this.expectedAt(f, g, month);
            if (at !== null && t > at) {
              this.d.alerts?.raise({ code: "LISTER_STUCK", severity: "action", gpuId: g, key: alertKey, message: `lister: ${what} on factory ${f.factory} still NotReady past ${at} (its anchor days are not final; an anchor waiting for the attester is the usual cause)`, data: { lateS: (t - at).toString() } });
            }
            continue;
          }
          this.clear("LISTER_STUCK", { gpuId: g, key: alertKey });
          if (name === "MonthNotOpen") continue; // a month boundary between two reads
          if (name === "AlreadyListed") {
            this.clear("LISTER_REFUSED", { gpuId: g, key: alertKey });
            unowe(what);
            s = await r.seriesOf(f.factory, g, month);
          } else if (name === "IndexStartsAfterMonth") {
            unowe(what); // it can never list: nothing to keep back for it
            st.neverList.push(key);
            this.d.state.save();
            this.d.alerts?.raise({ code: "LISTER_INDEX_STARTS_AFTER", severity: "info", gpuId: g, key: alertKey, message: `lister: ${what} on factory ${f.factory} can never list: ${chk.error}` });
            continue;
          } else {
            unowe(what); // R2-L2, as above
            this.refused(f, g, month, label, alertKey, key, t, chk.error);
            continue;
          }
        }
      } else {
        // the slot is filled (by us or anyone, even after our own list reverted on a front-run): nothing is stuck
        // or refused any more (audit P-L1)
        this.clear("LISTER_STUCK", { gpuId: g, key: alertKey });
        this.clear("LISTER_REFUSED", { gpuId: g, key: alertKey });
        delete st.retryAt[key];
        this.unbind(key);
      }
      if (s.toLowerCase() === ZERO_ADDRESS) {
        rep.owed.push(what); // listed, yet the view has no series yet (a lagging node): the next tick looks again
        continue;
      }
      if (kr.toLowerCase() === ZERO_ADDRESS) continue; // the pilot: its market is the admin's attachMarket
      const mk = await r.marketOf(f.factory, s);
      const sk = s.toLowerCase();
      if (mk.venue !== VENUE.NONE) {
        // the market exists (ours, a stranger's, or the admin's attach): clear a createMarket refusal (P-L1)
        this.clear("LISTER_MARKET_REFUSED", { key: sk });
        delete st.marketRetryAt[sk];
        this.unbind(sk);
        continue;
      }
      // no market yet: owed until it exists (R1-H1), whether this tick creates it or not; not inside the hour after a
      // refusal (R2-L2: no spend can create it then)
      if ((st.marketRetryAt[sk] ?? 0) > Number(t)) continue;
      rep.owed.push(`market ${what}`);
      const res = await this.send("createMarket", f, [s], `createMarket ${what}`, rep, sk);
      if (!res) return;
      if (res.ok && res.sent) {
        unowe(`market ${what}`);
        rep.created.push(what);
        this.say("market_created", { factory: f.name, gpu: label, month: monthLabel(month), series: s, tx: res.txHash });
        this.clear("LISTER_MARKET_REFUSED", { key: sk });
        delete st.marketRetryAt[sk];
        this.unbind(sk);
        this.d.state.save();
        continue;
      }
      const name = errorName(res.error);
      if (!res.sent && name === "MarketAlreadySet") {
        this.clear("LISTER_MARKET_REFUSED", { key: sk });
        unowe(`market ${what}`);
        continue;
      }
      if (unconfirmed(res)) this.say("create_market_skipped", { what, error: res.error });
      else if (res.sent || isRefusal(res.error)) {
        // here res.sent means a receipt with a revert status (unconfirmed() took every other sent outcome)
        unowe(`market ${what}`); // R2-L2
        st.marketRetryAt[sk] = Number(t) + RETRY_S;
        if (res.sent) this.bind(sk); // reverted onchain: its retries are the day's budget's
        this.d.state.save();
        this.d.alerts?.raise({ code: "LISTER_MARKET_REFUSED", severity: "action", key: sk, message: `lister: createMarket for ${what} (series ${s}) ${res.sent ? `reverted onchain (${res.txHash})` : `refused: ${res.error}`}; retrying hourly`, data: { factory: fk, month } });
      } else this.say("create_market_skipped", { what, error: res.error });
    }
  }

  /** (R1-H1) A ready month whose list the spend guard refused past expectedAt: LISTER_STUCK (action), cleared once the
   *  slot is filled. A first listing is a safety send, so the guard refuses it only at the floor (the key needs MON);
   *  the day's budget refuses only the retry of a list that reverted onchain (budgetBound). */
  private async budgetStuck(f: FactoryEntry, g: Hex, month: number, what: string, alertKey: string, t: bigint, why: "BUDGET" | "FLOOR"): Promise<void> {
    const at = await this.expectedAt(f, g, month);
    if (at === null || t <= at) return;
    const cause = why === "FLOOR" ? "the key's floor (keepMon) has refused its list" : "the day's budget has refused the retry of its list, which reverted onchain";
    const fix = why === "FLOOR" ? "top up the key with MON (ops/testnet/fund.sh)" : "see its LISTER_REFUSED for why it reverts";
    this.d.alerts?.raise({ code: "LISTER_STUCK", severity: "action", gpuId: g, key: alertKey, message: `lister: ${what} on factory ${f.factory} is ready but ${cause} past ${at} (${fix})`, data: { lateS: (t - at).toString() } });
  }

  /** A list key or series whose send reverted onchain: its next sends are the day's budget's, until its slot fills. */
  private bind(k: string): void {
    const b = this.d.state.data.budgetBound;
    if (!b.includes(k)) b.push(k);
  }

  private unbind(k: string): void {
    const b = this.d.state.data.budgetBound;
    const i = b.indexOf(k);
    if (i >= 0) b.splice(i, 1);
  }

  private refused(f: FactoryEntry, g: Hex, month: number, label: string, alertKey: string, key: string, t: bigint, error: string): void {
    this.d.state.data.retryAt[key] = Number(t) + RETRY_S;
    this.d.state.save();
    this.d.alerts?.raise({ code: "LISTER_REFUSED", severity: "action", gpuId: g, key: alertKey, message: `lister: ${f.name} ${label} ${monthLabel(month)} on factory ${f.factory} refused: ${error}; retrying in an hour` });
  }
}
