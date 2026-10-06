// The deployments the handlers read: src/lib/deployments.generated.ts (the committed test world, or the testnet when
// ops/testnet/indexer.sh regenerates its own copy), or with ENVIO_AGATE_DEPLOYMENTS=testnet the committed testnet pair
// that the hosted indexer runs (config.testnet.yaml, bun run gen:testnet). Any other value stops the indexer.
import * as generated from "./deployments.generated.ts";
import * as testnet from "./deployments.testnet.generated.ts";

const which = process.env.ENVIO_AGATE_DEPLOYMENTS ?? "";
if (which !== "" && which !== "testnet") throw new Error(`ENVIO_AGATE_DEPLOYMENTS must be unset or "testnet", not "${which}"`);
const d = which === "testnet" ? testnet : generated;

export type { FactoryInfo, IndexInfo } from "./deployments.generated.ts";
export const CHAIN_ID = d.CHAIN_ID;
export const DOLLAR = d.DOLLAR;
export const FACTORIES = d.FACTORIES;
export const INDEXES = d.INDEXES;
