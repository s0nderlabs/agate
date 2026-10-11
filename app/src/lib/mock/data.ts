// Mock market data. Real numbers where we have them (the wall's Oct 2 2026 launch panel, peers'
// Oct 2 reads); everything before our own record (Sep 30) is example history and marked so. getMarket builds the
// client's full Market shape (@agate/client), so example and live data read the same on every screen; the example
// source (lib/data/example.ts) serves it.
import type { Gpu, Market, MarketGpu, PanelSlot, Series, SourceReading } from "./types";
import { indexHistory, novCandles } from "./market";
import { median } from "@/lib/peers";

export { median, peersFor, type PeerPrice } from "@/lib/peers";

/** The three GPUs with monthly markets (the strip's tabs). */
export const GPUS: MarketGpu[] = ["H100", "H200", "B200"];
/** All six, in the index's order (the client returns its markets in this order). */
export const ALL_GPUS: Gpu[] = ["H100", "H200", "B200", "B300", "A100", "L40S"];

/** The mock's "now". Today's index price is the last final day: a day closes at 00:00 UTC, its price is
 * published about 01:00 UTC and turns final about 07:00 UTC after a six-hour pending window. */
export const AS_OF = "2026-10-03T06:00:00Z";

export const SOURCES: Record<MarketGpu, SourceReading[]> = {
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

/** The price-only GPUs' panels as the testnet registers them (Oct 4 read): no price yet, so none is invented here. */
const PRICE_ONLY_PANEL: Record<Exclude<Gpu, MarketGpu>, PanelSlot[]> = {
  B300: [
    { family: "Verda", live: true, reserve: false, price: null },
    { family: "Nebius", live: true, reserve: false, price: null },
    { family: "Civo", live: true, reserve: false, price: null },
    { family: "Hyperstack", live: false, reserve: true, price: null },
  ],
  A100: [
    { family: "Verda", live: true, reserve: false, price: null },
    { family: "Lambda", live: true, reserve: false, price: null },
    { family: "CoreWeave", live: true, reserve: false, price: null },
    { family: "Hyperstack", live: false, reserve: true, price: null },
  ],
  L40S: [
    { family: "Verda", live: true, reserve: false, price: null },
    { family: "CoreWeave", live: true, reserve: false, price: null },
    { family: "Civo", live: true, reserve: false, price: null },
  ],
};

/** November's band, from the spec formula (F = 0.5x, C = 2x the five-day average, on a $0.05 grid). */
export const NOVEMBER: Record<MarketGpu, { floor: number; cap: number; quote: { bid: number; ask: number; last: number } }> = {
  H100: { floor: 1.95, cap: 8.0, quote: { bid: 4.01, ask: 4.05, last: 4.03 } },
  H200: { floor: 2.35, cap: 9.6, quote: { bid: 4.8, ask: 4.86, last: 4.84 } },
  B200: { floor: 3.45, cap: 14.0, quote: { bid: 7.0, ask: 7.08, last: 7.05 } },
};

/** The example data's states (Mock controls). "normal" is the default; the rest show each live situation before it
 * happens: no index price yet, the month not open yet, listed with no trades, an empty book, the indexer down, and
 * Monad's test network unreachable with no data or with old data. */
export type DataState = "normal" | "loading" | "degraded" | "carried" | "beforeFirst" | "upcoming" | "noTrades" | "emptyBook" | "indexerDown" | "rpcDown" | "rpcStale";
export const DATA_STATES: readonly DataState[] = ["normal", "loading", "degraded", "carried", "beforeFirst", "upcoming", "noTrades", "emptyBook", "indexerDown", "rpcDown", "rpcStale"];

/** The testnet market-maker's quote (agate, Oct 3): best bid = fair x 0.99 rounded down to the cent, best ask =
 * fair x 1.01 rounded up; fair = the month's last trade here. */
export function botQuote(fair: number) {
  return { bid: Math.floor(fair * 0.99 * 100 + 1e-6) / 100, ask: Math.ceil(fair * 1.01 * 100 - 1e-6) / 100 };
}

const ZERO = "0x0000000000000000000000000000000000000000";
const DAY = 86_400_000;

/** The next time of day hh:00 UTC after `now` (the example's next close and next final price follow the real clock,
 * so the countdown runs as it will live). */
function nextAt(now: number, hour: number) {
  const d = new Date(now);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour);
  if (t <= now) t += DAY;
  return new Date(t).toISOString().replace(".000Z", "Z");
}

/** The example market of one GPU in one data state, in the client's full shape. Price-only GPUs take the shape the
 * testnet returns today (no price yet), so no price is invented for them. */
export function getMarket(gpu: Gpu, state: DataState = "normal"): Market {
  const now = Date.now();
  const nextUpdateAt = nextAt(now, 7);
  const nextCloseAt = nextAt(now, 1);
  if (!(gpu in SOURCES)) {
    const panel = PRICE_ONLY_PANEL[gpu as Exclude<Gpu, MarketGpu>];
    return { gpu, price: 0, prevPrice: 0, updatedAt: "", sources: [], history: [], series: [], nextUpdateAt, liveCount: panel.filter((p) => !p.reserve).length, panelSize: panel.length, priceDate: null, nextCloseAt, tradable: false, panel };
  }
  const g = gpu as MarketGpu;
  let sources = SOURCES[g];
  if (state === "degraded") sources = sources.map((s) => (s.family === "CoreWeave" ? { ...s, live: false } : s));
  const reserve = (family: string) => g === "H100" && family === "Hyperstack";
  const live = sources.filter((s) => s.live).map((s) => s.price);
  const price = Math.round(median(live) * 100) / 100;
  const before = state === "beforeFirst";
  const panel: PanelSlot[] = sources.map((s) => ({ family: s.family, live: before ? !reserve(s.family) : s.live, reserve: reserve(s.family), price: before || !s.live ? null : s.price }));
  const hist = before ? [] : indexHistory(g, price, state);

  const nov = NOVEMBER[g];
  const quote = { ...nov.quote, ...botQuote(nov.quote.last), lastAt: "2026-10-03T05:58:00Z" as string | null };
  const mid = Math.round(((quote.bid + quote.ask) / 2) * 100) / 100;
  // Held open: GPU-hours in open positions, 62% of everything traded since listing (the example's own rule)
  const traded = novCandles(g, nov.quote.last).reduce((a, x) => a + x.v, 0);
  const listed: Series = {
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
    quote,
    openInterest: Math.round((traded * 0.62) / 240) * 240,
    listedAt: "2026-10-01T00:00:00Z",
    closesAt: "2026-12-01T00:00:00Z",
    startsAt: "2026-11-01T00:00:00Z",
    address: ZERO,
    token: ZERO,
    market: null,
  };
  const upcoming = (month: string, opensOn: string): Series => {
    const [y, m] = month.split("-").map(Number);
    return {
      gpu,
      month,
      name: `Agate ${gpu} ${new Date(Date.UTC(y, m - 1)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })} ${y}`,
      symbol: `${gpu}-${new Date(Date.UTC(y, m - 1)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase()}${String(y).slice(2)}`,
      n: new Date(Date.UTC(y, m, 0)).getUTCDate(),
      floor: 0,
      cap: 0,
      phase: "upcoming",
      opensOn,
      k: 0,
      S: 0,
      quote: null,
      openInterest: 0,
      listedAt: "",
      closesAt: new Date(Date.UTC(y, m, 1)).toISOString().replace(".000Z", "Z"),
      startsAt: new Date(Date.UTC(y, m - 1, 1)).toISOString().replace(".000Z", "Z"),
      address: ZERO,
      token: ZERO,
      market: null,
    };
  };
  const december = upcoming("2026-12", "2026-11-01T07:00:00Z");
  let series: Series[];
  if (before || state === "upcoming") series = [upcoming("2026-11", nextUpdateAt)];
  else if (state === "noTrades") series = [{ ...listed, openInterest: 0, quote: { ...quote, last: mid, lastAt: null } }, december];
  else if (state === "emptyBook") series = [{ ...listed, openInterest: 0, quote: { bid: 0, ask: 0, last: 0, lastAt: null } }, december];
  // without the indexer: no listing time and no trades, so the last price is the middle of the book
  else if (state === "indexerDown") series = [{ ...listed, listedAt: "", quote: { ...quote, last: mid, lastAt: null } }, december];
  else series = [listed, december];

  return {
    gpu,
    price: before ? 0 : price,
    prevPrice: hist.length > 1 ? hist[hist.length - 2].price : before ? 0 : price,
    // when the newest day turned final: about 07:00 UTC the day after it (as the method says)
    updatedAt: before ? "" : hist.length ? new Date(Date.parse(`${hist[hist.length - 1].date}T07:00:00Z`) + 86_400_000).toISOString().replace(".000Z", "Z") : AS_OF,
    sources: before ? [] : sources,
    history: hist,
    series,
    nextUpdateAt,
    liveCount: before ? panel.filter((p) => !p.reserve).length : live.length,
    panelSize: panel.length,
    priceDate: before ? null : "2026-10-02",
    nextCloseAt,
    tradable: true,
    panel,
  };
}

export const MONTH_LABEL: Record<string, string> = { "2026-11": "November", "2026-12": "December" };
