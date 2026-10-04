// Where the numbers come from. One shape, two sources: the example data (with its states, for judging every screen
// before it happens) and the live testnet through @agate/client. The hooks (hooks.ts) read whichever the Mock
// controls pick, so no screen knows which one it shows.
import type { Book, Candle, Fill, Gpu, Market } from "@/lib/mock/types";
import { getAgate } from "./agate";

export interface DataSource {
  /** part of every query key, so switching sources never mixes caches: "example:<state>" or "live" */
  key: string;
  kind: "example" | "live";
  /** the six GPUs (index price, sources, history; the open months of the three market GPUs), in one read */
  markets(): Promise<Market[]>;
  /** one month's book; empty for a month not listed */
  book(gpu: Gpu, month: string): Promise<Book>;
  /** one month's recent fills, newest first */
  fills(gpu: Gpu, month: string, limit: number): Promise<Fill[]>;
  /** one month's hourly candles */
  candles(gpu: Gpu, month: string): Promise<Candle[]>;
  /** whether the indexer answers (trade history, candles and listing times come from it) */
  indexerUp(): Promise<boolean>;
  /** the example source's answers, synchronously, so the server render and the first paint already hold them
   *  (absent where the state has no data: loading, Monad unreachable) */
  initial?: {
    markets?: () => Market[];
    /** when that data was read (ms): the stale state backdates it */
    marketsAt?: number;
    book: (gpu: Gpu, month: string) => Book;
    fills: (gpu: Gpu, month: string, limit: number) => Fill[];
    candles: (gpu: Gpu, month: string) => Candle[];
    indexerUp: boolean;
  };
  /** "now" for the numbers that count from it (traded in the last 24 hours, days left): the example data is frozen at
   *  its own morning, live is the clock */
  now(): number;
}

export const EMPTY_BOOK: Book = { asks: [], bids: [], spread: 0 };

export const liveSource: DataSource = {
  key: "live",
  kind: "live",
  markets: async () => (await getAgate()).getMarkets(),
  book: async (gpu, month) => (await getAgate()).book(gpu, month),
  fills: async (gpu, month, limit) => (await getAgate()).recentFills(gpu, month, limit),
  candles: async (gpu, month) => (await getAgate()).candles(gpu, month),
  indexerUp: async () => (await getAgate()).indexerUp(),
  now: () => Date.now(),
};

export { exampleSource } from "./example";
