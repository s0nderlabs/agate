// The page check process (BUILD-SPEC 15.1): `bun run apps/pagecheck/src/main.ts`, one per index, alert only.
// Env: AGATE_INDEX, AGATE_PANELS (JSON Panel[] or {panels}), AGATE_WALL_HOME (default ~/.agate-wall),
// AGATE_WATCHER_LOG_DIR (the watcher's log folder when it is not <home>/watcher/<index>), TRACKER_BASE_URL (a
// replayed index: the replay server's tracker routes), AGATE_NOTIFY_CMD. No RPC, no key: it refuses to start with
// any *_KEY, *_KEY_CMD or CRE_ETH_PRIVATE_KEY variable set.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Panel } from "@agate/sources/types";
import { AlertSink, Heartbeat, takeLock, wallHome } from "@agate/watcher";
import { httpFetchTracker } from "./fetch.ts";
import { refuseKeys } from "./guard.ts";
import { heartbeatPathOf, index8, PageCheck, type PcClock, pagecheckDir } from "./pagecheck.ts";
import { WatchLog } from "./watchlog.ts";

const nowS = () => Math.floor(Date.now() / 1000);
const say = (event: string, data?: Record<string, unknown>) => console.log(JSON.stringify({ t: nowS(), role: "pagecheck", event, ...data }));

export function loadPanelFile(path: string): Panel[] {
  const j = JSON.parse(readFileSync(path, "utf8")) as Panel[] | { panels: Panel[] };
  const panels = Array.isArray(j) ? j : j.panels;
  if (!Array.isArray(panels) || panels.length === 0) throw new Error(`${path}: no panels`);
  return panels;
}

/** The index clock the watcher cached from clocks() (<home>/watcher/<index>/clocks.json), read only. */
export function readClock(watcherDir: string): PcClock | null {
  const p = join(watcherDir, "clocks.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const c = { day: Number(j.day), slice: Number(j.slice), minReadings: Number(j.minReadings), epochTs: Number(j.epochTs) };
    return c.day > 0 && c.slice > 0 && c.minReadings > 0 && Number.isFinite(c.epochTs) ? c : null;
  } catch {
    return null;
  }
}

function need(env: Record<string, string | undefined>, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
}

export async function main(env: Record<string, string | undefined>): Promise<number> {
  refuseKeys(env, "the page check");
  const index = need(env, "AGATE_INDEX");
  if (!/^0x[0-9a-fA-F]{40}$/.test(index)) throw new Error("AGATE_INDEX must be an address");
  const panels = loadPanelFile(need(env, "AGATE_PANELS"));
  const home = env.AGATE_WALL_HOME || wallHome();
  const watcherDir = join(home, "watcher", index.toLowerCase());
  const logDir = env.AGATE_WATCHER_LOG_DIR || watcherDir;
  try {
    takeLock(join(home, "pagecheck", `${index8(index)}.lock`));
  } catch (e) {
    console.error(`pagecheck: ${(e as Error).message}; exiting`);
    return 3;
  }
  let clock = readClock(watcherDir);
  while (!clock) {
    say("waiting", { why: `no ${join(watcherDir, "clocks.json")} yet (the watcher writes it at start)` });
    await Bun.sleep(60_000);
    clock = readClock(watcherDir);
  }
  const alerts = new AlertSink(join(home, "alerts", "alerts.jsonl"), { now: nowS, role: "pagecheck", index, ...(env.AGATE_NOTIFY_CMD ? { notifyCmd: env.AGATE_NOTIFY_CMD } : {}) });
  const pc = new PageCheck({
    index,
    clock,
    panels,
    log: new WatchLog(logDir),
    alerts,
    home,
    fetch: httpFetchTracker,
    ...(env.TRACKER_BASE_URL ? { trackerBaseUrl: env.TRACKER_BASE_URL } : {}),
    heartbeat: new Heartbeat(heartbeatPathOf(home, index), "pagecheck", index),
    now: nowS,
  });
  say("start", { index, dir: pagecheckDir(home, index), pairs: pc.pairs.length, slice: clock.slice, replay: Boolean(env.TRACKER_BASE_URL) });
  let stop = false;
  for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => (stop = true));
  const period = Math.max(1, Math.min(30, Math.floor(clock.slice / 20)));
  while (!stop) {
    try {
      await pc.tick(nowS());
    } catch (e) {
      say("tick_error", { error: e instanceof Error ? e.message : String(e) });
    }
    await Bun.sleep(period * 1000);
  }
  say("stop");
  return 0;
}

if (import.meta.main) {
  main(process.env).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`pagecheck: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
