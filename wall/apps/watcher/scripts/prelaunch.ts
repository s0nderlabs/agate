// Writes the production index's pre-launch history (src/prelaunch.ts): per GPU, what the index's model records from
// the index logger's archive for the days from --from up to the day before the index's firstDay, plus the firstDay
// itself computed on its own as an entry day from a fresh registration, exactly as the chain did (`check`, to compare
// with the chain's record of that day). Numbers only, never page content. Display only: the client shows these days
// apart, as "recorded by our logger, not onchain".
//   bun run scripts/prelaunch.ts [--from 2026-10-01] [--out ../../../contracts/deployments/10143-prelaunch.json]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DeployEntry, deployGpus, panelFileFor } from "@agate/sources";
import { archivePresent, listHours, rawDir, valuesOfHour } from "@agate/sources/io";
import type { Panel } from "@agate/sources/types";
import { dayOfDate, prelaunchDays } from "../src/prelaunch.ts";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1]! : d;
};
const from = arg("from", "2026-10-01");
const fromDay = dayOfDate(from);
const out = arg("out", join(ROOT, "contracts", "deployments", "10143-prelaunch.json"));
if (!archivePresent()) {
  console.error(`no archive at ${rawDir()} (set AGATE_RAW_DIR)`);
  process.exit(1);
}

const indexes = JSON.parse(readFileSync(join(ROOT, "contracts", "deployments", "10143-indexes.json"), "utf8"));
const prod = indexes.production as { index: string; config: string; firstDay: number };
const configFile = `${prod.config}.json`;
const config = JSON.parse(readFileSync(join(ROOT, "contracts", "script", "config", configFile), "utf8")) as { profile: { day: number; slices: number; minReadings: number; qMin: number; signAll: boolean; demoLabel: boolean; epochDay: number }; gpus: DeployEntry[] };
const panelFile = panelFileFor(configFile);
const launch = JSON.parse(readFileSync(join(ROOT, "wall", "packages", "sources", "panels", panelFile), "utf8")) as { panels: Panel[]; deploy: DeployEntry[] };
// the history uses exactly what the index registered (recipeHash included): deploy-gpus.ts --check's comparison
if (JSON.stringify(config.gpus) !== JSON.stringify(deployGpus(configFile, panelFile, launch.deploy))) throw new Error(`${configFile} does not register panels/${panelFile} (bun run packages/sources/scripts/deploy-gpus.ts ${prod.config} --check)`);
for (const d of launch.deploy) if (launch.panels.find((p) => p.gpu === d.gpu)?.gpuId.toLowerCase() !== d.gpuId.toLowerCase()) throw new Error(`panels/${panelFile}: ${d.gpu}'s panel is not its deploy entry`);
if (fromDay >= prod.firstDay) throw new Error(`--from is not before the index's firstDay`);

const { day, slices, minReadings, qMin, signAll, demoLabel, epochDay } = config.profile;
const profile = { day, slices, minReadings, qMin, signAll, demoLabel, epochDay, epochTs: 0 };
// only the hours of the days computed are parsed (the archive grows every hour)
const hours = listHours()
  .filter((h) => dayOfDate(h.date) >= fromDay && dayOfDate(h.date) <= prod.firstDay)
  .map((h) => valuesOfHour(h));
const panels = launch.panels;
const before = prelaunchDays({ hours, panels, profile, fromDay, toDay: prod.firstDay - 1 });
const first = prelaunchDays({ hours, panels, profile, fromDay: prod.firstDay, toDay: prod.firstDay });

const doc = {
  note: "Display only, not onchain: per GPU, the daily price the index's model (wall/apps/watcher/src/sim/model-index.ts, the contract's port) records from the index logger's archived hours, for the days before the production index's firstDay. One archived hour = one writer report of that slice; GPUs registered as the deploy registered them, live from fromDay (an entry day). valueU: 10^-6 USD per GPU-hour. check: the firstDay computed the same way from a fresh registration, to compare with the chain's record of that day. The logger read each page at its own minute of the hour, not the writers', so on a day a cloud changes its price the median can differ by a cent from what the writers would have posted (Oct 4: H100 and B300 equal the chain; H200 and B200 one cent above, Verda having moved mid-day).",
  generatedBy: "wall/apps/watcher/scripts/prelaunch.ts",
  chainId: indexes.chainId,
  index: prod.index,
  firstDay: prod.firstDay,
  fromDay,
  days: Object.fromEntries(panels.map((p) => [p.gpu, before[p.gpu] ?? []])),
  check: { day: prod.firstDay, values: Object.fromEntries(panels.map((p) => [p.gpu, first[p.gpu]?.[0] ?? null])) },
};
writeFileSync(out, `${JSON.stringify(doc, null, 1)}\n`);
console.log(`wrote ${out}`);
for (const p of panels) console.log(`${p.gpu} ${(before[p.gpu] ?? []).map((d) => `${d.date.slice(5)} ${(d.valueU / 1e6).toFixed(2)}${d.status === "CARRIED" ? " carried" : ""}`).join(", ")}; check ${first[p.gpu]?.[0] ? (first[p.gpu]![0]!.valueU / 1e6).toFixed(2) : "none"}`);
