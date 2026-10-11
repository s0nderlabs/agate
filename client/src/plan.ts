// Plan-only writes: the same checks as writes.ts (the band, ThinBook, PriceMoved, InsufficientBalance, slippage,
// payee, own positions), but nothing is sent. Each returns the calls of ONE batch (an exact approval when the
// allowance is short, then the router call) for a smart account to send as one user operation: the app's main account
// (sendCalls with a Kernel client) or an AI pocket (agate's server). `me` is the account that will send the batch.
// The bounds go on chain inside the router call (minimum out / maximum in), exactly as the plain writes do.
import { type Abi, type Address, encodeFunctionData, type Hex, type Log } from "viem";
import { agateDollarAbi, agateRouterAbi, agateSeriesAbi, agateTokenAbi, kuruMarginAccountAbi, kuruOrderBookAbi } from "./abi.ts";
import type { AgateClient } from "./client.ts";
import type { Gpu } from "./types.ts";
import { type Amount, AmountError, iso, KURU_MAX_SIZE, KURU_MIN_SIZE, LOT, parseDollars, parseHours, parsePrice, SIZE_PER_TOKEN, TICK, toNumber6, U, unitsToHours } from "./units.ts";
import { band, buyBackBound, type BuyBackGuard, buyBound, type BuyGuard, ceilDiv, checkPayee, type DecodedEvent, decodeLogs, live, needDollars, NOPERMIT, ownPositions, sellBound, type SellGuard, WriteError } from "./writes.ts";

/** One call of a batch. */
export interface PlanCall {
  to: Address;
  value: bigint;
  data: Hex;
  /** what it does, in plain words ("approve tUSD to the router", "openLong") */
  label: string;
}

/** A planned write: the batch to send and what it will do, in plain numbers. */
export interface Plan<S> {
  /** the account the batch is planned for */
  account: Address;
  calls: PlanCall[];
  summary: S;
}

export interface TradeSummary {
  action: "openLong" | "openLongDaily" | "closeLong" | "openShort" | "closeShort" | "closeLongDaily" | "drip" | "rollLong";
  gpu?: Gpu;
  month?: string;
  series?: Address;
  /** dollars the batch may take from the account at most (0 for a sale) */
  maxSpend: number;
  /** the router's bound: GPU-hours or dollars at least received (or at most paid, for a buy-back) */
  bound: { kind: "minTokensOut" | "minDollarsOut" | "maxDollarsIn"; value: number };
  gpuHours?: number;
  payee?: Address;
  /** rollLong: the month sold and its least proceeds, which pay for the new month in the same batch */
  from?: { month: string; series: Address; gpuHours: number; minDollarsOut: number };
}

/** An approve call, only when the allowance is short of `amount`. */
async function approvalTo(c: AgateClient, me: Address, token: Address, spender: Address, amount: bigint, label: string): Promise<PlanCall[]> {
  if (amount === 0n) return [];
  const cur = (await c.pub.readContract({ address: token, abi: agateTokenAbi as Abi, functionName: "allowance", args: [me, spender] })) as bigint;
  if (cur >= amount) return [];
  return [{ to: token, value: 0n, data: encodeFunctionData({ abi: agateTokenAbi as Abi, functionName: "approve", args: [spender, amount] }), label }];
}

const approvalIfShort = (c: AgateClient, me: Address, token: Address, amount: bigint, label: string) => approvalTo(c, me, token, c.router, amount, label);

const routerCall = (c: AgateClient, functionName: string, args: readonly unknown[]): PlanCall => ({
  to: c.router,
  value: 0n,
  data: encodeFunctionData({ abi: agateRouterAbi as Abi, functionName, args }),
  label: functionName,
});

/** The faucet (AgateDollar.drip), refused before the account's next drip time. */
export async function planDrip(c: AgateClient, me: Address): Promise<Plan<TradeSummary>> {
  const nextAt = (await c.pub.readContract({ address: c.dollar, abi: agateDollarAbi as Abi, functionName: "nextDripAt", args: [me] })) as bigint;
  const now = await c.chainTime();
  if (now < nextAt) throw new WriteError(`the next drip opens at ${iso(nextAt)}`, "check", "DripTooSoon");
  return { account: me, calls: [{ to: c.dollar, value: 0n, data: encodeFunctionData({ abi: agateDollarAbi as Abi, functionName: "drip", args: [] }), label: "drip" }], summary: { action: "drip", maxSpend: 0, bound: { kind: "minDollarsOut", value: 0 } } };
}

/** Long (openLong) for `dollars`, bounded like buyLong. */
export async function planBuyLong(c: AgateClient, me: Address, p: { gpu: Gpu; month: string; dollars: Amount } & BuyGuard): Promise<Plan<TradeSummary>> {
  const s = await live(c, p.gpu, p.month);
  const dollars = parseDollars(p.dollars);
  if (dollars === 0n) throw new AmountError("dollars must be above 0");
  const minOut = await buyBound(c, s, dollars, p);
  await needDollars(c, me, dollars, "this buy");
  const calls = [...(await approvalIfShort(c, me, c.dollar, dollars, "approve tUSD to the router")), routerCall(c, "openLong", [s.terms.series, dollars, minOut, NOPERMIT])];
  return { account: me, calls, summary: { action: "openLong", gpu: p.gpu, month: p.month, series: s.terms.series, maxSpend: toNumber6(dollars), bound: { kind: "minTokensOut", value: toNumber6(minOut) } } };
}

/** Sell held tokens (closeLong), bounded like sellLong. */
export async function planSellLong(c: AgateClient, me: Address, p: { gpu: Gpu; month: string; gpuHours: Amount } & SellGuard): Promise<Plan<TradeSummary>> {
  const s = await live(c, p.gpu, p.month);
  const tokens = parseHours(p.gpuHours);
  if (tokens === 0n) throw new AmountError("GPU-hours must be above 0");
  const held = (await c.pub.readContract({ address: s.terms.token, abi: agateTokenAbi as Abi, functionName: "balanceOf", args: [me] })) as bigint;
  if (held < tokens) throw new WriteError(`the account holds ${toNumber6(held)} GPU-hours of ${s.terms.symbol}`, "check", "InsufficientTokens");
  const minOut = sellBound(s, tokens, p);
  const calls = [...(await approvalIfShort(c, me, s.terms.token, tokens, `approve ${s.terms.symbol} to the router`)), routerCall(c, "closeLong", [s.terms.series, tokens, minOut, NOPERMIT])];
  return { account: me, calls, summary: { action: "closeLong", gpu: p.gpu, month: p.month, series: s.terms.series, maxSpend: 0, gpuHours: toNumber6(tokens), bound: { kind: "minDollarsOut", value: toNumber6(minOut) } } };
}

/** Long, pay me daily (openLongDaily), bounded like openLongDaily; the payee defaults to the account itself. */
export async function planOpenLongDaily(c: AgateClient, me: Address, p: { gpu: Gpu; month: string; dollars: Amount; parts?: number; payee?: Address } & BuyGuard): Promise<Plan<TradeSummary>> {
  const s = await live(c, p.gpu, p.month);
  const payee = p.payee ?? me;
  checkPayee(c, s, payee);
  const parts = BigInt(p.parts ?? 1);
  if (parts < 1n) throw new AmountError("parts must be at least 1");
  const dollars = parseDollars(p.dollars);
  if (dollars === 0n) throw new AmountError("dollars must be above 0");
  const minOut = await buyBound(c, s, dollars, p);
  if (minOut / parts / LOT === 0n) throw new WriteError("the size is too small for that many parts", "check", "PartsTooSmall");
  await needDollars(c, me, dollars, "this buy");
  const calls = [...(await approvalIfShort(c, me, c.dollar, dollars, "approve tUSD to the router")), routerCall(c, "openLongDaily", [s.terms.series, dollars, minOut, parts, payee, NOPERMIT])];
  return { account: me, calls, summary: { action: "openLongDaily", gpu: p.gpu, month: p.month, series: s.terms.series, maxSpend: toNumber6(dollars), payee, bound: { kind: "minTokensOut", value: toNumber6(minOut) } } };
}

/** Exit pay-me-daily long positions early (closeLongDaily), bounded like closeLongDaily. */
export async function planCloseLongDaily(c: AgateClient, me: Address, p: { gpu: Gpu; month: string; positionIds: (string | bigint)[] } & SellGuard): Promise<Plan<TradeSummary>> {
  const s = await live(c, p.gpu, p.month);
  const ids = p.positionIds.map((x) => BigInt(x));
  const q = await ownPositions(c, s, ids, me, 0);
  const cost = (q * s.terms.cap + U - 1n) / U;
  const minOut = sellBound(s, q, p);
  await needDollars(c, me, cost, `closing early (the router mints ${toNumber6(q)} pairs at $${toNumber6(s.terms.cap)}, most of it paid back in the same transaction)`);
  const calls = [...(await approvalIfShort(c, me, c.dollar, cost, "approve tUSD to the router")), routerCall(c, "closeLongDaily", [s.terms.series, ids, minOut, NOPERMIT])];
  return { account: me, calls, summary: { action: "closeLongDaily", gpu: p.gpu, month: p.month, series: s.terms.series, maxSpend: toNumber6(cost), gpuHours: toNumber6(q), bound: { kind: "minDollarsOut", value: toNumber6(minOut) } } };
}

/** Short (openShort), bounded like openShort; the payee defaults to the account itself. */
export async function planOpenShort(c: AgateClient, me: Address, p: { gpu: Gpu; month: string; gpuHours: Amount; parts?: number; daily?: boolean; payee?: Address } & SellGuard): Promise<Plan<TradeSummary>> {
  const s = await live(c, p.gpu, p.month);
  const payee = p.payee ?? me;
  checkPayee(c, s, payee);
  const tokens = parseHours(p.gpuHours);
  const parts = BigInt(p.parts ?? 1);
  if (tokens === 0n || parts < 1n || tokens % parts !== 0n || (tokens / parts) % LOT !== 0n) throw new AmountError("GPU-hours must split into equal parts of whole 0.0001 GPU-hours");
  const cost = (tokens * s.terms.cap + U - 1n) / U;
  const minOut = sellBound(s, tokens, p);
  await needDollars(c, me, cost, `a short of ${toNumber6(tokens)} GPU-hours (the pairs' collateral, $${toNumber6(s.terms.cap)} each, the sale paid back in the same transaction)`);
  const calls = [...(await approvalIfShort(c, me, c.dollar, cost, "approve tUSD to the router")), routerCall(c, "openShort", [s.terms.series, tokens, minOut, parts, payee, p.daily ?? true, NOPERMIT])];
  return { account: me, calls, summary: { action: "openShort", gpu: p.gpu, month: p.month, series: s.terms.series, maxSpend: toNumber6(cost), gpuHours: toNumber6(tokens), payee, bound: { kind: "minDollarsOut", value: toNumber6(minOut) } } };
}

/** Close short positions (closeShort), bounded like closeShort. */
export async function planCloseShort(c: AgateClient, me: Address, p: { gpu: Gpu; month: string; positionIds: (string | bigint)[] } & BuyBackGuard): Promise<Plan<TradeSummary>> {
  const s = await live(c, p.gpu, p.month);
  const ids = p.positionIds.map((x) => BigInt(x));
  const q = await ownPositions(c, s, ids, me, 1);
  const dollarsIn = await buyBackBound(c, s, q, p);
  await needDollars(c, me, dollarsIn, "this buy-back (at most; the unused part comes back)");
  const calls = [...(await approvalIfShort(c, me, c.dollar, dollarsIn, "approve tUSD to the router")), routerCall(c, "closeShort", [s.terms.series, ids, dollarsIn, NOPERMIT])];
  return { account: me, calls, summary: { action: "closeShort", gpu: p.gpu, month: p.month, series: s.terms.series, maxSpend: toNumber6(dollarsIn), gpuHours: toNumber6(q), bound: { kind: "maxDollarsIn", value: toNumber6(dollarsIn) } } };
}

/** "Keep my hedge going": sells held tokens of one month (closeLong, bounded like sellLong) and buys the same GPU's
 *  next month with the sale's least proceeds (openLong, bounded like buyLong), in ONE batch: the buy is paid by the
 *  sale, so nothing else of the account's dollars is used, and if either side misses its bound the whole batch
 *  reverts (no half-rolled hedge). */
export async function planRollLong(c: AgateClient, me: Address, p: { gpu: Gpu; fromMonth: string; toMonth: string; gpuHours?: Amount; minPrice?: Amount; maxPrice?: Amount; slippageBps?: number }): Promise<Plan<TradeSummary>> {
  if (p.fromMonth === p.toMonth) throw new AmountError("roll to a different month");
  const from = await live(c, p.gpu, p.fromMonth);
  const to = await live(c, p.gpu, p.toMonth);
  const held = (await c.pub.readContract({ address: from.terms.token, abi: agateTokenAbi as Abi, functionName: "balanceOf", args: [me] })) as bigint;
  const tokens = p.gpuHours === undefined ? held - (held % LOT) : parseHours(p.gpuHours);
  if (tokens === 0n) throw new WriteError(`the account holds no ${from.terms.symbol} to roll`, "check", "InsufficientTokens");
  if (held < tokens) throw new WriteError(`the account holds ${toNumber6(held)} GPU-hours of ${from.terms.symbol}`, "check", "InsufficientTokens");
  // minPrice guards the sale (old month), maxPrice the buy (new month); both sides keep the slippage allowance
  const minOut = sellBound(from, tokens, { minPrice: p.minPrice, slippageBps: p.slippageBps });
  // the new month's bound comes from a fresh simulation of buying with exactly the sale's least proceeds
  const minTokens = await buyBound(c, to, minOut, { maxPrice: p.maxPrice, slippageBps: p.slippageBps });
  const calls = [
    ...(await approvalIfShort(c, me, from.terms.token, tokens, `approve ${from.terms.symbol} to the router`)),
    routerCall(c, "closeLong", [from.terms.series, tokens, minOut, NOPERMIT]),
    ...(await approvalIfShort(c, me, c.dollar, minOut, "approve tUSD to the router")),
    routerCall(c, "openLong", [to.terms.series, minOut, minTokens, NOPERMIT]),
  ];
  return {
    account: me,
    calls,
    summary: {
      action: "rollLong",
      gpu: p.gpu,
      month: p.toMonth,
      series: to.terms.series,
      maxSpend: toNumber6(minOut),
      gpuHours: toNumber6(tokens),
      bound: { kind: "minTokensOut", value: toNumber6(minTokens) },
      from: { month: p.fromMonth, series: from.terms.series, gpuHours: toNumber6(tokens), minDollarsOut: toNumber6(minOut) },
    },
  };
}

// ------------------------------------------------------------------ claims and the month end (main account)

export interface ClaimSummary {
  action: "claim" | "claimAll" | "settle";
  /** per series: what the batch claims or settles */
  series: { gpu: Gpu; month: string; series: Address; positionIds?: string[]; long?: number; short?: number }[];
  /** dollars claimable now by the indexer's reading (claimAll only; the chain pays what has vested when it lands) */
  claimable?: number;
}

const seriesCall = (series: Address, functionName: string, args: readonly unknown[], label: string): PlanCall => ({
  to: series,
  value: 0n,
  data: encodeFunctionData({ abi: agateSeriesAbi as Abi, functionName, args }),
  label,
});

const claimCall = (series: Address, ids: bigint[]): PlanCall => (ids.length === 1 ? seriesCall(series, "claim", [ids[0]], "claim") : seriesCall(series, "claimMany", [ids], `claimMany(${ids.length})`));

/** Claims positions of one series, like claim (claim for one id, claimMany for several). */
export async function planClaim(c: AgateClient, me: Address, p: { gpu: Gpu; month: string; positionIds: (string | bigint)[] }): Promise<Plan<ClaimSummary>> {
  const s = await c.seriesAt(p.gpu, p.month);
  const ids = p.positionIds.map((x) => BigInt(x));
  if (ids.length === 0) throw new WriteError("no positions given", "check", "NoPositions");
  return { account: me, calls: [claimCall(s.terms.series, ids)], summary: { action: "claim", series: [{ gpu: p.gpu, month: p.month, series: s.terms.series, positionIds: ids.map(String) }] } };
}

/** "Collect now": every open position the account owns with something claimable, one claim call per series, all in
 *  one batch (claimDaily sends them one by one). */
export async function planClaimAll(c: AgateClient, me: Address): Promise<Plan<ClaimSummary>> {
  const wallet = await c.getWallet(me);
  const bySeries = new Map<string, { gpu: Gpu; month: string; ids: string[] }>();
  let claimable = 0;
  for (const pos of wallet.positions) {
    if (pos.kind !== "position" || pos.claimable <= 0 || !pos.positionId) continue;
    const e = bySeries.get(pos.series) ?? { gpu: pos.gpu, month: pos.month, ids: [] };
    e.ids.push(pos.positionId);
    bySeries.set(pos.series, e);
    claimable += pos.claimable;
  }
  if (bySeries.size === 0) throw new WriteError("nothing to claim yet", "check");
  const calls: PlanCall[] = [];
  const series: ClaimSummary["series"] = [];
  for (const e of bySeries.values()) {
    const s = await c.seriesAt(e.gpu, e.month);
    calls.push(claimCall(s.terms.series, e.ids.map((x) => BigInt(x))));
    series.push({ gpu: e.gpu, month: e.month, series: s.terms.series, positionIds: e.ids });
  }
  return { account: me, calls, summary: { action: "claimAll", series, claimable: Number(claimable.toFixed(6)) } };
}

/** The account's two sides of one month in its wallet: tokens (not those at Kuru) and its short balance. A failed
 *  read throws: a plan never guesses a balance. */
async function walletSides(c: AgateClient, terms: { token: Address; series: Address; symbol: string }, me: Address): Promise<{ tokens: bigint; shorts: bigint }> {
  const [t, sh] = await c.mc([
    { address: terms.token, abi: agateTokenAbi as Abi, functionName: "balanceOf", args: [me] },
    { address: terms.series, abi: agateSeriesAbi as Abi, functionName: "shortOf", args: [me] },
  ]);
  if (!t!.ok || !sh!.ok) throw new WriteError(`could not read ${terms.symbol}'s balances`, "check");
  return { tokens: BigInt(t!.value as bigint), shorts: BigInt(sh!.value as bigint) };
}

/** After the month (every day applied): settles held tokens and the short balance, like settle. */
export async function planSettle(c: AgateClient, me: Address, p: { gpu: Gpu; month: string; side?: "long" | "short" | "both" }): Promise<Plan<ClaimSummary>> {
  const s = await c.seriesAt(p.gpu, p.month);
  if (s.k < s.terms.n) throw new WriteError(`${s.terms.symbol} has applied ${s.k} of ${s.terms.n} days: it settles once every day is final`, "check", "MonthNotFinal");
  const { tokens, shorts } = await walletSides(c, s.terms, me);
  const side = p.side ?? "both";
  const wantLong = (side === "long" || side === "both") && tokens > 0n;
  const wantShort = (side === "short" || side === "both") && shorts > 0n;
  if (!wantLong && !wantShort) throw new WriteError("nothing to settle in the account (tokens in Kuru's margin account come back with planWithdrawMargin first)", "check");
  const calls: PlanCall[] = [];
  if (wantLong) calls.push(seriesCall(s.terms.series, "settle", [0, tokens, me], "settle long"));
  if (wantShort) calls.push(seriesCall(s.terms.series, "settle", [1, shorts, me], "settle short"));
  return { account: me, calls, summary: { action: "settle", series: [{ gpu: p.gpu, month: p.month, series: s.terms.series, long: wantLong ? toNumber6(tokens) : 0, short: wantShort ? toNumber6(shorts) : 0 }] } };
}

// ------------------------------------------------------------------ pro: limit orders on Kuru (main account)

export interface LimitSummary {
  action: "placeLimit" | "cancelLimit" | "withdrawMargin" | "redeem";
  gpu?: Gpu;
  month?: string;
  side?: "long" | "short";
  price?: number;
  gpuHours?: number;
  postOnly?: boolean;
  /** moved into Kuru's margin account by this batch (dollars for a bid, GPU-hours for an ask) */
  deposited?: number;
  /** pairs minted by this batch for an ask */
  minted?: number;
  /** cancelLimit: the ids cancelled and the ones left out (already filled, cancelled, or not the account's) */
  cancelled?: string[];
  skipped?: string[];
  /** withdrawn from Kuru's margin account by this batch */
  withdrawn?: { dollars: number; gpuHours: number };
  /** redeem: dollars the pairs return (the ceiling each) */
  paid?: number;
}

async function marginBalance(c: AgateClient, me: Address, token: Address): Promise<bigint> {
  return (await c.pub.readContract({ address: c.marginAccount, abi: kuruMarginAccountAbi as Abi, functionName: "getBalance", args: [me, token] })) as bigint;
}

const marginCall = (c: AgateClient, functionName: string, args: readonly unknown[], label: string): PlanCall => ({
  to: c.marginAccount,
  value: 0n,
  data: encodeFunctionData({ abi: kuruMarginAccountAbi as Abi, functionName, args }),
  label,
});

const bookCall = (market: Address, functionName: string, args: readonly unknown[], label: string): PlanCall => ({
  to: market,
  value: 0n,
  data: encodeFunctionData({ abi: kuruOrderBookAbi as Abi, functionName, args }),
  label,
});

/** A resting limit order, like placeLimit, as one batch: deposit what the order needs into Kuru's margin account
 *  (minting pairs for an ask when the account holds too few tokens, or always with `mint: true`), then the order. The
 *  same checks: the price inside the band and on the tick, Kuru's sizes, and a post-only order must not cross the
 *  book read now. */
export async function planPlaceLimit(c: AgateClient, me: Address, p: { gpu: Gpu; month: string; side: "long" | "short"; price: Amount; gpuHours: Amount; postOnly?: boolean; mint?: boolean }): Promise<Plan<LimitSummary>> {
  const s = await live(c, p.gpu, p.month);
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
  const calls: PlanCall[] = [];
  let deposited = 0n;
  let minted = 0n;
  if (p.side === "long") {
    const need = (price * units) / SIZE_PER_TOKEN;
    const have = await marginBalance(c, me, c.dollar);
    if (have < need) {
      deposited = need - have;
      await needDollars(c, me, deposited, `a bid of ${toNumber6(tokens)} GPU-hours at $${toNumber6(price)} (its deposit in Kuru's margin account)`);
      calls.push(...(await approvalTo(c, me, c.dollar, MA, deposited, "approve tUSD to Kuru's margin account")));
      calls.push(marginCall(c, "deposit", [me, c.dollar, deposited], "deposit tUSD into Kuru"));
    }
    calls.push(bookCall(s.market, "addBuyOrder", [Number(price), units, postOnly], "addBuyOrder"));
  } else {
    const have = p.mint ? 0n : await marginBalance(c, me, s.terms.token);
    if (have < tokens) {
      deposited = tokens - have;
      const held = p.mint ? 0n : ((await c.pub.readContract({ address: s.terms.token, abi: agateTokenAbi as Abi, functionName: "balanceOf", args: [me] })) as bigint);
      if (held < deposited) {
        minted = deposited - held;
        const cost = (minted * s.terms.cap + U - 1n) / U;
        await needDollars(c, me, cost, `an ask that mints ${toNumber6(minted)} pairs ($${toNumber6(s.terms.cap)} each)`);
        calls.push(...(await approvalTo(c, me, c.dollar, s.terms.series, cost, `approve tUSD to ${s.terms.symbol}`)));
        calls.push(seriesCall(s.terms.series, "mint", [minted, me], "mint pairs"));
      }
      calls.push(...(await approvalTo(c, me, s.terms.token, MA, deposited, `approve ${s.terms.symbol} to Kuru's margin account`)));
      calls.push(marginCall(c, "deposit", [me, s.terms.token, deposited], `deposit ${s.terms.symbol} into Kuru`));
    }
    calls.push(bookCall(s.market, "addSellOrder", [Number(price), units, postOnly], "addSellOrder"));
  }
  return { account: me, calls, summary: { action: "placeLimit", gpu: p.gpu, month: p.month, side: p.side, price: toNumber6(price), gpuHours: toNumber6(tokens), postOnly, deposited: toNumber6(deposited), minted: toNumber6(minted) } };
}

/** Cancels the account's resting orders on one month's book, like cancelLimit (ids already filled, cancelled or not
 *  the account's are left out first: Kuru reverts on them). With `withdraw` (default true) the same batch takes the
 *  margin account's balance plus what the cancels free (rounded down, so the batch never asks for more than is there)
 *  back to the account. */
export async function planCancelLimit(c: AgateClient, me: Address, p: { gpu: Gpu; month: string; orderIds: (string | bigint)[]; withdraw?: boolean }): Promise<Plan<LimitSummary>> {
  const s = await live(c, p.gpu, p.month);
  const ids = p.orderIds.map((x) => BigInt(x));
  const st = await c.orderStatus(ids.map((id) => ({ market: s.market, id })));
  const mine = (i: number) => st[i]?.status === "ACTIVE" && st[i]!.owner.toLowerCase() === me.toLowerCase();
  const keep = ids.filter((_, i) => mine(i));
  const skipped = ids.filter((id) => !keep.includes(id)).map(String);
  if (keep.length === 0) throw new WriteError("none of these orders is resting and yours", "check");
  const calls: PlanCall[] = [bookCall(s.market, "batchCancelOrders", [keep.map((id) => Number(id))], "batchCancelOrders")];
  let dollars = 0n;
  let tokens = 0n;
  if (p.withdraw ?? true) {
    let freedDollars = 0n;
    let freedTokens = 0n;
    ids.forEach((_, i) => {
      if (!mine(i)) return;
      const o = st[i]!;
      if (o.isBuy) freedDollars += (o.price * o.remaining) / SIZE_PER_TOKEN;
      else freedTokens += o.remaining * LOT;
    });
    const [hd, ht] = await Promise.all([marginBalance(c, me, c.dollar), marginBalance(c, me, s.terms.token)]);
    dollars = hd + freedDollars;
    tokens = ht + freedTokens;
    if (dollars > 0n) calls.push(marginCall(c, "withdraw", [dollars, c.dollar], "withdraw tUSD from Kuru"));
    if (tokens > 0n) calls.push(marginCall(c, "withdraw", [tokens, s.terms.token], `withdraw ${s.terms.symbol} from Kuru`));
  }
  return { account: me, calls, summary: { action: "cancelLimit", gpu: p.gpu, month: p.month, cancelled: keep.map(String), skipped, withdrawn: { dollars: toNumber6(dollars), gpuHours: toNumber6(tokens) } } };
}

/** Withdraws from Kuru's margin account, like withdrawMargin: tUSD (asset "dollar") or a month's token; all by
 *  default. */
export async function planWithdrawMargin(c: AgateClient, me: Address, p: { asset: "dollar" | { gpu: Gpu; month: string }; amount?: Amount }): Promise<Plan<LimitSummary>> {
  const month = p.asset === "dollar" ? null : p.asset;
  const token = month ? (await c.seriesAt(month.gpu, month.month)).terms.token : c.dollar;
  const have = await marginBalance(c, me, token);
  const amount = p.amount === undefined ? have : parseDollars(p.amount, "amount");
  if (amount === 0n || amount > have) throw new WriteError(`the margin account holds ${toNumber6(have)}`, "check");
  return {
    account: me,
    calls: [marginCall(c, "withdraw", [amount, token], "withdraw from Kuru")],
    summary: { action: "withdrawMargin", ...(month ? { gpu: month.gpu, month: month.month } : {}), withdrawn: { dollars: month ? 0 : toNumber6(amount), gpuHours: month ? toNumber6(amount) : 0 } },
  };
}

/** Redeems pairs, like redeem: a token plus a unit of short balance return the month's ceiling each, any time
 *  (series.redeem). A cancelled minted ask leaves exactly such a pair (planCancelLimit with withdraw brings its tokens
 *  back to the wallet first), and this closes it. gpuHours defaults to every pair the wallet holds: the smaller of its
 *  tokens in the wallet (not at Kuru) and its short balance. */
export async function planRedeem(c: AgateClient, me: Address, p: { gpu: Gpu; month: string; gpuHours?: Amount }): Promise<Plan<LimitSummary>> {
  const s = await c.seriesAt(p.gpu, p.month);
  const { tokens, shorts } = await walletSides(c, s.terms, me);
  // series.redeem takes whole lots only (q % LOT == 0): a token balance can hold dust from a plain transfer
  const both = tokens < shorts ? tokens : shorts;
  const pairs = both - (both % LOT);
  const q = p.gpuHours === undefined ? pairs : parseHours(p.gpuHours);
  if (pairs === 0n) throw new WriteError(`the wallet holds no ${s.terms.symbol} pair (a token and a short unit)`, "check", "InsufficientBalance");
  if (q === 0n) throw new AmountError("GPU-hours must be above 0");
  if (q > pairs) throw new WriteError(`the wallet holds ${toNumber6(pairs)} ${s.terms.symbol} pairs (${toNumber6(tokens)} tokens, ${toNumber6(shorts)} short)`, "check", "InsufficientBalance");
  return {
    account: me,
    calls: [seriesCall(s.terms.series, "redeem", [q, me], `redeem ${toNumber6(q)} ${s.terms.symbol} pairs`)],
    summary: { action: "redeem", gpu: p.gpu, month: p.month, gpuHours: toNumber6(q), paid: toNumber6((q * s.terms.cap) / U) },
  };
}

// ------------------------------------------------------------------ reading what a sent batch did

export type PlanAction = TradeSummary["action"] | ClaimSummary["action"] | LimitSummary["action"];

/** What a landed batch did, from its receipt's logs, in the same words the plain writes return (so "Done" never
 *  repeats the math). Router trades read the router's Routed event (from `c.router`); claims sum Claimed; settles sum
 *  Settled; a limit order reads OrderCreated. */
export function readResult(c: AgateClient, action: PlanAction, logs: readonly Log[]): Record<string, unknown> {
  const evs = decodeLogs(logs);
  const of = (name: string) => evs.filter((e) => e.name === name);
  const sum = (name: string, field: string, pick: (e: DecodedEvent) => boolean = () => true) => of(name).filter(pick).reduce((a, e) => a + (e.args[field] as bigint), 0n);
  const routed = () => {
    const r = of("Routed").find((e) => e.address === c.router.toLowerCase());
    if (!r) throw new WriteError("the router emitted no Routed event", "receipt");
    return r.args as { tokens: bigint; dollarsIn: bigint; dollarsOut: bigint; refund: bigint; tokensIn: bigint; tokensOut: bigint; positionIds: bigint[] };
  };
  switch (action) {
    case "openLong": {
      const r = routed();
      const spent = r.dollarsIn - r.refund;
      return { gpuHours: toNumber6(r.tokensOut), spent: toNumber6(spent), received: 0, refund: toNumber6(r.refund), avgPrice: r.tokensOut > 0n ? toNumber6((spent * U) / r.tokensOut) : 0, positionIds: [] };
    }
    case "closeLong": {
      const r = routed();
      return { gpuHours: toNumber6(r.tokensIn), spent: 0, received: toNumber6(r.dollarsOut), refund: 0, avgPrice: r.tokensIn > 0n ? toNumber6((r.dollarsOut * U) / r.tokensIn) : 0, positionIds: [] };
    }
    case "openLongDaily": {
      const r = routed();
      const paidNow = sum("PositionOpened", "paidNow");
      const spent = r.dollarsIn - r.refund;
      return { gpuHours: toNumber6(r.tokens), spent: toNumber6(spent), received: toNumber6(paidNow), refund: toNumber6(r.refund), avgPrice: r.tokens > 0n ? toNumber6((spent * U) / r.tokens) : 0, positionIds: r.positionIds.map(String), paidNow: toNumber6(paidNow), restTokens: toNumber6(r.tokensOut) };
    }
    case "closeLongDaily": {
      const r = routed();
      const paid = sum("PositionClosed", "amount");
      return { cost: toNumber6(r.dollarsIn), received: toNumber6(r.dollarsOut - paid), paid: toNumber6(paid) };
    }
    case "openShort": {
      const r = routed();
      const paidNow = sum("PositionOpened", "paidNow");
      const sale = r.dollarsOut - paidNow;
      return { gpuHours: toNumber6(r.tokens), spent: toNumber6(r.dollarsIn), received: toNumber6(r.dollarsOut), refund: 0, avgPrice: r.tokens > 0n ? toNumber6((sale * U) / r.tokens) : 0, positionIds: r.positionIds.map(String), cost: toNumber6(r.dollarsIn) };
    }
    case "closeShort": {
      const r = routed();
      return { spent: toNumber6(r.dollarsIn - r.refund), refund: toNumber6(r.refund), paid: toNumber6(sum("PositionClosed", "amount")), surplusGpuHours: toNumber6(r.tokensOut) };
    }
    case "rollLong": {
      // two Routed events in order: the sale of the old month, then the buy of the new one
      const [sold, bought] = of("Routed").filter((e) => e.address === c.router.toLowerCase()).map((e) => e.args as ReturnType<typeof routed>);
      if (!sold || !bought) throw new WriteError("the roll's batch did not emit both router events", "receipt");
      const spent = bought.dollarsIn - bought.refund;
      return {
        sold: { gpuHours: toNumber6(sold.tokensIn), received: toNumber6(sold.dollarsOut), avgPrice: sold.tokensIn > 0n ? toNumber6((sold.dollarsOut * U) / sold.tokensIn) : 0 },
        bought: { gpuHours: toNumber6(bought.tokensOut), spent: toNumber6(spent), refund: toNumber6(bought.refund), avgPrice: bought.tokensOut > 0n ? toNumber6((spent * U) / bought.tokensOut) : 0 },
        leftOver: toNumber6(sold.dollarsOut - spent),
      };
    }
    case "drip":
      return { amount: toNumber6(sum("Dripped", "amount")) };
    case "claim":
    case "claimAll":
      return { paid: toNumber6(sum("Claimed", "amount")), closed: of("PositionClosed").map((e) => String(e.args.id)), series: new Set(of("Claimed").map((e) => e.address)).size };
    case "settle": {
      const side = (sd: number) => sum("Settled", "paid", (e) => Number(e.args.side) === sd);
      return { paid: toNumber6(side(0) + side(1)), long: toNumber6(side(0)), short: toNumber6(side(1)) };
    }
    case "placeLimit": {
      const created = of("OrderCreated").at(-1)?.args as { orderId: number | bigint } | undefined;
      return { orderId: created ? String(created.orderId) : "" };
    }
    case "cancelLimit":
      return { cancelled: of("OrdersCanceled").flatMap((e) => (e.args.orderId as readonly (number | bigint)[]).map(String)) };
    case "withdrawMargin":
      return {};
    case "redeem":
      return { paid: toNumber6(sum("Redeemed", "paid")) };
  }
}
