// The deployments the handlers look addresses up in: src/lib/deployments.generated.ts (the committed test world, or
// the testnet when ops/testnet/indexer.sh regenerates its own copy) merged with the committed testnet pair that the
// hosted indexer runs (config.testnet.yaml, bun run gen:testnet). Nothing selects between them (Envio Cloud's free
// plan has no environment variables). The handlers look a factory or index up by the address an event came from, and
// an event only comes from a contract of the running config, so the other set's entries never match one; the clock
// enumerates every factory here, and finds market rows only for the running config's. On an address in both, the
// generated module wins.
import * as generated from "./deployments.generated.ts";
import type { FactoryInfo, IndexInfo } from "./deployments.generated.ts";
import * as testnet from "./deployments.testnet.generated.ts";

export type { FactoryInfo, IndexInfo };
export const CHAIN_ID = generated.CHAIN_ID;
export const FACTORIES: Readonly<Record<string, FactoryInfo>> = { ...testnet.FACTORIES, ...generated.FACTORIES };
export const INDEXES: Readonly<Record<string, IndexInfo>> = { ...testnet.INDEXES, ...generated.INDEXES };
