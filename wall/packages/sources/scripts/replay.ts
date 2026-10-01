// Runs the replay server (BUILD-SPEC 7.9) for a demo index.
//   bun run scripts/replay.ts --t0 <unix s of demo day 0> --day 600 --slices 4 [--port 8787] [--scenario replay/demo.json]
// Writers and the watcher then use SOURCE_BASE_URL=http://127.0.0.1:<port> (or .../r/<role> for a per-role view).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rawDir } from "../src/io/archive.ts";
import { type ReplayScenario, startReplay } from "../src/io/replay.ts";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
}

const scenarioPath = arg("scenario", join(import.meta.dir, "..", "replay", "demo.json"));
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as ReplayScenario;
const clock = { t0: Number(arg("t0")), daySec: Number(arg("day", "600")), slices: Number(arg("slices", "4")) };
const s = startReplay({ port: Number(arg("port", "8787")), clock, scenario });
console.log(
  JSON.stringify({
    event: "replay_started",
    url: s.url,
    rawDir: rawDir(),
    archiveHours: s.replay.hours.length,
    first: s.replay.hours[0] ? `${s.replay.hours[0].date}T${s.replay.hours[0].hour}` : null,
    last: s.replay.hours.at(-1) ? `${s.replay.hours.at(-1)!.date}T${s.replay.hours.at(-1)!.hour}` : null,
    clock,
    scenario: scenarioPath,
  }),
);
process.on("SIGINT", () => {
  s.stop();
  process.exit(0);
});
