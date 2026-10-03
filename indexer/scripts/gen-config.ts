// bun run gen:config <deployments.json> [--rpc] [--index-start <name>=<block> ... | --no-index-start] [--out config.yaml]
// Writes config.yaml (or --out) and src/lib/deployments.generated.ts (BOTS-SPEC 5.3). Never writes a URL: --rpc only
// names ${ENVIO_RPC_URL}, which Envio reads from the environment at run time. Fails closed (audit M-2): every index of
// the deployments file needs an --index-start (the deployments file has no index deploy block, and without one the
// index's history before the market deploy, GpuRegistered included, is never indexed), unless --no-index-start says
// so on purpose or the input is the test world's file.
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { missingIndexStarts, parseArgs, parseDeployments, renderConfig, TEST_DEPLOYMENTS } from "./config-gen.ts";

const root = join(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const input = resolve(args.input);
const d = parseDeployments(JSON.parse(readFileSync(input, "utf8")));
const rel = relative(root, input);
const source = rel.startsWith("..") ? basename(input) : rel;
const missing = missingIndexStarts(d, args.indexStart);
if (missing.length > 0 && !args.noIndexStart && rel !== TEST_DEPLOYMENTS) {
  console.error(`refused: no --index-start for ${missing.length} index(es) of ${source} (${missing.join(", ")}): give --index-start <factory>=<the index's deploy block> for a factory over each, or --no-index-start to start them at the factories' start block on purpose`);
  process.exit(2);
}
const { yaml, ts } = renderConfig(d, { rpc: args.rpc, indexStart: args.indexStart, source });
const out = resolve(root, args.out);
writeFileSync(out, yaml);
writeFileSync(join(root, "src/lib/deployments.generated.ts"), ts);
if (missing.length > 0) console.warn(`no --index-start for ${missing.join(", ")}: their history starts at the factories' start block`);
if (relative(root, out) !== "config.yaml") {
  // the handlers read src/lib/deployments.generated.ts, so a run from another config rewrites it too (audit L-6)
  console.warn(`src/lib/deployments.generated.ts now describes ${source}: regenerate the committed pair (config.yaml and it) before a commit or the hosted deploy`);
}
console.log(`wrote ${relative(root, out)} and src/lib/deployments.generated.ts from ${source} (${d.factories.length} factories)`);
