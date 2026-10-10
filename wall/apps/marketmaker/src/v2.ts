// The maker's Kuru Spot V2 desk (Oct 10 2026): quotes a series' token on a V2 book that Kuru's governance listed, beside
// its V1 book, from the same process and key (one nonce). It reuses the V1 maker's fair value, band and ladder, so both
// venues quote the same prices; only the venue mechanics differ:
//   - funds sit in the maker's V2 account (AccountCore): tokens and Kuru's test USDC are deposited before quoting;
//   - orders live in slots of the maker's page; one batch cancels the occupied slots and places the new ladder (the
//     cancels run first, so freed slots are reused), post-only GTC;
//   - fills are seen as order ids leaving their slots or the market's locked reserves dropping, not per order.
// Inventory: the tokens held in the V2 account are capped (maxBaseTokens; at the cap the bids close) and counted in the
// loss limit's mark with the USDC; a series that is final has its tokens withdrawn to the wallet so the V1 wind-down
// settles them (a V2 withdrawal costs about 0.66 MON of gas on testnet, so it happens only then or on withdraw-all).
import { join } from "node:path";
import type { Abi, Address } from "viem";
import { appendLine, RpcDown } from "@agate/watcher";
import { agateSeriesAbi, kuruV2AccountCoreAbi, kuruV2OrderBookAbi, type L2Book, LOT, type MarketReads, type SendResult, type SendSpec, U, V2_EXEC, V2_MARKET_ACTIVE, V2_MAX_CANCELS, V2_SIDE, V2_TIF, type V2Params, type V2Reads } from "@agate/market";
import type { BookConfig } from "./config.ts";
import { planTokens } from "./inventory.ts";
import { clampCrossing, type Ladder, targetLadder, UNITS_PER_TOKEN } from "./ladder.ts";
import type { MmState } from "./state.ts";

export interface V2BookCfg {
  market: Address;
  series: Address;
}
export interface V2Cfg extends BookConfig {
  accountCore: Address;
  books: V2BookCfg[];
  /** tokens the V2 account may hold for one book (free + resting asks); at the cap the bids close */
  maxBaseTokens: number;
}

/** One V2 order in V2's raw units: price in quote per base x pricePrecision, qty in base x sizePrecision. */
export interface V2Order {
  side: 0 | 1;
  price: bigint;
  qty: bigint;
}

/** The last requote of a V2 book. ids null: placed, the slots are adopted (with the locked reserves) next tick. */
export interface V2Quoted {
  fair: bigint;
  lo: bigint;
  hi: bigint;
  at: number;
  ids: bigint[] | null;
  base: bigint | null;
  quote: bigint | null;
  bids: [bigint, bigint][];
  asks: [bigint, bigint][];
}

/** What the desk needs of a series (the V1 maker's SeriesCtx, structurally). */
export interface V2Series {
  series: Address;
  token: Address;
  terms: { floor: bigint; cap: bigint; n: number };
  quotable: boolean;
  k: number;
  Tw: bigint;
  Sh: bigint;
  fair: bigint | null;
  lo: bigint | null;
  hi: bigint | null;
  stopAt: number;
}

export interface V2Snap {
  cfg: V2BookCfg;
  s: V2Series | null;
  p: V2Params;
  state: number | null;
  id: number;
  slots: bigint[];
  locked: { base: bigint; quote: bigint };
  freeBase: bigint;
  freeQuote: bigint;
  walletQuote: bigint;
  book: L2Book;
}

export interface V2Host {
  maker: Address;
  reads: MarketReads & V2Reads;
  dollar: Address;
  dir: string;
  send(s: SendSpec): Promise<SendResult>;
  approve(token: Address, spender: Address, safety: boolean): Promise<boolean>;
  /** keep the series in the maker's held list (state.series), so it is discovered, wound down and settled after its
   *  month even if only V2 traded it */
  hold(series: Address): void;
  say(event: string, data?: Record<string, unknown>): void;
  raise?(x: { code: string; severity: "info" | "action"; message: string; key?: string }): void;
  clear?(code: string, key: string): void;
  state(): MmState;
  save(): void;
  nowMs(): number;
  budgetOut(): boolean;
}

export interface V2TickCtx {
  t: number;
  killed: string | null;
  cancelAll: boolean;
  withdrawAll: boolean;
  oneShot: boolean;
  /** tUSD the wallet can still spend this tick (u); the desk returns what it spent on mints */
  walletD: bigint;
}

const lc = (a: string) => a.toLowerCase();
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const PPS = 1_000_000n;

// ------------------------------------------------------------------ units

/** u per token (the V1 maker's prices) to V2's raw price, on V2's tick: bids round down, asks up. */
export function toV2Price(u: bigint, p: V2Params, side: "bid" | "ask"): bigint {
  const num = u * p.pricePrecision;
  const raw = side === "bid" ? num / U : ceilDiv(num, U);
  return side === "bid" ? (raw / p.tickSize) * p.tickSize : ceilDiv(raw, p.tickSize) * p.tickSize;
}
/** V2's raw price to u per token (rounded toward the given side's safety: a bid's others' best down, an ask's up). */
export function fromV2Price(raw: bigint, p: V2Params, round: "down" | "up" = "down"): bigint {
  const num = raw * U;
  return round === "down" ? num / p.pricePrecision : ceilDiv(num, p.pricePrecision);
}
/** The V1 maker's size units (1e-4 token) to V2's raw quantity, rounded down. */
export function toV2Qty(units: bigint, p: V2Params): bigint {
  return (units * p.sizePrecision) / UNITS_PER_TOKEN;
}
/** Base token atoms (agate tokens have 6 decimals, U per token) of a V2 quantity. */
export function baseAtoms(qty: bigint, p: V2Params): bigint {
  return (qty * U) / p.sizePrecision;
}
/** Quote atoms an order is worth: price x qty, scaled to the quote token's decimals. */
export function notional(o: V2Order, p: V2Params): bigint {
  return (o.price * o.qty * 10n ** BigInt(p.quoteDecimals)) / (p.pricePrecision * p.sizePrecision);
}
/** Quote atoms a resting bid reserves: its notional plus the maker fee allowance, rounded up. */
export function bidReserve(o: V2Order, p: V2Params): bigint {
  return ceilDiv(notional(o, p) * (PPS + p.makerFeePps), PPS);
}
/** Quote atoms to u (the V1 maker's dollars). */
export function quoteToU(atoms: bigint, p: V2Params): bigint {
  return (atoms * U) / 10n ** BigInt(p.quoteDecimals);
}

/** A V1-unit ladder as V2 orders: bids first (best first), then asks; a level under the book's minimum notional or of
 *  zero quantity is dropped, and a price repeated on its side keeps the first. */
export function v2Orders(l: Ladder, p: V2Params): V2Order[] {
  const out: V2Order[] = [];
  const seen = new Set<string>();
  for (const [side, levels] of [
    [V2_SIDE.BUY, l.bids],
    [V2_SIDE.SELL, l.asks],
  ] as const) {
    for (const x of levels) {
      const o: V2Order = { side, price: toV2Price(x.price, p, side === V2_SIDE.BUY ? "bid" : "ask"), qty: toV2Qty(x.size, p) };
      const key = `${side}:${o.price}`;
      if (o.qty <= 0n || o.price <= 0n || seen.has(key) || notional(o, p) < p.minQuoteNotional) continue;
      seen.add(key);
      out.push(o);
    }
  }
  return out;
}

/** The book's best bid and ask after taking the maker's own resting quantity out of each of its price levels. */
export function othersBestV2(book: L2Book, own: { bids: readonly [bigint, bigint][]; asks: readonly [bigint, bigint][] }): { bid: bigint | null; ask: bigint | null } {
  const mine = (xs: readonly [bigint, bigint][]) => {
    const m = new Map<bigint, bigint>();
    for (const [px, q] of xs) m.set(px, (m.get(px) ?? 0n) + q);
    return m;
  };
  const ob = mine(own.bids);
  const oa = mine(own.asks);
  const bid = book.bids.find(([px, q]) => q > (ob.get(px) ?? 0n))?.[0] ?? null;
  const ask = book.asks.find(([px, q]) => q > (oa.get(px) ?? 0n))?.[0] ?? null;
  return { bid, ask };
}

/** Keeps orders of one side from the best outward while their need fits the budget (a partial level is cut to what
 *  fits, in whole quantity steps of `step`, if it stays over the minimum notional). */
export function fitSide(orders: readonly V2Order[], budget: bigint, need: (o: V2Order) => bigint, p: V2Params, step: bigint): V2Order[] {
  const out: V2Order[] = [];
  let left = budget;
  for (const o of orders) {
    const n = need(o);
    if (n <= left) {
      out.push(o);
      left -= n;
      continue;
    }
    // the largest quantity that fits, in steps
    let lo = 0n;
    let hi = o.qty / step;
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      if (need({ ...o, qty: mid * step }) <= left) lo = mid;
      else hi = mid - 1n;
    }
    const cut: V2Order = { ...o, qty: lo * step };
    if (cut.qty > 0n && notional(cut, p) >= p.minQuoteNotional) out.push(cut);
    break;
  }
  return out;
}

export type V2Decision = { act: "none"; why?: string } | { act: "cancel"; why: string } | { act: "requote"; why: string };

/** One book's decision (the V1 maker's rules, in V2's terms). */
export function decideV2(x: {
  t: number;
  nowMs: number;
  cancelOnly: string | null;
  own: number;
  slots: readonly bigint[];
  locked: { base: bigint; quote: bigint };
  fair: bigint | null;
  lo: bigint | null;
  hi: bigint | null;
  rec: V2Quoted | null;
  lastSendMs: number | null;
  bc: Pick<BookConfig, "requoteMoveU" | "replenishBelowPct" | "staleS" | "minRequoteS">;
}): V2Decision {
  if (x.cancelOnly !== null) return x.own > 0 ? { act: "cancel", why: x.cancelOnly } : { act: "none", why: x.cancelOnly };
  if (x.fair === null) return { act: "none", why: "no fair" };
  if (x.lastSendMs !== null && x.nowMs - x.lastSendMs < x.bc.minRequoteS * 1000) return { act: "none", why: "min requote interval" };
  const r = x.rec;
  if (r === null) return { act: "requote", why: "first quote" };
  if (r.ids === null) return { act: "none", why: "adopting" };
  const live = new Set(x.slots.filter((id) => id !== 0n));
  if (r.ids.some((id) => !live.has(id))) return { act: "requote", why: "an order left its slot (filled)" };
  const pct = BigInt(x.bc.replenishBelowPct);
  if (r.base !== null && r.base > 0n && x.locked.base * 100n < r.base * pct) return { act: "requote", why: "asks filled" };
  if (r.quote !== null && r.quote > 0n && x.locked.quote * 100n < r.quote * pct) return { act: "requote", why: "bids filled" };
  // V1's condition 3: the largest move of fair or either band edge, strictly over requoteMoveU
  const { lo, hi } = bandAround(x.fair, x.lo, x.hi);
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const moves = [abs(x.fair - r.fair), abs(lo - r.lo), abs(hi - r.hi)];
  if (moves.some((m) => m > x.bc.requoteMoveU)) return { act: "requote", why: lo !== x.fair || hi !== x.fair ? "fair or its band moved" : "fair moved" };
  if (x.t - r.at >= x.bc.staleS) return { act: "requote", why: "stale" };
  return { act: "none" };
}

/** The band a ladder is placed around, as the V1 maker takes it: lo <= fair <= hi. */
export function bandAround(fair: bigint, lo: bigint | null, hi: bigint | null): { lo: bigint; hi: bigint } {
  return { lo: lo !== null && lo < fair ? lo : fair, hi: hi !== null && hi > fair ? hi : fair };
}

// ------------------------------------------------------------------ the desk

export class V2Desk {
  private readonly lastSendMs = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  constructor(
    readonly cfg: V2Cfg,
    readonly h: V2Host,
  ) {}

  private get recs(): Record<string, V2Quoted> {
    const st = this.h.state();
    st.v2 ??= {};
    return st.v2;
  }
  private slotsToScan(): number {
    return Math.min(64, 2 * this.cfg.levels + 4);
  }

  /** One read of every configured book (batched with the tick's other reads by the multicall client). A book the chain
   *  cannot read (a revert, not the RPC: RpcDown propagates) is left out with MM_V2_UNREADABLE (action); the mark then
   *  carries its last known holdings, and nothing is sent for it until it reads again. */
  async snapshot(series: readonly V2Series[]): Promise<V2Snap[]> {
    const r = this.h.reads;
    this.unreadable = new Set();
    let id: number;
    try {
      id = await r.v2RootId(this.cfg.accountCore, this.h.maker);
    } catch (e) {
      if (e instanceof RpcDown) throw e;
      this.allUnreadable(e);
      return [];
    }
    const out = await Promise.all(
      this.cfg.books.map(async (cfg): Promise<V2Snap | null> => {
        try {
          const p = await r.v2Params(cfg.market);
          const s = series.find((x) => lc(x.series) === lc(cfg.series)) ?? null;
          if (s && lc(p.base) !== lc(s.token)) {
            this.h.say("v2_misconfigured", { market: cfg.market, series: cfg.series, why: `the book's base ${p.base} is not the series' token ${s.token}` });
          }
          const [state, slots, locked, freeBase, freeQuote, walletQuote, book] = await Promise.all([
            r.v2MarketState(cfg.market),
            id ? r.v2Slots(cfg.market, id, this.slotsToScan()) : Promise.resolve([] as bigint[]),
            id ? r.v2Locked(cfg.market, id) : Promise.resolve({ base: 0n, quote: 0n }),
            id ? r.v2Balance(this.cfg.accountCore, id, p.base) : Promise.resolve(0n),
            id ? r.v2Balance(this.cfg.accountCore, id, p.quote) : Promise.resolve(0n),
            r.erc20Balance(p.quote, this.h.maker),
            r.v2Book(cfg.market, 10),
          ]);
          this.h.clear?.("MM_V2_UNREADABLE", cfg.market);
          return { cfg, s: s && lc(p.base) === lc(s.token) ? s : null, p, state, id, slots, locked, freeBase, freeQuote, walletQuote, book };
        } catch (e) {
          if (e instanceof RpcDown) throw e;
          this.markUnreadable(cfg.market, e);
          return null;
        }
      }),
    );
    return out.filter((x): x is V2Snap => x !== null);
  }

  private unreadable = new Set<string>();
  /** The last holdings read per book, and each quote token's free plus wallet balance, in u: the mark of a book that
   *  cannot be read this tick (so the loss limit neither trips on nor forgets what the V2 account holds). */
  private readonly lastHold = new Map<string, { series: string | null; tokens: bigint; lockedU: bigint; quote: string }>();
  private readonly lastQuoteU = new Map<string, bigint>();

  private markUnreadable(market: Address, e: unknown): void {
    this.unreadable.add(lc(market));
    const why = e instanceof Error ? e.message.split("\n")[0] : String(e);
    this.h.say("v2_unreadable", { market, error: why });
    this.h.raise?.({ code: "MM_V2_UNREADABLE", severity: "action", key: market, message: `marketmaker: the Kuru V2 book ${market} cannot be read (${why}); nothing is sent for it and the mark keeps its last holdings` });
  }
  private allUnreadable(e: unknown): void {
    for (const b of this.cfg.books) this.markUnreadable(b.market, e);
  }

  /** For the loss limit's mark: tokens held in the V2 account per series (free + resting asks), and the V2 dollars
   *  (each quote token's free account balance and wallet balance once, plus every book's resting bids), in u. A book
   *  left out of this tick's snapshot counts with its last known holdings. */
  holdings(snaps: readonly V2Snap[]): { tokens: Map<string, bigint>; dollars: bigint } {
    const tokens = new Map<string, bigint>();
    let dollars = 0n;
    const quotes = new Set<string>();
    const add = (series: string | null, n: bigint) => {
      if (series) tokens.set(series, (tokens.get(series) ?? 0n) + n);
    };
    for (const x of snaps) {
      const series = x.s ? lc(x.s.series) : lc(x.cfg.series);
      const held = x.freeBase + x.locked.base;
      const lockedU = quoteToU(x.locked.quote, x.p);
      this.lastHold.set(lc(x.cfg.market), { series, tokens: held, lockedU, quote: lc(x.p.quote) });
      add(series, held);
      dollars += lockedU;
      if (quotes.has(lc(x.p.quote))) continue;
      quotes.add(lc(x.p.quote));
      const freeU = quoteToU(x.freeQuote + x.walletQuote, x.p);
      this.lastQuoteU.set(lc(x.p.quote), freeU);
      dollars += freeU;
    }
    for (const m of this.unreadable) {
      const last = this.lastHold.get(m);
      if (!last) continue;
      add(last.series, last.tokens);
      dollars += last.lockedU;
      if (quotes.has(last.quote)) continue;
      quotes.add(last.quote);
      dollars += this.lastQuoteU.get(last.quote) ?? 0n;
    }
    return { tokens, dollars };
  }

  private async send(s: SendSpec, market: Address): Promise<SendResult> {
    const r = await this.h.send(s);
    const k = lc(market);
    if (r.ok && r.sent) {
      this.failures.set(k, 0);
      this.h.clear?.("MM_V2_SEND_FAILED", market);
    } else if (r.error !== "DRY_RUN" && r.error !== "stopping" && !r.error?.startsWith("BUDGET") && r.error !== "FLOOR" && !r.error?.startsWith("key busy")) {
      const n = (this.failures.get(k) ?? 0) + 1;
      this.failures.set(k, n);
      if (n >= 3) this.h.raise?.({ code: "MM_V2_SEND_FAILED", severity: "action", key: market, message: `marketmaker: ${n} failed V2 sends in a row on ${market} (last: ${r.error ?? "unknown"})` });
    }
    return r;
  }

  private async deposit(token: Address, amount: bigint, market: Address, safety: boolean): Promise<boolean> {
    if (amount <= 0n) return true;
    if (!(await this.h.approve(token, this.cfg.accountCore, safety))) return false;
    const r = await this.send({ to: this.cfg.accountCore, abi: kuruV2AccountCoreAbi as Abi, functionName: "deposit", args: [this.h.maker, token, amount], shape: "kuruV2.deposit", safety, label: `v2 deposit ${amount} of ${token.slice(0, 10)}` }, market);
    return r.ok;
  }

  private async withdraw(id: number, token: Address, amount: bigint, market: Address): Promise<boolean> {
    if (amount <= 0n || !id) return true;
    const r = await this.send({ to: this.cfg.accountCore, abi: kuruV2AccountCoreAbi as Abi, functionName: "withdraw", args: [id, token, amount, this.h.maker], shape: "kuruV2.withdraw", safety: true, label: `v2 withdraw ${amount} of ${token.slice(0, 10)}` }, market);
    return r.ok;
  }

  /** The tick's V2 work, after the V1 sends and before the V1 wind-down (so a final series' tokens come home first). */
  async run(snaps: V2Snap[], c: V2TickCtx): Promise<void> {
    // the wallet's dollars across this tick's V2 mints (several books can mint)
    let walletD = c.walletD;
    for (const x of snaps) {
      const k = lc(x.cfg.market);
      const s = x.s;
      const own = x.slots.filter((id) => id !== 0n).length;
      let cancelOnly: string | null = null;
      if (c.killed !== null) cancelOnly = `kill (${c.killed})`;
      else if (c.cancelAll) cancelOnly = "cancel-all";
      else if (s === null) cancelOnly = "no open series for this book";
      else if (!s.quotable) cancelOnly = "not an open month";
      else if (c.t >= s.stopAt) cancelOnly = "wind-down";
      else if (x.state !== V2_MARKET_ACTIVE) cancelOnly = "market not active";
      const rec = this.recs[k] ?? null;
      if (rec && rec.ids === null && cancelOnly === null) {
        // adopt what the last batch left in the slots: post-only orders that would have crossed were skipped
        rec.ids = x.slots.filter((id) => id !== 0n);
        rec.base = x.locked.base;
        rec.quote = x.locked.quote;
        this.h.save();
        this.h.say("v2_adopted", { market: x.cfg.market, orders: rec.ids.length, lockedBase: rec.base, lockedQuote: rec.quote });
      }
      const d = decideV2({ t: c.t, nowMs: this.h.nowMs(), cancelOnly, own, slots: x.slots, locked: x.locked, fair: s?.fair ?? null, lo: s?.lo ?? null, hi: s?.hi ?? null, rec, lastSendMs: this.lastSendMs.get(k) ?? null, bc: this.cfg });
      if (d.act === "cancel") {
        const r = await this.send({ to: x.cfg.market, abi: kuruV2OrderBookAbi as Abi, functionName: "cancelAllOrders", args: [x.id], shape: "kuruV2.cancelAll", safety: true, label: `v2 cancel all ${x.cfg.market.slice(0, 10)} (${d.why})` }, x.cfg.market);
        if (r.ok && r.sent) {
          delete this.recs[k];
          this.h.save();
          x.freeBase += x.locked.base;
          x.freeQuote += x.locked.quote;
          x.locked = { base: 0n, quote: 0n };
          x.slots = x.slots.map(() => 0n);
        }
        this.lastSendMs.set(k, this.h.nowMs());
      } else if (d.act === "requote" && c.oneShot) {
        // a one-shot CLI tick places nothing (no process would manage it); the next `run` quotes
        this.h.say("v2_one_shot_no_quotes", { market: x.cfg.market, why: d.why });
      } else if (d.act === "requote" && s && !this.h.budgetOut()) {
        walletD = await this.requote(x, s, rec, d.why, c.t, walletD);
      }
      await this.homeward(x, c);
    }
  }

  /** A final series' tokens leave the V2 account (so the V1 wind-down settles them); withdraw-all (kill on) takes the
   *  tokens and the USDC. Only with no resting orders. */
  private async homeward(x: V2Snap, c: V2TickCtx): Promise<void> {
    if (!x.id || x.slots.some((id) => id !== 0n)) return;
    const final = x.s !== null && x.s.k >= x.s.terms.n;
    if ((final || (c.withdrawAll && c.killed !== null)) && x.freeBase > 0n) {
      if (await this.withdraw(x.id, x.p.base, x.freeBase, x.cfg.market)) {
        if (x.s) x.s.Tw += x.freeBase;
        x.freeBase = 0n;
      }
    }
    if (c.withdrawAll && c.killed !== null && x.freeQuote > 0n) {
      if (await this.withdraw(x.id, x.p.quote, x.freeQuote, x.cfg.market)) x.freeQuote = 0n;
    }
  }

  /** Returns the wallet's dollars left after this book's mint. */
  private async requote(x: V2Snap, s: V2Series, rec: V2Quoted | null, why: string, t: number, walletD0: bigint): Promise<bigint> {
    let walletD = walletD0;
    const p = x.p;
    const fair = s.fair!;
    const band = bandAround(fair, s.lo, s.hi);
    const raw = targetLadder(fair, s.terms.floor, s.terms.cap, this.cfg, band);
    const ob = othersBestV2(x.book, { bids: rec?.bids ?? [], asks: rec?.asks ?? [] });
    const clamped = clampCrossing(raw, { bid: ob.bid === null ? null : fromV2Price(ob.bid, p, "down"), ask: ob.ask === null ? null : fromV2Price(ob.ask, p, "up") }, s.terms.floor, s.terms.cap);
    const maxBase = BigInt(this.cfg.maxBaseTokens) * U;
    const hold = x.freeBase + x.locked.base;
    let orders = v2Orders(hold >= maxBase ? { bids: [], asks: clamped.asks } : clamped, p);
    if (hold >= maxBase) this.h.say("v2_bids_closed", { market: x.cfg.market, hold, maxBase });
    const step = p.sizePrecision / UNITS_PER_TOKEN > 0n ? p.sizePrecision / UNITS_PER_TOKEN : 1n;

    // tokens for the asks: what the account has (free + what this batch frees), then the wallet, then a mint. The asks
    // are first cut to the account's room under maxBaseTokens; the V1 maker's planTokens then sizes the mint (whole
    // tokens, inside maxPairsTokens and what the wallet's dollars buy at the cap) and the deposit.
    let asks = orders.filter((o) => o.side === V2_SIDE.SELL);
    let bids = orders.filter((o) => o.side === V2_SIDE.BUY);
    let haveBase = x.freeBase + x.locked.base;
    const room = maxBase > hold ? maxBase - hold : 0n;
    asks = fitSide(asks, haveBase + room, (o) => baseAtoms(o.qty, p), p, step);
    const tp = planTokens(
      asks.map((o) => ({ price: 0n, size: baseAtoms(o.qty, p) / LOT })),
      { Tw: s.Tw, Tm: x.freeBase, Tr: x.locked.base, Sh: s.Sh },
      { cap: s.terms.cap, maxPairsBase: BigInt(this.cfg.maxPairsTokens) * U, walletDollars: walletD },
    );
    if (tp.mintQ > 0n && (await this.h.approve(this.h.dollar, s.series, false))) {
      const m = await this.send({ to: s.series, abi: agateSeriesAbi as Abi, functionName: "mint", args: [tp.mintQ, this.h.maker], shape: "series.mint", safety: false, label: `v2 mint ${tp.mintQ} of ${s.series.slice(0, 10)}` }, x.cfg.market);
      if (m.ok && m.sent) {
        s.Tw += tp.mintQ;
        s.Sh += tp.mintQ;
        walletD -= tp.mintCost;
        this.h.hold(s.series); // its shorts and V2 tokens must outlive the month, as V1's mint does (hold)
      }
    }
    const dep = tp.depositT < s.Tw ? tp.depositT : s.Tw;
    if (dep > 0n && (await this.deposit(x.p.base, dep, x.cfg.market, false))) {
      s.Tw -= dep;
      x.freeBase += dep;
      haveBase += dep;
      this.h.hold(s.series);
    }
    asks = fitSide(asks, haveBase, (o) => baseAtoms(o.qty, p), p, step);

    // USDC for the bids: the account's (free + this batch's freed), then the wallet's
    let haveQuote = x.freeQuote + x.locked.quote;
    const needQuote = bids.reduce((a, o) => a + bidReserve(o, p), 0n);
    if (needQuote > haveQuote && x.walletQuote > 0n) {
      const dep = needQuote - haveQuote < x.walletQuote ? needQuote - haveQuote : x.walletQuote;
      if (await this.deposit(p.quote, dep, x.cfg.market, false)) {
        x.walletQuote -= dep;
        x.freeQuote += dep;
        haveQuote += dep;
      }
    }
    bids = fitSide(bids, haveQuote, (o) => bidReserve(o, p), p, step);
    orders = [...bids, ...asks];

    let id = x.id;
    if (!id) id = await this.h.reads.v2RootId(this.cfg.accountCore, this.h.maker);
    const cancel = x.slots.map((oid, slot) => (oid !== 0n ? slot : -1)).filter((slot) => slot >= 0).slice(0, V2_MAX_CANCELS);
    if (!id || (orders.length === 0 && cancel.length === 0)) {
      this.h.say("v2_nothing_to_place", { market: x.cfg.market, why, haveBase, haveQuote, account: id });
      return walletD;
    }
    const native = orders.map((o) => ({ side: o.side, quantity: o.qty, price: Number(o.price), tif: V2_TIF.GTC, executionInstruction: V2_EXEC.POST_ONLY, minSizeAfterBlock: 0 }));
    const r = await this.send({ to: x.cfg.market, abi: kuruV2OrderBookAbi as Abi, functionName: "batch", args: [id, native, cancel], shape: "kuruV2.batch", adds: orders.length, cancels: cancel.length, safety: false, label: `v2 requote ${x.cfg.market.slice(0, 10)} (${why})` }, x.cfg.market);
    this.lastSendMs.set(lc(x.cfg.market), this.h.nowMs());
    if (r.ok && r.sent) {
      this.recs[lc(x.cfg.market)] = { fair, lo: band.lo, hi: band.hi, at: t, ids: null, base: null, quote: null, bids: bids.map((o) => [o.price, o.qty]), asks: asks.map((o) => [o.price, o.qty]) };
      this.h.save();
      appendLine(join(this.h.dir, "quotes.jsonl"), { t, venue: "kuru-v2", market: x.cfg.market, series: s.series, fair, ...(band.lo !== fair || band.hi !== fair ? band : {}), why, cancelled: cancel.length, bids: bids.map((o) => [o.price, o.qty]), asks: asks.map((o) => [o.price, o.qty]), tx: r.txHash });
    }
    return walletD;
  }
}

/** Reads the V2 desk needs present (the fake chain of the tests may not have them). */
export function hasV2Reads(r: unknown): r is V2Reads {
  const x = r as Partial<V2Reads>;
  return typeof x.v2Params === "function" && typeof x.v2Slots === "function" && typeof x.v2RootId === "function";
}
