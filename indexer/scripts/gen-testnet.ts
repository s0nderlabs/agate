// bun run gen:testnet
// Writes the committed testnet pair for the hosted indexer (Envio Cloud): config.testnet.yaml and
// src/lib/deployments.testnet.generated.ts, from contracts/deployments/10143.json, each index starting at its deploy
// block from 10143-indexes.json (scripts/index-starts.ts, the rule ops/testnet/indexer.sh uses too).
// HyperSync, no RPC list. The handlers find these addresses through src/lib/deployments.ts, which merges this pair in.
// Rerun after a deploy changes either file; test/drift.test.ts fails while the pair is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testnetPair, TESTNET_CONFIG, TESTNET_TS } from "./testnet-pair.ts";

const root = join(import.meta.dirname, "..");
const { yaml, ts, starts } = testnetPair(
  JSON.parse(readFileSync(join(root, "../contracts/deployments/10143.json"), "utf8")),
  JSON.parse(readFileSync(join(root, "../contracts/deployments/10143-indexes.json"), "utf8")),
);
writeFileSync(join(root, TESTNET_CONFIG), yaml);
writeFileSync(join(root, TESTNET_TS), ts);
console.log(`wrote ${TESTNET_CONFIG} and ${TESTNET_TS} (index starts: ${Object.entries(starts).map(([n, b]) => `${n}=${b}`).join(", ")})`);
