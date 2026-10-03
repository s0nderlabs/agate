// Regenerates abis/*.json from a Foundry build (AGATE_FORGE_OUT, else contracts/out) and Appendix C's Kuru subset.
// Run after forge build in contracts/: bun run gen:abis
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { abiJson, buildAbis, forgeOut } from "./abis.ts";

const dir = join(import.meta.dirname, "../abis");
mkdirSync(dir, { recursive: true });
const abis = buildAbis();
for (const [name, abi] of Object.entries(abis)) {
  writeFileSync(join(dir, `${name}.json`), abiJson(abi));
  console.log(`abis/${name}.json: ${abi.length} items`);
}
console.log(`from ${forgeOut()}`);
