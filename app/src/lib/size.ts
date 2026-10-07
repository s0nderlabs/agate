// Trade sizing, shared by both tickets: what people type, the contract's steps (0.0001 GPU-hour, $0.01, agate's
// @agate/client rules, Oct 4), and what a size costs once it walks the book. Pure numbers, no React.

/** The smallest GPU-hour step a trade can take (agate: LOT = 0.0001 GPU-hour). */
export const HOUR_STEP = 0.0001;
/** Limit orders on Kuru: at least 1 GPU-hour, at most 1,000,000 (agate: KURU_MIN_SIZE / KURU_MAX_SIZE). */
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 1_000_000;

/** What people type: "1,000", "$1,000.50", ".5", "0." all read; anything else is empty. */
export function parseAmount(text: string): number | null {
  const t = text.replace(/[$,\s]/g, "");
  if (t === "" || t === ".") return null;
  if (!/^\d*\.?\d*$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/** While typing: keep digits, one dot and commas, so "0." and "1,0" survive until the box loses focus. */
export function cleanTyping(text: string, decimals: number) {
  let t = text.replace(/[^\d.,]/g, "");
  const dot = t.indexOf(".");
  if (dot >= 0) t = t.slice(0, dot + 1) + t.slice(dot + 1).replace(/[.,]/g, "").slice(0, decimals);
  return t;
}

// round away float noise first (2447.4327 * 10000 is 24474326.9999...), then floor to the step
export const floorHours = (h: number) => Math.floor(Math.round(h * 1e8) / 1e4) / 1e4;
export const floorCents = (d: number) => Math.floor(Math.round(d * 1e6) / 1e4) / 100;

/** GPU-hours as people read them: up to 4 decimals, trailing zeros dropped ("122.549", "1,440"). */
export const fmtHours = (h: number) => h.toLocaleString("en-US", { maximumFractionDigits: 4 });
/** GPU-hours to read on screen: up to 2 decimals ("799.57", "1,440"), 4 under 0.01 so a small amount never reads 0.
 * Input boxes, and anything that fills one, keep fmtHours' 4 so a sale never asks for more than is held. */
export const showHours = (h: number) => h.toLocaleString("en-US", { maximumFractionDigits: h !== 0 && Math.abs(h) < 0.01 ? 4 : 2 });
/** Dollars for an input box: up to 2 decimals, no symbol ("1,000", "12.5"). */
export const fmtDollars = (d: number) => d.toLocaleString("en-US", { maximumFractionDigits: 2 });
/** GPUs for an input box: up to 2 decimals, 4 under one GPU so a small amount never reads 0. */
export const fmtGpus = (g: number) => g.toLocaleString("en-US", { maximumFractionDigits: g < 1 ? 4 : 2 });
/** GPUs floored to what the box shows (2 decimals, 4 under one GPU), so a shown amount never costs more than it said. */
export const floorGpus = (g: number) => {
  const d = g < 1 ? 1e4 : 100;
  return Math.floor(Math.round(g * d * 1e4) / 1e4) / d;
};
/** "GPU" or "GPUs": one or less is singular ("0.5 GPU", "1 GPU", "2 GPUs"). */
export const gpuWord = (g: number) => (g <= 1 ? "GPU" : "GPUs");

export type Level = { price: number; size: number };

/** What one GPU-hour at this price takes from the wallet: a Long pays the price, a Short puts up ceiling - price. */
const perHour = (side: "long" | "short", price: number, cap: number) => (side === "long" ? price : cap - price);

/**
 * Fill `hours` against the book, best price first: a Long takes the asks, a Short sells into the bids.
 * Returns what fills (never more than the book holds), what it takes from the wallet, and the average price.
 */
export function walkHours(levels: Level[], side: "long" | "short", hours: number, cap: number) {
  let left = hours;
  let filled = 0;
  let outlay = 0;
  let notional = 0;
  for (const l of levels) {
    if (left <= 0) break;
    const take = Math.min(left, l.size);
    filled += take;
    outlay += take * perHour(side, l.price, cap);
    notional += take * l.price;
    left -= take;
  }
  return { filled: floorHours(filled), outlay, avg: filled > 0 ? notional / filled : levels[0]?.price ?? 0, short: left > 1e-9 };
}

/** Spend `dollars` against the book: the GPU-hours they buy (Long) or back (Short), best price first. */
export function walkDollars(levels: Level[], side: "long" | "short", dollars: number, cap: number) {
  let left = dollars;
  let hours = 0;
  for (const l of levels) {
    if (left <= 0) break;
    const cost = perHour(side, l.price, cap);
    const take = Math.min(l.size, left / cost);
    hours += take;
    left -= take * cost;
  }
  return walkHours(levels, side, floorHours(hours), cap);
}

/**
 * A requested size in the other unit. The part the book holds is priced level by level; anything past it is priced
 * at the last level, so a request bigger than the book stays bigger after a unit switch and the warning stays up
 * (nothing shrinks to the book's depth without the person agreeing to it).
 */
export function hoursToDollars(levels: Level[], side: "long" | "short", hours: number, cap: number) {
  const w = walkHours(levels, side, hours, cap);
  const last = levels[levels.length - 1];
  return w.outlay + (last ? Math.max(0, hours - w.filled) * perHour(side, last.price, cap) : 0);
}
export function dollarsToHours(levels: Level[], side: "long" | "short", dollars: number, cap: number) {
  const w = walkDollars(levels, side, dollars, cap);
  const last = levels[levels.length - 1];
  const per = last ? perHour(side, last.price, cap) : 0;
  return w.filled + (per > 0 ? Math.max(0, dollars - w.outlay) / per : 0);
}

/** The biggest size a balance can pay for, capped by what the book holds now. */
export function maxFor(levels: Level[], side: "long" | "short", balance: number, cap: number) {
  const byMoney = walkDollars(levels, side, balance, cap);
  const depth = levels.reduce((a, l) => a + l.size, 0);
  return { hours: Math.min(byMoney.filled, depth), dollars: Math.min(balance, walkHours(levels, side, depth, cap).outlay), bookBound: walkHours(levels, side, depth, cap).outlay < balance };
}
