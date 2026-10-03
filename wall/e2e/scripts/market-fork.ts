// The market's fork e2e (BOTS-SPEC 6): bun run scripts/market-fork.ts [--report <file.json>] [--keep] [--no-replay]
// From wall/e2e. Needs the network once (anvil forks https://testnet-rpc.monad.xyz, read only), a Foundry build of
// contracts/ in AGATE_FORGE_OUT (default ~/.agate-build/integrate-bots/out) and 30 GB free. Sends nothing to any
// public network: every transaction goes to the loopback fork. Writes the indexer's fork fixture into
// indexer/test/fork/fixtures and runs the indexer's fork replay. Exit 0 only when every check passed.
import { writeFileSync } from "node:fs";
import { runMarketFork } from "../src/market/scenario.ts";

const args = process.argv.slice(2);
const at = args.indexOf("--report");
const reportPath = at >= 0 ? args[at + 1] : undefined;
const rep = await runMarketFork({ keep: args.includes("--keep"), replay: !args.includes("--no-replay") });
if (reportPath) writeFileSync(reportPath, rep.json());
const failed = rep.failed();
console.log(`\n${rep.checks.length - failed.length} of ${rep.checks.length} checks passed${failed.length ? `; failed: ${failed.map((c) => `${c.id} ${c.name}`).join(" | ")}` : ""}`);
process.exit(rep.ok ? 0 : 1);
