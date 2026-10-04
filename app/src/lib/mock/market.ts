// Trade-screen mock data: index history with the texture of real list prices (flat for days, then a step
// when one cloud reprices), the November book on Kuru, recent fills and hourly candles. The example source
// (lib/data/example.ts) serves these in the client's shapes; screens never call them directly.
import type { DataState } from "./data";
import type { BookLevel, Candle, Day, Fill, MarketGpu, Quote, Series } from "./types";

export type { BookLevel, Candle, Day, Fill } from "./types";

function rng(seed: number) {
  let t = seed;
  return () => {
    t = (t * 1664525 + 1013904223) % 4294967296;
    return t / 4294967296;
  };
}

const SEED: Record<MarketGpu, number> = { H100: 41, H200: 59, B200: 73 };

/** 120 days ending Oct 2 (the last final day). Walks backwards from today's real price. */
export function indexHistory(gpu: MarketGpu, today: number, state: DataState = "normal"): Day[] {
  const r = rng(SEED[gpu]);
  const end = Date.UTC(2026, 9, 2);
  const n = 120;
  const prices: number[] = [today];
  let p = today;
  for (let i = 1; i < n; i++) {
    // a cloud reprices on roughly one day in twelve; the middle price then moves a few cents
    if (r() < 0.085) p = Math.max(today * 0.82, Math.min(today * 1.12, p + (r() < 0.55 ? 1 : -1) * (0.03 + r() * 0.16) * (today / 4)));
    prices.push(Math.round(p * 100) / 100);
  }
  prices.reverse();
  const days: Day[] = prices.map((price, i) => {
    const date = new Date(end - (n - 1 - i) * 86400000).toISOString().slice(0, 10);
    return { date, price, status: "final", example: date < "2026-09-30" };
  });
  if (gpu === "H100") {
    const k = days.findIndex((d) => d.date === "2026-09-21");
    if (k > 0) days[k] = { ...days[k], price: days[k - 1].price, status: "carried" };
  }
  if (state === "carried") days[days.length - 1] = { ...days[days.length - 1], status: "carried" };
  return days;
}

/** agate's market-maker bot on testnet: 3 levels each side, a tick apart, 1,000 / 2,000 / 4,000 GPU-hours, never
 * outside the floor and ceiling, around a listed month's quote. */
export function book(series: Series) {
  const q = series.quote!;
  const sizes = [1000, 2000, 4000];
  const asks: BookLevel[] = sizes.map((size, i) => ({ price: Math.round((q.ask + i * 0.01) * 100) / 100, size })).filter((l) => l.price < series.cap);
  const bids: BookLevel[] = sizes.map((size, i) => ({ price: Math.round((q.bid - i * 0.01) * 100) / 100, size })).filter((l) => l.price > series.floor);
  return { asks, bids, spread: Math.round((q.ask - q.bid) * 100) / 100 };
}

/** 14 fills, newest first, on Oct 3 before 06:00 UTC (the example's now). */
export function recentFills(gpu: MarketGpu, q: Quote): Fill[] {
  const r = rng(SEED[gpu] + 13);
  let h = 5,
    m = 58;
  return Array.from({ length: 14 }, () => {
    m -= 1 + Math.floor(r() * 9);
    if (m < 0) {
      m += 60;
      h -= 1;
    }
    const buy = r() < 0.55;
    const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    return {
      time,
      side: buy ? "buy" : "sell",
      price: buy ? q.ask - (r() < 0.3 ? 0.01 : 0) : q.bid + (r() < 0.3 ? 0.01 : 0),
      size: Math.round(1 + r() * 5) * 240,
      at: `2026-10-03T${time}:00Z`,
      txHash: "",
    };
  });
}

/** Example day change of each November token, percent (shown in the market row and the header). */
export function monthChangePct(gpu: MarketGpu) {
  return { H100: 0.5, H200: -0.21, B200: 0.71 }[gpu];
}

const rnd = (x: number) => Math.round(x * 1000) / 1000;

/** Hourly candles for the November token since it listed (Oct 1, 00:00 UTC) up to now (Oct 3, 06:00 UTC), ending on
 * `last`. The close 24 hours before now is pinned to the example day change (monthChangePct), so the header's
 * "today" line and the candles tell the same story, the way the live header derives it from the candles. */
export function novCandles(gpu: MarketGpu, last: number): Candle[] {
  const r = rng(SEED[gpu] + 29);
  const start = Date.UTC(2026, 9, 1, 0);
  const n = 54;
  const out: Candle[] = [];
  // walk forward from a level a little under today's, ending on the current last trade
  let p = last * 0.985;
  for (let i = 0; i < n; i++) {
    const o = p;
    const drift = (last - p) / Math.max(1, n - i);
    const c = Math.max(o * 0.97, Math.min(o * 1.03, o + drift + (r() - 0.5) * last * 0.006));
    const h = Math.max(o, c) + r() * last * 0.0035;
    const l = Math.min(o, c) - r() * last * 0.0035;
    out.push({ t: new Date(start + i * 3600000).toISOString(), o: rnd(o), h: rnd(h), l: rnd(l), c: rnd(c), v: Math.round(1 + r() * 9) * 240 });
    p = c;
  }
  const end = out[n - 1];
  end.c = last;
  end.h = Math.max(end.h, last);
  end.l = Math.min(end.l, last);
  // the hour that ended 24 hours before now (Oct 2, 05:00 to 06:00) closes where the day change says, and the next
  // hour opens there
  const k = n - 25;
  const base = rnd(last / (1 + monthChangePct(gpu) / 100));
  out[k] = { ...out[k], c: base, h: Math.max(out[k].h, base), l: Math.min(out[k].l, base) };
  out[k + 1] = { ...out[k + 1], o: base, h: Math.max(out[k + 1].h, base), l: Math.min(out[k + 1].l, base) };
  return out;
}
