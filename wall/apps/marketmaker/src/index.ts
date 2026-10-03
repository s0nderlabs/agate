// @agate/marketmaker: P1 of BOTS-SPEC (section 3). The pure core (fair, ladder, inventory, decide) and the tick, over
// the shared layer @agate/market.
export * from "./fair.ts";
export * from "./ladder.ts";
export * from "./inventory.ts";
export * from "./decide.ts";
export * from "./book.ts";
export * from "./config.ts";
export * from "./state.ts";
export { MarketMaker, ROLE, type MmDeps, type TickReport } from "./mm.ts";
