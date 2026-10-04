// Mock market data. Real numbers where we have them (the wall's Oct 2 2026 launch panel, peers'
// Oct 2 reads); everything before our own record (Sep 30) is example history and marked so.
import type { Comparison, Gpu, IndexDay, Market, Series, SourceReading } from "./types";

export const GPUS: Gpu[] = ["H100", "H200", "B200"];

/** The mock's "now". Today's index price is the last final day: a day closes at 00:00 UTC, its price is
 * published about 01:00 UTC and turns final about 07:00 UTC after a six-hour pending window. */
export const AS_OF = "2026-10-03T06:00:00Z";

const SOURCES: Record<Gpu, SourceReading[]> = {
  H100: [
    { family: "Civo", price: 2.99, live: true },
    { family: "Verda", price: 3.66, live: true },
    { family: "Lambda", price: 3.99, live: true },
    { family: "Nebius", price: 4.5, live: true },
    { family: "CoreWeave", price: 6.16, live: true },
    { family: "Hyperstack", price: 3.2, live: false },
  ],
  H200: [
    { family: "Civo", price: 3.49, live: true },
    { family: "Hyperstack", price: 3.99, live: true },
    { family: "Verda", price: 4.78, live: true },
    { family: "Nebius", price: 5.4, live: true },
    { family: "CoreWeave", price: 6.31, live: true },
  ],
  B200: [
    { family: "Hyperstack", price: 6.0, live: true },
    { family: "Lambda", price: 6.69, live: true },
    { family: "Verda", price: 6.99, live: true },
    { family: "Nebius", price: 8.5, live: true },
    { family: "CoreWeave", price: 8.6, live: true },
  ],
};

/** November's band, from the spec formula (F = 0.5x, C = 2x the five-day average, on a $0.05 grid). */
const NOVEMBER: Record<Gpu, { floor: number; cap: number; quote: { bid: number; ask: number; last: number } }> = {
  H100: { floor: 1.95, cap: 8.0, quote: { bid: 4.01, ask: 4.05, last: 4.03 } },
  H200: { floor: 2.35, cap: 9.6, quote: { bid: 4.8, ask: 4.86, last: 4.84 } },
  B200: { floor: 3.45, cap: 14.0, quote: { bid: 7.0, ask: 7.08, last: 7.05 } },
};

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Deterministic wander so every load draws the same example history.
function rng(seed: number) {
  let t = seed;
  return () => {
    t = (t * 1664525 + 1013904223) % 4294967296;
    return t / 4294967296;
  };
}

function history(gpu: Gpu, today: number): IndexDay[] {
  const r = rng(gpu === "H100" ? 7 : gpu === "H200" ? 11 : 13);
  const days: IndexDay[] = [];
  const end = Date.UTC(2026, 9, 2); // Oct 2, the last final day
  let p = today * 0.965;
  for (let i = 29; i >= 0; i--) {
    const d = new Date(end - i * 86400000);
    const date = d.toISOString().slice(0, 10);
    if (i === 0) p = today;
    else p = Math.max(today * 0.9, Math.min(today * 1.04, p + (r() - 0.46) * today * 0.012));
    const carried = gpu === "H100" && date === "2026-09-21";
    if (carried && days.length) p = days[days.length - 1].price;
    days.push({ date, price: Math.round(p * 100) / 100, status: carried ? "carried" : "final", example: date < "2026-09-30" });
  }
  return days;
}

export type DataState = "live" | "loading" | "degraded" | "carried";

/** book "bot": the testnet market-maker's real shape (agate, Oct 3): best bid = fair x 0.99 rounded down to the
 * cent, best ask = fair x 1.01 rounded up; fair = the month's last trade here. "deep": the earlier 9-level mock. */
export function botQuote(fair: number) {
  return { bid: Math.floor(fair * 0.99 * 100 + 1e-6) / 100, ask: Math.ceil(fair * 1.01 * 100 - 1e-6) / 100 };
}

export function getMarket(gpu: Gpu, state: DataState = "live", bookMode: "bot" | "deep" = "deep"): Market {
  let sources = SOURCES[gpu];
  if (state === "degraded") sources = sources.map((s) => (s.family === "CoreWeave" ? { ...s, live: false } : s));
  const live = sources.filter((s) => s.live).map((s) => s.price);
  const price = Math.round(median(live) * 100) / 100;
  const hist = history(gpu, price);
  if (state === "carried") hist[hist.length - 1] = { ...hist[hist.length - 1], status: "carried" };
  const nov = NOVEMBER[gpu];
  const series: Series[] = [
    {
      gpu,
      month: "2026-11",
      name: `Agate ${gpu} Nov 2026`,
      symbol: `${gpu}-NOV26`,
      n: 30,
      floor: nov.floor,
      cap: nov.cap,
      phase: "trading",
      k: 0,
      S: 0,
      quote: bookMode === "bot" ? { ...nov.quote, ...botQuote(nov.quote.last) } : nov.quote,
    },
    {
      gpu,
      month: "2026-12",
      name: `Agate ${gpu} Dec 2026`,
      symbol: `${gpu}-DEC26`,
      n: 31,
      floor: 0,
      cap: 0,
      phase: "upcoming",
      opensOn: "2026-11-01",
      k: 0,
      S: 0,
      quote: null,
    },
  ];
  return {
    gpu,
    price,
    prevPrice: hist[hist.length - 2].price,
    updatedAt: AS_OF,
    sources,
    history: hist,
    series,
  };
}

/** Shown beside our index for H100 only; display only, never used to pay. */
export const COMPARISON: Comparison[] = [
  { name: "Agate index", price: 3.99, kind: "ours", note: "Posted prices from five clouds, onchain on Monad. This is the one that pays.", asOf: "Oct 2" },
  { name: "Ornn", price: 2.92, kind: "traded-private", note: "Traded prices, private data. Shown with credit, display only.", asOf: "Oct 2" },
  { name: "Akash", price: 2.6, kind: "traded-onchain", note: "Real rentals on Akash's own chain: 35 leases, 3 sellers. Display only.", asOf: "Oct 2" },
];

export const MONTH_LABEL: Record<string, string> = { "2026-11": "November", "2026-12": "December" };

/** Traded prices beside ours, per GPU (display only). Ornn agreed Oct 1 2026 to H100, H200 and B200 shown beside
 * the index with credit and a link. H200/B200 values are the last we read (licence check Sep 29). Akash: the
 * Oct 1 chain read found H200 listed (2 providers, 40 GPUs at $4.45) but none rented, and no B200: no traded price. */
export interface PeerPrice {
  name: string;
  kind: "traded-private" | "traded-onchain";
  price: number | null;
  note: string;
  asOf: string;
}
export function peersFor(gpu: Gpu): PeerPrice[] {
  const ornn: Record<Gpu, PeerPrice> = {
    H100: { name: "Ornn", kind: "traded-private", price: 2.92, note: "Traded prices, private data. Shown with credit, display only.", asOf: "Oct 2" },
    H200: { name: "Ornn", kind: "traded-private", price: 4.94, note: "Traded prices, private data. Shown with credit, display only.", asOf: "Sep 29" },
    B200: { name: "Ornn", kind: "traded-private", price: 8.14, note: "Traded prices, private data. Shown with credit, display only.", asOf: "Sep 29" },
  };
  const akash: Record<Gpu, PeerPrice> = {
    H100: { name: "Akash", kind: "traded-onchain", price: 2.6, note: "Real rentals on Akash's own chain: 35 leases, 3 sellers. Display only.", asOf: "Oct 2" },
    H200: { name: "Akash", kind: "traded-onchain", price: null, note: "40 H200 listed at $4.45, none rented yet. Display only.", asOf: "Oct 1" },
    B200: { name: "Akash", kind: "traded-onchain", price: null, note: "No B200 offered on Akash yet.", asOf: "Oct 1" },
  };
  return [ornn[gpu], akash[gpu]];
}
