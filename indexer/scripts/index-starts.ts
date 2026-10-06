// bun scripts/index-starts.ts <deployments.json> <indexes.json>
// Prints "<factory>=<block>" for each factory whose index has a deploy block in the records: the --index-start values
// for gen:config. The one place this rule lives: ops/testnet/indexer.sh and gen:testnet both use it.
import { readFileSync } from "node:fs";
import { indexStarts } from "./testnet-pair.ts";

const [dep, rec] = process.argv.slice(2);
if (!dep || !rec) {
  console.error("usage: bun scripts/index-starts.ts <deployments.json> <indexes.json>");
  process.exit(2);
}
const starts = indexStarts(JSON.parse(readFileSync(dep, "utf8")), JSON.parse(readFileSync(rec, "utf8")));
console.log(Object.entries(starts).map(([n, b]) => `${n}=${b}`).join(" "));
