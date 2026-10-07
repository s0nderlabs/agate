// Positions in the market page's frame (Oct 7 round 2), pure: the value line from the held months' own hourly candles
// and the holdings' own numbers (never a made-up curve), its money axis, the paid days as bars, and the short words of
// the header, the list and the rail. No React, no fetching, times in UTC.
import type { Candle, Series } from "@/lib/mock/types";
import { dateText, firstPayAt, lastTradingDay, sellEndsAt, timeText, whenText, type MonthStage } from "@/lib/data/derive";
import { usd, usd0 } from "@/lib/format";
import { finalAt, nextShareAt, type DayPaid, type HoldingView } from "./view";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** "1 holding", "3 holdings", "2 holdings, own pocket" (a strip tab's line). */
export function countText(n: number, pocket = false) {
  return `${n} holding${n === 1 ? "" : "s"}${pocket ? ", own pocket" : ""}`;
}

/** "in 33m", "in 15h", "in 30 days" until an ISO time; null once it is due (the times are expectations). */
export function inText(iso: string | null | undefined, now: number): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t) || t <= now) return null;
  const mins = Math.ceil((t - now) / MIN);
  if (mins < 60) return `in ${mins}m`;
  if (mins < 48 * 60) return `in ${Math.floor(mins / 60)}h`;
  return `in ${Math.floor(mins / 1440)} days`;
}

// ------------------------------------------------------------------ the value line

/** One holding as the value line reads it. */
export interface ValueInput {
  /** when it was bought (ms); the caller uses its month's listing when that is not known */
  start: number;
  /** GPU-hours */
  q: number;
  long: boolean;
  /** the month's ceiling: a Short is worth the ceiling less the price */
  cap: number;
  /** what it was bought at per GPU-hour; 0 when not known */
  entry: number;
  /** which candles are its month's */
  key: string;
  /** its price now as the header values it (the final average once final, else the last traded price); null: none */
  now: number | null;
}

/** One point of the line: what the holdings bought by `t` were worth then, paid-out money included (worth plus
 *  paid is the price times the GPU-hours, whatever was paid out), and what they cost (null when a cost is unknown). */
export interface ValuePoint {
  t: number;
  value: number;
  cost: number | null;
}

/** The scope's value over time, hourly. Each holding counts from when it was bought: at its own price until the
 *  first trade in its month after that (its own purchase hour included), then at its month's last close, carried
 *  through hours with no candle; at `end` (now) at the price the header uses. A holding that has not traded since it
 *  was bought holds at its price to the end, as the note under the chart says. `quiet`: none of them has. */
export function valueLine(hs: ValueInput[], candles: Record<string, Candle[] | undefined>, end: number): { points: ValuePoint[]; quiet: boolean } {
  const usable = hs.filter((h) => h.q > 0 && (h.long || h.cap > 0) && Number.isFinite(h.start));
  if (!usable.length || !Number.isFinite(end)) return { points: [], quiet: false };
  const per = (h: ValueInput, x: number) => (h.long ? x : h.cap - x) * h.q;
  const costKnown = usable.every((h) => h.entry > 0);
  // each month's closes in time order: the close of the hour that starts at t is known at t + 1 hour
  const closes = new Map<string, { at: number; c: number; v: number }[]>();
  for (const h of usable)
    if (!closes.has(h.key))
      closes.set(
        h.key,
        (candles[h.key] ?? [])
          .map((c) => ({ at: Date.parse(c.t) + HOUR, c: c.c, v: c.v }))
          .filter((x) => Number.isFinite(x.at))
          .sort((a, b) => a.at - b.at),
      );
  const info = usable.map((h) => {
    const list = closes.get(h.key)!;
    const start = Math.min(h.start, end);
    const first = list.find((x) => x.v > 0 && x.at > start)?.at;
    return { h, start, list, traded: first !== undefined && first <= end ? first : null };
  });
  const closeAt = (list: { at: number; c: number }[], T: number) => {
    let lo = 0;
    let hi = list.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].at <= T) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found < 0 ? null : list[found].c;
  };
  const priceAt = (x: (typeof info)[number], T: number): number | null => {
    const { h } = x;
    // now: always the price the header values it at, so the line ends on the header's figures
    if (T === end && h.now !== null) return h.now;
    if (x.traded === null || T < x.traded) return h.entry > 0 ? h.entry : closeAt(x.list, T);
    return closeAt(x.list, T);
  };
  const times = new Set<number>([end]);
  for (const x of info) times.add(x.start);
  const first = Math.min(...info.map((x) => x.start));
  for (let T = Math.ceil(first / HOUR) * HOUR; T < end; T += HOUR) times.add(T);
  const points: ValuePoint[] = [];
  for (const T of [...times].sort((a, b) => a - b)) {
    let value = 0;
    let cost = 0;
    let n = 0;
    for (const x of info) {
      if (x.start > T) continue;
      const price = priceAt(x, T);
      if (price === null) continue;
      value += per(x.h, price);
      cost += per(x.h, x.h.entry);
      n++;
    }
    if (n) points.push({ t: T, value, cost: costKnown ? cost : null });
  }
  return { points, quiet: info.every((x) => x.traded === null) };
}

/** The last `hours` of the line (null: all of it). It enters the range where it stood at the cut. */
export function clipRange(points: ValuePoint[], hours: number | null): ValuePoint[] {
  if (hours === null || points.length < 2) return points;
  const cut = points[points.length - 1].t - hours * HOUR;
  const i = points.findIndex((p) => p.t >= cut);
  if (i <= 0) return points;
  return points[i].t === cut ? points.slice(i) : [{ ...points[i - 1], t: cut }, ...points.slice(i)];
}

/** Hours from the line's first point to its last. */
export function spanHours(points: ValuePoint[]) {
  return points.length < 2 ? 0 : (points[points.length - 1].t - points[0].t) / HOUR;
}

/** A whole-dollar axis around `values`: four or five round steps ($100, $250, $1,000), never a cent. */
export function moneyScale(values: number[]): { lo: number; hi: number; ticks: number[] } {
  const ok = values.filter((v) => Number.isFinite(v));
  if (!ok.length) return { lo: 0, hi: 1, ticks: [] };
  const mn = Math.min(...ok);
  const mx = Math.max(...ok);
  const pad = Math.max((mx - mn) * 0.15, Math.abs(mx) * 0.01, 1);
  const raw = (mx - mn + pad * 2) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, ([1, 2, 2.5, 5, 10].find((m) => m * p >= raw) ?? 10) * p);
  const lo = Math.floor((mn - pad) / step) * step;
  const hi = Math.ceil((mx + pad) / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 1000; v += step) ticks.push(Math.round(v * 100) / 100);
  return { lo, hi, ticks };
}

/** A point's time in the hover readout: "Oct 4, 14:00 UTC". */
export function pointTime(t: number) {
  return whenText(new Date(t).toISOString());
}

/** An axis label: the day over a long line, the day and hour over a short one ("Oct 3, 05:00"). */
export function axisTime(t: number, spanH: number) {
  const iso = new Date(t).toISOString();
  return spanH >= 72 ? dateText(iso) : `${dateText(iso)}, ${timeText(iso).replace(" UTC", "")}`;
}

// ------------------------------------------------------------------ paid to you

/** One day of the month in "Paid to you": its share, paid with what was paid at once (priced before it was bought),
 *  or still to come. */
export interface DayBar {
  date: string;
  kind: "paid" | "atOnce" | "ahead";
  amount: number;
  price: number | null;
}

/** The month's days as bars, from the checked shares (dailyShares, sharesByDay). */
export function dayBars(series: Pick<Series, "month" | "n" | "k">, shares: DayPaid[]): DayBar[] {
  const by = new Map(shares.map((d) => [d.date, d]));
  return Array.from({ length: Math.max(0, series.n) }, (_, i) => {
    const date = `${series.month}-${String(i + 1).padStart(2, "0")}`;
    const d = by.get(date);
    if (d) return { date, kind: "paid" as const, amount: d.amount, price: d.price };
    return { date, kind: i < series.k ? ("atOnce" as const) : ("ahead" as const), amount: 0, price: null };
  });
}

/** A bar's readout: "Nov 12, priced at $4.33, +$114.24", "Nov 1, paid when bought", "Nov 20, still to come". */
export function barText(b: DayBar) {
  const day = dateText(b.date);
  if (b.kind === "atOnce") return `${day}, paid when bought`;
  if (b.kind === "ahead") return `${day}, still to come`;
  return `${day}${b.price !== null ? `, priced at ${usd(b.price)}` : ""}, +${usd(b.amount)}`;
}

/** The line over the bars: what was paid when bought, then the daily shares since. */
export function paidLine(atOnce: number, shares: DayPaid[]) {
  const sum = shares.reduce((a, d) => a + d.amount, 0);
  const n = shares.length;
  const days = `${n} daily share${n === 1 ? "" : "s"}`;
  if (atOnce > 0 && n) return `Paid when bought ${usd(atOnce)}, then ${days} ${usd(sum)}.`;
  if (atOnce > 0) return `Paid when bought ${usd(atOnce)}.`;
  if (n) return `Paid in ${days}, ${usd(sum)}.`;
  return "Nothing paid yet.";
}

// ------------------------------------------------------------------ the header's figures

/** A figure in the header's stats: the value, and its quiet part beside it. */
export interface Stat {
  value: string;
  small?: string;
}

/** "Next share": the day the next daily share pays (the first one before the month starts). */
export function nextShareStat(series: Series, stage: MonthStage, now: number): Stat {
  if (stage === "upcoming") return { value: "Not yet", small: "month not open" };
  if (stage === "final") return { value: "All paid", small: `${series.n} of ${series.n} days` };
  const at = stage === "listed" ? firstPayAt(series) : nextShareAt(series);
  if (!at) return { value: "All paid", small: `${series.n} of ${series.n} days` };
  const left = inText(at, now);
  if (!left) return { value: "Due now", small: "any minute" };
  return { value: dateText(at), small: `${timeText(at)}, ${left}` };
}

/** "Pays out": a plain holding pays once its month's last day is final, about 07:00 UTC. */
export function payOutStat(series: Series, stage: MonthStage): Stat {
  const at = finalAt(series);
  if (!at) return { value: "Month end" };
  return stage === "final" ? { value: dateText(at), small: "final" } : { value: dateText(at), small: `about ${timeText(at)}` };
}

/** "Trading closes": the month's last trading day, and how far off it is. */
export function closesStat(series: Series, stage: MonthStage, now: number): Stat {
  const day = lastTradingDay(series);
  const date = dateText(new Date(day).toISOString());
  if (stage === "lastDay") return { value: "Today", small: `until ${timeText(sellEndsAt(series))}` };
  if (stage === "closed" || stage === "final") return { value: date, small: "closed" };
  const days = Math.max(0, Math.ceil((day - now) / DAY));
  return { value: date, small: `in ${days} day${days === 1 ? "" : "s"}` };
}

/** The month the header's dates speak for: the first held month still trading (else the first held). */
export function frontHeld<T extends { month: string }>(held: { series: T; stage: MonthStage }[]): T | undefined {
  const sorted = [...held].sort((a, b) => (a.series.month < b.series.month ? -1 : a.series.month > b.series.month ? 1 : 0));
  const open = sorted.find((x) => x.stage === "listed" || x.stage === "paying" || x.stage === "lastDay");
  return (open ?? sorted[0])?.series;
}

// ------------------------------------------------------------------ the list and the rail

/** The list's Pays cell: what the holding has paid, or when it pays. */
export function paysCell(daily: boolean, paid: number, v: Pick<HoldingView, "done" | "ready" | "final" | "stage">) {
  if (v.done) return daily ? "Paid in full" : "Collected";
  if (v.ready > 0) return "Ready to collect";
  if (daily) return `Paid ${usd0(paid)}`;
  if (v.final) return "At the final price";
  if (v.stage === "closed") return "Once final";
  return "At month end";
}

/** One row of the rail's timeline. done: its time has come (a filled dot); otherwise a ring. */
export interface Step {
  label: string;
  when: string;
  sub?: string;
  at: number;
  done: boolean;
}

/** The selected holding's short timeline: bought, how it pays, when trading closes, and once final, its price. */
export function steps(o: { openedAt: string; daily: boolean; series: Series; stage: MonthStage; now: number }): Step[] {
  const { series, stage, now } = o;
  const out: Omit<Step, "done">[] = [];
  const bought = Date.parse(o.openedAt);
  if (Number.isFinite(bought)) out.push({ label: "Bought", when: dateText(o.openedAt), at: bought });
  const fin = finalAt(series);
  const finT = Date.parse(fin);
  const sell = sellEndsAt(series);
  const ended = stage === "closed" || stage === "final";
  out.push({ label: ended ? "Trading closed" : "Trading closes", when: whenText(sell), at: Date.parse(sell) });
  if (o.daily) {
    const from = firstPayAt(series);
    const k = Math.min(series.k, series.n);
    out.push({ label: "Pays a share each day", when: `${dateText(from)} to ${dateText(fin)}`, sub: k > 0 ? `${k} of ${series.n} paid` : undefined, at: Date.parse(from) });
  } else if (stage === "final" && series.n > 0) {
    out.push({ label: `Final at ${usd(series.S / series.n)}`, when: dateText(fin), at: finT });
  } else {
    out.push({ label: "Pays at month end", when: `${dateText(fin)}, about ${timeText(fin)}`, at: finT });
  }
  return out
    .filter((x) => Number.isFinite(x.at) && x.when)
    .sort((a, b) => a.at - b.at)
    .map((x) => ({ ...x, done: x.at <= now }));
}

/** Why the rail has no close form for one of your holdings, in one line; null when it can be closed, or once final
 *  (it settles, nothing to close). closable: closeOrder has an order for it. */
export function closeWhy(stage: MonthStage | null, month: string, closable: boolean, kind: "position" | "tokens" | "shortBalance"): string | null {
  if (stage === "final") return null;
  if (stage === null) return `Can't read ${month}'s prices right now, so it can't be closed from here.`;
  if (stage === "upcoming") return `${month} isn't open for trading yet.`;
  if (stage === "closed") return `${month} has stopped trading, so this one settles at the final price.`;
  if (closable) return null;
  return kind === "tokens" ? "These GPU-hours rest in an order at Kuru, so they settle at the month's end." : "This one can't be closed from here: it settles at the month's end.";
}
