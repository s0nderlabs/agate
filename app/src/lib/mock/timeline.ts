// The example's month timeline (Mock controls "Day"): the same example markets on later days, when two months are
// live at once, a month's last hours, the gap before its last day is final, and after it. Every number comes from one
// index path and the band rules, never typed in: the floor is half and the ceiling double the anchor (the five days
// before the month lists) on a $0.05 grid, k and S are the days priced and their clamped sum, and the maker quotes
// (S + (N - k) x the index's clamped price) / N, a cent either side, as the testnet bot does.
import type { Candle, Day, Fill, Gpu, Market, MarketGpu, PanelSlot, Position, Quote, Series } from "./types";
import type { Moment } from "./config";
import { AS_OF, botQuote, getMarket, NOVEMBER, SOURCES } from "./data";
import { indexHistory, monthChangePct } from "./market";
import { median } from "@/lib/peers";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const ZERO = "0x0000000000000000000000000000000000000000";

/** The moment each Day stands on (UTC): after the day's final price (07:00) unless the moment is about that gap. */
export const MOMENT_AT: Record<Moment, string> = {
  oct: AS_OF,
  nov3: "2026-11-03T09:00:00Z",
  nov13: "2026-11-13T09:00:00Z",
  nov30: "2026-11-30T22:15:00Z",
  dec1gap: "2026-12-01T03:00:00Z",
  dec1final: "2026-12-01T09:00:00Z",
};

export const momentNow = (m: Moment) => Date.parse(MOMENT_AT[m]);

const iso = (t: number) => new Date(t).toISOString().replace(".000Z", "Z");
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function rng(seed: number) {
  let t = seed;
  return () => {
    t = (t * 1664525 + 1013904223) % 4294967296;
    return t / 4294967296;
  };
}
const SEED: Record<MarketGpu, number> = { H100: 41, H200: 59, B200: 73 };

/** Today's example index (the median of the live clouds), as getMarket has it. */
const basePrice = (g: MarketGpu) =>
  r2(
    median(
      SOURCES[g]
        .filter((s) => s.live)
        .map((s) => s.price),
    ),
  );

/** The newest final day at `now`: a day's price turns final about 07:00 UTC the next day. */
function lastFinal(now: number) {
  return dayOf(Math.floor((now - 7 * HOUR) / DAY) * DAY - DAY);
}

/** Final prices from the example's 120 days to Oct 2 (indexHistory), then on to Dec 1 with the same texture (a cloud
 *  reprices on about one day in eight), drifting a few percent up through November. */
const PATHS = new Map<MarketGpu, Day[]>();
function path(g: MarketGpu): Day[] {
  const had = PATHS.get(g);
  if (had) return had;
  const base = basePrice(g);
  const days: Day[] = indexHistory(g, base, "normal");
  const r = rng(SEED[g] + 101);
  let p = base;
  for (let t = Date.UTC(2026, 9, 3); t <= Date.UTC(2026, 11, 1); t += DAY) {
    if (r() < 0.13) p = clamp(p + (r() < 0.62 ? 1 : -1) * (0.01 + r() * 0.025) * base, base * 0.9, base * 1.15);
    days.push({ date: dayOf(t), price: r2(p), status: "final", example: false });
  }
  PATHS.set(g, days);
  return days;
}

const grid = (x: number, up: boolean) => r2((up ? Math.ceil(x / 0.05 - 1e-9) : Math.floor(x / 0.05 + 1e-9)) * 0.05);

/** A month's band from its anchor days: floor half, ceiling double their average, on a $0.05 grid. */
function bandFrom(g: MarketGpu, from: string, to: string) {
  const ds = path(g).filter((d) => d.date >= from && d.date <= to);
  const a = ds.reduce((x, d) => x + d.price, 0) / ds.length;
  return { floor: grid(a / 2, false), cap: grid(a * 2, true) };
}

interface MonthSpec {
  month: string;
  /** when it lists: the anchor's last day final (07:00 UTC on the 1st of the month before) */
  listedAt: string;
  band: (g: MarketGpu) => { floor: number; cap: number };
}
const MONTHS: MonthSpec[] = [
  { month: "2026-11", listedAt: "2026-10-01T00:00:00Z", band: (g) => ({ floor: NOVEMBER[g].floor, cap: NOVEMBER[g].cap }) },
  { month: "2026-12", listedAt: "2026-11-01T07:00:00Z", band: (g) => bandFrom(g, "2026-10-27", "2026-10-31") },
  { month: "2027-01", listedAt: "2026-12-01T07:00:00Z", band: (g) => bandFrom(g, "2026-11-26", "2026-11-30") },
  { month: "2027-02", listedAt: "2027-01-01T07:00:00Z", band: () => ({ floor: 0, cap: 0 }) },
];

/** The maker's premium over the index for days not priced yet: the example November quote against the example index. */
const premium = (g: MarketGpu) => NOVEMBER[g].quote.last / basePrice(g) - 1;

/** Hourly candles from `from` to `to`, ending on `last`, the close 24 hours before `to` pinned to the example day
 *  change (as novCandles does for the example's own morning). */
function candlesBetween(g: MarketGpu, salt: number, last: number, from: number, to: number): Candle[] {
  const r = rng(SEED[g] + 29 + salt);
  const n = Math.max(2, Math.floor((to - from) / HOUR));
  const out: Candle[] = [];
  let p = last * 0.985;
  for (let i = 0; i < n; i++) {
    const o = p;
    const drift = (last - p) / Math.max(1, n - i);
    const c = Math.max(o * 0.97, Math.min(o * 1.03, o + drift + (r() - 0.5) * last * 0.006));
    const h = Math.max(o, c) + r() * last * 0.0035;
    const l = Math.min(o, c) - r() * last * 0.0035;
    out.push({ t: iso(from + i * HOUR), o: r3(o), h: r3(h), l: r3(l), c: r3(c), v: Math.round(1 + r() * 9) * 240 });
    p = c;
  }
  const end = out[n - 1];
  end.c = last;
  end.h = Math.max(end.h, last);
  end.l = Math.min(end.l, last);
  const k = n - 25;
  if (k > 0) {
    const base = r3(last / (1 + monthChangePct(g) / 100));
    out[k] = { ...out[k], c: base, h: Math.max(out[k].h, base), l: Math.min(out[k].l, base) };
    out[k + 1] = { ...out[k + 1], o: base, h: Math.max(out[k + 1].h, base), l: Math.min(out[k + 1].l, base) };
  }
  return out;
}

/** 14 fills before `at`, newest first, around the quote. */
function fillsBefore(g: MarketGpu, salt: number, q: Quote, at: number): Fill[] {
  const r = rng(SEED[g] + 13 + salt);
  let t = at - 2 * MIN;
  const bid = q.bid || q.last * 0.99;
  const ask = q.ask || q.last * 1.01;
  return Array.from({ length: 14 }, () => {
    t -= (1 + Math.floor(r() * 9)) * MIN;
    const buy = r() < 0.55;
    const d = new Date(t);
    return {
      time: `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`,
      side: buy ? "buy" : "sell",
      price: r2(buy ? ask - (r() < 0.3 ? 0.01 : 0) : bid + (r() < 0.3 ? 0.01 : 0)),
      size: Math.round(1 + r() * 5) * 240,
      at: iso(t),
      txHash: "",
    };
  });
}

interface Built {
  market: Market;
  candles: Map<string, Candle[]>;
  fills: Map<string, Fill[]>;
}
const BUILT = new Map<string, Built>();

function build(g: MarketGpu, m: Moment): Built {
  const key = `${g}|${m}`;
  const had = BUILT.get(key);
  if (had) return had;
  const now = momentNow(m);
  const base = basePrice(g);
  const last = lastFinal(now);
  const all = path(g);
  const hist = all.filter((d) => d.date <= last).slice(-120);
  const price = hist[hist.length - 1].price;
  const ratio = price / base;
  const sources = SOURCES[g].map((s) => ({ ...s, price: r2(s.price * ratio) }));
  const reserve = (family: string) => g === "H100" && family === "Hyperstack";
  const panel: PanelSlot[] = sources.map((s) => ({ family: s.family, live: s.live, reserve: reserve(s.family), price: s.live ? s.price : null }));
  const candles = new Map<string, Candle[]>();
  const fills = new Map<string, Fill[]>();

  const series: Series[] = [];
  for (const [i, spec] of MONTHS.entries()) {
    const [y, mo] = spec.month.split("-").map(Number);
    const startsAt = Date.UTC(y, mo - 1, 1);
    const closesAt = Date.UTC(y, mo, 1);
    const n = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const short = new Date(startsAt).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
    const shape = { gpu: g as Gpu, month: spec.month, name: `Agate ${g} ${short} ${y}`, symbol: `${g}-${short.toUpperCase()}${String(y).slice(2)}`, n, startsAt: iso(startsAt), closesAt: iso(closesAt), address: ZERO, token: ZERO, market: null };
    const listedAt = Date.parse(spec.listedAt);
    if (now < listedAt) {
      // only the next month to list shows, as the client returns it
      series.push({ ...shape, floor: 0, cap: 0, phase: "upcoming", opensOn: spec.listedAt, k: 0, S: 0, quote: null, openInterest: 0, listedAt: "" });
      break;
    }
    const { floor, cap } = spec.band(g);
    const priced = all.filter((d) => d.date.startsWith(spec.month) && d.date <= last);
    const k = priced.length;
    const S = priced.reduce((x, d) => x + clamp(d.price, floor, cap), 0);
    const phase: Series["phase"] = k >= n ? "settled" : now < startsAt ? "trading" : "paying";
    const stop = closesAt - HOUR;
    const xc = clamp(price * (1 + premium(g)), floor, cap);
    const fair = r2((S + (n - k) * xc) / n);
    let quote: Quote;
    if (phase === "settled") quote = { bid: 0, ask: 0, last: r2(S / n), lastAt: iso(stop - 3 * MIN) };
    else if (now >= stop) quote = { bid: 0, ask: 0, last: fair, lastAt: iso(stop - 3 * MIN) };
    else quote = { ...botQuote(fair), last: fair, lastAt: iso(now - 2 * MIN) };
    const until = Math.min(now, stop);
    const cs = candlesBetween(g, i * 7, quote.last, listedAt, until);
    candles.set(spec.month, cs);
    fills.set(spec.month, fillsBefore(g, i * 7, quote, until));
    const traded = cs.reduce((a, x) => a + x.v, 0);
    series.push({ ...shape, floor, cap, phase, k, S, quote, openInterest: Math.round((traded * 0.62) / 240) * 240, listedAt: spec.listedAt });
  }

  const live = sources.filter((s) => s.live).map((s) => s.price);
  // the next price and close follow the real clock, as the example's own morning does, so their countdowns run live
  const nextAt = (hour: number) => {
    const c = Date.now();
    let t = Date.UTC(new Date(c).getUTCFullYear(), new Date(c).getUTCMonth(), new Date(c).getUTCDate(), hour);
    if (t <= c) t += DAY;
    return iso(t);
  };
  const market: Market = {
    gpu: g,
    price,
    prevPrice: hist.length > 1 ? hist[hist.length - 2].price : price,
    updatedAt: iso(Date.parse(`${last}T00:00:00Z`) + DAY + 7 * HOUR),
    sources,
    history: hist,
    series,
    nextUpdateAt: nextAt(7),
    liveCount: live.length,
    panelSize: panel.length,
    priceDate: last,
    nextCloseAt: nextAt(1),
    tradable: true,
    panel,
  };
  const b = { market, candles, fills };
  BUILT.set(key, b);
  return b;
}

const isMarketGpu = (g: Gpu): g is MarketGpu => g in SOURCES;

/** One GPU's example market on a Day of the timeline (price-only GPUs as they are every day: no price yet). */
export function momentMarket(g: Gpu, m: Moment): Market {
  return isMarketGpu(g) ? build(g, m).market : getMarket(g);
}

export function momentCandles(g: Gpu, month: string, m: Moment): Candle[] {
  return isMarketGpu(g) ? (build(g, m).candles.get(month) ?? []) : [];
}

export function momentFills(g: Gpu, month: string, m: Moment, limit: number): Fill[] {
  return isMarketGpu(g) ? (build(g, m).fills.get(month) ?? []).slice(0, limit) : [];
}

/** A holder of H100 November, bought on the example's morning (Oct 3) at the example quote: two GPUs Long with pay me
 *  daily, one GPU Long paid at the end, one GPU Short paid at the end. Paid so far and what a collect pays follow the
 *  Day: a daily Long has the priced days plus the floor for the rest; the others are paid once, after the month. */
export function holderPositions(m: Moment): Position[] {
  const { bid, ask } = botQuote(NOVEMBER.H100.quote.last);
  const base = { gpu: "H100" as Gpu, month: "2026-11", openedAt: "2026-10-03T05:10:00Z", series: ZERO, payee: null, inMargin: 0, paid: 0, claimable: 0 };
  const held: Position[] = [
    { ...base, id: "example-nov-daily", side: "long", q: 1440, entry: ask, daily: true, kind: "position", positionId: "1" },
    { ...base, id: "example-nov-long", side: "long", q: 720, entry: ask, daily: false, kind: "tokens", positionId: null },
    { ...base, id: "example-nov-short", side: "short", q: 720, entry: bid, daily: false, kind: "position", positionId: "2" },
  ];
  // on today's morning the pay me daily Long has already had November's floor back, as the router pays it at once
  const floor = build("H100", m).market.series.find((x) => x.month === base.month)?.floor ?? 0;
  return held.map((p) => (m === "oct" && p.daily && p.side === "long" ? { ...p, paid: Math.round(p.q * floor * 100) / 100 } : positionAt(p, m)));
}

/** A position as it stands on a Day, opened before its month started: pay me daily has been paid the priced days plus
 *  (a Long) the floor for the rest at once, as AgateSeries pays it; the others are paid once, after the month, and
 *  can be collected once it is final. Today's example (the Oct morning) keeps what the trade itself recorded. */
export function positionAt(p: Position, m: Moment): Position {
  if (m === "oct" || !isMarketGpu(p.gpu)) return p;
  const s = build(p.gpu, m).market.series.find((x) => x.month === p.month);
  if (!s || s.phase === "upcoming") return p;
  const n = s.n;
  const k = Math.min(s.k, n);
  const cents = (x: number) => Math.round(x * 100) / 100;
  const L = p.side === "long";
  if (p.daily) return { ...p, paid: cents(p.q * (L ? (s.S + (n - k) * s.floor) / n : (k * s.cap - s.S) / n)), claimable: 0 };
  const V = s.S / n;
  return { ...p, paid: 0, claimable: k >= n ? cents(p.q * (L ? V : s.cap - V)) : 0 };
}
