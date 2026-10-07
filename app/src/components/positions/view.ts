// The reworked Positions page in numbers and words (Oct 6 mock), pure: what a holding cost, what it is still worth
// and what it pays; where its month stands; and the daily shares behind "Paid to you". No React, no fetching, times
// in UTC. Every figure comes from the position and its month as the client reads them; a daily share is listed only
// when the index days in the market's history add up to the month's own record (k and S) and to what the position
// says it was paid, so a per-day number is never shown that the chain would not back.
import { bandNow, dateText, firstPayAt, monthLong, monthStage, sellEndsAt, timeText, whenText, type MonthStage } from "@/lib/data/derive";
import type { Day, Position, Series } from "@/lib/mock/types";
import { usd, usd0 } from "@/lib/format";

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** half a cent: anything under it reads as nothing */
const CENT = 0.005;

export interface HoldingView {
  long: boolean;
  stage: MonthStage | null;
  final: boolean;
  /** what it is valued at, per GPU-hour: the month's final average once final, else the last traded price */
  price: number | null;
  /** what it took from the wallet: a Long the price, a Short the ceiling less the price; null when not known */
  cost: number | null;
  /** what it is still worth at that price; what was already paid out is in the account, so it is left out */
  worth: number | null;
  /** gain or loss since bought, what was paid out included */
  change: number | null;
  /** final and nothing left in it: everything was paid out or collected */
  done: boolean;
  /** dollars that can be collected now (a final month, or a pay me daily share waiting), else 0 */
  ready: number;
}

/** A holding at `last` (its month's last traded price, null without one) on `now`. */
export function holdingView(p: Position, series: Series | undefined, last: number | null, now: number): HoldingView {
  const long = p.side === "long";
  const stage = series ? monthStage(series, now) : null;
  const final = stage === "final" && !!series && series.n > 0;
  const price = final ? series!.S / series!.n : last;
  // a Short is valued against its ceiling, so without the month's terms it has no value to show
  const cap = series?.cap ?? 0;
  const priced = long || cap > 0;
  const per = (x: number) => (long ? x : cap - x);
  const cost = p.entry > 0 && priced ? per(p.entry) * p.q : null;
  // under half a cent left (float noise once everything is paid out) is nothing
  const left = price === null || !priced ? null : per(price) * p.q - p.paid;
  const worth = left === null ? null : left > CENT ? left : 0;
  const change = price === null || p.entry <= 0 ? null : (long ? price - p.entry : p.entry - price) * p.q;
  const done = final && worth !== null && worth <= CENT && p.claimable <= CENT;
  const ready = p.claimable > CENT && (final || p.daily) ? p.claimable : 0;
  return { long, stage, final, price, cost, worth, change, done, ready };
}

/** "+$12", "−$3", or "$0" when it rounds to nothing (never a signed zero). */
export function changeText(change: number) {
  const r = Math.round(change);
  return r === 0 ? "$0" : `${r > 0 ? "+" : "−"}${usd0(Math.abs(r))}`;
}

/** The change's color, none when it rounds to $0. */
export function changeTone(change: number | null): "up" | "down" | undefined {
  if (change === null || Math.round(change) === 0) return undefined;
  return change > 0 ? "up" : "down";
}

/** "Long · 720 GPU-hours"-style side words: "Long", "Long, paid daily", "Short". */
export function sideText(p: Position) {
  return `${p.side === "long" ? "Long" : "Short"}${p.daily ? ", paid daily" : ""}`;
}

/** What the holding pays, in a few words under its worth, and the dollars that go with them (shown as figures). */
export function paysText(p: Position, v: HoldingView): { words: string; dollars: number | null } {
  if (v.done) return { words: p.daily ? "Paid in full" : "Collected", dollars: null };
  if (v.final) return v.ready > 0 ? { words: "Ready to collect", dollars: null } : { words: "Settles at the final price", dollars: null };
  if (p.daily) return { words: "Paid so far", dollars: p.paid };
  if (v.stage === "closed") return { words: "Pays once the final price is in", dollars: null };
  return { words: "Pays at month end", dollars: null };
}

/** When a month's last day turns final (about 07:00 UTC on the day after it closes), ISO; "" when unknown. */
export function finalAt(series: Series) {
  const t = Date.parse(series.closesAt);
  return Number.isFinite(t) ? new Date(t + 7 * HOUR).toISOString() : "";
}

/** When the month's next day turns final and pays its daily share (day k + 1, about 07:00 UTC the day after it),
 *  ISO; null once every day is priced or the start is unknown. */
export function nextShareAt(series: Series) {
  const start = Date.parse(series.startsAt);
  if (!Number.isFinite(start) || series.k >= series.n) return null;
  return new Date(start + (series.k + 1) * DAY + 7 * HOUR).toISOString();
}

/** The month's header line: where it stands and its next date, in plain words. `mine`: the holdings in it that are
 *  the person's own (what "ready to collect" and "collected" speak for). */
export function monthLine(series: Series, stage: MonthStage, mine: HoldingView[]) {
  const ends = sellEndsAt(series);
  switch (stage) {
    case "upcoming":
      return "Not open for trading yet";
    case "listed":
      return `Starts ${dateText(series.startsAt)}, trading until ${whenText(ends)}`;
    case "paying": {
      const b = bandNow(series);
      return `${b.k} of ${b.n} days priced, trading until ${whenText(ends)}`;
    }
    case "lastDay":
      return `Last day, trading until ${timeText(ends)} today`;
    case "closed":
      return `Final price pending, pays about ${whenText(finalAt(series))}`;
    case "final": {
      const avg = `Final at ${usd(series.S / series.n)} per GPU-hour`;
      if (mine.some((v) => v.ready > 0)) return `${avg}, ready to collect`;
      if (mine.length && mine.every((v) => v.done)) return `${avg}, collected`;
      return avg;
    }
  }
}

/** Which pay me daily month "Paid to you" follows first: one paying now, then one about to start, then a final one. */
export function stageRank(stage: MonthStage | null) {
  if (stage === "paying" || stage === "lastDay" || stage === "closed") return 0;
  if (stage === "listed") return 1;
  return stage === "final" ? 2 : 3;
}

/** "Paid to you"'s line on the daily shares of a month: when they start, when the next (or the last) one pays, or that
 *  every day has paid. "" when the month's dates are not known. */
export function shareLine(series: Series, stage: MonthStage, now: number) {
  switch (stage) {
    case "listed": {
      const t = firstPayAt(series);
      return t ? `A share pays each day from ${dateText(t)}, about ${timeText(t)}.` : "";
    }
    case "paying":
    case "lastDay":
    case "closed": {
      const t = nextShareAt(series);
      if (!t) return "";
      // the times are expectations: a share past its time is due, not missed
      if (Date.parse(t) <= now) return "The next share is due any minute now.";
      return `${series.k + 1 >= series.n ? "Last share" : "Next share"} about ${whenText(t)}.`;
    }
    case "final":
      return `Every day of ${monthLong(series.month)} has paid its share.`;
    default:
      return "";
  }
}

export interface Share {
  /** "2026-11-12": the index day that paid it */
  date: string;
  /** that day's price as the month counts it (clamped to the band) */
  price: number;
  /** dollars it paid this position */
  amount: number;
}

/** A pay me daily position's shares, day by day, or null when they cannot be checked against the chain's record.
 *  `atOnce` is what was paid when it was bought (a Long gets the floor for the days still to come; a position opened
 *  mid-month also the days already priced); `days` the shares of the days priced since, oldest first. Checked three
 *  ways: the history holds exactly the month's k priced days, their clamped sum is the month's S, and the shares add
 *  up to what the position was paid (and can collect). */
export function dailyShares(p: Position, series: Series | undefined, history: Day[] | undefined): { atOnce: number; days: Share[] } | null {
  if (!p.daily || !series || !history || series.n <= 0 || series.phase === "upcoming") return null;
  const long = p.side === "long";
  const { n, k, S, floor, cap } = series;
  const clamp = (x: number) => Math.min(cap, Math.max(floor, x));
  const days = history.filter((d) => d.date.startsWith(`${series.month}-`)).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (days.length !== k) return null;
  const sum = days.reduce((a, d) => a + clamp(d.price), 0);
  if (Math.abs(sum - S) > 0.01 * Math.max(1, k)) return null;
  const owed = (p.q * (long ? S + (n - k) * floor : k * cap - S)) / n;
  const total = p.paid + p.claimable;
  if (Math.abs(owed - total) > 0.02 + 0.01 * k) return null;
  // a day pays once it turns final (about 07:00 UTC the next day); days final before the position opened were paid
  // with what it paid at once
  const opened = Date.parse(p.openedAt);
  const since = days.filter((d) => !Number.isFinite(opened) || Date.parse(`${d.date}T00:00:00Z`) + DAY + 7 * HOUR > opened);
  const list = since.map((d) => {
    const x = clamp(d.price);
    return { date: d.date, price: x, amount: (p.q * (long ? x - floor : cap - x)) / n };
  });
  const atOnce = total - list.reduce((a, s) => a + s.amount, 0);
  return { atOnce: atOnce > CENT ? atOnce : 0, days: list };
}

/** One day of "Paid to you": what every position paid that day; `price` only when one position paid it (several
 *  months or GPUs priced the day differently). */
export interface DayPaid {
  date: string;
  price: number | null;
  amount: number;
}

/** Shares of several positions added up per day, newest first. */
export function sharesByDay(all: Share[][]): DayPaid[] {
  const by = new Map<string, DayPaid>();
  for (const list of all)
    for (const s of list) {
      const had = by.get(s.date);
      by.set(s.date, had ? { date: s.date, price: null, amount: had.amount + s.amount } : { date: s.date, price: s.price, amount: s.amount });
    }
  return [...by.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}
