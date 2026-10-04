// Kuru V1 books in our units (BOTS-SPEC 1): getL2Book's words, the app's Book shape, and the walks a quote needs.
// Prices are u per token (pricePrecision 10^6), sizes Kuru size units (10^4 per token).
import { type Hex, hexToBigInt } from "viem";
import type { Book, BookLevel } from "./types.ts";
import { LOT, SIZE_PER_TOKEN, toNumber6, unitsToHours } from "./units.ts";

/** A book as the chain gives it: [price u, size units] per level, best first on each side. */
export interface RawBook {
  block: bigint;
  bids: [bigint, bigint][];
  asks: [bigint, bigint][];
}

/** getL2Book's bytes: 32-byte words; the block number, (price, size) pairs of the bids best first, a zero word, then
 *  the asks best first. The same decoding as the bots' (wall/packages/market/src/reads.ts). */
export function decodeL2Book(data: Hex): RawBook {
  const hex = data.slice(2);
  const words: bigint[] = [];
  for (let i = 0; i + 64 <= hex.length; i += 64) words.push(hexToBigInt(`0x${hex.slice(i, i + 64)}`));
  const book: RawBook = { block: words[0] ?? 0n, bids: [], asks: [] };
  let i = 1;
  let side: "bids" | "asks" = "bids";
  while (i < words.length) {
    const price = words[i]!;
    if (side === "bids" && price === 0n) {
      side = "asks";
      i += 1;
      continue;
    }
    if (i + 1 >= words.length) break;
    book[side].push([price, words[i + 1]!]);
    i += 2;
  }
  return book;
}

const level = ([p, s]: [bigint, bigint]): BookLevel => ({ price: toNumber6(p), size: unitsToHours(s) });

/** The app's Book: asks rising from the best ask, bids falling from the best bid, sizes in GPU-hours. */
export function toBook(raw: RawBook): Book {
  const asks = raw.asks.map(level);
  const bids = raw.bids.map(level);
  const spread = raw.asks.length && raw.bids.length ? toNumber6(raw.asks[0]![0] - raw.bids[0]![0]) : 0;
  return { asks, bids, spread };
}

export class DepthError extends Error {
  override name = "DepthError";
}

/** What selling `tokens` (base units, a multiple of LOT) into the bids pays, exactly as Kuru pays a sell: each level
 *  `price * units / 10^4` u. Throws DepthError when the bids hold less (the router's sells are fill-or-kill). */
export function sellProceeds(bids: [bigint, bigint][], tokens: bigint): { dollars: bigint; levels: number } {
  if (tokens % LOT !== 0n) throw new DepthError("a sale must be a multiple of 0.0001 GPU-hour");
  let left = tokens / LOT;
  let dollars = 0n;
  let levels = 0;
  for (const [p, s] of bids) {
    if (left === 0n) break;
    const take = left < s ? left : s;
    dollars += (p * take) / SIZE_PER_TOKEN;
    left -= take;
    levels++;
  }
  if (left > 0n) throw new DepthError(`the bids hold ${unitsToHours(tokens / LOT - left)} GPU-hours, the sale needs ${unitsToHours(tokens / LOT)}`);
  return { dollars, levels };
}

/** Kuru's market buy of `quote` u into the asks (MS 6.5, Kuru's `_marketBuyMatch` before its taker fee): the quote
 *  left turns into whole units at each level, and when a level runs out the quote left is re-derived from the units
 *  left at that level's price. Returns the tokens (base units) it buys and the quote it uses: all of it, unless the
 *  asks run out first (Kuru returns the rest; a remainder under one unit's cost is used up, Kuru keeps it). */
export function buyFill(asks: [bigint, bigint][], quote: bigint): { tokens: bigint; spent: bigint } {
  let quoteLeft = quote;
  let got = 0n;
  for (const [p, s] of asks) {
    const units = (quoteLeft * SIZE_PER_TOKEN) / p;
    if (units <= s) return { tokens: (got + units) * LOT, spent: quote };
    got += s;
    quoteLeft = (p * (units - s)) / SIZE_PER_TOKEN;
  }
  return { tokens: got * LOT, spent: quote - quoteLeft };
}

/** The tokens (base units) Kuru's market buy of `quote` u gets from the asks (buyFill). */
export function buyTokens(asks: [bigint, bigint][], quote: bigint): bigint {
  return buyFill(asks, quote).tokens;
}

/** What the asks priced at or under `topNum / n` (u per token, a fraction) hold: those levels (best first, so a
 *  prefix) and their cost in u, exact (a price on the tick times whole units). */
export function asksUpTo(asks: [bigint, bigint][], topNum: bigint, n: bigint): { levels: [bigint, bigint][]; dollars: bigint } {
  let i = 0;
  let dollars = 0n;
  while (i < asks.length && asks[i]![0] * n <= topNum) {
    dollars += (asks[i]![0] * asks[i]![1]) / SIZE_PER_TOKEN;
    i++;
  }
  return { levels: asks.slice(0, i), dollars };
}

/** The book cost of buying exactly `tokens` (base units) from the asks, plus one unit's cost at every level crossed
 *  after the first (Kuru's dust, MS 6.5). Throws DepthError when the asks hold less. */
export function buyCost(asks: [bigint, bigint][], tokens: bigint): { dollars: bigint; levels: number } {
  let left = (tokens + LOT - 1n) / LOT;
  let dollars = 0n;
  let levels = 0;
  for (const [p, s] of asks) {
    if (left === 0n) break;
    const take = left < s ? left : s;
    dollars += (p * take + SIZE_PER_TOKEN - 1n) / SIZE_PER_TOKEN;
    if (levels > 0) dollars += (p + SIZE_PER_TOKEN - 1n) / SIZE_PER_TOKEN;
    left -= take;
    levels++;
  }
  if (left > 0n) throw new DepthError(`the asks hold less than ${toNumber6(tokens)} GPU-hours`);
  return { dollars, levels };
}
