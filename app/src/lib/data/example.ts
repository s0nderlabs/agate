// The example source: today's mock (lib/mock) in @agate/client's shapes, field for field, behind the same promises the
// live source has. Its states (Mock controls, ?data=) show every live situation before it happens, through the same
// code paths: loading is a read that never answers, Monad unreachable is a read that fails.
import type { Book, Candle, Fill, Gpu, Market, MarketGpu, Series } from "@/lib/mock/types";
import { ALL_GPUS, AS_OF, getMarket, type DataState } from "@/lib/mock/data";
import { book as mockBook, novCandles, recentFills } from "@/lib/mock/market";
import type { Moment } from "@/lib/mock/config";
import { momentCandles, momentFills, momentMarket, momentNow } from "@/lib/mock/timeline";
import type { DataSource } from "./source";

/** The example's frozen "now": Oct 3, 06:00 UTC, an hour before the day's price turns final. */
export const EXAMPLE_NOW = Date.parse(AS_OF);

const EMPTY: Book = { asks: [], bids: [], spread: 0 };
/** listed, but nothing has traded yet (or the indexer that knows the trades is down) */
const NO_TRADES: ReadonlySet<DataState> = new Set(["noTrades", "emptyBook", "indexerDown"]);

// Today (the example's Oct 3 morning) reads the example's own states; a later Day of the timeline reads its months
// (the month states there come from the Day itself, so only loading, Monad unreachable and the indexer apply)
function marketOf(gpu: Gpu, state: DataState, when: Moment): Market {
  return when === "oct" ? getMarket(gpu, state) : momentMarket(gpu, when);
}

function markets(state: DataState, when: Moment): Market[] {
  return ALL_GPUS.map((g) => marketOf(g, state, when));
}

/** The month as listed in this state, or null when it is not listed (upcoming, a price-only GPU, no such month). */
function listed(gpu: Gpu, month: string, state: DataState, when: Moment): Series | null {
  const s = marketOf(gpu, state, when).series.find((x) => x.month === month);
  return s && s.phase !== "upcoming" && s.quote ? s : null;
}

function book(gpu: Gpu, month: string, state: DataState, when: Moment): Book {
  const s = listed(gpu, month, state, when);
  // a month whose maker has stopped (its last hour, or settled) has no book
  return s && state !== "emptyBook" && s.quote!.bid > 0 && s.quote!.ask > 0 ? mockBook(s) : EMPTY;
}

function fills(gpu: Gpu, month: string, limit: number, state: DataState, when: Moment): Fill[] {
  const s = listed(gpu, month, state, when);
  if (!s || NO_TRADES.has(state)) return [];
  return when === "oct" ? recentFills(gpu as MarketGpu, s.quote!).slice(0, limit) : momentFills(gpu, month, when, limit);
}

function candles(gpu: Gpu, month: string, state: DataState, when: Moment): Candle[] {
  const s = listed(gpu, month, state, when);
  if (!s || NO_TRADES.has(state)) return [];
  return when === "oct" ? novCandles(gpu as MarketGpu, s.quote!.last) : momentCandles(gpu, month, when);
}

const never = <T,>() => new Promise<T>(() => {});
const unreachable = <T,>() => Promise.reject<T>(new Error("Example: Monad's test network did not answer."));

function build(state: DataState, when: Moment): DataSource {
  const now = when === "oct" ? EXAMPLE_NOW : momentNow(when);
  // what a read does in this state: answer, never answer (loading), or fail (Monad unreachable)
  const read = <T,>(answer: () => T): Promise<T> => (state === "loading" ? never<T>() : state === "rpcDown" || state === "rpcStale" ? unreachable<T>() : Promise.resolve().then(answer));
  const hasData = state !== "loading" && state !== "rpcDown";
  return {
    key: `example:${state}:${when}`,
    kind: "example",
    markets: () => read(() => markets(state, when)),
    book: (gpu, month) => read(() => book(gpu, month, state, when)),
    fills: (gpu, month, limit) => read(() => fills(gpu, month, limit, state, when)),
    candles: (gpu, month) => read(() => candles(gpu, month, state, when)),
    indexerUp: () => (state === "loading" ? never<boolean>() : Promise.resolve(state !== "indexerDown")),
    initial: {
      markets: hasData ? () => markets(state, when) : undefined,
      // old data: the last good read was five minutes before the example's own morning (a fixed time, so the server
      // render and the browser agree on "Showing prices from 05:55 UTC")
      marketsAt: state === "rpcStale" ? now - 5 * 60_000 : undefined,
      book: (gpu, month) => (hasData ? book(gpu, month, state, when) : EMPTY),
      fills: (gpu, month, limit) => (hasData ? fills(gpu, month, limit, state, when) : []),
      candles: (gpu, month) => (hasData ? candles(gpu, month, state, when) : []),
      indexerUp: state !== "indexerDown",
    },
    now: () => now,
  };
}

const sources = new Map<string, DataSource>();

/** One source per state and Day, made once, so its identity (and the queries keyed on it) stays put across renders. */
export function exampleSource(state: DataState, when: Moment = "oct"): DataSource {
  const k = `${state}:${when}`;
  let s = sources.get(k);
  if (!s) {
    s = build(state, when);
    sources.set(k, s);
  }
  return s;
}
