// Shapes the screens read: @agate/client's own types (client/src/types.ts), so every screen reads one shape whether
// the numbers are example or live. The client copied these from this file on Oct 4 2026 and widened them (six GPUs,
// listing and closing times, the panel, open interest); this file now re-exports them, so the old import paths keep
// working. Type-only: nothing here pulls the client's code into a bundle.
export type {
  Book,
  BookLevel,
  Candle,
  Day,
  Fill,
  Gpu,
  IndexDay,
  Market,
  MarketGpu,
  PanelSlot,
  Position,
  Quote,
  Series,
  Side,
  SourceReading,
  TickerItem,
  Wallet,
} from "@agate/client/types";

/** Traded prices we show beside ours, display only (the app's own; the client has no peer prices). */
export interface Comparison {
  name: string;
  price: number;
  kind: "ours" | "traded-private" | "traded-onchain";
  note: string;
  asOf: string;
}
