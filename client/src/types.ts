// The shapes the app reads, in plain dollars and GPU-hours.
//
// Copied from the app's mock layer on Oct 4 2026: app/src/lib/mock/types.ts (Market, Series, IndexDay, SourceReading,
// Quote, Position, Wallet; unchanged since Oct 3 11:43 WIB) and app/src/lib/mock/market.ts (Day, BookLevel and
// book(), Fill, TickerItem, Candle), plus OpenOrder from app/src/components/trade/OrderTicket.tsx. Field for field
// as there, with the changes the app asked for on Oct 4 2026: Gpu widened to the index's six GPUs; per Series
// openInterest, listedAt and closesAt; per Market nextUpdateAt, liveCount and panelSize; OpenOrder without `daily`
// (a direct Kuru limit fill cannot be paid daily, README). Comparison is not here: the app owns peer prices. Every
// other field marked "added" is extra and optional to read.

/** The index's six GPUs. B300, A100 and L40S are price only: no series, no market. */
export type Gpu = "H100" | "H200" | "B200" | "B300" | "A100" | "L40S";
/** The GPUs with monthly markets. */
export type MarketGpu = "H100" | "H200" | "B200";
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
  /** true for history we invented before our own record starts. Always false here: the client returns real days only. */
  example: boolean;
  /** added: false on a pre-launch day (Market.prelaunch): computed by the index's formula from our logger's archive,
   *  never onchain, nothing settles on it (draw it greyed, "recorded by our logger, not onchain"). Absent = onchain. */
  onchain?: boolean;
}
/** static.ts's pre-launch days (contracts/deployments/10143-prelaunch.json): per GPU, the index model's record of each
 *  day before the index's firstDay, for the index (and chain) named here only. valueU: 10^-6 USD per GPU-hour. */
export interface PrelaunchDays {
  chainId: number;
  /** lowercase */
  index: string;
  days: Record<string, { day: number; valueU: number; status: "final" | "carried" }[]>;
}
/** market.ts's Day: the same shape. */
export type Day = IndexDay;

/** The order book's top for a month token on Kuru. */
export interface Quote {
  /** best bid, 0 when the book has no bid */
  bid: number;
  /** best ask, 0 when the book has no ask */
  ask: number;
  /** the last trade; before the first trade the mid (or the one side there is), 0 on an empty book */
  last: number;
  /** added: when the last trade happened (ISO); null = no trade yet, so `last` is not a trade */
  lastAt: string | null;
}

/** One month of one GPU (SeriesListed plus live state). */
export interface Series {
  gpu: Gpu;
  /** "2026-11" */
  month: string;
  /** "agate H100 Nov 2026" (the token's onchain name) */
  name: string;
  /** "H100-NOV26" */
  symbol: string;
  /** days in the month, N */
  n: number;
  /** F and C, dollars per GPU-hour (0 while upcoming) */
  floor: number;
  cap: number;
  /** upcoming = not listed yet; trading = listed, month not started; paying = inside the month; settled = after */
  phase: "upcoming" | "trading" | "paying" | "settled";
  /** for upcoming months: when it is expected to list (ISO; the listing needs index days that are not final yet) */
  opensOn?: string;
  /** days applied so far (k) and their sum (S, dollars), for owed amounts; what a sync would apply now */
  k: number;
  S: number;
  quote: Quote | null;
  /** GPU-hours outstanding: tokens in existence plus tokens held in open pay-me-daily long positions */
  openInterest: number;
  /** when the series listed (ISO); "" when the indexer is not reachable */
  listedAt: string;
  /** when the month's last day ends (ISO): after it the token only settles */
  closesAt: string;
  /** added: when the month's first day starts (ISO) */
  startsAt: string;
  /** added: contract addresses (lowercase); zero address while upcoming */
  address: string;
  token: string;
  /** added: the Kuru V1 market, null when none is recorded */
  market: string | null;
}

export interface Market {
  gpu: Gpu;
  /** today's index price: the newest final day (0 before the first final day; see priceDate) */
  price: number;
  /** the final day before it, for the change line (equals price when there is none) */
  prevPrice: number;
  /** when today's price became final (ISO); "" before the first final day */
  updatedAt: string;
  sources: SourceReading[];
  history: IndexDay[];
  /** added: the days before the index's firstDay, oldest first, each `onchain: false` (Monad testnet production index
   *  only: Oct 1 to 3 2026; empty elsewhere). Display only: never part of `history`, price or any settlement */
  prelaunch?: IndexDay[];
  /** the two months a user can trade (this month and next, or next only early in a month); empty for price-only GPUs */
  series: Series[];
  /** when the next index price is expected to become final (ISO): the next day's close plus T_PEND (README) */
  nextUpdateAt: string;
  /** clouds counted in today's price (in the median) */
  liveCount: number;
  /** every registered slot of the GPU, the reserve included ("n of N clouds") */
  panelSize: number;
  /** added: the index day `price` belongs to (YYYY-MM-DD); null before the first final day */
  priceDate: string | null;
  /** added: when the next price is expected to close (published, not final yet) (ISO) */
  nextCloseAt: string;
  /** added: false for the price-only GPUs */
  tradable: boolean;
  /** added: every registered slot in the index's order, the reserve included, for "n of N clouds" with names */
  panel: PanelSlot[];
}

/** One registered slot of a GPU's panel. */
export interface PanelSlot {
  family: string;
  /** counted in today's price (in the median; before the first final day: open today) */
  live: boolean;
  /** on the panel as the reserve (not live at the start) */
  reserve: boolean;
  /** its price on the newest final day; null when it was not read (the writers post no reading for a reserve) */
  price: number | null;
}

export interface Position {
  /** "<series>-<positionId>" for a pay-me-daily position, "<series>-long" / "<series>-short" for plain holdings */
  id: string;
  gpu: Gpu;
  month: string;
  side: Side;
  /** GPU-hours (tokens) */
  q: number;
  /** price per GPU-hour at entry (volume-weighted over the fills that opened it); 0 when unknown */
  entry: number;
  /** pay me daily (a stream position) */
  daily: boolean;
  /** dollars already paid out to the payee */
  paid: number;
  /** ISO; "" when unknown */
  openedAt: string;
  /** added: what it is: a pay-me-daily or short position, held tokens, or a short balance from minted pairs */
  kind: "position" | "tokens" | "shortBalance";
  /** added: the series address and, for a position, its id inside the series (decimal string) */
  series: string;
  positionId: string | null;
  /** added: dollars a claim would pay now (positions only) */
  claimable: number;
  /** added: who the claims pay (positions only) */
  payee: string | null;
  /** added: the part of q resting in Kuru's margin account (held tokens only: a filled limit buy or a cancelled ask
   *  lands there; withdrawMargin brings it to the wallet, and sellLong, settle and redeem need it in the wallet) */
  inMargin: number;
}

export interface Wallet {
  /** an address was given (the login provider later sets this) */
  signedIn: boolean;
  /** the login provider's; always null here */
  email: string | null;
  /** test dollars in the wallet */
  balance: number;
  /** ISO time of the last faucet drip (10,000 per day); null = never */
  lastDrip: string | null;
  positions: Position[];
  /** added */
  address: string;
  /** added: from when the next drip is allowed (ISO); null = never dripped */
  nextDrip: string | null;
  /** added: a drip would succeed now */
  canDrip: boolean;
  /** added: test dollars resting in Kuru's margin account (limit orders, cancels and fills land there) */
  marginBalance: number;
  /** added: MON for gas */
  mon: number;
}

/** One price level of the book: price in dollars per GPU-hour, size in GPU-hours. */
export interface BookLevel {
  price: number;
  size: number;
}
/** book(): asks rising from the best ask, bids falling from the best bid, the real Kuru levels. */
export interface Book {
  asks: BookLevel[];
  bids: BookLevel[];
  /** best ask minus best bid; 0 when a side is empty */
  spread: number;
}

export interface Fill {
  /** "HH:MM" UTC */
  time: string;
  /** the taker's side */
  side: "buy" | "sell";
  price: number;
  /** GPU-hours */
  size: number;
  /** added: ISO time and the transaction */
  at: string;
  txHash: string;
}

export interface TickerItem {
  label: string;
  price: number;
  /** percent: the index against the final day before; a token against its price 24 h earlier */
  change: number;
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

/** A resting Kuru limit order of the user's (pro mode). */
export interface OpenOrder {
  /** the Kuru order id */
  id: string;
  gpu: string;
  month: string;
  /** long = a bid (addBuyOrder), short = an ask (addSellOrder) */
  side: "long" | "short";
  price: number;
  /** GPU-hours still resting */
  q: number;
  /** ISO */
  placedAt: string;
  /** added: GPU-hours already filled */
  filled: number;
  /** added: the Kuru market */
  market: string;
}

// ------------------------------------------------------------------ the client's own shapes

/** contracts/deployments/<chainId>.json */
export interface FactoryRecord {
  index: string;
  dollar: string;
  tag: string;
  factory: string;
  router: string;
  tPend: number;
  startBlock: number | string;
}
export interface Deployments {
  chainId: number;
  dollar: string;
  kuru: { router: string; marginAccount: string };
  factories: Record<string, FactoryRecord>;
}

/** One GPU of the launch panel. */
export interface PanelGpu {
  gpu: string;
  gpuId: string;
  spec: string;
  slots: { slot: number; family: string; sourceId: string; liveAtStart: boolean }[];
}
