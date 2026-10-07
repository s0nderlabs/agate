// The Index page in the market page's frame (round 2, Oct 7), its words and numbers, pure: the day's move under the big
// price, the 7 and 30 day cells, the clouds cell, the ladder of clouds (highest on top, the index raised), the check
// line, the day-by-day list with its dividers, and the four steps. No React, no fetching, both data sources alike.
import type { IndexDay, Market } from "@/lib/mock/types";
import type { Range } from "@/components/trade/LineChart";
import { countWord, dateText, frontMonth, monthLong, panelCount, timeText } from "@/lib/data/derive";
import { signedUsd, usd } from "@/lib/format";
import { changeOver, cloudRows, middleCheck, middleOf, pctText, recentDays, type CloudRow, type DayKind } from "./view";

export type Tone = "up" | "down" | null;

const toneOf = (n: number): Tone => (Math.abs(n) < 0.005 ? null : n > 0 ? "up" : "down");

/** The days each range shows: the same spans the history chart draws (LineChart), so both views agree. */
export const RANGE_DAYS: Record<Range, number> = { "1W": 7, "1M": 30, "3M": 90, ALL: 10_000 };

/** Where the onchain record starts: the first day that is neither example history nor the logger's. */
export function recordStart(days: IndexDay[]) {
  return days.find((d) => !d.example && d.onchain !== false)?.date;
}

/** The colored line under the big price, then the quiet one beside it. Before the first price: when it lands. */
export function dayMove(market: Market): { text: string; tone: Tone; quiet: string } {
  if (market.priceDate === null) return { text: `First price about ${timeText(market.nextUpdateAt) || "07:00 UTC"}`, tone: null, quiet: "" };
  const quiet = `The price for ${dateText(market.priceDate)}`;
  const last = market.history[market.history.length - 1];
  if (last?.status === "carried") return { text: "Carried from the day before, unverified", tone: null, quiet };
  if (market.history.length === 1) return { text: "First day of our record", tone: null, quiet };
  const delta = market.price - market.prevPrice;
  const tone = toneOf(delta);
  return { text: tone ? `${signedUsd(delta)} since yesterday` : "Same as yesterday", tone, quiet };
}

/** One change cell ("7 days", "30 days"): the percent in its color and the dollars quiet beside it; a stretch the
 *  record does not reach says so ("Not yet", where the record starts). The note names the day it is measured from. */
export function periodCell(history: IndexDay[], n: number) {
  const c = changeOver(history, n);
  if (!c) {
    const from = recordStart(history);
    return { value: "Not yet", quiet: from ? `Record starts ${dateText(from)}` : "", tone: null as Tone, note: null };
  }
  const tone = toneOf(c.delta);
  return {
    value: pctText(c.pct),
    quiet: tone ? signedUsd(c.delta) : "No change",
    tone,
    note: `Today's price against the price for ${dateText(c.base.date)}, ${usd(c.base.price)}.`,
  };
}

/** The header's two change cells, 7 then 30 days. Where the record starts is said once: when neither stretch is
 *  reached yet, the second "Not yet" stands alone. */
export function periodCells(history: IndexDay[]) {
  const cells = ([7, 30] as const).map((n) => ({ n, label: `${n} days`, ...periodCell(history, n) }));
  if (cells[0].value === "Not yet" && cells[1].value === "Not yet") cells[1].quiet = "";
  return cells;
}

/** "5 of 5", and "plus 1 reserve" only when the panel has one. Before the first price, the clouds being read. */
export function cloudsCell(market: Market) {
  const panel = panelCount(market);
  const reserves = market.panel.filter((p) => p.reserve).length;
  const before = market.priceDate === null;
  return {
    label: before ? "Clouds read" : "Clouds counted",
    value: `${before ? panel : market.liveCount} of ${panel}`,
    quiet: reserves ? `plus ${reserves} ${reserves > 1 ? "reserves" : "reserve"}` : "",
  };
}

/** A rung of the ladder: a counted cloud, or (an even count) the index itself, halfway between the middle two. */
export type Rung = { kind: "cloud"; row: CloudRow } | { kind: "mid"; price: number };

const byPriceDesc = (a: CloudRow, b: CloudRow) => (b.price ?? -1) - (a.price ?? -1) || a.family.localeCompare(b.family);

/** The clouds as an order book reads: the counted ones highest on top, the index raised among them, then the clouds
 *  not counted today (a reserve, a cloud that gave no price). Before the first price, the clouds being read, no prices. */
export function ladder(market: Market): { rungs: Rung[]; rest: CloudRow[]; halfway: boolean } {
  const rows = cloudRows(market);
  const counted = rows.filter((r) => r.counted && !r.reserve).sort(byPriceDesc);
  const rest = rows.filter((r) => !(r.counted && !r.reserve)).sort(byPriceDesc);
  const rungs: Rung[] = counted.map((row) => ({ kind: "cloud", row }));
  const mid = market.priceDate === null ? null : middleOf(market);
  const priced = counted.filter((r) => r.price !== null).length;
  // an even count: no cloud is the middle, so the index sits between the two middle clouds, like a book's spread
  const halfway = mid !== null && !counted.some((r) => r.middle) && priced >= 2 && priced % 2 === 0;
  if (halfway) {
    const at = counted.findIndex((r) => r.price !== null && r.price < mid);
    rungs.splice(at < 0 ? rungs.length : at, 0, { kind: "mid", price: mid });
  }
  return { rungs, rest, halfway };
}

/** Under the rail's title: what the clouds' prices are and why one cloud cannot move the index. `before`: the data
 *  says the index has no price yet (never while the first read is on its way). */
export function railLine(gpu: string, { before = false, halfway = false } = {}) {
  const read = `Each cloud's own on-demand ${gpu} price, read every hour.`;
  // short: the How panel says why the middle (no single cloud can move it)
  if (before) return `${read} From the first day, the middle one sets the day's price.`;
  return halfway ? `${read} The day's price sits halfway between the middle two.` : `${read} The middle one sets the day's price.`;
}

/** The check anyone can redo: the middle of the readings on screen against the price the contract holds. A mismatch
 *  says both numbers plainly. null before the first price. */
export function checkLine(market: Market): { text: string; same: boolean } | null {
  const c = middleCheck(market);
  if (!c) return null;
  const these = c.count === 1 ? `The one counted price is ${usd(c.mid)}` : `The middle of these ${countWord(c.count)} is ${usd(c.mid)}`;
  if (c.same) return { text: `${these}, and the index contract reads ${usd(c.onchain)}.`, same: true };
  if (c.carried) return { text: `${these}. The index contract reads ${usd(c.onchain)}, carried from the day before.`, same: false };
  return { text: `${these}, but the index contract reads ${usd(c.onchain)}. The contract's price is the one that pays.`, same: false };
}

export type DayItem = { type: "day"; date: string; price: number; change: number | null; carried: boolean; kind: DayKind } | { type: "divider"; kind: Exclude<DayKind, "onchain">; text: string };

/** The day-by-day list for a range, newest first: each day with its change from the day before (the oldest shown keeps
 *  its change from the day before it, when there is one). The days before the onchain record follow one divider line. */
export function dayItems(days: IndexDay[], range: Range): DayItem[] {
  const from = dateText(recordStart(days));
  const out: DayItem[] = [];
  let prev: DayKind = "onchain";
  for (const r of recentDays(days, RANGE_DAYS[range])) {
    if (r.kind !== "onchain" && r.kind !== prev) {
      const text =
        r.kind === "example" ? (from ? `Example history before ${from}` : "Example history") : from ? `Recorded by our logger before ${from}, not onchain` : "Recorded by our logger, not onchain";
      out.push({ type: "divider", kind: r.kind, text });
    }
    out.push({ type: "day", date: r.date, price: r.price, change: r.change, carried: r.status === "carried", kind: r.kind });
    prev = r.kind;
  }
  return out;
}

/** A day's change in words: "+$0.05", "No change", or nothing for the first day there is. */
export function changeWords(change: number | null): { text: string; tone: Tone } {
  if (change === null) return { text: "", tone: null };
  const tone = toneOf(change);
  return { text: tone ? signedUsd(change) : "No change", tone };
}

/** The rail's last button: the month the market page trades for this GPU; null for a GPU with an index only. */
export function tradeLabel(market: Market, now: number) {
  if (!market.tradable) return null;
  const mo = frontMonth(market, now);
  return mo ? `Trade ${market.gpu} ${monthLong(mo.month)}` : `Trade ${market.gpu}`;
}

/** How the price is made, in four steps. */
export function howSteps(gpu: string) {
  return [
    { title: "Read every hour", text: `Agate reads each cloud's public price page for one on-demand ${gpu} GPU-hour.` },
    { title: "The middle counts", text: "A cloud's day price is the average of its hourly reads. The index is the middle of the clouds counted." },
    { title: "Written onchain", text: "The day closes at 00:00 UTC. About an hour later the price is written on Monad, and a second, independent reader must countersign any change." },
    { title: "Final at 07:00 UTC", text: "After six hours of checks it turns final. A day with no new reading carries the day before's price, marked unverified." },
  ];
}
