// The example source: today's mock (lib/mock) in @agate/client's shapes, field for field, behind the same promises the
// live source has. Its states (Mock controls, ?data=) show every live situation before it happens, through the same
// code paths: loading is a read that never answers, Monad unreachable is a read that fails.
import type { Book, Candle, Fill, Gpu, Market, MarketGpu, Series } from "@/lib/mock/types";
import { ALL_GPUS, AS_OF, getMarket, type DataState } from "@/lib/mock/data";
import { book as mockBook, novCandles, recentFills } from "@/lib/mock/market";
import type { DataSource } from "./source";

/** The example's frozen "now": Oct 3, 06:00 UTC, an hour before the day's price turns final. */
export const EXAMPLE_NOW = Date.parse(AS_OF);

const EMPTY: Book = { asks: [], bids: [], spread: 0 };
/** listed, but nothing has traded yet (or the indexer that knows the trades is down) */
const NO_TRADES: ReadonlySet<DataState> = new Set(["noTrades", "emptyBook", "indexerDown"]);

function markets(state: DataState): Market[] {
  return ALL_GPUS.map((g) => getMarket(g, state));
}

/** The month as listed in this state, or null when it is not listed (upcoming, a price-only GPU, no such month). */
function listed(gpu: Gpu, month: string, state: DataState): Series | null {
  const s = getMarket(gpu, state).series.find((x) => x.month === month);
  return s && s.phase !== "upcoming" && s.quote ? s : null;
}

function book(gpu: Gpu, month: string, state: DataState): Book {
  const s = listed(gpu, month, state);
  return s && state !== "emptyBook" ? mockBook(s) : EMPTY;
}

function fills(gpu: Gpu, month: string, limit: number, state: DataState): Fill[] {
  const s = listed(gpu, month, state);
  return s && !NO_TRADES.has(state) ? recentFills(gpu as MarketGpu, s.quote!).slice(0, limit) : [];
}

function candles(gpu: Gpu, month: string, state: DataState): Candle[] {
  const s = listed(gpu, month, state);
  return s && !NO_TRADES.has(state) ? novCandles(gpu as MarketGpu, s.quote!.last) : [];
}

const never = <T,>() => new Promise<T>(() => {});
const unreachable = <T,>() => Promise.reject<T>(new Error("Example: Monad's test network did not answer."));

function build(state: DataState): DataSource {
  // what a read does in this state: answer, never answer (loading), or fail (Monad unreachable)
  const read = <T,>(answer: () => T): Promise<T> => (state === "loading" ? never<T>() : state === "rpcDown" || state === "rpcStale" ? unreachable<T>() : Promise.resolve().then(answer));
  const hasData = state !== "loading" && state !== "rpcDown";
  return {
    key: `example:${state}`,
    kind: "example",
    markets: () => read(() => markets(state)),
    book: (gpu, month) => read(() => book(gpu, month, state)),
    fills: (gpu, month, limit) => read(() => fills(gpu, month, limit, state)),
    candles: (gpu, month) => read(() => candles(gpu, month, state)),
    indexerUp: () => (state === "loading" ? never<boolean>() : Promise.resolve(state !== "indexerDown")),
    initial: {
      markets: hasData ? () => markets(state) : undefined,
      // old data: the last good read was five minutes before the example's own morning (a fixed time, so the server
      // render and the browser agree on "Showing prices from 05:55 UTC")
      marketsAt: state === "rpcStale" ? EXAMPLE_NOW - 5 * 60_000 : undefined,
      book: (gpu, month) => (hasData ? book(gpu, month, state) : EMPTY),
      fills: (gpu, month, limit) => (hasData ? fills(gpu, month, limit, state) : []),
      candles: (gpu, month) => (hasData ? candles(gpu, month, state) : []),
      indexerUp: state !== "indexerDown",
    },
    now: () => EXAMPLE_NOW,
  };
}

const sources = new Map<DataState, DataSource>();

/** One source per state, made once, so its identity (and the queries keyed on it) stays put across renders. */
export function exampleSource(state: DataState): DataSource {
  let s = sources.get(state);
  if (!s) {
    s = build(state);
    sources.set(state, s);
  }
  return s;
}
