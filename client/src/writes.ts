// Every user write, as a plain async function taking the client and a viem WalletClient (any signer: an injected
// browser wallet now, a login provider's wallet later). Each transaction is simulated first (eth_call from the
// user), then sent with an explicit gas limit of 1.2 x the chain's own eth_estimateGas (Monad bills the gas LIMIT, so
// a limit is always set, and a revert would cost all of it: nothing is sent that did not simulate), then its receipt
// is read and its events decoded. Approvals are exact amounts, set only when the allowance is short, to the spender
// that pulls: the router (its flows), the series (minting pairs) or Kuru's margin account (deposits for limit
// orders); never unlimited. Amounts in are decimal strings or bigint base units, never floats.
//
// Price bounds: every market write is bounded before anything is sent and again on chain (the router's minimum out or
// maximum in) by the stricter of (a) the fresh quote less the slippage allowance, (b) the band: a token pays its
// month's value V at the end, and V lies in [(S + (N - k) F) / N, (S + (N - k) C) / N] (F and C the floor and cap, k
// days applied with sum S; [F, C] before the month, S / N once settled), so a buy above the top or a sale below the
// bottom is a sure loss and is refused, and (c) when the app passes the price it showed (maxPrice / minGpuHours for a
// buy, minPrice / minDollars for a sale, maxPrice / maxDollars for a buy-back), that less the slippage allowance: a
// fresh quote worse than it is refused with the new quote attached (WriteError.quote) for the app to confirm.
// Kuru's market buy is not fill-or-kill (what the asks cannot fill comes back), so a minimum out bounds only what
// filled: a buy (buyLong, openLongDaily) may therefore spend no more than the asks priced at or under the band's top
// hold ("ThinBook" names that amount), and its minimum out is met only by a complete fill at those prices.
// A wallet whose tUSD cannot pay a write is refused before its approval ("InsufficientBalance").
//
// A write of several transactions that is refused after some landed throws a WriteError carrying them (txs) and
// saying what moved and how to undo it; an allowance it raised that nothing used is put back first.
import { type Abi, type Address, decodeEventLog, type Hex, type Log, type WalletClient } from "viem";
import { agateDollarAbi, agateFactoryAbi, agateRouterAbi, agateSeriesAbi, agateTokenAbi, kuruMarginAccountAbi, kuruOrderBookAbi } from "./abi.ts";
import { asksUpTo, buyCost, buyFill, decodeL2Book, DepthError, type RawBook, sellProceeds } from "./book.ts";
import { type AgateClient, errorName, type SeriesLive } from "./client.ts";
import type { Gpu } from "./types.ts";
import { type Amount, AmountError, checkBps, iso, KURU_MAX_SIZE, KURU_MIN_SIZE, LOT, minus, parseDollars, parseHours, parsePrice, plus, SIZE_PER_TOKEN, TICK, toNumber6, U, unitsToHours, ZERO_ADDRESS } from "./units.ts";

/** gas limit = ceil(eth_estimateGas x GAS_MARGIN_NUM / GAS_MARGIN_DEN) */
export const GAS_MARGIN_NUM = 12n;
export const GAS_MARGIN_DEN = 10n;
export const DEFAULT_SLIPPAGE_BPS = 100;
/** how long a write waits for a receipt before it reports the hash as sent but not yet seen */
export const RECEIPT_TIMEOUT_MS = 120_000;
/** Kuru turns a quote into whole size units at each level: a buy at exactly the band's top may get up to this many
 *  base units less than dollars / top (5 size units, 0.0005 GPU-hour), which the band check allows */
export const BAND_DUST = 5n * LOT;
export const NOPERMIT = { value: 0n, deadline: 0n, v: 0, r: `0x${"00".repeat(32)}` as Hex, s: `0x${"00".repeat(32)}` as Hex };

/** A trade's quote now, in plain numbers: what a refused write found (WriteError.quote), for the app to show. */
export interface FreshQuote {
  /** GPU-hours the trade would move */
  gpuHours: number;
  /** dollars it would cost (a buy) or pay (a sale) */
  dollars: number;
  /** dollars per GPU-hour on average */
  avgPrice: number;
}

export class WriteError extends Error {
  override name = "WriteError";
  /** every transaction this write had landed before it stopped (empty: nothing was sent) */
  readonly txs: TxSummary[];
  /** the fresh quote, when the write was refused for its price (stage "check") */
  readonly quote: FreshQuote | undefined;
  constructor(
    message: string,
    readonly stage: "check" | "simulate" | "estimate" | "send" | "receipt",
    readonly reason?: string,
    readonly hash?: Hex,
    extra: { txs?: TxSummary[]; quote?: FreshQuote } = {},
  ) {
    super(message);
    this.txs = extra.txs ?? [];
    this.quote = extra.quote;
  }
}

export interface DecodedEvent {
  name: string;
  address: string;
  args: Record<string, unknown>;
}
/** One landed transaction. */
export interface TxSummary {
  label: string;
  hash: Hex;
  to: Address;
  gasLimit: bigint;
  gasUsed: bigint;
  block: bigint;
  events: DecodedEvent[];
}
/** A write's outcome: every transaction it sent (approvals and deposits first, the main one last) and what it did,
 *  in plain dollars and GPU-hours. */
export interface WriteResult<T> {
  hash: Hex;
  txs: TxSummary[];
  result: T;
}

const ALL_EVENTS = [...agateSeriesAbi, ...agateRouterAbi, ...agateDollarAbi, ...agateFactoryAbi, ...kuruOrderBookAbi, ...kuruMarginAccountAbi].filter((e) => e.type === "event") as Abi;

export function decodeLogs(logs: readonly Log[]): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  for (const l of logs) {
    try {
      const d = decodeEventLog({ abi: ALL_EVENTS, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as unknown as { eventName: string; args: Record<string, unknown> };
      out.push({ name: d.eventName, address: l.address.toLowerCase(), args: d.args });
    } catch {
      // an event of a contract we do not decode
    }
  }
  return out;
}

interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  label: string;
}

function accountOf(w: WalletClient): Address {
  const a = w.account;
  if (!a) throw new WriteError("the wallet client has no account", "check");
  return a.address;
}

async function checkChain(c: AgateClient, w: WalletClient): Promise<void> {
  const id = await w.getChainId();
  if (id !== c.chain.id) throw new WriteError(`the wallet is on chain ${id}, the market is on chain ${c.chain.id}: switch networks first`, "check");
}

export const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Simulate, estimate, send with gas = 1.2 x estimate, wait, decode. `landed` are the transactions the same write sent
 *  before this one (only for the error message: "nothing was sent" is said only when there are none). */
export async function send(c: AgateClient, w: WalletClient, call: Call, landed: readonly TxSummary[] = []): Promise<TxSummary> {
  const account = w.account;
  if (!account) throw new WriteError("the wallet client has no account", "check");
  const notSent = landed.length ? "this transaction was not sent" : "nothing was sent";
  const req = { account, address: call.address, abi: call.abi, functionName: call.functionName, args: call.args } as never;
  try {
    await c.pub.simulateContract(req);
  } catch (e) {
    const why = errorName(e);
    throw new WriteError(`${call.label}: the simulation reverted (${why}); ${notSent}`, "simulate", why);
  }
  let est: bigint;
  try {
    est = await c.pub.estimateContractGas(req);
  } catch (e) {
    const why = errorName(e);
    throw new WriteError(`${call.label}: eth_estimateGas failed (${why}); ${notSent}`, "estimate", why);
  }
  const gas = (est * GAS_MARGIN_NUM + GAS_MARGIN_DEN - 1n) / GAS_MARGIN_DEN;
  let hash: Hex;
  try {
    hash = await w.writeContract({ ...(req as object), chain: w.chain ?? c.chain, gas } as never);
  } catch (e) {
    throw new WriteError(`${call.label}: the wallet did not send (${errorName(e)})`, "send", errorName(e));
  }
  let rc: Awaited<ReturnType<AgateClient["pub"]["waitForTransactionReceipt"]>>;
  try {
    rc = await c.pub.waitForTransactionReceipt({ hash, pollingInterval: 500, timeout: RECEIPT_TIMEOUT_MS });
  } catch (e) {
    // sent, not seen yet: the app must look the hash up before it offers to send again
    throw new WriteError(`${call.label}: sent as ${hash}, but no receipt within ${RECEIPT_TIMEOUT_MS / 1000} s (${errorName(e)}); it may still land: look it up before sending again`, "receipt", "NoReceipt", hash);
  }
  if (rc.status !== "success") throw new WriteError(`${call.label} reverted onchain (${hash})`, "receipt", "reverted", hash);
  return { label: call.label, hash, to: call.address, gasLimit: gas, gasUsed: rc.gasUsed, block: rc.blockNumber, events: decodeLogs(rc.logs) };
}

/** What one write has done so far: its landed transactions and the allowances it raised. */
class Sent {
  txs: TxSummary[] = [];
  raised: { token: Address; spender: Address; before: bigint; label: string }[] = [];
  async send(c: AgateClient, w: WalletClient, call: Call): Promise<TxSummary> {
    const t = await send(c, w, call, this.txs);
    this.txs.push(t);
    return t;
  }
}

/** Runs a write of one or more transactions. When a step is refused (or reverts) after earlier ones landed, puts back
 *  every allowance the write raised that nothing used (unless the wallet itself declined to send, so no new prompt
 *  follows a "no", or a receipt did not come, so the outcome is unknown), and throws a WriteError carrying every
 *  landed transaction, what moved and how to undo it (`undo`). */
async function guarded<T>(c: AgateClient, w: WalletClient, undo: (s: Sent) => string, body: (s: Sent) => Promise<T>): Promise<T> {
  const s = new Sent();
  try {
    return await body(s);
  } catch (e) {
    if (s.txs.length === 0) throw e;
    const we = e instanceof WriteError ? e : null;
    const stage = we?.stage ?? "receipt";
    const notes: string[] = [];
    const me = accountOf(w);
    for (const a of s.raised) {
      let cur: bigint;
      try {
        cur = (await c.pub.readContract({ address: a.token, abi: agateTokenAbi as Abi, functionName: "allowance", args: [me, a.spender] })) as bigint;
      } catch {
        continue;
      }
      if (cur <= a.before) continue; // used up by a later step
      // the wallet declined (no new prompt after a "no"), or the last transaction's outcome is unknown (it may still
      // land and use the allowance; a put-back would queue behind it): say so instead
      if (stage === "send" || we?.reason === "NoReceipt") {
        notes.push(`The allowance of step "${a.label}" stays at ${toNumber6(cur)} for now (the spender pulls only in your own calls): approve it back to ${toNumber6(a.before)} to clear it once nothing is pending`);
        continue;
      }
      try {
        await s.send(c, w, { address: a.token, abi: agateTokenAbi as Abi, functionName: "approve", args: [a.spender, a.before], label: `put back: ${a.label}` });
        notes.push(`The unused allowance of step "${a.label}" was put back to ${toNumber6(a.before)}`);
      } catch (x) {
        notes.push(`The unused allowance of step "${a.label}" stays at ${toNumber6(cur)} (putting it back failed: ${(x as Error).message})`);
      }
    }
    const landed = s.txs.map((t) => `${t.label} (${t.hash})`).join(", ");
    const u = undo(s);
    const msg = `${(e as Error).message}. Already landed: ${landed}.${u ? ` ${u}.` : ""}${notes.length ? ` ${notes.join(". ")}.` : ""}`;
    throw new WriteError(msg, stage, we?.reason ?? (e as Error).name, we?.hash, { txs: [...s.txs], ...(we?.quote ? { quote: we.quote } : {}) });
  }
}

/** Sets an exact allowance when the current one is below `amount` (and records it, to put back if a later step is
 *  refused). */
async function ensureAllowance(c: AgateClient, w: WalletClient, token: Address, spender: Address, amount: bigint, label: string, s: Sent): Promise<void> {
  if (amount === 0n) return;
  const owner = accountOf(w);
  const cur = (await c.pub.readContract({ address: token, abi: agateTokenAbi as Abi, functionName: "allowance", args: [owner, spender] })) as bigint;
  if (cur >= amount) return;
  await s.send(c, w, { address: token, abi: agateTokenAbi as Abi, functionName: "approve", args: [spender, amount], label });
  s.raised.push({ token, spender, before: cur, label });
}

function ev(txs: TxSummary[], name: string): DecodedEvent[] {
  return txs.flatMap((t) => t.events.filter((e) => e.name === name));
}

/** @internal Shared with plan.ts; not part of the app API (it may change). */
export async function live(c: AgateClient, gpu: Gpu, month: string): Promise<SeriesLive & { market: Address }> {
  const s = await c.seriesAt(gpu, month);
  if (!s.market) throw new WriteError(`${gpu} ${month} has no Kuru market yet`, "check");
  return s as SeriesLive & { market: Address };
}

/** What `dollars` (u) would buy now: Kuru's own simulation from address 0 (MS 6.5), base units. */
export async function simulateBuy(c: AgateClient, market: Address, dollars: bigint): Promise<bigint> {
  const r = await c.pub.simulateContract({ account: ZERO_ADDRESS, address: market, abi: kuruOrderBookAbi, functionName: "placeAndExecuteMarketBuy", args: [dollars, 1n, false, false] } as never);
  return BigInt(r.result as bigint);
}
/** What selling `tokens` (base units) would pay now: Kuru's own simulation from address 0, u. */
export async function simulateSell(c: AgateClient, market: Address, tokens: bigint): Promise<bigint> {
  const r = await c.pub.simulateContract({ account: ZERO_ADDRESS, address: market, abi: kuruOrderBookAbi, functionName: "placeAndExecuteMarketSell", args: [tokens / LOT, 1n, false, false] } as never);
  return BigInt(r.result as bigint);
}

/** The smallest quote (u) that buys at least `tokens` now: the book's exact cost, checked and raised by Kuru's
 *  simulation (one size unit's cost at a time) until it buys enough. */
export async function quoteExactOut(c: AgateClient, s: SeriesLive & { market: Address }, tokens: bigint): Promise<bigint> {
  if (!s.book) throw new WriteError("the book could not be read", "check");
  let q: bigint;
  try {
    q = buyCost(s.book.asks, tokens).dollars;
  } catch (e) {
    if (e instanceof DepthError) throw new WriteError(e.message, "check", "Depth");
    throw e;
  }
  const top = s.book.asks[s.book.asks.length - 1]?.[0] ?? 0n;
  for (let i = 0; i < 20; i++) {
    if ((await simulateBuy(c, s.market, q)) >= tokens) return q;
    q += (top + SIZE_PER_TOKEN - 1n) / SIZE_PER_TOKEN;
  }
  throw new WriteError("could not find a quote that buys the size: the book moved", "check");
}

/** The range a month token's final value lies in now, per GPU-hour, as numerators over N (u): every day not applied
 *  yet adds between F and C to the sum S. */
export function band(s: SeriesLive): { loNum: bigint; hiNum: bigint; n: bigint; lo: number; hi: number } {
  const n = BigInt(s.terms.n);
  const left = n - BigInt(Math.min(s.k, s.terms.n));
  const loNum = s.S + left * s.terms.floor;
  const hiNum = s.S + left * s.terms.cap;
  return { loNum, hiNum, n, lo: toNumber6(loNum / n), hi: toNumber6(hiNum / n) };
}

const quoteOf = (tokens: bigint, dollars: bigint): FreshQuote => ({ gpuHours: toNumber6(tokens), dollars: toNumber6(dollars), avgPrice: tokens > 0n ? toNumber6((dollars * U) / tokens) : 0 });
const pctOf = (bps: number) => `${bps / 100}%`;

/** A buy's price guard (the app's shown price, optional): maxPrice (dollars per GPU-hour on average) or minGpuHours. */
export interface BuyGuard {
  maxPrice?: Amount;
  minGpuHours?: Amount;
  slippageBps?: number;
}
/** A sale's price guard (optional): minPrice (dollars per GPU-hour on average) or minDollars. */
export interface SellGuard {
  minPrice?: Amount;
  minDollars?: Amount;
  slippageBps?: number;
}
/** A buy-back's price guard (optional): maxPrice (dollars per GPU-hour on average) or maxDollars. */
export interface BuyBackGuard {
  maxPrice?: Amount;
  maxDollars?: Amount;
  slippageBps?: number;
}

function positive(v: bigint, what: string): bigint {
  if (v === 0n) throw new AmountError(`${what} must be above 0`);
  return v;
}

/** Kuru's taker fee in bps, taken from a market buy's tokens (OrderBook `_marketBuyMatch`): the factory's own, the same
 *  for every market of it (AgateFactory makes markets with its fees and refuses to record one with others). Read once
 *  per client. */
const TAKER_FEES = new WeakMap<object, Promise<bigint>>();
export function takerFeeBps(c: AgateClient): Promise<bigint> {
  let p = TAKER_FEES.get(c);
  if (!p) {
    p = (c.pub.readContract({ address: c.factory, abi: agateFactoryAbi as Abi, functionName: "takerFeeBps" }) as Promise<unknown>).then((v) => BigInt(v as bigint));
    TAKER_FEES.set(c, p);
    p.catch(() => TAKER_FEES.delete(c));
  }
  return p;
}

/** A market buy of `dollars` into `asks` as Kuru fills it, its taker fee taken: the tokens and the dollars it uses. */
function fillAfterFee(asks: [bigint, bigint][], dollars: bigint, fee: bigint): { tokens: bigint; spent: bigint } {
  const f = buyFill(asks, dollars);
  return { tokens: fee > 0n ? f.tokens - ceilDiv(f.tokens * fee, 10_000n) : f.tokens, spent: f.spent };
}

/** The book's answer to a buy of `dollars`, before anything is sent. Kuru's market buy is not fill-or-kill: what the
 *  asks cannot fill is returned, and the router's minimum out then bounds only the part that filled. So a buy may
 *  spend only what the asks priced at or under the band's top hold: beyond that the rest would meet whatever asks
 *  stand (or are posted) above, at any price, while the average still looked fine. Refused: no ask at or under the
 *  top ("AboveBand"), or more dollars than those asks hold ("ThinBook": buy at most what they hold). Otherwise the
 *  buy fills completely at those prices: the tokens and dollars of that fill (the walk of Kuru's own rounding). */
function planBuy(s: SeriesLive, asks: [bigint, bigint][], dollars: bigint, fee: bigint): { tokens: bigint; spent: bigint } {
  if (asks.length === 0) throw new WriteError("the asks are empty: nothing to buy; nothing was sent", "check", "EmptyBook");
  const b = band(s);
  const fair = asksUpTo(asks, b.hiNum, b.n);
  if (fair.levels.length === 0) {
    const all = fillAfterFee(asks, dollars, fee);
    const quote = quoteOf(all.tokens, all.spent);
    throw new WriteError(`the best ask is $${toNumber6(asks[0]![0])} (a buy of $${toNumber6(dollars)} would average $${quote.avgPrice} per GPU-hour), above $${b.hi}, the most a ${s.terms.symbol} token can pay at the month's end (a sure loss); nothing was sent`, "check", "AboveBand", undefined, { quote });
  }
  if (dollars > fair.dollars) {
    const can = fillAfterFee(fair.levels, fair.dollars, fee);
    const quote = quoteOf(can.tokens, can.spent);
    throw new WriteError(`the asks at or under $${b.hi} (the most a ${s.terms.symbol} token can pay at the month's end) hold only $${quote.dollars} (${quote.gpuHours} GPU-hours): the rest of a $${toNumber6(dollars)} buy would meet whatever asks stand above them, at any price; buy at most $${quote.dollars}; nothing was sent`, "check", "ThinBook", undefined, { quote });
  }
  return fillAfterFee(fair.levels, dollars, fee);
}

/** The book of a month read now (getL2Book, every level). */
async function readBook(c: AgateClient, market: Address): Promise<RawBook> {
  return decodeL2Book((await c.pub.readContract({ address: market, abi: kuruOrderBookAbi as Abi, functionName: "getL2Book", args: [] } as never)) as Hex);
}

/** The fewest tokens a buy of `dollars` may return (the router's minTokensOut), checked before anything is sent:
 *  the buy must fit the asks at or under the band's top (planBuy), Kuru's own simulation must agree with that fill
 *  (when the book moved since it was read, it is read again once), and the minimum out is the larger of that fill and
 *  the simulation less slippage, never under dollars / the band's top (a sure loss) nor under the app's shown quote
 *  less slippage. A minimum out met only by a complete fill at those prices is what bounds the whole spend.
 *  @internal Shared with plan.ts; not part of the app API (it may change). */
export async function buyBound(c: AgateClient, s: SeriesLive & { market: Address }, dollars: bigint, g: BuyGuard): Promise<bigint> {
  const slip = g.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  checkBps(slip);
  const shown = g.minGpuHours !== undefined ? positive(parseHours(g.minGpuHours, "minGpuHours"), "minGpuHours") : g.maxPrice !== undefined ? ceilDiv(dollars * U, positive(parseDollars(g.maxPrice, "maxPrice"), "maxPrice")) : null;
  const fee = await takerFeeBps(c);
  const planOf = (book: RawBook) => {
    const p = planBuy(s, book.asks, dollars, fee);
    if (p.tokens === 0n) throw new WriteError(`$${toNumber6(dollars)} buys less than 0.0001 GPU-hour (one Kuru size unit): the size is too small to buy; nothing was sent`, "check");
    return p;
  };
  let plan = planOf(s.book ?? (await readBook(c, s.market)));
  let fresh = await simulateBuy(c, s.market, dollars);
  if (fresh < minus(plan.tokens, slip)) {
    // Kuru's simulation fills less than the book read a moment before: the book moved. Read it again, with a new
    // simulation beside it, and plan on that (a book that thinned meanwhile is refused as above)
    const [again, sim] = await Promise.all([readBook(c, s.market), simulateBuy(c, s.market, dollars)]);
    plan = planOf(again);
    fresh = sim;
    if (fresh < minus(plan.tokens, slip)) throw new WriteError(`the book is moving: Kuru's simulation buys ${toNumber6(fresh)} GPU-hours for $${toNumber6(dollars)}, the asks read beside it ${toNumber6(plan.tokens)}; nothing was sent: quote again`, "check", "PriceMoved", undefined, { quote: quoteOf(fresh, dollars) });
  }
  // a complete fill (plan.spent = dollars): the quote is what the dollars buy now
  const quote = quoteOf(fresh, plan.spent);
  let minOut = minus(fresh > plan.tokens ? fresh : plan.tokens, slip);
  const b = band(s);
  const exact = (dollars * U * b.n) / b.hiNum;
  const bandMin = exact > BAND_DUST ? exact - BAND_DUST : 0n;
  if (bandMin > minOut) minOut = bandMin;
  if (shown !== null) {
    const least = minus(shown, slip);
    if (fresh < least) throw new WriteError(`the price moved: $${toNumber6(dollars)} now buys ${quote.gpuHours} GPU-hours ($${quote.avgPrice} each), worse than shown by more than ${pctOf(slip)}; nothing was sent: confirm the new quote`, "check", "PriceMoved", undefined, { quote });
    if (least > minOut) minOut = least;
  }
  // only when the book moved between the read and the simulation to asks averaging above the top
  if (fresh < minOut) throw new WriteError(`the asks would cost $${quote.avgPrice} per GPU-hour on average, above $${b.hi}, the most a ${s.terms.symbol} token can pay at the month's end (a sure loss); nothing was sent`, "check", "AboveBand", undefined, { quote });
  return minOut;
}

/** The least a fill-or-kill sale of `tokens` may pay (the router's minDollarsOut), checked before anything is sent:
 *  the exact proceeds of the bids now less slippage, never under tokens x the band's bottom (a sure loss) nor under
 *  the app's shown proceeds less slippage.
 *  @internal Shared with plan.ts; not part of the app API (it may change). */
export function sellBound(s: SeriesLive, tokens: bigint, g: SellGuard): bigint {
  const slip = g.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  checkBps(slip);
  const fresh = proceeds(s, tokens);
  const quote = quoteOf(tokens, fresh);
  const b = band(s);
  const bandMin = (tokens * b.loNum) / (b.n * U);
  if (fresh < bandMin) throw new WriteError(`the bids would pay $${quote.avgPrice} per GPU-hour on average, below $${b.lo}, the least a ${s.terms.symbol} token pays at the month's end (a sure loss); nothing was sent`, "check", "BelowBand", undefined, { quote });
  let minOut = minus(fresh, slip);
  if (bandMin > minOut) minOut = bandMin;
  const shown = g.minDollars !== undefined ? positive(parseDollars(g.minDollars, "minDollars"), "minDollars") : g.minPrice !== undefined ? ceilDiv(tokens * positive(parseDollars(g.minPrice, "minPrice"), "minPrice"), U) : null;
  if (shown !== null) {
    const least = minus(shown, slip);
    if (fresh < least) throw new WriteError(`the price moved: ${toNumber6(tokens)} GPU-hours now sell for $${quote.dollars} ($${quote.avgPrice} each), worse than shown by more than ${pctOf(slip)}; nothing was sent: confirm the new quote`, "check", "PriceMoved", undefined, { quote });
    if (least > minOut) minOut = least;
  }
  if (minOut === 0n) throw new WriteError("the sale would pay nothing", "check");
  return minOut;
}

/** The most a buy-back of exactly `q` tokens may spend (the router's dollarsIn): the smallest quote that buys q now
 *  plus slippage, never over q x the band's top (a sure loss against holding the short) nor over the app's shown
 *  cost plus slippage.
 *  @internal Shared with plan.ts; not part of the app API (it may change). */
export async function buyBackBound(c: AgateClient, s: SeriesLive & { market: Address }, q: bigint, g: BuyBackGuard): Promise<bigint> {
  const slip = g.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  checkBps(slip);
  const fresh = await quoteExactOut(c, s, q);
  const quote = quoteOf(q, fresh);
  const b = band(s);
  // q x top, plus one size unit's cost per level Kuru may round away
  const bandMax = ceilDiv(q * b.hiNum, b.n * U) + 3n * ceilDiv(b.hiNum, b.n * SIZE_PER_TOKEN);
  if (fresh > bandMax) throw new WriteError(`buying back ${toNumber6(q)} GPU-hours would cost $${quote.avgPrice} each, above $${b.hi}, the most a ${s.terms.symbol} token can pay at the month's end: holding the short pays more; nothing was sent`, "check", "AboveBand", undefined, { quote });
  let maxIn = plus(fresh, slip);
  if (maxIn > bandMax) maxIn = bandMax;
  const shown = g.maxDollars !== undefined ? positive(parseDollars(g.maxDollars, "maxDollars"), "maxDollars") : g.maxPrice !== undefined ? ceilDiv(q * positive(parseDollars(g.maxPrice, "maxPrice"), "maxPrice"), U) : null;
  if (shown !== null) {
    const most = plus(shown, slip);
    if (fresh > most) throw new WriteError(`the price moved: buying back ${toNumber6(q)} GPU-hours now costs $${quote.dollars} ($${quote.avgPrice} each), worse than shown by more than ${pctOf(slip)}; nothing was sent: confirm the new quote`, "check", "PriceMoved", undefined, { quote });
    if (most < maxIn) maxIn = most;
  }
  return maxIn;
}

/** Refuses a write the wallet's tUSD cannot pay, before its approval (otherwise the approval lands, the main
 *  transaction's simulation reverts, and the approval is put back: two fees for nothing).
 *  @internal Shared with plan.ts; not part of the app API (it may change). */
export async function needDollars(c: AgateClient, me: Address, amount: bigint, what: string): Promise<void> {
  if (amount === 0n) return;
  const have = (await c.pub.readContract({ address: c.dollar, abi: agateTokenAbi as Abi, functionName: "balanceOf", args: [me] })) as bigint;
  if (have < amount) throw new WriteError(`${what} needs $${toNumber6(amount)} and the wallet holds $${toNumber6(have)} tUSD; nothing was sent`, "check", "InsufficientBalance");
}

/** Payees the app refuses (MS 6.2, audit L3): a contract of the system would hold every claim for ever. @internal Shared with plan.ts; not part of the app API (it may change). */
export function checkPayee(c: AgateClient, s: SeriesLive, payee: Address): void {
  const bad = [ZERO_ADDRESS, s.terms.series, s.terms.token, s.market ?? ZERO_ADDRESS, c.factory, c.router, c.deployments.kuru.marginAccount, c.deployments.kuru.router].map((a) => a.toLowerCase());
  if (bad.includes(payee.toLowerCase())) throw new WriteError(`payee ${payee} is a contract of the market and could never spend its claims`, "check");
}

// ------------------------------------------------------------------ the faucet

/** The test dollar's faucet: 10,000 tUSD per address per day (AgateDollar.drip). */
export async function drip(c: AgateClient, w: WalletClient): Promise<WriteResult<{ amount: number; nextDrip: string }>> {
  await checkChain(c, w);
  const me = accountOf(w);
  const nextAt = (await c.pub.readContract({ address: c.dollar, abi: agateDollarAbi as Abi, functionName: "nextDripAt", args: [me] })) as bigint;
  const now = await c.chainTime();
  if (now < nextAt) throw new WriteError(`the next drip opens at ${iso(nextAt)}`, "check", "DripTooSoon");
  const tx = await send(c, w, { address: c.dollar, abi: agateDollarAbi as Abi, functionName: "drip", args: [], label: "drip" });
  const d = ev([tx], "Dripped")[0]?.args as { amount: bigint; nextAt: bigint } | undefined;
  return { hash: tx.hash, txs: [tx], result: { amount: d ? toNumber6(d.amount) : 0, nextDrip: d ? iso(d.nextAt) : "" } };
}

/** Sets the wallet's allowance of `token` to `spender` back to 0 (an allowance a refused write could not put back). */
export async function resetAllowance(c: AgateClient, w: WalletClient, p: { token: Address; spender: Address }): Promise<WriteResult<{ allowance: number }>> {
  await checkChain(c, w);
  const tx = await send(c, w, { address: p.token, abi: agateTokenAbi as Abi, functionName: "approve", args: [p.spender, 0n], label: "reset allowance" });
  return { hash: tx.hash, txs: [tx], result: { allowance: 0 } };
}

// ------------------------------------------------------------------ Long

export interface RoutedResult {
  gpuHours: number;
  spent: number;
  received: number;
  refund: number;
  /** dollars per GPU-hour over the fills, 0 when nothing filled */
  avgPrice: number;
  positionIds: string[];
}

function routed(txs: TxSummary[], c: AgateClient): { tokens: bigint; dollarsIn: bigint; dollarsOut: bigint; refund: bigint; tokensIn: bigint; tokensOut: bigint; positionIds: bigint[] } {
  const r = ev(txs, "Routed").find((e) => e.address === c.router.toLowerCase());
  if (!r) throw new WriteError("the router emitted no Routed event", "receipt");
  return r.args as never;
}

const ROUTER_UNDO = "Nothing else moved";

/** Long: buy the month's token through the router (openLong). `dollars` is the most it spends; the least it accepts
 *  is bounded as the header says (fresh simulation, the band, the shown price). */
export async function buyLong(c: AgateClient, w: WalletClient, p: { gpu: Gpu; month: string; dollars: Amount } & BuyGuard): Promise<WriteResult<RoutedResult>> {
  await checkChain(c, w);
  const s = await live(c, p.gpu, p.month);
  const dollars = parseDollars(p.dollars);
  if (dollars === 0n) throw new AmountError("dollars must be above 0");
  const minOut = await buyBound(c, s, dollars, p);
  await needDollars(c, accountOf(w), dollars, "this buy");
  return guarded(c, w, () => ROUTER_UNDO, async (st) => {
    await ensureAllowance(c, w, c.dollar, c.router, dollars, "approve tUSD to the router", st);
    await st.send(c, w, { address: c.router, abi: agateRouterAbi as Abi, functionName: "openLong", args: [s.terms.series, dollars, minOut, NOPERMIT], label: "openLong" });
    const r = routed(st.txs, c);
    const spent = r.dollarsIn - r.refund;
    return { hash: st.txs[st.txs.length - 1]!.hash, txs: st.txs, result: { gpuHours: toNumber6(r.tokensOut), spent: toNumber6(spent), received: 0, refund: toNumber6(r.refund), avgPrice: r.tokensOut > 0n ? toNumber6((spent * U) / r.tokensOut) : 0, positionIds: [] } };
  });
}

/** Sell held tokens through the router (closeLong): fill-or-kill on the bids, the least it accepts bounded as the
 *  header says (the exact proceeds now, the band, the shown price). */
export async function sellLong(c: AgateClient, w: WalletClient, p: { gpu: Gpu; month: string; gpuHours: Amount } & SellGuard): Promise<WriteResult<RoutedResult>> {
  await checkChain(c, w);
  const s = await live(c, p.gpu, p.month);
  const tokens = parseHours(p.gpuHours);
  if (tokens === 0n) throw new AmountError("GPU-hours must be above 0");
  const held = (await c.pub.readContract({ address: s.terms.token, abi: agateTokenAbi as Abi, functionName: "balanceOf", args: [accountOf(w)] })) as bigint;
  if (held < tokens) throw new WriteError(`you hold ${toNumber6(held)} GPU-hours of ${s.terms.symbol} in the wallet${await marginNote(c, accountOf(w), s.terms.token)}`, "check");
  const minOut = sellBound(s, tokens, p);
  return guarded(c, w, () => ROUTER_UNDO, async (st) => {
    await ensureAllowance(c, w, s.terms.token, c.router, tokens, `approve ${s.terms.symbol} to the router`, st);
    await st.send(c, w, { address: c.router, abi: agateRouterAbi as Abi, functionName: "closeLong", args: [s.terms.series, tokens, minOut, NOPERMIT], label: "closeLong" });
    const r = routed(st.txs, c);
    return { hash: st.txs[st.txs.length - 1]!.hash, txs: st.txs, result: { gpuHours: toNumber6(r.tokensIn), spent: 0, received: toNumber6(r.dollarsOut), refund: 0, avgPrice: toNumber6((r.dollarsOut * U) / r.tokensIn), positionIds: [] } };
  });
}

/** ", and N in Kuru's margin account (withdrawMargin first)" when the margin account holds some of the token. */
async function marginNote(c: AgateClient, me: Address, token: Address): Promise<string> {
  const m = (await c.pub.readContract({ address: c.marginAccount, abi: kuruMarginAccountAbi as Abi, functionName: "getBalance", args: [me, token] })) as bigint;
  return m > 0n ? `, and ${toNumber6(m)} in Kuru's margin account (withdrawMargin first)` : "";
}

function proceeds(s: SeriesLive, tokens: bigint): bigint {
  if (!s.book) throw new WriteError("the book could not be read", "check");
  try {
    return sellProceeds(s.book.bids, tokens).dollars;
  } catch (e) {
    if (e instanceof DepthError) throw new WriteError(e.message, "check", "Depth");
    throw e;
  }
}

/** Long, pay me daily (openLongDaily): buys like buyLong, then turns the tokens into `parts` daily positions owned
 *  by the user (the floor for every remaining day is paid at once, the rest each day to `payee`). */
export async function openLongDaily(c: AgateClient, w: WalletClient, p: { gpu: Gpu; month: string; dollars: Amount; parts?: number; payee?: Address } & BuyGuard): Promise<WriteResult<RoutedResult & { paidNow: number; restTokens: number }>> {
  await checkChain(c, w);
  const s = await live(c, p.gpu, p.month);
  const me = accountOf(w);
  const payee = p.payee ?? me;
  checkPayee(c, s, payee);
  const parts = BigInt(p.parts ?? 1);
  if (parts < 1n) throw new AmountError("parts must be at least 1");
  const dollars = parseDollars(p.dollars);
  if (dollars === 0n) throw new AmountError("dollars must be above 0");
  const minOut = await buyBound(c, s, dollars, p);
  if (minOut / parts / LOT === 0n) throw new WriteError("the size is too small for that many parts", "check");
  await needDollars(c, me, dollars, "this buy");
  return guarded(c, w, () => ROUTER_UNDO, async (st) => {
    await ensureAllowance(c, w, c.dollar, c.router, dollars, "approve tUSD to the router", st);
    await st.send(c, w, { address: c.router, abi: agateRouterAbi as Abi, functionName: "openLongDaily", args: [s.terms.series, dollars, minOut, parts, payee, NOPERMIT], label: "openLongDaily" });
    const r = routed(st.txs, c);
    const opened = ev(st.txs, "PositionOpened");
    const paidNow = opened.reduce((a, e) => a + (e.args.paidNow as bigint), 0n);
    const spent = r.dollarsIn - r.refund;
    return {
      hash: st.txs[st.txs.length - 1]!.hash,
      txs: st.txs,
      result: { gpuHours: toNumber6(r.tokens), spent: toNumber6(spent), received: toNumber6(paidNow), refund: toNumber6(r.refund), avgPrice: r.tokens > 0n ? toNumber6((spent * U) / r.tokens) : 0, positionIds: r.positionIds.map(String), paidNow: toNumber6(paidNow), restTokens: toNumber6(r.tokensOut) },
    };
  });
}

/** Exit pay-me-daily long positions early (closeLongDaily): the router mints the pairs that close them (cost q x C,
 *  approved exactly), sells the q tokens fill-or-kill on the bids (bounded like sellLong), and the series pays the
 *  positions' remaining value to the owner. */
export async function closeLongDaily(c: AgateClient, w: WalletClient, p: { gpu: Gpu; month: string; positionIds: (string | bigint)[] } & SellGuard): Promise<WriteResult<{ cost: number; received: number; paid: number }>> {
  await checkChain(c, w);
  const s = await live(c, p.gpu, p.month);
  const ids = p.positionIds.map((x) => BigInt(x));
  const q = await ownPositions(c, s, ids, accountOf(w), 0);
  const cost = (q * s.terms.cap + U - 1n) / U;
  const minOut = sellBound(s, q, p);
  await needDollars(c, accountOf(w), cost, `closing early (the router mints ${toNumber6(q)} pairs at $${toNumber6(s.terms.cap)}, most of it paid back in the same transaction)`);
  return guarded(c, w, () => ROUTER_UNDO, async (st) => {
    await ensureAllowance(c, w, c.dollar, c.router, cost, "approve tUSD to the router", st);
    await st.send(c, w, { address: c.router, abi: agateRouterAbi as Abi, functionName: "closeLongDaily", args: [s.terms.series, ids, minOut, NOPERMIT], label: "closeLongDaily" });
    const r = routed(st.txs, c);
    const paid = ev(st.txs, "PositionClosed").reduce((a, e) => a + (e.args.amount as bigint), 0n);
    return { hash: st.txs[st.txs.length - 1]!.hash, txs: st.txs, result: { cost: toNumber6(r.dollarsIn), received: toNumber6(r.dollarsOut - paid), paid: toNumber6(paid) } };
  });
}

/** The positions' total q after checking each is the user's, on `side` (0 long, 1 short), opened through the router
 *  (its operator), as the router requires.
 *  @internal Shared with plan.ts; not part of the app API (it may change). */
export async function ownPositions(c: AgateClient, s: SeriesLive, ids: bigint[], me: Address, side: 0 | 1): Promise<bigint> {
  if (ids.length === 0) throw new WriteError("no positions given", "check");
  const r = await c.mc(ids.map((id) => ({ address: s.terms.series, abi: agateSeriesAbi as Abi, functionName: "position", args: [id] })));
  let q = 0n;
  r.forEach((x, i) => {
    if (!x.ok) throw new WriteError(`position ${ids[i]} could not be read`, "check");
    const pos = x.value as { owner: Address; side: number; q: bigint; operator: Address };
    if (pos.owner.toLowerCase() !== me.toLowerCase()) throw new WriteError(`position ${ids[i]} is not yours`, "check");
    if (Number(pos.side) !== side) throw new WriteError(`position ${ids[i]} is a ${Number(pos.side) === 0 ? "long" : "short"}`, "check");
    if (pos.operator.toLowerCase() !== c.router.toLowerCase()) throw new WriteError(`position ${ids[i]} was not opened through the router: close it with the series directly`, "check");
    q += BigInt(pos.q);
  });
  return q;
}

// ------------------------------------------------------------------ Short

/** Short (openShort): the router mints `gpuHours` pairs (cost gpuHours x C, approved exactly), sells the tokens
 *  fill-or-kill on the bids (bounded like sellLong) and opens `parts` short positions for the user, paid daily when
 *  `daily` (default true). */
export async function openShort(c: AgateClient, w: WalletClient, p: { gpu: Gpu; month: string; gpuHours: Amount; parts?: number; daily?: boolean; payee?: Address } & SellGuard): Promise<WriteResult<RoutedResult & { cost: number }>> {
  await checkChain(c, w);
  const s = await live(c, p.gpu, p.month);
  const me = accountOf(w);
  const payee = p.payee ?? me;
  checkPayee(c, s, payee);
  const tokens = parseHours(p.gpuHours);
  const parts = BigInt(p.parts ?? 1);
  if (tokens === 0n || parts < 1n || tokens % parts !== 0n || (tokens / parts) % LOT !== 0n) throw new AmountError("GPU-hours must split into equal parts of whole 0.0001 GPU-hours");
  const cost = (tokens * s.terms.cap + U - 1n) / U;
  const minOut = sellBound(s, tokens, p);
  await needDollars(c, me, cost, `a short of ${toNumber6(tokens)} GPU-hours (the pairs' collateral, $${toNumber6(s.terms.cap)} each, the sale paid back in the same transaction)`);
  return guarded(c, w, () => ROUTER_UNDO, async (st) => {
    await ensureAllowance(c, w, c.dollar, c.router, cost, "approve tUSD to the router", st);
    await st.send(c, w, { address: c.router, abi: agateRouterAbi as Abi, functionName: "openShort", args: [s.terms.series, tokens, minOut, parts, payee, p.daily ?? true, NOPERMIT], label: "openShort" });
    const r = routed(st.txs, c);
    // Routed.dollarsOut is the sale plus what the positions were paid at once (0 before the month starts)
    const paidNow = ev(st.txs, "PositionOpened").reduce((a, e) => a + (e.args.paidNow as bigint), 0n);
    const sale = r.dollarsOut - paidNow;
    return { hash: st.txs[st.txs.length - 1]!.hash, txs: st.txs, result: { gpuHours: toNumber6(r.tokens), spent: toNumber6(r.dollarsIn), received: toNumber6(r.dollarsOut), refund: 0, avgPrice: toNumber6((sale * U) / r.tokens), positionIds: r.positionIds.map(String), cost: toNumber6(cost) } };
  });
}

/** Close short positions (closeShort): the router buys their q back (the smallest quote that buys it, checked by
 *  Kuru's simulation, plus the slippage allowance, bounded by the band and the shown price; the unused part comes
 *  back) and closes each, the series paying the owner q x C - paid. */
export async function closeShort(c: AgateClient, w: WalletClient, p: { gpu: Gpu; month: string; positionIds: (string | bigint)[] } & BuyBackGuard): Promise<WriteResult<{ spent: number; refund: number; paid: number; surplusGpuHours: number }>> {
  await checkChain(c, w);
  const s = await live(c, p.gpu, p.month);
  const ids = p.positionIds.map((x) => BigInt(x));
  const q = await ownPositions(c, s, ids, accountOf(w), 1);
  const dollarsIn = await buyBackBound(c, s, q, p);
  await needDollars(c, accountOf(w), dollarsIn, "this buy-back (at most; the unused part comes back)");
  return guarded(c, w, () => ROUTER_UNDO, async (st) => {
    await ensureAllowance(c, w, c.dollar, c.router, dollarsIn, "approve tUSD to the router", st);
    await st.send(c, w, { address: c.router, abi: agateRouterAbi as Abi, functionName: "closeShort", args: [s.terms.series, ids, dollarsIn, NOPERMIT], label: "closeShort" });
    const r = routed(st.txs, c);
    const paid = ev(st.txs, "PositionClosed").reduce((a, e) => a + (e.args.amount as bigint), 0n);
    return { hash: st.txs[st.txs.length - 1]!.hash, txs: st.txs, result: { spent: toNumber6(r.dollarsIn - r.refund), refund: toNumber6(r.refund), paid: toNumber6(paid), surplusGpuHours: toNumber6(r.tokensOut) } };
  });
}

// ------------------------------------------------------------------ claims, pairs, the month end

/** Claims positions of one series (claim for one id, claimMany for several): pays each payee what has vested. */
export async function claim(c: AgateClient, w: WalletClient, p: { gpu: Gpu; month: string; positionIds: (string | bigint)[] }): Promise<WriteResult<{ paid: number; closed: string[] }>> {
  await checkChain(c, w);
  const s = await c.seriesAt(p.gpu, p.month);
  const ids = p.positionIds.map((x) => BigInt(x));
  if (ids.length === 0) throw new WriteError("no positions given", "check");
  const tx = await send(c, w, ids.length === 1 ? { address: s.terms.series, abi: agateSeriesAbi as Abi, functionName: "claim", args: [ids[0]], label: "claim" } : { address: s.terms.series, abi: agateSeriesAbi as Abi, functionName: "claimMany", args: [ids], label: `claimMany(${ids.length})` });
  const paid = ev([tx], "Claimed").reduce((a, e) => a + (e.args.amount as bigint), 0n);
  const closed = ev([tx], "PositionClosed").map((e) => String(e.args.id));
  return { hash: tx.hash, txs: [tx], result: { paid: toNumber6(paid), closed } };
}

/** Claims every open position the wallet owns with something claimable, one claimMany per series. */
export async function claimDaily(c: AgateClient, w: WalletClient): Promise<WriteResult<{ paid: number; series: number }>> {
  await checkChain(c, w);
  const wallet = await c.getWallet(accountOf(w));
  const bySeries = new Map<string, { gpu: Gpu; month: string; ids: string[] }>();
  for (const pos of wallet.positions) {
    if (pos.kind !== "position" || pos.claimable <= 0 || !pos.positionId) continue;
    const e = bySeries.get(pos.series) ?? { gpu: pos.gpu, month: pos.month, ids: [] };
    e.ids.push(pos.positionId);
    bySeries.set(pos.series, e);
  }
  if (bySeries.size === 0) throw new WriteError("nothing to claim yet", "check");
  return guarded(c, w, () => "The claims above are paid; the rest can be claimed again", async (st) => {
    let paid = 0n;
    for (const e of bySeries.values()) {
      const s = await c.seriesAt(e.gpu, e.month);
      const tx = await st.send(c, w, e.ids.length === 1 ? { address: s.terms.series, abi: agateSeriesAbi as Abi, functionName: "claim", args: [BigInt(e.ids[0]!)], label: "claim" } : { address: s.terms.series, abi: agateSeriesAbi as Abi, functionName: "claimMany", args: [e.ids.map((x) => BigInt(x))], label: `claimMany(${e.ids.length})` });
      paid += ev([tx], "Claimed").reduce((a, x) => a + (x.args.amount as bigint), 0n);
    }
    return { hash: st.txs[st.txs.length - 1]!.hash, txs: st.txs, result: { paid: toNumber6(paid), series: bySeries.size } };
  });
}

/** Mints pairs directly (series.mint: cost gpuHours x C, approved exactly to the series): the tokens to the wallet,
 *  the short side to the wallet's own short balance. */
export async function mintPairs(c: AgateClient, w: WalletClient, p: { gpu: Gpu; month: string; gpuHours: Amount }): Promise<WriteResult<{ cost: number; gpuHours: number }>> {
  await checkChain(c, w);
  const s = await c.seriesAt(p.gpu, p.month);
  const q = parseHours(p.gpuHours);
  if (q === 0n) throw new AmountError("GPU-hours must be above 0");
  const cost = (q * s.terms.cap + U - 1n) / U;
  await needDollars(c, accountOf(w), cost, `minting ${toNumber6(q)} pairs ($${toNumber6(s.terms.cap)} each)`);
  return guarded(c, w, () => "Nothing else moved", async (st) => {
    await ensureAllowance(c, w, c.dollar, s.terms.series, cost, `approve tUSD to ${s.terms.symbol}`, st);
    await st.send(c, w, { address: s.terms.series, abi: agateSeriesAbi as Abi, functionName: "mint", args: [q, accountOf(w)], label: "mint" });
    const m = ev(st.txs, "Minted")[0]?.args as { cost: bigint; q: bigint } | undefined;
    return { hash: st.txs[st.txs.length - 1]!.hash, txs: st.txs, result: { cost: m ? toNumber6(m.cost) : 0, gpuHours: m ? toNumber6(m.q) : 0 } };
  });
}

/** Redeems pairs (a token plus a short unit) for C each, any time (series.redeem). */
export async function redeem(c: AgateClient, w: WalletClient, p: { gpu: Gpu; month: string; gpuHours: Amount }): Promise<WriteResult<{ paid: number }>> {
  await checkChain(c, w);
  const s = await c.seriesAt(p.gpu, p.month);
  const q = parseHours(p.gpuHours);
  if (q === 0n) throw new AmountError("GPU-hours must be above 0");
  const tx = await send(c, w, { address: s.terms.series, abi: agateSeriesAbi as Abi, functionName: "redeem", args: [q, accountOf(w)], label: "redeem" });
  const r = ev([tx], "Redeemed")[0]?.args as { paid: bigint } | undefined;
  return { hash: tx.hash, txs: [tx], result: { paid: r ? toNumber6(r.paid) : 0 } };
}

/** After the month (every day applied): settles the wallet's held tokens (S / N each) and short balance (C - S / N
 *  each), all of both by default. Positions are paid out by their final claim instead (claim). */
export async function settle(c: AgateClient, w: WalletClient, p: { gpu: Gpu; month: string; side?: "long" | "short" | "both" }): Promise<WriteResult<{ paid: number; long: number; short: number }>> {
  await checkChain(c, w);
  const s = await c.seriesAt(p.gpu, p.month);
  if (s.k < s.terms.n) throw new WriteError(`${s.terms.symbol} has applied ${s.k} of ${s.terms.n} days: it settles once every day is final`, "check", "MonthNotFinal");
  const me = accountOf(w);
  const [t, sh] = await c.mc([
    { address: s.terms.token, abi: agateTokenAbi as Abi, functionName: "balanceOf", args: [me] },
    { address: s.terms.series, abi: agateSeriesAbi as Abi, functionName: "shortOf", args: [me] },
  ]);
  const tokens = t!.ok ? BigInt(t!.value as bigint) : 0n;
  const shorts = sh!.ok ? BigInt(sh!.value as bigint) : 0n;
  const side = p.side ?? "both";
  const wantLong = (side === "long" || side === "both") && tokens > 0n;
  const wantShort = (side === "short" || side === "both") && shorts > 0n;
  if (!wantLong && !wantShort) throw new WriteError(`nothing to settle in the wallet${await marginNote(c, me, s.terms.token)}`, "check");
  return guarded(c, w, () => "The side above is settled; settle the other again", async (st) => {
    if (wantLong) await st.send(c, w, { address: s.terms.series, abi: agateSeriesAbi as Abi, functionName: "settle", args: [0, tokens, me], label: "settle long" });
    if (wantShort) await st.send(c, w, { address: s.terms.series, abi: agateSeriesAbi as Abi, functionName: "settle", args: [1, shorts, me], label: "settle short" });
    const ss = ev(st.txs, "Settled");
    const sum = (sd: number) => ss.filter((e) => Number(e.args.side) === sd).reduce((a, e) => a + (e.args.paid as bigint), 0n);
    return { hash: st.txs[st.txs.length - 1]!.hash, txs: st.txs, result: { paid: toNumber6(sum(0) + sum(1)), long: toNumber6(sum(0)), short: toNumber6(sum(1)) } };
  });
}

// ------------------------------------------------------------------ pro: limit orders on Kuru

/** A resting limit order on the month's Kuru book, placed by the user directly (the router holds nothing between
 *  calls, so a resting order cannot be the router's). Long = a bid: tUSD deposited into Kuru's margin account as
 *  needed (approved exactly to the margin account), then addBuyOrder. Short = an ask: the wallet's tokens (in the
 *  margin account, then in the wallet) go first and any shortfall is minted as pairs (the short side stays in the
 *  wallet's short balance); `mint: true` mints the whole size, so the order opens a short whatever the wallet holds.
 *  The tokens are deposited, then addSellOrder.
 *  Checked before anything is sent: the price lies inside the band (a token's final value: [F, C] before the month,
 *  narrower as days are applied), so a fill is never a sure loss; and a post-only order (the default) must not cross
 *  the book read now (a bid below the best ask, an ask above the best bid), which Kuru would refuse only after the
 *  deposit. */
export async function placeLimit(c: AgateClient, w: WalletClient, p: { gpu: Gpu; month: string; side: "long" | "short"; price: Amount; gpuHours: Amount; postOnly?: boolean; mint?: boolean }): Promise<WriteResult<{ orderId: string; price: number; gpuHours: number; deposited: number; minted: number }>> {
  await checkChain(c, w);
  const s = await live(c, p.gpu, p.month);
  const me = accountOf(w);
  const price = parsePrice(p.price);
  const b = band(s);
  const lo = ceilDiv(ceilDiv(b.loNum, b.n), TICK) * TICK;
  const hi = (b.hiNum / b.n / TICK) * TICK;
  if (price < lo || price > hi) throw new AmountError(`price must lie in the band ${toNumber6(lo)} to ${toNumber6(hi)} (what a ${s.terms.symbol} token can still pay at the month's end)`);
  const tokens = parseHours(p.gpuHours);
  const units = tokens / LOT;
  if (units < KURU_MIN_SIZE || units > KURU_MAX_SIZE) throw new AmountError(`a limit order is 1 to 1,000,000 GPU-hours (Kuru's sizes), not ${unitsToHours(units)}`);
  const postOnly = p.postOnly ?? true;
  if (postOnly) {
    if (!s.book) throw new WriteError("the book could not be read, so a post-only order cannot be checked; nothing was sent", "check");
    const ask = s.book.asks[0]?.[0];
    const bid = s.book.bids[0]?.[0];
    if (p.side === "long" && ask !== undefined && price >= ask) throw new WriteError(`a post-only bid at ${toNumber6(price)} would cross the best ask ${toNumber6(ask)}: price it below the ask (or pass postOnly: false to take); nothing was sent`, "check", "PostOnlyError");
    if (p.side === "short" && bid !== undefined && price <= bid) throw new WriteError(`a post-only ask at ${toNumber6(price)} would cross the best bid ${toNumber6(bid)}: price it above the bid (or pass postOnly: false to take); nothing was sent`, "check", "PostOnlyError");
  }
  const MA = c.marginAccount;
  let deposited = 0n;
  let minted = 0n;
  const undo = (st: Sent) => {
    const did = (label: string) => st.txs.some((t) => t.label === label);
    const parts: string[] = [];
    if (did("deposit tUSD into Kuru")) parts.push(`$${toNumber6(deposited)} rests in Kuru's margin account: withdrawMargin({asset: "dollar"}) brings it back`);
    if (did("mint pairs")) parts.push(`${toNumber6(minted)} pairs were minted ($${toNumber6((minted * s.terms.cap + U - 1n) / U)}): their short side is in the wallet's short balance; redeem({gpu, month, gpuHours: "${toNumber6(minted)}"}) pays $${toNumber6(s.terms.cap)} each back once the tokens are in the wallet`);
    if (did(`deposit ${s.terms.symbol} into Kuru`)) parts.push(`${toNumber6(deposited)} ${s.terms.symbol} rest in Kuru's margin account: withdrawMargin({asset: {gpu, month}}) brings them back`);
    return parts.map((x) => x[0]!.toUpperCase() + x.slice(1)).join(". ");
  };
  return guarded(c, w, undo, async (st) => {
    if (p.side === "long") {
      const need = (price * units) / SIZE_PER_TOKEN;
      const have = (await c.pub.readContract({ address: MA, abi: kuruMarginAccountAbi as Abi, functionName: "getBalance", args: [me, c.dollar] })) as bigint;
      if (have < need) {
        deposited = need - have;
        await needDollars(c, me, deposited, `a bid of ${toNumber6(tokens)} GPU-hours at $${toNumber6(price)} (its deposit in Kuru's margin account)`);
        await ensureAllowance(c, w, c.dollar, MA, deposited, "approve tUSD to Kuru's margin account", st);
        await st.send(c, w, { address: MA, abi: kuruMarginAccountAbi as Abi, functionName: "deposit", args: [me, c.dollar, deposited], label: "deposit tUSD into Kuru" });
      }
      await st.send(c, w, { address: s.market, abi: kuruOrderBookAbi as Abi, functionName: "addBuyOrder", args: [Number(price), units, postOnly], label: "addBuyOrder" });
    } else {
      // mint: true opens a short whatever the wallet holds (every token of the order minted as a pair)
      const have = p.mint ? 0n : ((await c.pub.readContract({ address: MA, abi: kuruMarginAccountAbi as Abi, functionName: "getBalance", args: [me, s.terms.token] })) as bigint);
      if (have < tokens) {
        deposited = tokens - have;
        const held = p.mint ? 0n : ((await c.pub.readContract({ address: s.terms.token, abi: agateTokenAbi as Abi, functionName: "balanceOf", args: [me] })) as bigint);
        if (held < deposited) {
          minted = deposited - held;
          const cost = (minted * s.terms.cap + U - 1n) / U;
          await needDollars(c, me, cost, `an ask that mints ${toNumber6(minted)} pairs ($${toNumber6(s.terms.cap)} each)`);
          await ensureAllowance(c, w, c.dollar, s.terms.series, cost, `approve tUSD to ${s.terms.symbol}`, st);
          await st.send(c, w, { address: s.terms.series, abi: agateSeriesAbi as Abi, functionName: "mint", args: [minted, me], label: "mint pairs" });
        }
        await ensureAllowance(c, w, s.terms.token, MA, deposited, `approve ${s.terms.symbol} to Kuru's margin account`, st);
        await st.send(c, w, { address: MA, abi: kuruMarginAccountAbi as Abi, functionName: "deposit", args: [me, s.terms.token, deposited], label: `deposit ${s.terms.symbol} into Kuru` });
      }
      await st.send(c, w, { address: s.market, abi: kuruOrderBookAbi as Abi, functionName: "addSellOrder", args: [Number(price), units, postOnly], label: "addSellOrder" });
    }
    const created = ev(st.txs.slice(-1), "OrderCreated")[0]?.args as { orderId: number | bigint } | undefined;
    return { hash: st.txs[st.txs.length - 1]!.hash, txs: st.txs, result: { orderId: created ? String(created.orderId) : "", price: toNumber6(price), gpuHours: toNumber6(tokens), deposited: toNumber6(deposited), minted: toNumber6(minted) } };
  });
}

/** Cancels the user's resting orders on one month's book (batchCancelOrders); ids already filled or cancelled are
 *  left out first (Kuru reverts on them). The funds go back to Kuru's margin account (withdrawMargin). */
export async function cancelLimit(c: AgateClient, w: WalletClient, p: { gpu: Gpu; month: string; orderIds: (string | bigint)[] }): Promise<WriteResult<{ cancelled: string[]; skipped: string[] }>> {
  await checkChain(c, w);
  const s = await live(c, p.gpu, p.month);
  const me = accountOf(w).toLowerCase();
  const ids = p.orderIds.map((x) => BigInt(x));
  const st = await c.orderStatus(ids.map((id) => ({ market: s.market, id })));
  const keep = ids.filter((_, i) => st[i]?.status === "ACTIVE" && st[i]!.owner.toLowerCase() === me);
  const skipped = ids.filter((id) => !keep.includes(id)).map(String);
  if (keep.length === 0) throw new WriteError("none of these orders is resting and yours", "check");
  const tx = await send(c, w, { address: s.market, abi: kuruOrderBookAbi as Abi, functionName: "batchCancelOrders", args: [keep.map((id) => Number(id))], label: "batchCancelOrders" });
  return { hash: tx.hash, txs: [tx], result: { cancelled: keep.map(String), skipped } };
}

/** Withdraws from Kuru's margin account to the wallet: tUSD (asset "dollar") or a month's token; all by default. */
export async function withdrawMargin(c: AgateClient, w: WalletClient, p: { asset: "dollar" | { gpu: Gpu; month: string }; amount?: Amount }): Promise<WriteResult<{ amount: number }>> {
  await checkChain(c, w);
  const me = accountOf(w);
  const token = p.asset === "dollar" ? c.dollar : (await c.seriesAt(p.asset.gpu, p.asset.month)).terms.token;
  const have = (await c.pub.readContract({ address: c.marginAccount, abi: kuruMarginAccountAbi as Abi, functionName: "getBalance", args: [me, token] })) as bigint;
  const amount = p.amount === undefined ? have : parseDollars(p.amount, "amount");
  if (amount === 0n || amount > have) throw new WriteError(`the margin account holds ${toNumber6(have)}`, "check");
  const tx = await send(c, w, { address: c.marginAccount, abi: kuruMarginAccountAbi as Abi, functionName: "withdraw", args: [amount, token], label: "withdraw from Kuru" });
  return { hash: tx.hash, txs: [tx], result: { amount: toNumber6(amount) } };
}
