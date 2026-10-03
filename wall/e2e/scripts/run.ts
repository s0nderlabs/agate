// Runs e2e and chaos scenarios on a private local anvil and prints the verdicts.
//   bun run e2e/scripts/run.ts [name ...] [--verbose] [--json out.json] [--list]
// No name: every scenario. Archive scenarios read AGATE_RAW_DIR (default ~/.agate-index-logger/data/raw) in place
// and are skipped when it is absent.
import { writeFileSync } from "node:fs";
import { archivePresent } from "../src/archive.ts";
import { haveAnvil } from "../src/chain.ts";
import { printReport, type RunReport } from "../src/report.ts";
import { haveSandbox, SCENARIOS } from "../src/scenarios.ts";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const ji = args.indexOf("--json");
const jsonOut = ji >= 0 ? args[ji + 1] : undefined;
const names = args.filter((a, i) => !a.startsWith("--") && !(ji >= 0 && i === ji + 1));
if (args.includes("--list")) {
  for (const s of SCENARIOS) console.log(`${s.name.padEnd(28)} ${s.what}`);
  process.exit(0);
}
if (!haveAnvil()) {
  console.error("anvil or contracts/out is missing: install foundry and run `cd contracts && forge build`");
  process.exit(2);
}
const pick = names.length ? SCENARIOS.filter((s) => names.includes(s.name)) : SCENARIOS;
if (names.length && pick.length !== names.length) {
  console.error(`unknown scenario: ${names.filter((n) => !SCENARIOS.some((s) => s.name === n)).join(", ")}`);
  process.exit(2);
}
const reports: RunReport[] = [];
for (const s of pick) {
  if (s.needsArchive && !archivePresent()) {
    console.log(`== ${s.name}: SKIPPED (no archive at AGATE_RAW_DIR)`);
    continue;
  }
  if (s.needsSandbox && !haveSandbox()) {
    console.log(`== ${s.name}: SKIPPED (needs macOS sandbox-exec)`);
    continue;
  }
  const t0 = Date.now();
  try {
    const r = await s.run();
    reports.push(r);
    console.log(printReport(r, verbose));
  } catch (e) {
    const r: RunReport = { name: s.name, profile: "?", ok: false, checks: [{ name: "run", ok: false, detail: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) }], days: [], alertCounts: {}, guardianActs: [], timeline: [], errors: [], stats: {} };
    reports.push(r);
    console.log(printReport(r, verbose));
  }
  console.log(`   (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(reports, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1));
const failed = reports.filter((r) => !r.ok).map((r) => r.name);
console.log(failed.length ? `FAILED: ${failed.join(", ")}` : `all ${reports.length} passed`);
process.exit(failed.length ? 1 : 0);
