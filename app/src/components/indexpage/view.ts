// The Index page's numbers, pure: the change over a period, the recent days, each cloud's row, the middle-price check
// and where the line's labels fit. No React, no fetching, both data sources alike. Days are UTC dates ("2026-10-02").
import type { IndexDay, Market } from "@/lib/mock/types";
import { median } from "@/lib/peers";
import { dateText, timeText } from "@/lib/data/derive";
import { pricePage } from "./pages";

const DAY = 86_400_000;
const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const cents = (n: number) => Math.round(n * 100) / 100;

export interface Change {
  /** the day it is measured from */
  base: IndexDay;
  /** dollars, to the cent */
  delta: number;
  /** a fraction of the base price */
  pct: number;
}

/** The newest day against the last day on or before `days` earlier. null when the record does not reach back that
 *  far: a change is never made up from a shorter stretch than its label says. */
export function changeOver(history: IndexDay[], days: number): Change | null {
  const last = history[history.length - 1];
  if (!last) return null;
  const target = dayMs(last.date) - days * DAY;
  for (let i = history.length - 2; i >= 0; i--) {
    if (dayMs(history[i].date) > target) continue;
    const base = history[i];
    const delta = cents(last.price - base.price);
    return { base, delta, pct: base.price > 0 ? delta / base.price : 0 };
  }
  return null;
}

/** "+1.0%" / "−0.4%" / "0.0%": the minus is the true minus sign, as everywhere in the app. */
export function pctText(pct: number) {
  const v = Math.abs(pct * 100);
  if (v < 0.05) return "0.0%";
  return `${pct > 0 ? "+" : "−"}${v.toFixed(1)}%`;
}

export type DayKind = "onchain" | "logger" | "example";

export interface DayRow {
  date: string;
  price: number;
  /** against the day before it in the record; null for the first day there is */
  change: number | null;
  pct: number | null;
  status: IndexDay["status"];
  /** onchain, recorded by our logger before the index went onchain, or example history */
  kind: DayKind;
}

/** The last `n` days, newest first, each with its change from the day before. `days` is oldest first (the logger's
 *  days, then the index's own). */
export function recentDays(days: IndexDay[], n = 14): DayRow[] {
  const rows: DayRow[] = [];
  for (let i = days.length - 1; i >= 0 && rows.length < n; i--) {
    const d = days[i];
    const prev = days[i - 1];
    const change = prev ? cents(d.price - prev.price) : null;
    rows.push({
      date: d.date,
      price: d.price,
      change,
      pct: prev && change !== null && prev.price > 0 ? change / prev.price : null,
      status: d.status,
      kind: d.onchain === false ? "logger" : d.example ? "example" : "onchain",
    });
  }
  return rows;
}

export interface CloudRow {
  family: string;
  /** its price for the day; null when it was not read (a reserve, or before the first final day) */
  price: number | null;
  /** in the median today */
  counted: boolean;
  reserve: boolean;
  /** the counted cloud whose price is the index */
  middle: boolean;
  /** the public page its price is read from, when known */
  url: string | null;
}

/** Every cloud on the panel, today's readings first, low to high, then the ones without a price. Live data never lists
 *  the reserve in `sources` (the writers post no reading for it), so the panel fills in who is missing. */
export function cloudRows(market: Market): CloudRow[] {
  const reserve = new Set(market.panel.filter((p) => p.reserve).map((p) => p.family));
  const read = market.sources.map((x) => ({ family: x.family, price: x.price as number | null, counted: x.live }));
  const rest = market.panel.filter((p) => !read.some((x) => x.family === p.family)).map((p) => ({ family: p.family, price: null, counted: p.live && !p.reserve }));
  const all = [...read, ...rest].sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9) || Number(b.counted) - Number(a.counted) || a.family.localeCompare(b.family));
  const mid = middleOf(market);
  // one cloud is the index: with two counted clouds at the middle price, the first of them
  const at = mid === null ? -1 : all.findIndex((x) => x.counted && x.price !== null && Math.abs(x.price - mid) < 0.005);
  return all.map((x, i) => ({
    ...x,
    reserve: reserve.has(x.family),
    middle: i === at,
    url: pricePage(x.family),
  }));
}

/** The median of the counted clouds' prices, to the cent; null when none has a price. Worked in whole cents the way
 *  the contract works it (IndexMath: an even count takes the mean of the two middle prices, halves up), so a float
 *  never puts the check a cent off the onchain price: (1.01 + 1.02) / 2 is $1.02, as onchain. */
export function middleOf(market: Market): number | null {
  const c = market.sources
    .filter((x) => x.live)
    .map((x) => Math.round(x.price * 100))
    .sort((a, b) => a - b);
  if (!c.length) return null;
  const m = c.length >> 1;
  return (c.length % 2 ? c[m] : Math.floor((c[m - 1] + c[m] + 1) / 2)) / 100;
}

/** "Middle of these 5 = $3.99, onchain = $3.99": the index recomputed from the readings on screen against the price
 *  the contract holds. null before the first final day. `carried`: today's price is yesterday's, carried. */
export function middleCheck(market: Market) {
  if (market.priceDate === null) return null;
  const mid = middleOf(market);
  if (mid === null) return null;
  const last = market.history[market.history.length - 1];
  return {
    count: market.sources.filter((x) => x.live).length,
    mid,
    onchain: market.price,
    same: Math.abs(mid - market.price) < 0.005,
    carried: last?.status === "carried",
  };
}

/** When a cloud's price was read, from what the data holds: the readings are hourly through the index day and its
 *  price is their average, so the day is known and the minute is not. */
export function readText(row: CloudRow, market: Market) {
  if (market.priceDate === null) return row.reserve ? "Waits as the reserve" : "Read every hour from today";
  if (row.price !== null) return `Read every hour on ${dateText(market.priceDate)}`;
  return row.reserve ? "Not read while it waits as the reserve" : `No reading on ${dateText(market.priceDate)}`;
}

/** Where each label under the price line goes: label `i` is centred on `x[i]` (px) and `w[i]` wide; returns its row
 *  (0 nearest the line) or -1 when it fits in none of `rows` without touching a neighbour. Placed by `rank` (lower
 *  first; the index's cloud, then the counted ones, then the rest), left to right within a rank, each in the first row
 *  where it touches nothing, so a crowded line drops a reserve's name before the index's. */
export function placeLabels(x: number[], w: number[], width: number, rows: number, gap = 12, rank: number[] = []): number[] {
  const order = x.map((_, i) => i).sort((a, b) => (rank[a] ?? 0) - (rank[b] ?? 0) || x[a] - x[b]);
  const taken: [number, number][][] = Array.from({ length: rows }, () => []);
  const out = x.map(() => -1);
  for (const i of order) {
    const left = Math.max(0, Math.min(width - w[i], x[i] - w[i] / 2));
    const right = left + w[i];
    const r = taken.findIndex((row) => row.every(([a, b]) => right + gap <= a || left >= b + gap));
    if (r < 0) continue;
    out[i] = r;
    taken[r].push([left, right]);
  }
  return out;
}

/** The price line's ends: every price with a little air, and never narrower than a tenth of the middle price, so two
 *  clouds a cent apart do not sit at opposite ends as if far apart. */
export function lineScale(prices: number[]) {
  if (!prices.length) return { lo: 0, hi: 1 };
  const mn = Math.min(...prices);
  const mx = Math.max(...prices);
  const span = Math.max(mx - mn, median(prices) * 0.1, 0.1);
  const mid = (mn + mx) / 2;
  const half = span / 2 + span * 0.08;
  return { lo: mid - half, hi: mid + half };
}

/** "18h 32m 07s" until an ISO time (days past 48 hours), or null once it is due: the times are expectations. */
export function countdownLong(isoTime: string, now: number) {
  const t = Date.parse(isoTime);
  if (!Number.isFinite(t) || t <= now) return null;
  const secs = Math.ceil((t - now) / 1000);
  if (secs >= 48 * 3600) return `${Math.floor(secs / 86400)} days`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const sec = secs % 60;
  return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
}

/** Under the countdown: when the next price is published and when it turns final, in that order. Between about 01:00
 *  and 07:00 UTC it is already published (the next close is then the day after's), so it says it is in its checks. */
export function nextPriceText(market: Pick<Market, "nextUpdateAt" | "nextCloseAt">) {
  const final = `final about ${timeText(market.nextUpdateAt)} on ${dateText(market.nextUpdateAt)}`;
  const close = timeText(market.nextCloseAt);
  if (!close) return `Turns ${final}`;
  return Date.parse(market.nextCloseAt) > Date.parse(market.nextUpdateAt) ? `Published and in its six hours of checks, ${final}` : `Published about ${close}, ${final}`;
}

/** A sparkline's points (0..w, 0..h) for the last `n` days. The scale never narrows below 4% of the price, so a cent
 *  of noise stays a ripple, the way the history chart keeps its axis honest. "" with fewer than two days. */
export function sparkPath(days: IndexDay[], w: number, h: number, n = 30) {
  const pts = days.slice(-n);
  if (pts.length < 2) return "";
  const ps = pts.map((d) => d.price);
  const mn = Math.min(...ps);
  const mx = Math.max(...ps);
  const span = Math.max(mx - mn, mx * 0.04);
  const mid = (mn + mx) / 2;
  const lo = mid - span / 2;
  const X = (i: number) => (i / (pts.length - 1)) * w;
  const Y = (p: number) => h - ((p - lo) / span) * h;
  // a step line, like the chart: flat for days, then a step when a cloud reprices
  let d = `M0,${Y(ps[0]).toFixed(1)}`;
  for (let i = 1; i < ps.length; i++) d += ` H${X(i).toFixed(1)} V${Y(ps[i]).toFixed(1)}`;
  return d;
}
