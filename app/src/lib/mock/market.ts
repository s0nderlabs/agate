// Trade-screen mock data: index history with the texture of real list prices (flat for days, then a step
// when one cloud reprices), the November book on Kuru, recent fills and the ticker strip.
import type { DataState } from "./data";
import type { Gpu, Market } from "./types";

export interface Day {
  date: string;
  price: number;
  status: "final" | "carried";
  example: boolean;
}

function rng(seed: number) {
  let t = seed;
  return () => {
    t = (t * 1664525 + 1013904223) % 4294967296;
    return t / 4294967296;
  };
}

const SEED: Record<Gpu, number> = { H100: 41, H200: 59, B200: 73 };

/** 120 days ending Oct 2 (the last final day). Walks backwards from today's real price. */
export function indexHistory(gpu: Gpu, today: number, state: DataState = "live"): Day[] {
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

export interface BookLevel {
  price: number;
  size: number; // GPU-hours
}

/** agate's market-maker bot on testnet: 3 levels each side, a tick apart, 1,000 / 2,000 / 4,000 GPU-hours, never
 * outside the floor and ceiling. */
export function book(market: Market) {
  const q = market.series[0].quote!;
  const s0 = market.series[0];
  const sizes = [1000, 2000, 4000];
  const asks: BookLevel[] = sizes.map((size, i) => ({ price: Math.round((q.ask + i * 0.01) * 100) / 100, size })).filter((l) => l.price < s0.cap);
  const bids: BookLevel[] = sizes.map((size, i) => ({ price: Math.round((q.bid - i * 0.01) * 100) / 100, size })).filter((l) => l.price > s0.floor);
  return { asks, bids, spread: Math.round((q.ask - q.bid) * 100) / 100 };
}

export interface Fill {
  time: string;
  side: "buy" | "sell";
  price: number;
  size: number;
}

export function recentFills(gpu: Gpu, market: Market): Fill[] {
  const q = market.series[0].quote!;
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
    return {
      time: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
      side: buy ? "buy" : "sell",
      price: buy ? q.ask - (r() < 0.3 ? 0.01 : 0) : q.bid + (r() < 0.3 ? 0.01 : 0),
      size: Math.round(1 + r() * 5) * 240,
    };
  });
}

/** Example day change of each November token, percent (shown in the market row and the header). */
export function monthChangePct(gpu: Gpu) {
  return { H100: 0.5, H200: -0.21, B200: 0.71 }[gpu];
}

export interface Candle {
  /** ISO hour, UTC */
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  /** GPU-hours traded */
  v: number;
}

const rnd = (x: number) => Math.round(x * 1000) / 1000;

/** Hourly candles for the November token since it listed (Oct 1, 00:00 UTC) up to now (Oct 3, 06:00 UTC). */
export function novCandles(gpu: Gpu, market: Market): Candle[] {
  const q = market.series[0].quote!;
  const r = rng(SEED[gpu] + 29);
  const start = Date.UTC(2026, 9, 1, 0);
  const n = 54;
  const out: Candle[] = [];
  // walk forward from a level a little under today's, ending on the current last trade
  let p = q.last * 0.985;
  for (let i = 0; i < n; i++) {
    const o = p;
    const drift = (q.last - p) / Math.max(1, n - i);
    const c = Math.max(o * 0.97, Math.min(o * 1.03, o + drift + (r() - 0.5) * q.last * 0.006));
    const h = Math.max(o, c) + r() * q.last * 0.0035;
    const l = Math.min(o, c) - r() * q.last * 0.0035;
    out.push({ t: new Date(start + i * 3600000).toISOString(), o: rnd(o), h: rnd(h), l: rnd(l), c: rnd(c), v: Math.round(1 + r() * 9) * 240 });
    p = c;
  }
  const last = out[n - 1];
  last.c = q.last;
  last.h = Math.max(last.h, q.last);
  last.l = Math.min(last.l, q.last);
  return out;
}
