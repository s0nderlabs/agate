// Shapes the screens read. They mirror what the live layer will return from the contracts
// (SeriesListed, FixApplied, PositionOpened) and the indexer, in plain dollars instead of
// 6-decimal integers. agate's phase 5 data layer implements these same types.

export type Gpu = "H100" | "H200" | "B200";
export type Side = "long" | "short";

/** One cloud's posted on-demand price for one GPU-hour, read by the wall. */
export interface SourceReading {
  family: string;
  price: number;
  /** false = on the panel as the reserve, not counted today */
  live: boolean;
}

/** One day of the index (the series' view: FixApplied). */
export interface IndexDay {
  /** ISO date, UTC day */
  date: string;
  price: number;
  /** final = signed and attested; carried = no new reading, yesterday's price carried (shown as "carried, unverified") */
  status: "final" | "carried";
  /** true for history we invented before our own record starts (Sep 30) */
  example: boolean;
}

/** The order book's top for a month token on Kuru. */
export interface Quote {
  bid: number;
  ask: number;
  last: number;
}

/** One month of one GPU (SeriesListed plus live state). */
export interface Series {
  gpu: Gpu;
  /** "2026-11" */
  month: string;
  /** "agate H100 Nov 2026" */
  name: string;
  /** "H100-NOV26" */
  symbol: string;
  /** days in the month, N */
  n: number;
  /** F and C, dollars per GPU-hour */
  floor: number;
  cap: number;
  /** upcoming = not listed yet; trading = listed, month not started; paying = inside the month; settled = after */
  phase: "upcoming" | "trading" | "paying" | "settled";
  /** for upcoming months: when it opens */
  opensOn?: string;
  /** days applied so far (k) and their sum (S), for owed amounts */
  k: number;
  S: number;
  quote: Quote | null;
}

export interface Market {
  gpu: Gpu;
  /** today's index price */
  price: number;
  /** yesterday's, for the change line */
  prevPrice: number;
  /** when today's price became final */
  updatedAt: string;
  sources: SourceReading[];
  history: IndexDay[];
  /** the two months a user can trade (this month and next, or next only early in a month) */
  series: Series[];
}

/** Traded prices we show beside ours, display only. */
export interface Comparison {
  name: string;
  price: number;
  kind: "ours" | "traded-private" | "traded-onchain";
  note: string;
  asOf: string;
}

export interface Position {
  id: string;
  gpu: Gpu;
  month: string;
  side: Side;
  /** GPU-hours (tokens) */
  q: number;
  /** price per GPU-hour at entry */
  entry: number;
  /** pay me daily (a stream position) */
  daily: boolean;
  /** dollars already paid out to the user */
  paid: number;
  openedAt: string;
}

export interface Wallet {
  signedIn: boolean;
  email: string | null;
  /** test dollars */
  balance: number;
  /** ISO time of the last faucet drip (10,000 per day) */
  lastDrip: string | null;
  positions: Position[];
}
