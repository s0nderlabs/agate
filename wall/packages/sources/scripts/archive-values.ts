// Re-parses the logger's archived hours (Sep 30 17 UTC onwards) and writes the per-hour values per source and GPU as
// a numbers-only fixture (BUILD-SPEC 7.7), for the watcher's tests and the e2e replay. Never writes page content.
//   bun run scripts/archive-values.ts [--out test/fixtures/archive-values.json]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { archivePresent, rawDir } from "../src/io/archive.ts";
import { archiveValues } from "../src/io/archiveValues.ts";

const i = process.argv.indexOf("--out");
const out = i > 0 ? process.argv[i + 1]! : join(import.meta.dir, "..", "test", "fixtures", "archive-values.json");
if (!archivePresent()) {
  console.error(`no archive at ${rawDir()} (set AGATE_RAW_DIR)`);
  process.exit(1);
}
const hours = archiveValues().filter((h) => h.hour >= "2026-09-30T17");
const doc = {
  note: "Numbers only: per archived hour, per source and GPU, the parsed state (s) and valueU (v, 10^-6 USD per GPU-hour). pageTime: the logger's fetch time (unix s). fx: the ECB rate the FX rule picked for that hour's date.",
  generatedBy: "wall/packages/sources/scripts/archive-values.ts",
  hours,
};
writeFileSync(out, `${JSON.stringify(doc, null, 1)}\n`);
console.log(`wrote ${hours.length} hours (${hours[0]?.hour} to ${hours.at(-1)?.hour}) to ${out}`);
