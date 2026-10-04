// @agate/client: agate's live data layer. Reads return the app's shapes (types.ts) in plain dollars and GPU-hours;
// writes are plain async functions taking the client and a viem WalletClient. Browser-safe: viem only, no node:*.
export * from "./types.ts";
export { AgateClient, createAgateClient, resolveGraphqlUrl, pageIsLocal, PUBLIC_RPC, MULTICALL3, SCAN_ORDERS, GPUS, ReadError, errorName, isCallFailure, cent, quoteOf, hourlyCandles, sortTrades, fillOf, vwap, type ClientConfig, type SeriesLive, type SeriesTerms } from "./client.ts";
export { DEFAULT_GRAPHQL_URL, IndexerError, graphql, type GraphQL } from "./graphql.ts";
export { decodeL2Book, toBook, sellProceeds, buyTokens, buyFill, buyCost, asksUpTo, DepthError, type RawBook } from "./book.ts";
export { dayStart, dayIdAt, expectedClose, expectedFinal, type IndexClocks } from "./clock.ts";
export * from "./units.ts";
export * from "./writes.ts";
export { TESTNET_DEPLOYMENTS, TESTNET_INDEXES, PANELS } from "./static.ts";
export * as abi from "./abi.ts";
export * from "./plan.ts";
