// Pure view helpers over the client's shapes: what the screens say about a market, for both sources. No React, no
// fetching. Times are always UTC, parsed with Date.parse (the client's ISO strings carry no milliseconds, so they are
// never compared as strings against toISOString()).
import type { Book, Candle, Day, Gpu, Market, Quote, Series } from "@/lib/mock/types";
import { usd } from "@/lib/format";

const HOUR = 3_600_000;
const DAY = 86_400_000;

export const EMPTY_QUOTE: Quote = { bid: 0, ask: 0, last: 0, lastAt: null };
/** A history day for "nothing yet", so a screen's `last` keeps its type. */
export const NO_DAY: Day = { date: "", price: 0, status: "final", example: false };

const MARKET_GPUS: readonly Gpu[] = ["H100", "H200", "B200"];

function iso(t: number) {
  return new Date(t).toISOString().replace(".000Z", "Z");
}

/** The month after "YYYY-MM". */
export function nextMonthOf(month: string) {
  const [y, m] = month.split("-").map(Number);
  return `${m === 12 ? y + 1 : y}-${String((m % 12) + 1).padStart(2, "0")}`;
}

/** "November" from "2026-11"; "" for anything else. */
export function monthLong(month: string) {
  const t = Date.parse(`${month}-01T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" }) : "";
}

/** "Oct 5" (UTC) from an ISO time or date; "" when there is none. */
export function dateText(isoTime: string | undefined | null) {
  const t = isoTime ? Date.parse(isoTime.length === 10 ? `${isoTime}T00:00:00Z` : isoTime) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "";
}

/** "07:00 UTC" from an ISO time; "" when there is none. */
export function timeText(isoTime: string | undefined | null) {
  const t = isoTime ? Date.parse(isoTime) : NaN;
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** "Oct 5, 07:00 UTC" from an ISO time; "" when there is none. */
export function whenText(isoTime: string | undefined | null) {
  const d = dateText(isoTime);
  return d ? `${d}, ${timeText(isoTime)}` : "";
}

/** "18h 32m" until an ISO time, or null once it is due (say "Any minute now": the times are expectations). */
export function countdown(isoTime: string | undefined | null, now: number) {
  const t = isoTime ? Date.parse(isoTime) : NaN;
  if (!Number.isFinite(t) || t <= now) return null;
  const mins = Math.ceil((t - now) / 60_000);
  return mins >= 48 * 60 ? `${Math.floor(mins / 1440)} days` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** The panel's counted slots: every cloud but the reserve ("n of N clouds" uses this N, never panelSize, or H100
 *  would read "5 of 6" as if a cloud were missing). */
export function panelCount(market: Market) {
  const n = market.panel.filter((p) => !p.reserve).length;
  return n || market.panelSize || market.sources.length;
}

/** "5 of 5 clouds", with the carried note when today's price was carried from yesterday. */
export function cloudsText(market: Market) {
  const last = market.history[market.history.length - 1];
  return `${market.liveCount} of ${panelCount(market)} clouds${last?.status === "carried" ? ", carried from yesterday, unverified" : ""}`;
}

/** The book's top as a quote: the ticket labels and its walk then read the same levels (the book refreshes on its own
 *  cadence, the market's quote with the markets read); the quote fills in a side the book has not loaded. `loaded`:
 *  the book has been read, so its sides are the truth and an empty side has no price (0), never the older quote's. */
export function topOf(book: Book, quote: Quote | null | undefined, loaded = false): Quote {
  const fill = loaded ? null : quote;
  return {
    bid: book.bids[0]?.price ?? fill?.bid ?? 0,
    ask: book.asks[0]?.price ?? fill?.ask ?? 0,
    last: quote?.last ?? 0,
    lastAt: quote?.lastAt ?? null,
  };
}

/** The month's change over the last 24 hours from its candles: the last close against the close of the last hour
 *  that ended by then (the first candle's open when the month is younger), in cents. 0 without candles. */
export function monthChange(candles: Candle[], now: number) {
  if (!candles.length) return 0;
  const cut = now - DAY;
  let base = candles[0].o;
  for (const c of candles) {
    if (Date.parse(c.t) + HOUR <= cut) base = c.c;
    else break;
  }
  return Math.round((candles[candles.length - 1].c - base) * 100) / 100;
}

/** GPU-hours traded in the 24 hours before now. */
export function tradedToday(candles: Candle[], now: number) {
  const cut = now - DAY;
  return candles.reduce((a, c) => (Date.parse(c.t) >= cut ? a + c.v : a), 0);
}

/** Whole hours since the month listed (the "Since listing" range); 0 when the listing time is unknown. */
export function hoursSinceListing(series: Series, now: number) {
  const t = series.listedAt ? Date.parse(series.listedAt) : NaN;
  return Number.isFinite(t) && now > t ? Math.ceil((now - t) / HOUR) : 0;
}

/** The start of the last day the month trades (UTC ms): the day before closesAt, or the month's last day. */
export function lastTradingDay(series: Series) {
  const t = series.closesAt ? Date.parse(series.closesAt) : NaN;
  if (Number.isFinite(t)) return t - DAY;
  const [y, m] = series.month.split("-").map(Number);
  return Date.UTC(y, m, 0);
}

/** How long before a month closes its market maker stops quoting (agate: about an hour), so selling ends then. */
export const MAKER_STOP_MS = HOUR;

/** Where a month's final value can still land, per GPU-hour, as the client's band() (writes.ts): with k of its N days
 *  priced (their clamped sum S), every day left adds between the floor and the ceiling. Before the month it is the
 *  floor to the ceiling. Also what pay me daily pays at once: a Long the low end (the priced days, plus the floor for
 *  the days left), a Short the ceiling less each priced day (AgateSeries._owed). */
export function bandNow(series: Pick<Series, "n" | "k" | "S" | "floor" | "cap">) {
  const n = Math.max(1, series.n);
  const k = Math.min(Math.max(0, series.k), n);
  const left = n - k;
  const lo = (series.S + left * series.floor) / n;
  const hi = (series.S + left * series.cap) / n;
  return { k, n, left, lo, hi, longNow: lo, shortNow: (k * series.cap - series.S) / n, soFar: k > 0 ? series.S / k : null };
}

/** Where a month stands at `now`: not listed yet, listed before it starts, paying out, its last day to sell, closed
 *  but its last day not final yet (nothing can be sold or collected), or final. */
export type MonthStage = "upcoming" | "listed" | "paying" | "lastDay" | "closed" | "final";
export function monthStage(series: Series, now: number): MonthStage {
  if (series.phase === "upcoming") return "upcoming";
  if (series.phase === "settled" || series.k >= series.n) return "final";
  const close = Date.parse(series.closesAt);
  if (Number.isFinite(close) && now >= close - MAKER_STOP_MS) return "closed";
  if (Number.isFinite(close) && now >= close - DAY) return "lastDay";
  return series.phase === "trading" ? "listed" : "paying";
}

/** A month that can be traded now: listed, priced in the book, and its maker still quoting. */
export function monthOpen(series: Series, now: number) {
  const st = monthStage(series, now);
  return (st === "listed" || st === "paying" || st === "lastDay") && !!series.quote;
}

/** When selling a month ends (its maker stops, about an hour before the month closes), ISO. */
export function sellEndsAt(series: Series) {
  const close = Date.parse(series.closesAt);
  return Number.isFinite(close) ? iso(close - MAKER_STOP_MS) : "";
}

/** The month Simple trades and the market row shows: the next month that has not started (listed, else the one
 *  opening next), so the screen always carries one month beside the index. A market with none shows its first. */
export function frontMonth(market: Pick<Market, "series">, now: number): Series | undefined {
  const ahead = market.series.filter((s) => s.phase !== "settled" && !(Date.parse(s.startsAt) <= now));
  return ahead.find((s) => s.phase === "trading") ?? ahead[0] ?? market.series[0];
}

/** A stand-in month for a market with none (a price-only GPU, or while nothing has loaded): the month after the next
 *  index price, upcoming, no band and no quote, so every screen can lay out without inventing a price. */
export function placeholderSeries(market: Pick<Market, "gpu" | "nextUpdateAt">): Series {
  const from = Date.parse(market.nextUpdateAt);
  const d = new Date(Number.isFinite(from) ? from : Date.now());
  const month = nextMonthOf(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  const [y, m] = month.split("-").map(Number);
  const short = new Date(Date.UTC(y, m - 1)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return {
    gpu: market.gpu,
    month,
    name: `Agate ${market.gpu} ${short} ${y}`,
    symbol: `${market.gpu}-${short.toUpperCase()}${String(y).slice(2)}`,
    n: new Date(Date.UTC(y, m, 0)).getUTCDate(),
    floor: 0,
    cap: 0,
    phase: "upcoming",
    k: 0,
    S: 0,
    quote: null,
    openInterest: 0,
    listedAt: "",
    closesAt: iso(Date.UTC(y, m, 1)),
    startsAt: iso(Date.UTC(y, m - 1, 1)),
    address: "",
    token: "",
    market: null,
  };
}

/** A market with nothing in it yet (while the first read is on its way, or when it failed): no price, no sources, no
 *  history, the next month upcoming. Neutral on purpose: a loading screen never shows a made-up number. */
export function placeholderMarket(gpu: Gpu, now = Date.now()): Market {
  const d = new Date(now);
  let next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 7);
  if (next <= now) next += DAY;
  const tradable = MARKET_GPUS.includes(gpu);
  const base = { gpu, nextUpdateAt: iso(next) };
  return {
    gpu,
    price: 0,
    prevPrice: 0,
    updatedAt: "",
    sources: [],
    history: [],
    series: tradable ? [placeholderSeries(base)] : [],
    nextUpdateAt: base.nextUpdateAt,
    liveCount: 0,
    panelSize: 0,
    priceDate: null,
    nextCloseAt: iso(next - 6 * HOUR),
    tradable,
    panel: [],
  };
}

const WORDS: Record<number, string> = { 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine" };

/** "five" for 5 (the number itself past nine). */
export function countWord(n: number) {
  return WORDS[n] ?? String(n);
}

/** "Verda, Nebius and Civo" */
export function listText(names: string[]) {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The month's own situation for the ticket, the book, the trades and the month chart (the index's "before the first
 *  price" is separate: it never decides what the month shows). `book` is the month's book once it has loaded. */
export type MonthState = "priceOnly" | "upcoming" | "emptyBook" | "noTrades" | "trading";
export function monthStateOf(market: Market, series: Series | null | undefined, book?: Book | null): MonthState {
  if (!market.tradable) return "priceOnly";
  if (!series || series.phase === "upcoming" || !series.quote) return "upcoming";
  if (book && !book.asks.length && !book.bids.length) return "emptyBook";
  if (series.quote.lastAt === null) return "noTrades";
  return "trading";
}

export type ScreenState = "priceOnly" | "beforeFirst" | "upcoming" | "emptyBook" | "noTrades" | "trading";

/** Which situation the trade screen is in, most important first. `book` is the month's book when it has loaded. */
export function screenState(market: Market, series: Series | null | undefined, book?: Book | null): ScreenState {
  if (!market.tradable) return "priceOnly";
  if (market.priceDate === null) return "beforeFirst";
  if (!series || series.phase === "upcoming" || !series.quote) return "upcoming";
  if (book && !book.asks.length && !book.bids.length) return "emptyBook";
  if (series.quote.lastAt === null) return "noTrades";
  return "trading";
}

/** The one status line for the Notice bar slot (pass 2 passes it as Notice's `status`), or null when all is well.
 *  `status` is useDataStatus(); `hasData` whether a markets read ever answered. Never the raw error text. */
export function statusLine(status: { error: boolean; stale: boolean; updatedAt: number; indexerUp: boolean }, hasData: boolean) {
  if (status.error || status.stale) {
    // while reads fail the markets read runs every minute (hooks.ts doubles its 30 s cadence)
    if (!hasData || !status.updatedAt) return "Can't reach Monad's test network right now. Trying again every minute.";
    // the day too, once the prices shown are from an earlier day (UTC)
    const at = new Date(status.updatedAt).toISOString();
    const today = new Date().toISOString().slice(0, 10) === at.slice(0, 10);
    return `Can't reach Monad's test network. Showing prices from ${today ? timeText(at) : whenText(at)}, trying again.`;
  }
  if (!status.indexerUp) return "Trade history is catching up. Prices and the book are live.";
  return null;
}

/** The trade bar's and the CTA's stale state: "nodata" (nothing ever read), "stale" (old prices), or "none". */
export function staleState(status: { error: boolean; stale: boolean }, hasData: boolean): "none" | "stale" | "nodata" {
  if (!hasData) return status.error ? "nodata" : "none";
  return status.stale ? "stale" : "none";
}

export interface Cell {
  label: string;
  value: string;
  sub: string;
}

/** The trade header's two cells as words (label, value, the line under it), the month against the index, and the
 *  insight behind it (null when there is no month price to compare). Pass 2 renders these; copy per the live map.
 *  `candles` null: they could not be read, so the day change is said to be unavailable, never "+$0.00" (while they
 *  are on their way the screen shows a skeleton there instead). */
export function headline(market: Market, series: Series | null | undefined, candles: Candle[] | null, now: number, indexerUp = true) {
  const gpu = market.gpu;
  const first = market.history.length === 1;
  const delta = market.price - market.prevPrice;
  const index: Cell =
    market.priceDate === null
      ? { label: `${gpu} index`, value: dateText(market.nextUpdateAt), sub: `First price about ${timeText(market.nextUpdateAt)}` }
      : {
          label: `Today's ${gpu} index`,
          value: usd(market.price),
          sub: first ? `First day of our record, ${dateText(market.priceDate)}` : Math.abs(delta) < 0.005 ? "Same as yesterday" : `${delta > 0 ? "+" : "−"}${usd(Math.abs(delta))} since yesterday`,
        };
  const s = series ?? null;
  const name = s ? monthLong(s.month) : "";
  let month: Cell;
  let monthPrice: number | null = null;
  if (!market.tradable || !s) month = { label: "Monthly market", value: "None", sub: "Price only for now" };
  // the opening time when it is known ("soon" otherwise, as the strip, the bar and the ticket say)
  else if (s.phase === "upcoming" || !s.quote)
    month = s.opensOn ? { label: `${name} market`, value: `Opens ${dateText(s.opensOn)}`, sub: `about ${timeText(s.opensOn)}` } : { label: `${name} market`, value: "Opens soon", sub: "Not open for trading yet" };
  else if (!s.quote.last) month = { label: `${name} market`, value: "No price yet", sub: "No prices in the book yet" };
  else {
    monthPrice = s.quote.last;
    const change = candles ? monthChange(candles, now) : null;
    month = {
      label: `${name} market`,
      value: usd(s.quote.last),
      sub:
        s.quote.lastAt === null
          ? indexerUp
            ? "No trades yet, middle of the book"
            : "Middle of the book"
          : change === null
            ? "Today's change not available"
            : `${change >= 0 ? "+" : "−"}${usd(Math.abs(change))} today`,
    };
  }
  let premText: string | null = null;
  let insight: string | null = null;
  if (monthPrice !== null && market.price > 0) {
    const prem = monthPrice / market.price - 1;
    const level = Math.abs(prem) < 0.0005;
    premText = level ? "Level with the index" : `${Math.abs(prem * 100).toFixed(1)}% ${prem > 0 ? "above" : "below"} the index`;
    insight = level
      ? `Traders expect ${name} to cost about the same as today's index (${usd(monthPrice)} against ${usd(market.price)}). Think it will average more? Long gains. Less? Short gains.`
      : `Traders expect ${name} to cost ${Math.abs(prem * 100).toFixed(1)}% ${prem > 0 ? "more" : "less"} than today's index (${usd(monthPrice)} against ${usd(market.price)}). Think it will average above ${usd(monthPrice)}? Long gains. Below? Short gains.`;
  }
  return { index, month, premText, insight };
}
