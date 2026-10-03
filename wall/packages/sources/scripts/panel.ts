// The panel tool (BUILD-SPEC 7.2, 7.6, 14.1 items 3 to 5): picks each GPU's slots from the recipe, the measured page
// sizes and the archive's VALID hours, and prints the writers' panel JSON and the deploy entries for registerGpu.
//   bun run scripts/panel.ts [--include-eur] [--include-over-cap] [--reserve H200=p_civo] [--no-archive]
//     [--from 2026-09-30T17] [--to 2026-10-02T17] [--out file]
// Prints a summary on stderr and {panels, deploy, choices} as JSON on stdout (or into --out). --from and --to keep only
// the archived hours inside that range (UTC, inclusive), so a panel stays reproducible while the archive grows.
// The launch panel (BUILD-SPEC 7.10): --include-over-cap --from 2026-09-30T17 --to 2026-10-02T17 --out panels/launch.json
import { writeFileSync } from "node:fs";
import type { GpuModel } from "@agate/report/types";
import { archivePresent, rawDir } from "../src/io/archive.ts";
import { archiveValues, statsOf } from "../src/io/archiveValues.ts";
import { buildPanel, type PanelFlags } from "../src/panelTool.ts";
import { GPUS } from "../src/pure/recipe.ts";

const args = process.argv.slice(2);
const flags: PanelFlags = { includeEur: args.includes("--include-eur"), includeOverCap: args.includes("--include-over-cap"), reserve: {} };
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--reserve") {
    const m = /^(H100|H200|B200)=(p_[a-z]+)$/.exec(args[++i] ?? "");
    if (!m) throw new Error("--reserve takes GPU=sourceId, e.g. H200=p_civo");
    flags.reserve![m[1] as GpuModel] = m[2]!;
  }
}
const outAt = args.indexOf("--out");
const hourArg = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1] ?? "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(v)) throw new Error(`${flag} takes a UTC hour, e.g. 2026-10-02T17`);
  return v;
};
const from = hourArg("--from");
const to = hourArg("--to");
const useArchive = !args.includes("--no-archive") && archivePresent();
const values = useArchive ? archiveValues().filter((h) => (!from || h.hour >= from) && (!to || h.hour <= to)) : [];
const stats = useArchive ? statsOf(values) : null;

const choices = GPUS.map((g) => buildPanel(g, stats, flags));
const say = (s: string) => process.stderr.write(`${s}\n`);
say(`archive: ${useArchive ? `${values.length} hours from ${rawDir()} (${values[0]?.hour} to ${values.at(-1)?.hour})` : "not used"}`);
say(`flags: include-eur=${!!flags.includeEur} include-over-cap=${!!flags.includeOverCap}`);
for (const c of choices) {
  say(`\n${c.gpu}  ${c.deploy.spec}  gpuId ${c.deploy.gpuId}`);
  say(`  live (${c.live.length}): ${c.live.map((id) => `${id}${stats ? ` [${c.validHours[id]} VALID h]` : ""}`).join(", ")}`);
  say(`  reserve: ${c.reserve ?? "none (odd eligible count)"}${c.reserve && stats ? ` [${c.validHours[c.reserve]} VALID h]` : ""}`);
  for (const d of c.displayOnly) say(`  display-only ${d.sourceId}: ${d.reasons.join("; ")}`);
  for (const w of c.warnings) say(`  warning: ${w}`);
  say(`  recipeHash ${c.deploy.recipeHash}  family [${c.deploy.family}]  famQ [${c.deploy.famQ}]  liveAtStartMask ${c.deploy.liveAtStartMask}`);
}
const doc = {
  generatedBy: "wall/packages/sources/scripts/panel.ts",
  flags,
  archiveHours: values.length,
  ...(values.length ? { archiveRange: [values[0]!.hour, values.at(-1)!.hour] } : {}),
  panels: choices.map((c) => c.panel),
  deploy: choices.map((c) => c.deploy),
  choices: choices.map(({ gpu, live, reserve, displayOnly, validHours, warnings }) => ({ gpu, live, reserve, displayOnly, validHours, warnings })),
};
const json = `${JSON.stringify(doc, null, 1)}\n`;
if (outAt >= 0) {
  writeFileSync(args[outAt + 1]!, json);
  say(`\nwrote ${args[outAt + 1]}`);
} else process.stdout.write(json);
