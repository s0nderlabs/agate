// The watcher app (BUILD-SPEC 9): `bun run src/main.ts <log|attest|keep|health|status>`, one set per index
// (AGATE_INDEX). Each process takes its per-key lock, writes a heartbeat every tick, runs its wake routine after a
// clock jump, and never exits on an error inside a tick. Keys are read from their variables at the moment of signing:
// AGATE_ATTESTER_KEY (attest), AGATE_KEEPER_KEY (keep). See config.ts for the rest of the environment.
import { join } from "node:path";
import { Attester } from "./attester.ts";
import { TxSender, addressOfEnvKey, measuredFromEnv } from "./chain/sender.ts";
import { connect, env, eventIndexer, maxFeeGwei, type Wall } from "./config.ts";
import { AlertSink } from "./alerts.ts";
import { deriveClocks, fetchTimeoutS, PROFILES, wallClock } from "./clock.ts";
import { Heartbeat, LockHeld, takeLock, wallHome } from "./fsutil.ts";
import { GuardianLog } from "./guardian-log.ts";
import { beatStatus, Health, type RoleBeat } from "./health.ts";
import { Keeper, pickNotePath, readPickNote } from "./keeper.ts";
import { cryptoRand, httpFetchPage, Logger, type LoggerApi } from "./log/logger.ts";
import { LogStore } from "./log/store.ts";

const ROLES = ["log", "attest", "keep", "health", "status"] as const;
type Role = (typeof ROLES)[number];
const nowS = () => Math.floor(Date.now() / 1000);
const say = (role: string, event: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ t: nowS(), role, event, ...data }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

export function heartbeatFile(w: { dir: string; logDir?: string }, role: string): string {
  return join(role === "log" && w.logDir ? w.logDir : w.dir, `heartbeat-${role}.json`);
}

/** A writer's heartbeat for one index: <home>/<role>/heartbeat-<index 8 hex>.json. Its heartbeat.json beside it is
 *  shared by every index's writer of that role, so a live writer on one index would hide a dead one on another. */
export function writerBeatFile(home: string, role: string, index: string): string {
  return join(home, role, `heartbeat-${index.slice(2, 10).toLowerCase()}.json`);
}

/** The roles health watches, with their tick periods (13.4). */
export function roleBeats(w: Wall): RoleBeat[] {
  const c = w.clock;
  return [
    { role: "log", path: heartbeatFile(w, "log"), periodS: c.slice },
    { role: "attest", path: heartbeatFile(w, "attest"), periodS: c.slice },
    { role: "keep", path: heartbeatFile(w, "keep"), periodS: c.keeperPeriod },
    ...(process.env.AGATE_HEALTH_WRITERS ?? "primary,standby").split(",").filter(Boolean).map((r) => ({ role: r, path: writerBeatFile(w.home, r, w.index), periodS: c.slice })),
  ];
}

async function loop(role: string, periodS: number, tick: (now: number) => Promise<void>, onWake?: () => void): Promise<void> {
  let stop = false;
  for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => (stop = true));
  let last = nowS();
  while (!stop) {
    const now = nowS();
    if (now - last > 3 * periodS) {
      say(role, "wake", { slept: now - last });
      onWake?.();
    }
    last = now;
    try {
      await tick(now);
    } catch (e) {
      say(role, "tick_error", { error: e instanceof Error ? e.message : String(e) });
    }
    await Bun.sleep(periodS * 1000);
  }
  say(role, "stop");
}

async function loadLoggerApi(): Promise<LoggerApi> {
  const m = (await import("@agate/sources/pure")) as Partial<LoggerApi>;
  if (!Array.isArray(m.SOURCES) || typeof m.parse !== "function" || typeof m.parseEcb !== "function")
    throw new Error("@agate/sources/pure does not export SOURCES, parse and parseEcb yet (builder B)");
  return m as LoggerApi;
}

/** 13.3 step 2: the logger starts before the index is deployed. Without AGATE_INDEX it runs on a profile clock
 *  (AGATE_PROFILE, AGATE_EPOCH_TS; PRODUCTION's intervals do not depend on the index) and writes to
 *  AGATE_WATCHER_LOG_DIR, which the attester and the guardian later read through the same variable. */
async function standaloneLogger(): Promise<void> {
  const prof = env("AGATE_PROFILE") as keyof typeof PROFILES;
  if (!(prof in PROFILES)) throw new Error(`AGATE_PROFILE must be one of ${Object.keys(PROFILES).join(", ")}`);
  const epochTs = Number(process.env.AGATE_EPOCH_TS ?? 0);
  const c = wallClock(deriveClocks({ ...PROFILES[prof], epochTs }));
  const home = wallHome();
  const dir = process.env.AGATE_WATCHER_LOG_DIR || join(home, "watcher", `${prof.toLowerCase()}-${epochTs}`);
  takeLock(join(dir, "log.lock"));
  const alerts = new AlertSink(join(home, "alerts", "alerts.jsonl"), { now: nowS, role: "log", ...(process.env.AGATE_NOTIFY_CMD ? { notifyCmd: process.env.AGATE_NOTIFY_CMD } : {}) });
  const store = new LogStore(dir);
  store.refresh();
  const want = process.env.AGATE_WATCH_SOURCES?.split(",").filter(Boolean);
  const logger = new Logger({
    clock: { slice: c.slice, epochTs: c.epochTs },
    api: await loadLoggerApi(),
    ...(want ? { sourceIds: want } : {}),
    fetchPage: httpFetchPage,
    ...(process.env.SOURCE_BASE_URL ? { baseUrl: process.env.SOURCE_BASE_URL } : {}),
    dir,
    store,
    alerts,
    heartbeat: new Heartbeat(join(dir, "heartbeat-log.json"), "log", prof),
    rand: cryptoRand,
    timeoutMs: fetchTimeoutS(c) * 1000,
    tickS: 1,
    now: () => Date.now() / 1000,
  });
  say("log", "start", { profile: prof, epochTs, dir });
  return loop("log", 1, (now) => logger.tick(now));
}

async function main(role: Role): Promise<void> {
  if (role === "log" && !process.env.AGATE_INDEX) return standaloneLogger();
  const w = await connect(role, nowS);
  if (role !== "status") {
    try {
      takeLock(join(w.dir, `${role}.lock`));
    } catch (e) {
      if (e instanceof LockHeld) {
        console.error(`${role}: another process holds the lock for ${w.index} (${e.message}); exiting`);
        process.exit(3);
      }
      throw e;
    }
  }
  const hb = new Heartbeat(heartbeatFile(w, role), role, w.index);
  const c = w.clock;
  say(role, "start", { index: w.index, day: c.day, slices: c.slices, urls: w.pool.urls(), panels: w.panels.map((p) => p.gpu) });

  if (role === "log") {
    const api = await loadLoggerApi();
    const want = process.env.AGATE_WATCH_SOURCES?.split(",").filter(Boolean);
    const store = new LogStore(w.logDir);
    store.refresh();
    const logger = new Logger({
      clock: { slice: c.slice, epochTs: c.epochTs },
      api,
      ...(want ? { sourceIds: want } : {}),
      fetchPage: httpFetchPage,
      ...(process.env.SOURCE_BASE_URL ? { baseUrl: process.env.SOURCE_BASE_URL } : {}),
      dir: w.logDir,
      store,
      alerts: w.alerts,
      heartbeat: hb,
      rand: cryptoRand,
      timeoutMs: fetchTimeoutS(c) * 1000,
      tickS: 1,
      now: () => Date.now() / 1000,
    });
    return loop(role, 1, (now) => logger.tick(now));
  }

  if (role === "attest") {
    const events = eventIndexer(w);
    const store = new LogStore(w.logDir);
    const sender = new TxSender({ pool: w.pool, to: w.index, keyEnv: "AGATE_ATTESTER_KEY", role, alerts: w.alerts, measured: measuredFromEnv(process.env), ...(maxFeeGwei() !== undefined ? { maxFeeGwei: maxFeeGwei()! } : {}), now: nowS, rebroadcastS: 30, replaceS: Math.max(120, c.slice / 4) });
    const att = new Attester({ view: w.view, events, log: store, guardian: new GuardianLog(join(w.home, "guardian")), alerts: w.alerts, sender, clock: c, panels: w.panels, decisionsPath: join(w.home, "attester", "decisions.jsonl"), pickPath: (g) => pickNotePath(w.home, w.index, g), heartbeat: hb, tickS: Math.max(1, Math.min(10, Math.floor(c.slice / 20))) });
    const period = Math.max(1, Math.min(10, Math.floor(c.slice / 20)));
    return loop(role, period, async (now) => {
      await w.pool.tick(now);
      await att.tick(now);
    }, () => sender.resetNonce());
  }

  if (role === "keep") {
    const sender = new TxSender({ pool: w.pool, to: w.index, keyEnv: "AGATE_KEEPER_KEY", role, alerts: w.alerts, measured: measuredFromEnv(process.env), ...(maxFeeGwei() !== undefined ? { maxFeeGwei: maxFeeGwei()! } : {}), now: nowS, rebroadcastS: 30, replaceS: Math.max(120, c.slice / 4) });
    const period = Math.max(1, Math.min(30, Math.floor(c.slice / 12)));
    const keeper = new Keeper({ view: w.view, sender, clock: c, gpuIds: w.panels.map((p) => p.gpuId), alerts: w.alerts, heartbeat: hb, tickS: period, attesterPick: (g) => readPickNote(pickNotePath(w.home, w.index, g)) });
    return loop(role, period, async (now) => {
      await w.pool.tick(now);
      await keeper.tick(now);
    }, () => sender.resetNonce());
  }

  if (role === "health") {
    const keys: { role: string; address: `0x${string}` }[] = [];
    const ws = await w.view.writers();
    keys.push({ role: "primary", address: ws[0] }, { role: "standby", address: ws[1] }, { role: "attester", address: await w.view.attester() });
    for (const [r, v] of [["keeper", "AGATE_KEEPER_ADDRESS"], ["guardian", "AGATE_GUARDIAN_ADDRESS"]] as const) if (process.env[v]) keys.push({ role: r, address: process.env[v] as `0x${string}` });
    if (process.env.AGATE_KEEPER_KEY) keys.push({ role: "keeper", address: addressOfEnvKey("AGATE_KEEPER_KEY") });
    const health = new Health({ view: w.view, pool: w.pool, clock: c, alerts: w.alerts, roles: roleBeats(w), gpuIds: w.panels.map((p) => p.gpuId), keys: keys.filter((k) => !/^0x0{40}$/i.test(k.address)), heartbeat: hb });
    return loop(role, Math.min(60, c.slice), (now) => health.tick(now));
  }

  // status: heartbeats and open alerts
  for (const b of beatStatus(roleBeats(w), nowS())) say("status", "heartbeat", { ...b });
  for (const a of w.alerts.open().sort((x, y) => (x.deadline ?? Infinity) - (y.deadline ?? Infinity))) say("status", "alert", { ...a });
}

if (import.meta.main) {
  const role = process.argv[2] as Role;
  if (!ROLES.includes(role)) {
    console.error(`usage: bun run src/main.ts <${ROLES.join("|")}>`);
    process.exit(2);
  }
  if (role !== "log") env("AGATE_INDEX");
  main(role).catch((e) => {
    console.error(`${role}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
