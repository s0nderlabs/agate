// The user's journey through every flow, driven only through @agate/client and checked after each step through the
// client's own reads (chain, and the indexer where it serves the data): drip, buy long, sell part, open a short, close
// a short, pay me daily, a limit order placed and cancelled (both sides, the short one minting pairs, then redeemed),
// the same limit orders as the call batches built for a smart account (planPlaceLimit, planCancelLimit, planWithdrawMargin),
// the daily claim after a final day, and the month end (final claims and settle). Time moves only through the world's
// hook (index days written on the fork). Every transaction goes to a loopback anvil fork (assertFork).
import { type Address, createWalletClient, type Hex, http, type Log, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  type AgateClient,
  buyLong,
  cancelLimit,
  claimDaily,
  closeShort,
  createAgateClient,
  drip,
  type Gpu,
  type LimitSummary,
  type Market,
  openLongDaily,
  openShort,
  placeLimit,
  type Plan,
  planCancelLimit,
  planPlaceLimit,
  planWithdrawMargin,
  readResult,
  redeem,
  sellLong,
  settle,
  type TxSummary,
  toNumber6,
  withdrawMargin,
  type WriteError,
  type WriteResult,
} from "../src/index.ts";
import { abi } from "../src/index.ts";
import { assertFork } from "./fork.ts";

export const GAS_GWEI = 102n;

export interface Row {
  step: string;
  label: string;
  hash: string;
  gasLimit: bigint;
  gasUsed: bigint;
  mon: string;
}
export interface Check {
  step: string;
  name: string;
  ok: boolean;
  detail?: unknown;
}

export class Steps {
  rows: Row[] = [];
  checks: Check[] = [];
  constructor(readonly log: (s: string) => void) {}
  txs(step: string, txs: TxSummary[]): void {
    for (const t of txs) this.rows.push({ step, label: t.label, hash: t.hash, gasLimit: t.gasLimit, gasUsed: t.gasUsed, mon: monOf(t.gasLimit) });
  }
  check(step: string, name: string, ok: boolean, detail?: unknown): void {
    this.checks.push({ step, name, ok, detail });
    this.log(`  ${ok ? "pass" : "FAIL"}  ${name}${detail !== undefined && !ok ? `  ${big(detail)}` : ""}`);
  }
  failed(): Check[] {
    return this.checks.filter((c) => !c.ok);
  }
  table(): string {
    const steps = [...new Set([...this.checks.map((c) => c.step), ...this.rows.map((r) => r.step)])];
    const lines = ["| step | transaction | tx hash | gas limit | gas used | MON at 102 gwei | checks passed |", "|---|---|---|---|---|---|---|"];
    for (const s of steps) {
      const cs = this.checks.filter((c) => c.step === s);
      const passed = `${cs.filter((c) => c.ok).length} of ${cs.length}`;
      const rs = this.rows.filter((r) => r.step === s);
      if (rs.length === 0) lines.push(`| ${s} | (reads only) | | | | | ${passed} |`);
      rs.forEach((r, i) => lines.push(`| ${i === 0 ? s : ""} | ${r.label} | ${r.hash} | ${r.gasLimit.toLocaleString("en-US")} | ${r.gasUsed.toLocaleString("en-US")} | ${r.mon} | ${i === 0 ? passed : ""} |`));
    }
    const lim = this.rows.reduce((a, r) => a + r.gasLimit, 0n);
    const used = this.rows.reduce((a, r) => a + r.gasUsed, 0n);
    lines.push(`| total | ${this.rows.length} transactions | | ${lim.toLocaleString("en-US")} | ${used.toLocaleString("en-US")} | ${monOf(lim)} | ${this.checks.filter((c) => c.ok).length} of ${this.checks.length} |`);
    return lines.join("\n");
  }
}

export function monOf(gas: bigint): string {
  const wei = gas * GAS_GWEI * 10n ** 9n;
  return (Number(wei / 10n ** 12n) / 1e6).toFixed(4);
}
export const big = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

/** Hooks the harness gives the journey: index days written up to a day id (time moves to after its T_PEND), and
 *  a wait until the indexer has processed the chain's newest block (null when no indexer is attached). */
export interface Hooks {
  daysTo(day: number): Promise<void>;
  indexed(): Promise<void>;
  waitBooks(gpu: Gpu, month: string): Promise<void>;
}

export interface JourneyOptions {
  rpc: string;
  key: Hex;
  graphqlUrl: string | null;
  factory: string;
  deployments?: import("../src/types.ts").Deployments;
  hooks: Hooks;
  steps: Steps;
}

const GPU: Gpu = "H100";

export async function journey(o: JourneyOptions): Promise<{ client: AgateClient; user: Address }> {
  await assertFork(o.rpc);
  const S = o.steps;
  const c = createAgateClient({ rpcUrl: o.rpc, graphqlUrl: o.graphqlUrl, factory: o.factory, ...(o.deployments ? { deployments: o.deployments } : {}) });
  const account = privateKeyToAccount(o.key);
  const user = account.address;
  const w: WalletClient = createWalletClient({ account, chain: c.chain, transport: http(o.rpc) });
  const say = S.log;
  const step = (name: string) => say(`\n== ${name}`);
  const record = <T>(name: string, r: WriteResult<T>) => {
    S.txs(name, r.txs);
    return r;
  };
  const idx = o.graphqlUrl !== null;

  // ---------------------------------------------------------------- the market as the app first sees it
  let st = "reads: index final, November listed, the maker's book";
  step(st);
  // the indexer first syncs the fork from the index's deploy block: wait until it has the chain's head (the listing)
  if (idx) await o.hooks.indexed();
  const ms = await c.getMarkets();
  const h100 = ms.find((m) => m.gpu === GPU)!;
  S.check(st, "six GPUs returned; B300, A100, L40S are price only (no series, not tradable)", ms.length === 6 && ms.filter((m) => !m.tradable).map((m) => m.gpu).join() === "B300,A100,L40S" && ms.filter((m) => !m.tradable).every((m) => m.series.length === 0));
  // the newest final day: 2026-10-04 on a fork written from the start, a later day on a fork of the live index
  const newest = h100.priceDate ?? "";
  S.check(st, "every GPU has a final price for the same newest day (2026-10-04 or later) with its sources and n of N clouds", newest >= "2026-10-04" && ms.every((m) => m.priceDate === newest && m.price > 0 && m.liveCount > 0 && m.liveCount <= m.panelSize && m.sources.length > 0), ms.map((m) => ({ gpu: m.gpu, price: m.price, date: m.priceDate, live: m.liveCount, of: m.panelSize, sources: m.sources.length })));
  // the price itself is whatever the newest final day says ($3.99 on a fork written from the start; the live median
  // on a later fork, Verda's daily rises can move it): the panel check below ties it to the five live clouds
  S.check(st, `H100: $${h100.price} from five live clouds of six (the reserve is not counted)`, h100.price > 0 && h100.liveCount === 5 && h100.panelSize === 6 && h100.sources.filter((s) => s.live).length === 5, { price: h100.price, live: h100.liveCount, sources: h100.sources });
  // the five live clouds' day values (the fork's own readings, plus whatever slices the live writers had posted before
  // the fork block): their median is the index price
  const livePrices = h100.panel.filter((p) => p.live).map((p) => p.price ?? 0).sort((a, b) => a - b);
  S.check(st, "H100's panel: six slots in index order, Hyperstack the reserve with no reading, the median of the five live clouds is the price", h100.panel.length === 6 && h100.panel.map((p) => p.family).join() === "Verda,Nebius,Lambda,CoreWeave,Civo,Hyperstack" && h100.panel[5]!.reserve && h100.panel[5]!.price === null && !h100.panel[5]!.live && livePrices.length === 5 && livePrices[2] === h100.price && h100.panel.slice(0, 5).every((p) => !p.reserve), h100.panel);
  S.check(st, `history is the real days only (no example days), from 2026-10-04 to the newest final day (${newest})`, h100.history.length >= 1 && h100.history.every((d) => !d.example && d.date >= "2026-10-04") && h100.history.at(-1)!.date === newest, h100.history);
  const nov = h100.series.find((s) => s.month === "2026-11");
  S.check(st, "October never lists (the index started Oct 4); November is listed and trading, band 0.5x/2x of $3.99 on the $0.05 grid: $1.95 to $8.00", !h100.series.some((s) => s.month === "2026-10") && !!nov && nov.phase === "trading" && nov.floor === 1.95 && nov.cap === 8 && nov.symbol === "H100-NOV26" && nov.name === "agate H100 Nov 2026", nov);
  S.check(st, "November closes at the month's end; listedAt from the indexer", nov?.closesAt === "2026-12-01T00:00:00Z" && nov?.startsAt === "2026-11-01T00:00:00Z" && (idx ? nov.listedAt !== "" : true), { closesAt: nov?.closesAt, listedAt: nov?.listedAt });
  const book0 = await c.book(GPU, "2026-11");
  // the maker quotes about 1% around its fair (the index price before the month): 3.95 / 4.03 around 3.99
  const fair = h100.price;
  // the maker's 1,000 / 2,000 / 4,000 GPU-hours, a level partly taken by trades on the live market before the fork
  const ladder = (lv: { price: number; size: number }[], dir: 1 | -1) => lv.length === 3 && lv.every((l, i) => l.size > 0 && l.size <= [1000, 2000, 4000][i]! + 1e-6 && (i === 0 || near(l.price - lv[i - 1]!.price, dir * 0.01, 0.0001)));
  const [bid0, ask0] = [book0.bids[0]?.price ?? 0, book0.asks[0]?.price ?? 0];
  S.check(st, `the book is the maker's real ladder: 3 levels a tick apart each side, up to 1,000 / 2,000 / 4,000 GPU-hours, about 1% around fair ${fair}`, ladder(book0.bids, -1) && ladder(book0.asks, 1) && bid0 < fair && fair < ask0 && Math.abs((bid0 + ask0) / 2 - fair) <= 0.01 && near(book0.spread, ask0 - bid0) && ask0 - bid0 <= fair * 0.025, book0);
  // before any trade `last` is the mid; a fork of the live market read with its indexer may already hold trades
  const q0 = nov?.quote;
  S.check(st, "the quote is the top of book; before any trade `last` is the mid and lastAt is null", q0?.bid === bid0 && q0?.ask === ask0 && (q0?.lastAt === null ? near(q0.last, (bid0 + ask0) / 2, 0.005) : (q0?.last ?? 0) > 0), q0);
  const c0 = await c.chainTime();
  // the next day (newest + 1) closes after its end (about 01:00 UTC the day after; once posted, when it was posted, late
  // if the writer was) and turns final T_PEND (6 h) later at the earliest
  const closeAt = Date.parse(h100.nextCloseAt);
  const finalAt = Date.parse(h100.nextUpdateAt);
  const nextDayEnds = Date.parse(`${newest}T00:00:00Z`) + 2 * 86_400_000;
  S.check(st, "nextCloseAt is the next day's close (after its end, about 01:00 UTC); nextUpdateAt is T_PEND (6 h) after it at the earliest, still ahead", closeAt >= nextDayEnds && finalAt - closeAt >= 6 * 3_600_000 && finalAt > Number(c0) * 1000, { nextUpdateAt: h100.nextUpdateAt, nextCloseAt: h100.nextCloseAt, chainTime: new Date(Number(c0) * 1000).toISOString() });

  // ---------------------------------------------------------------- the faucet
  st = "drip";
  step(st);
  const w0 = await c.getWallet(user);
  const d = record(st, await drip(c, w));
  const w1 = await c.getWallet(user);
  S.check(st, "drip pays 10,000 tUSD; the next drip opens a day later; canDrip turns false", d.result.amount === 10_000 && near(w1.balance - w0.balance, 10_000) && !w1.canDrip && w1.lastDrip !== null && w1.nextDrip !== null && Date.parse(w1.nextDrip) - Date.parse(w1.lastDrip) === 86_400_000, { before: w0.balance, after: w1.balance, lastDrip: w1.lastDrip, nextDrip: w1.nextDrip });
  let refused = "";
  try {
    await drip(c, w);
  } catch (e) {
    refused = (e as Error).message;
  }
  S.check(st, "a second drip is refused before anything is sent", refused.includes("next drip opens"), refused);

  // ---------------------------------------------------------------- Long
  st = "buy long $1,000";
  step(st);
  // the app passes the ask it showed: the buy is bounded by it (less the slippage) as well as by the fresh quote
  const shownAsk = (await c.book(GPU, "2026-11")).asks[0]!.price;
  const b = record(st, await buyLong(c, w, { gpu: GPU, month: "2026-11", dollars: "1000", maxPrice: String(shownAsk) }));
  const w2 = await c.getWallet(user);
  const held = w2.positions.find((p) => p.kind === "tokens" && p.month === "2026-11");
  S.check(st, `bought at the best ask ${shownAsk}: $1,000 / ${shownAsk} GPU-hours for $999.99 or less, the unused quote refunded`, near(b.result.avgPrice, shownAsk, 0.0001) && near(b.result.gpuHours, 1000 / shownAsk, 0.0001) && b.result.spent <= 1000 && near(b.result.spent + b.result.refund, 1000), b.result);
  S.check(st, "the wallet holds the tokens; dollars down by exactly what was spent", !!held && near(held.q, b.result.gpuHours) && near(w1.balance - w2.balance, b.result.spent), { held, spent: b.result.spent, delta: w1.balance - w2.balance });
  if (idx) {
    await o.hooks.indexed();
    const w2i = await c.getWallet(user);
    const fills = await c.recentFills(GPU, "2026-11");
    const candles = await c.candles(GPU, "2026-11");
    S.check(st, `indexer: the fill is the newest (taker buy at ${shownAsk}, size in GPU-hours); the entry price is ${shownAsk}`, fills[0]?.side === "buy" && fills[0]?.price === shownAsk && near(fills[0]?.size ?? 0, b.result.gpuHours) && near(w2i.positions.find((p) => p.kind === "tokens")?.entry ?? 0, shownAsk), { fill: fills[0], entry: w2i.positions.find((p) => p.kind === "tokens")?.entry });
    // the newest hourly candle closes at the trade and holds its size (a fork of the live market may hold older trades)
    S.check(st, `indexer: the newest hourly candle holds the trade (c = ${shownAsk})`, candles.length >= 1 && candles.at(-1)!.c === shownAsk && candles.at(-1)!.v >= b.result.gpuHours - 0.0001, candles.slice(-3));
    const s2 = (await c.getMarket(GPU)).series.find((s) => s.month === "2026-11")!;
    S.check(st, "the quote's last is the trade now (lastAt set); open interest counts the tokens outstanding", s2.quote?.last === shownAsk && s2.quote?.lastAt !== null && s2.openInterest >= b.result.gpuHours, { quote: s2.quote, openInterest: s2.openInterest });
  }

  st = "sell 100 GPU-hours";
  step(st);
  await o.hooks.waitBooks(GPU, "2026-11");
  const bk = await c.book(GPU, "2026-11");
  const s1 = record(st, await sellLong(c, w, { gpu: GPU, month: "2026-11", gpuHours: "100", minPrice: String(bk.bids[0]!.price) }));
  const w3 = await c.getWallet(user);
  S.check(st, `sold into the best bid exactly: 100 x ${bk.bids[0]?.price} (fill-or-kill)`, near(s1.result.received, 100 * (bk.bids[0]?.price ?? 0)) && near(s1.result.gpuHours, 100), s1.result);
  S.check(st, "the wallet's tokens fell by 100 and dollars rose by the proceeds", near(w3.positions.find((p) => p.kind === "tokens")!.q, b.result.gpuHours - 100) && near(w3.balance - w2.balance, s1.result.received), { tokens: w3.positions.find((p) => p.kind === "tokens")?.q, delta: w3.balance - w2.balance });

  // ---------------------------------------------------------------- the guards: refused before anything is sent
  st = "guards: stale prices, a crossing post-only order, a buy beyond the asks, a short wallet; nothing sent";
  step(st);
  await o.hooks.waitBooks(GPU, "2026-11");
  const nonce0 = await c.pub.getTransactionCount({ address: user, blockTag: "latest" });
  const refusal = async (f: () => Promise<unknown>) => {
    try {
      await f();
      return null;
    } catch (e) {
      return e as WriteError;
    }
  };
  const gb = await c.book(GPU, "2026-11");
  const r1 = await refusal(() => buyLong(c, w, { gpu: GPU, month: "2026-11", dollars: "100", maxPrice: "3.50" }));
  S.check(st, `a buy the app priced at $3.50 while the ask is $${gb.asks[0]?.price} is refused with the fresh quote`, r1?.stage === "check" && r1.reason === "PriceMoved" && r1.quote?.avgPrice !== undefined && near(r1.quote.avgPrice, gb.asks[0]!.price, 0.0001) && r1.txs.length === 0, { reason: r1?.reason, quote: r1?.quote, message: r1?.message });
  const r2 = await refusal(() => sellLong(c, w, { gpu: GPU, month: "2026-11", gpuHours: "10", minPrice: "4.50" }));
  S.check(st, `a sale the app priced at $4.50 while the bid is $${gb.bids[0]?.price} is refused with the fresh quote`, r2?.stage === "check" && r2.reason === "PriceMoved" && near(r2.quote?.avgPrice ?? 0, gb.bids[0]!.price, 0.0001), { reason: r2?.reason, quote: r2?.quote });
  const r3 = await refusal(() => placeLimit(c, w, { gpu: GPU, month: "2026-11", side: "long", price: gb.asks[0]!.price.toFixed(2), gpuHours: "10" }));
  S.check(st, "a post-only bid at the best ask is refused before the approve and the deposit", r3?.stage === "check" && r3.reason === "PostOnlyError", { reason: r3?.reason, message: r3?.message });
  const r4 = await refusal(() => placeLimit(c, w, { gpu: GPU, month: "2026-11", side: "long", price: "8.05", gpuHours: "10" }));
  S.check(st, "a limit price above what a token can pay ($8.00, the cap) is refused", !!r4 && r4.message.includes("band"), { message: r4?.message });
  // a buy beyond the asks at or under the cap (every ask of the maker's is): Kuru's buy is not fill-or-kill, so the
  // rest would meet whatever asks stood above; refused, naming the most it may spend
  const depth = gb.asks.reduce((a, l) => a + l.price * l.size, 0);
  const ask5 = String(Math.ceil(depth) + 1000);
  const r5 = await refusal(() => buyLong(c, w, { gpu: GPU, month: "2026-11", dollars: ask5 }));
  S.check(st, `a buy of $${ask5}, more than the asks hold ($${depth.toFixed(2)}), is refused, naming the most it may spend`, r5?.stage === "check" && r5.reason === "ThinBook" && !!r5.quote && near(r5.quote.dollars, depth, 100) && r5.message.includes(`buy at most $${r5.quote.dollars}`) && r5.txs.length === 0, { reason: r5?.reason, quote: r5?.quote, message: r5?.message });
  // a buy the wallet cannot pay: refused before its approval (no approve and put-back paid for nothing)
  const bal = (await c.getWallet(user)).balance;
  const ask6 = String(Math.floor(bal) + 1);
  const r6 = await refusal(() => buyLong(c, w, { gpu: GPU, month: "2026-11", dollars: ask6 }));
  S.check(st, `a buy of $${ask6} with $${bal} in the wallet is refused before its approval`, r6?.stage === "check" && r6.reason === "InsufficientBalance" && r6.txs.length === 0, { reason: r6?.reason, message: r6?.message });
  const nonce1 = await c.pub.getTransactionCount({ address: user, blockTag: "latest" });
  S.check(st, "nothing was sent: the user's nonce is unchanged", nonce1 === nonce0, { nonce0, nonce1 });

  // ---------------------------------------------------------------- Short
  st = "open short 48 GPU-hours (2 daily positions)";
  step(st);
  await o.hooks.waitBooks(GPU, "2026-11");
  const bk2 = await c.book(GPU, "2026-11");
  const sh = record(st, await openShort(c, w, { gpu: GPU, month: "2026-11", gpuHours: "48", parts: 2, daily: true }));
  const w4 = await c.getWallet(user);
  const shorts = w4.positions.filter((p) => p.kind === "position" && p.side === "short");
  S.check(st, "puts up 48 x $8.00 = $384, sells 48 at the best bid; nets the cap minus the sale", sh.result.cost === 384 && near(sh.result.received, 48 * (bk2.bids[0]?.price ?? 0)) && near(w4.balance - w3.balance, sh.result.received - 384), { result: sh.result, delta: w4.balance - w3.balance });
  S.check(st, "two short positions of 24 GPU-hours each, paid daily, owned and paid to the user, nothing paid yet (before the month)", shorts.length === 2 && shorts.every((p) => p.q === 24 && p.daily && p.paid === 0 && p.payee === user.toLowerCase()), shorts);
  if (idx) {
    await o.hooks.indexed();
    const wi = await c.getWallet(user);
    const ws = wi.positions.filter((p) => p.kind === "position" && p.side === "short");
    S.check(st, "indexer: each short's entry is the sale price; openedAt set", ws.length === 2 && ws.every((p) => near(p.entry, bk2.bids[0]?.price ?? 0) && p.openedAt !== ""), ws);
  }

  st = "close one short";
  step(st);
  await o.hooks.waitBooks(GPU, "2026-11");
  const target = shorts[0]!;
  const cs = record(st, await closeShort(c, w, { gpu: GPU, month: "2026-11", positionIds: [target.positionId!] }));
  const w5 = await c.getWallet(user);
  S.check(st, "the series pays the owner 24 x $8.00 - 0 = $192; the buy-back's unused quote is refunded", cs.result.paid === 192 && cs.result.spent > 0 && near(w5.balance - w4.balance, 192 - cs.result.spent), { result: cs.result, delta: w5.balance - w4.balance });
  S.check(st, "that position is gone, the other stays", !w5.positions.some((p) => p.positionId === target.positionId) && w5.positions.filter((p) => p.kind === "position" && p.side === "short").length === 1);

  // ---------------------------------------------------------------- pay me daily
  st = "long, pay me daily, $500 in 2 parts";
  step(st);
  await o.hooks.waitBooks(GPU, "2026-11");
  const ld = record(st, await openLongDaily(c, w, { gpu: GPU, month: "2026-11", dollars: "500", parts: 2 }));
  const w6 = await c.getWallet(user);
  const longs = w6.positions.filter((p) => p.kind === "position" && p.side === "long");
  const per = longs[0]?.q ?? 0;
  S.check(st, "two daily long positions of equal size; the floor for every day ($1.95 each) paid at once", longs.length === 2 && longs.every((p) => p.daily && p.q === per && near(p.paid, per * 1.95)) && near(ld.result.paidNow, 2 * per * 1.95), { longs, paidNow: ld.result.paidNow });
  S.check(st, "the remainder under one LOT per part stays as tokens; dollars moved by -spent + paidNow", near(w6.balance - w5.balance, ld.result.paidNow - ld.result.spent) && ld.result.restTokens < 0.0002, { rest: ld.result.restTokens, delta: w6.balance - w5.balance });

  // ---------------------------------------------------------------- pro: limit orders
  // resting prices a little outside the opening book (3.90 and 4.10 around 3.95 / 4.03), so they never cross it
  const lp = Math.round((bid0 - 0.05) * 100) / 100;
  const sp = Math.round((ask0 + 0.07) * 100) / 100;
  st = `limit long 10 GPU-hours at $${lp.toFixed(2)}, then cancel`;
  step(st);
  const lb = record(st, await placeLimit(c, w, { gpu: GPU, month: "2026-11", side: "long", price: lp.toFixed(2), gpuHours: "10" }));
  const bkL = await c.book(GPU, "2026-11");
  S.check(st, `deposits exactly 10 x ${lp.toFixed(2)} into Kuru's margin account and rests a bid at ${lp.toFixed(2)}`, near(lb.result.deposited, 10 * lp) && bkL.bids.some((x) => x.price === lp && x.size >= 10), { deposited: lb.result.deposited, bids: bkL.bids });
  if (idx) await o.hooks.indexed();
  const oo = await c.openOrders(user);
  S.check(st, `openOrders lists it (id ${lb.result.orderId}, long, ${lp.toFixed(2)}, 10 GPU-hours)${idx ? ", from the indexer, checked on chain" : ", from the chain"}`, oo.length === 1 && oo[0]!.id === lb.result.orderId && oo[0]!.side === "long" && oo[0]!.price === lp && oo[0]!.q === 10 && (idx ? oo[0]!.placedAt !== "" : true), oo);
  const cl = record(st, await cancelLimit(c, w, { gpu: GPU, month: "2026-11", orderIds: [lb.result.orderId] }));
  if (idx) await o.hooks.indexed();
  const oo2 = await c.openOrders(user);
  const wm = await c.getWallet(user);
  S.check(st, `cancelled: no open order; the $${(10 * lp).toFixed(2)} is back in the margin account`, cl.result.cancelled.length === 1 && oo2.length === 0 && near(wm.marginBalance, 10 * lp), { cancelled: cl.result, open: oo2, margin: wm.marginBalance });
  const wd = record(st, await withdrawMargin(c, w, { asset: "dollar" }));
  const wm2 = await c.getWallet(user);
  S.check(st, `withdrawn: margin 0, the wallet up $${(10 * lp).toFixed(2)}`, near(wd.result.amount, 10 * lp) && wm2.marginBalance === 0 && near(wm2.balance - wm.balance, 10 * lp), { margin: wm2.marginBalance, delta: wm2.balance - wm.balance });

  st = `limit short 10 GPU-hours at $${sp.toFixed(2)} (mints pairs), cancel, redeem`;
  step(st);
  const ls = record(st, await placeLimit(c, w, { gpu: GPU, month: "2026-11", side: "short", price: sp.toFixed(2), gpuHours: "10", mint: true }));
  const wls = await c.getWallet(user);
  S.check(st, `mints 10 pairs (10 x $8.00 = $80 to the series), deposits the 10 tokens and rests an ask at ${sp.toFixed(2)}; the short side stays in the wallet's short balance`, ls.result.minted === 10 && ls.result.deposited === 10 && near(wm2.balance - wls.balance, 80) && wls.positions.some((p) => p.kind === "shortBalance" && p.q === 10), { result: ls.result, positions: wls.positions.filter((p) => p.kind === "shortBalance") });
  if (idx) await o.hooks.indexed();
  const oo3 = await c.openOrders(user);
  S.check(st, `openOrders lists the ask (short, ${sp.toFixed(2)}, 10)`, oo3.length === 1 && oo3[0]!.side === "short" && oo3[0]!.price === sp && oo3[0]!.q === 10, oo3);
  if (idx) {
    const we = await c.getWallet(user);
    const sb = we.positions.find((p) => p.kind === "shortBalance");
    const tk = we.positions.find((p) => p.kind === "tokens");
    S.check(st, "indexer: the short balance's entry is 0 (none of its asks filled yet), never another flow's sale price; held tokens' entry is the buyLong price", sb?.entry === 0 && near(tk?.entry ?? 0, b.result.avgPrice, 0.0001), { shortBalance: sb, tokens: tk });
  }
  record(st, await cancelLimit(c, w, { gpu: GPU, month: "2026-11", orderIds: [ls.result.orderId] }));
  const wc = await c.getWallet(user);
  const heldC = wc.positions.find((p) => p.kind === "tokens")!;
  S.check(st, "cancelled: the 10 tokens are back in Kuru's margin account and the wallet counts them (inMargin 10)", heldC.inMargin === 10 && near(heldC.q - heldC.inMargin, wls.positions.find((p) => p.kind === "tokens")!.q), heldC);
  record(st, await withdrawMargin(c, w, { asset: { gpu: GPU, month: "2026-11" } }));
  const heldW = (await c.getWallet(user)).positions.find((p) => p.kind === "tokens")!;
  const tokBefore = heldW.q;
  S.check(st, "withdrawn: the same tokens, all in the wallet now (inMargin 0)", heldW.inMargin === 0 && near(heldW.q, heldC.q), heldW);
  const rd = record(st, await redeem(c, w, { gpu: GPU, month: "2026-11", gpuHours: "10" }));
  const wr = await c.getWallet(user);
  S.check(st, "after cancel and withdraw, 10 pairs redeem for exactly 10 x $8.00 = $80; no short balance left", rd.result.paid === 80 && !wr.positions.some((p) => p.kind === "shortBalance") && near(tokBefore - wr.positions.find((p) => p.kind === "tokens")!.q, 10) && (await c.openOrders(user)).length === 0, { paid: rd.result.paid });

  // ---------------------------------------------------------------- pro: the same limits as call batches
  // planPlaceLimit, planCancelLimit and planWithdrawMargin build what a smart main account would send as one batch
  // (the app's Pro ticket does not use them yet; an AI pocket cannot, its session key allows only the router); here
  // the plain account sends each call in order, which runs the same calls against the same contracts
  st = `limit orders as call batches (smart accounts): a bid at $${lp.toFixed(2)} and a minted ask at $${sp.toFixed(2)}, cancelled, then the margin withdrawn`;
  step(st);
  const runPlan = async (plan: Plan<LimitSummary>) => {
    const logs: Log[] = [];
    for (const call of plan.calls) {
      const hash = await w.sendTransaction({ account: account, chain: c.chain, to: call.to, data: call.data, value: call.value });
      const rc = await c.pub.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error(`${plan.summary.action}: ${call.label} reverted (${hash})`);
      // the gas limit is what Monad bills: read it from the sent transaction for the step table
      const sent = await c.pub.getTransaction({ hash });
      const tx: TxSummary = { label: `${call.label} (batch)`, hash, to: call.to, gasLimit: sent.gas, gasUsed: rc.gasUsed, block: rc.blockNumber, events: [] };
      S.txs(st, [tx]);
      logs.push(...rc.logs);
    }
    return readResult(c, plan.summary.action, logs);
  };
  const w0p = await c.getWallet(user);
  const pb = await planPlaceLimit(c, user, { gpu: GPU, month: "2026-11", side: "long", price: lp.toFixed(2), gpuHours: "10" });
  S.check(st, `the bid's batch: deposit 10 x ${lp.toFixed(2)} into Kuru's margin account (after an approve when the allowance is short), then addBuyOrder`, pb.calls.at(-1)?.label === "addBuyOrder" && pb.calls.some((x) => x.label === "deposit tUSD into Kuru") && near(pb.summary.deposited ?? 0, 10 * lp), pb.summary);
  const bidId = String((await runPlan(pb)).orderId ?? "");
  const pa = await planPlaceLimit(c, user, { gpu: GPU, month: "2026-11", side: "short", price: sp.toFixed(2), gpuHours: "10", mint: true });
  S.check(st, "the ask's batch mints 10 pairs, deposits the 10 tokens and adds the sell order", pa.summary.minted === 10 && pa.summary.deposited === 10 && pa.calls.at(-1)?.label === "addSellOrder", pa.summary);
  const askId = String((await runPlan(pa)).orderId ?? "");
  const ooP = await c.openOrders(user);
  S.check(st, `both orders rest in the book (ids ${bidId}, ${askId}): a long at ${lp.toFixed(2)} and a short at ${sp.toFixed(2)}, 10 GPU-hours each`, bidId !== "" && askId !== "" && ooP.length === 2 && ooP.some((x) => x.id === bidId && x.side === "long" && x.price === lp && x.q === 10) && ooP.some((x) => x.id === askId && x.side === "short" && x.price === sp && x.q === 10), ooP);
  const pc = await planCancelLimit(c, user, { gpu: GPU, month: "2026-11", orderIds: [bidId, askId, "999999999"], withdraw: false });
  S.check(st, "the cancel batch cancels both in one call and leaves out an id that is not the account's", pc.calls.length === 1 && pc.summary.cancelled?.length === 2 && big(pc.summary.skipped) === big(["999999999"]), pc.summary);
  const cr = await runPlan(pc);
  const wcP = await c.getWallet(user);
  S.check(st, `cancelled: no open order; $${(10 * lp).toFixed(2)} and the 10 tokens wait in Kuru's margin account`, (cr.cancelled as string[] | undefined)?.length === 2 && (await c.openOrders(user)).length === 0 && near(wcP.marginBalance, 10 * lp) && wcP.positions.find((p) => p.kind === "tokens")?.inMargin === 10, { cancelled: cr.cancelled, margin: wcP.marginBalance });
  await runPlan(await planWithdrawMargin(c, user, { asset: "dollar" }));
  await runPlan(await planWithdrawMargin(c, user, { asset: { gpu: GPU, month: "2026-11" } }));
  const wwP = await c.getWallet(user);
  const tokP = (wx: typeof wwP) => wx.positions.find((p) => p.kind === "tokens");
  S.check(st, "withdrawn: margin 0 for both; the wallet is down exactly the 10 minted pairs ($80), now 10 extra tokens and a short balance of 10", wwP.marginBalance === 0 && tokP(wwP)?.inMargin === 0 && near(w0p.balance - wwP.balance, 80) && near((tokP(wwP)?.q ?? 0) - (tokP(w0p)?.q ?? 0), 10) && wwP.positions.some((p) => p.kind === "shortBalance" && near(p.q, 10)), { before: w0p.balance, after: wwP.balance, short: wwP.positions.find((p) => p.kind === "shortBalance") });
  const rdP = record(st, await redeem(c, w, { gpu: GPU, month: "2026-11", gpuHours: "10" }));
  S.check(st, "the 10 pairs redeem for $80: the wallet is back where it started", rdP.result.paid === 80 && near((await c.getWallet(user)).balance, w0p.balance), { paid: rdP.result.paid });

  // ---------------------------------------------------------------- a day of November final: the daily claim
  st = "Nov 1 final (time travel), the daily claim";
  step(st);
  await o.hooks.daysTo(20758);
  const wBefore = await c.getWallet(user);
  const mk = await c.getMarket(GPU);
  const nov1 = mk.series.find((s) => s.month === "2026-11")!;
  S.check(st, "November is paying with one day applied (k 1, S $3.99); the index's newest final day is 2026-11-01", nov1.phase === "paying" && nov1.k === 1 && nov1.S === 3.99 && mk.priceDate === "2026-11-01", { phase: nov1.phase, k: nov1.k, S: nov1.S, priceDate: mk.priceDate });
  const dec = mk.series.find((s) => s.month === "2026-12");
  S.check(st, "December is the next month: listed by the lister (RULE band from Oct 27 to 31) or upcoming with its listing time", !!dec && (dec.phase === "trading" || dec.phase === "upcoming"), dec);
  const due = wBefore.positions.filter((p) => p.kind === "position" && p.claimable > 0);
  // what each should get, from the contract's rule (MS 4.5): long q (S + (N - k) F) / N - paid, short q (k C - S) / N - paid
  const want = due.reduce((a, p) => a + (p.side === "long" ? (p.q * (3.99 + 29 * 1.95)) / 30 - p.paid : (p.q * (8 - 3.99)) / 30 - p.paid), 0);
  const cd = record(st, await claimDaily(c, w));
  const wAfter = await c.getWallet(user);
  S.check(st, "claims every daily position with something due (2 long, 1 short) in one claimMany: (3.99 - 1.95) / 30 per long GPU-hour, (8.00 - 3.99) / 30 per short GPU-hour", due.length === 3 && near(cd.result.paid, want, 0.00001) && near(wAfter.balance - wBefore.balance, cd.result.paid), { due: due.map((p) => ({ side: p.side, q: p.q, claimable: p.claimable })), paid: cd.result.paid, want });
  S.check(st, "after the claim nothing is claimable and paid grew", wAfter.positions.filter((p) => p.kind === "position").every((p) => p.claimable === 0));
  if (idx) {
    await o.hooks.indexed();
    const hist = (await c.getMarket(GPU)).history;
    S.check(st, "indexer: the history holds 2026-10-04 to 2026-11-01, every day final", hist.length === 29 && hist[0]!.date === "2026-10-04" && hist.at(-1)!.date === "2026-11-01" && hist.every((x) => x.status === "final" && !x.example), { days: hist.length, first: hist[0], last: hist.at(-1) });
  }

  // ---------------------------------------------------------------- the month end
  st = "month end: final claims and settle";
  step(st);
  await o.hooks.daysTo(20787);
  const ser = (await c.getSeries(GPU)).find((s) => s.month === "2026-11")!;
  S.check(st, "November settled: every day applied (k 30, S = 30 x $3.99)", ser.phase === "settled" && ser.k === 30 && near(ser.S, 119.7), { phase: ser.phase, k: ser.k, S: ser.S });
  const wE = await c.getWallet(user);
  const open = wE.positions.filter((p) => p.kind === "position");
  const wantFinal = open.reduce((a, p) => a + (p.side === "long" ? p.q * 3.99 - p.paid : p.q * (8 - 3.99) - p.paid), 0);
  const fc = record(st, await claimDaily(c, w));
  const wF = await c.getWallet(user);
  S.check(st, "the final claims pay each position the rest of its month and close it (long $3.99, short $4.01 per GPU-hour in all)", near(fc.result.paid, wantFinal, 0.00001) && !wF.positions.some((p) => p.kind === "position") && fc.txs.flatMap((t) => t.events).filter((e) => e.name === "PositionClosed").length === open.length, { paid: fc.result.paid, want: wantFinal });
  const tokens = wF.positions.find((p) => p.kind === "tokens")!;
  const se = record(st, await settle(c, w, { gpu: GPU, month: "2026-11" }));
  const wS = await c.getWallet(user);
  S.check(st, `settles the ${tokens.q} held GPU-hours at S / N = $3.99 each`, near(se.result.long, Math.floor(tokens.q * 3.99 * 1e6) / 1e6) && !wS.positions.some((p) => p.month === "2026-11") && near(wS.balance - wF.balance, se.result.paid), { settled: se.result, q: tokens.q });
  if (idx) {
    await o.hooks.indexed();
    const rows = await c.gql!.query<{ Position: { status: string }[]; Settle: { paid: string }[]; Claim: { amount: string }[] }>(
      `query($a: String!) { Position(where: {owner_id: {_eq: $a}}) { status } Settle(where: {holder_id: {_eq: $a}}) { paid } Claim(where: {payee_id: {_eq: $a}}) { amount } }`,
      { a: user.toLowerCase() },
    );
    S.check(st, "indexer: the user's positions are closed (1 with token, 3 final), its claims and its settle are rows", rows.Position.filter((p) => p.status === "CLOSED_FINAL").length === 3 && rows.Position.filter((p) => p.status === "CLOSED_WITH_TOKEN").length === 1 && rows.Settle.length === 1 && rows.Claim.length === 6, rows);
  }
  const lastFills = idx ? await c.recentFills(GPU, "2026-11", 500) : [];
  const ticker = await c.ticker();
  S.check(st, "reads after the month: ticker answers for every priced GPU and listed month; fills hold the user's trades", ticker.length >= 6 && (!idx || lastFills.some((f) => f.side === "sell")), { ticker, fills: lastFills.length });
  return { client: c, user };
}

export function readAbi() {
  return abi;
}

export function moneyOf(m: Market): number {
  return toNumber6(BigInt(Math.round(m.price * 1e6)));
}
