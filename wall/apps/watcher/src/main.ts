// The watcher app (BUILD-SPEC 9): `bun run src/main.ts <log|attest|keep|health|status>`, one set per index
// (AGATE_INDEX). Each process takes its per-key lock, writes a heartbeat every tick, runs its wake routine after a
// clock jump, and never exits on an error inside a tick. Keys are read from their variables at the moment of signing:
// AGATE_ATTESTER_KEY (attest), AGATE_KEEPER_KEY (keep). See config.ts for the rest of the environment.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { redactUrl } from "@agate/report/env";
import { Attester } from "./attester.ts";
import { keyLockPath, SendLock } from "./chain/keylock.ts";
import { TxSender, addressOfEnvKey, holdKey, measuredFromEnv } from "./chain/sender.ts";
import { Waker, WsWake } from "./chain/ws-wake.ts";
import { connect, env, eventIndexer, maxFeeGwei, type Wall } from "./config.ts";
import { AlertSink } from "./alerts.ts";
import { deriveClocks, fetchTimeoutS, PROFILES, wallClock } from "./clock.ts";
import { Heartbeat, LockHeld, takeLock, wallHome } from "./fsutil.ts";
import { GuardianLog } from "./guardian-log.ts";
import { beatStatus, Health, type RoleBeat } from "./health.ts";
import { Keeper, pickNotePath, readPickNote } from "./keeper.ts";
import { cryptoRand, httpFetchPage, Logger, type LoggerApi } from "./log/logger.ts";
import { LogStore } from "./log/store.ts";
import { isReaderApi, type ReaderApi, ReaderBook, readerCheckOf, readerRefresher } from "./readers.ts";

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

export const index8 = (index: string) => index.slice(2, 10).toLowerCase();

/** 9.2, 13.7 (Oct 3): the attester's decisions of one index (a shared decisions.jsonl would interleave two). */
export function decisionsPath(home: string, index: string): string {
  return join(home, "attester", `decisions-${index8(index)}.jsonl`);
}

/** 9.4: the key of the newest event the attester of one index announced (the event store is shared with the guardian
 *  CLI, so the events on disk are not all announced ones). */
export function announcedPath(home: string, index: string): string {
  return join(home, "attester", `announced-${index8(index)}.json`);
}

/** 10, 13.7 (Oct 3): the guardian log of one index: <home>/guardian/<index lowercase>/. Both indexes register the same
 *  gpuIds over overlapping days, so a shared log would vouch the other index's days. */
export function guardianLogDir(home: string, index: string): string {
  return join(home, "guardian", index.toLowerCase());
}

/** Files left in the old shared guardian folder are ignored, with one line saying so. */
export function oldGuardianLogWarning(home: string): string | null {
  const old = ["looks.jsonl", "signatures.jsonl", "r8.jsonl", "flags.jsonl"].filter((f) => existsSync(join(home, "guardian", f)));
  return old.length > 0 ? `ignoring the shared guardian log files ${old.join(", ")} in ${join(home, "guardian")} (since Oct 3 each index has its own folder, 13.7)` : null;
}

/** The roles health watches, with their tick periods (13.4); since Oct 3 also the page check of this index (one
 *  slice, at most 3,600 s), the repair agent (3,600 s) and the Akash reader (its interval), unless left out of
 *  AGATE_HEALTH_EXTRA (default "pagecheck,repair,akash"). */
export function roleBeats(w: Wall): RoleBeat[] {
  const c = w.clock;
  const extra = new Set((process.env.AGATE_HEALTH_EXTRA ?? "pagecheck,repair,akash").split(",").map((x) => x.trim()).filter(Boolean));
  const akashS = Number(process.env.AGATE_AKASH_INTERVAL_S ?? 3_600);
  return [
    { role: "log", path: heartbeatFile(w, "log"), periodS: c.slice },
    { role: "attest", path: heartbeatFile(w, "attest"), periodS: c.slice },
    { role: "keep", path: heartbeatFile(w, "keep"), periodS: c.keeperPeriod },
    ...(process.env.AGATE_HEALTH_WRITERS ?? "primary,standby").split(",").filter(Boolean).map((r) => ({ role: r, path: writerBeatFile(w.home, r, w.index), periodS: c.slice })),
    ...(extra.has("pagecheck") ? [{ role: "pagecheck", path: join(w.home, "pagecheck", `heartbeat-${index8(w.index)}.json`), periodS: Math.min(3_600, c.slice) }] : []),
    ...(extra.has("repair") ? [{ role: "repair", path: join(w.home, "repair", "heartbeat.json"), periodS: 3_600 }] : []),
    ...(extra.has("akash") ? [{ role: "akash", path: join(w.home, "akash", "heartbeat.json"), periodS: Number.isFinite(akashS) && akashS > 0 ? akashS : 3_600 }] : []),
  ];
}

async function loop(role: string, periodS: number, tick: (now: number) => Promise<void>, onWake?: () => void, waker?: Waker): Promise<void> {
  let stop = false;
  for (const s of ["SIGINT", "SIGTERM"] as const)
    process.on(s, () => {
      stop = true;
      waker?.wake();
    });
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
    // a websocket notification (13.6) cuts the sleep short: the next tick runs at once and reads the chain over HTTP
    if (waker) await waker.wait(periodS * 1000);
    else await Bun.sleep(periodS * 1000);
  }
  say(role, "stop");
}

/** 9.2, 13.6: the attester and the keeper wake on monadLogs for the index (first ws URL that connects); polling stays. */
function wsWake(w: Wall, role: string, waker: Waker): WsWake {
  const ws = new WsWake({ urls: w.endpoints.ws, address: w.index, kinds: ["logs"], onWake: () => waker.wake(), alerts: w.alerts, role, log: (event, data) => say(role, event, data) });
  ws.start();
  return ws;
}

/** 13.7: the per-key send lock, waiting at most max(30 s, slice / 4) per send. */
function sendLock(w: Wall, keyEnv: string): SendLock {
  return new SendLock(keyLockPath(w.home, addressOfEnvKey(keyEnv)), Math.max(30, w.clock.slice / 4) * 1000);
}

/** 8.6: the reader registry of @agate/sources, or null when this build has none (registered readers only; the
 *  attester then raises neither READER_MISSING nor READER_REFUSED, the ONCHAIN_EVENT action alert still names every
 *  queued swap). */
async function loadReaderApi(): Promise<ReaderApi | null> {
  const m = (await import("@agate/sources/pure")) as Partial<ReaderApi>;
  return isReaderApi(m) ? m : null;
}

async function loadLoggerApi(): Promise<LoggerApi> {
  const m = (await import("@agate/sources/pure")) as Partial<LoggerApi>;
  if (!Array.isArray(m.SOURCES) || typeof m.parse !== "function" || typeof m.parseEcb !== "function")
    throw new Error("@agate/sources/pure does not export SOURCES, parse and parseEcb yet");
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
  say(role, "start", { index: w.index, day: c.day, slices: c.slices, urls: w.pool.redactedUrls(), ws: w.endpoints.ws.map(redactUrl), panels: w.panels.map((p) => p.gpu) });

  if (role === "log") {
    const api = await loadLoggerApi();
    const want = process.env.AGATE_WATCH_SOURCES?.split(",").filter(Boolean);
    const store = new LogStore(w.logDir);
    store.refresh();
    const rapi = await loadReaderApi();
    const book = rapi ? new ReaderBook(rapi, w.panels, c) : null;
    // 8.6: at start, on wake, then at most once per slice; off the tick path below (the pages need no RPC)
    const refresh = book ? readerRefresher({ book, view: w.view, slice: c.slice, say: (event, data) => say("log", event, data) }) : null;
    await refresh?.(nowS(), true);
    const logger = new Logger({
      clock: { slice: c.slice, epochTs: c.epochTs },
      api: rapi ? { ...api, parseWith: rapi.parseWith } : api,
      ...(book ? { readers: (id: string, k: number) => (book.swapped ? book.plan(id, k) : []) } : {}),
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
    return loop(role, 1, async (now) => {
      void refresh?.(now); // never awaited: an RPC outage must not hold the page fetches (it never rejects)
      await logger.tick(now);
    }, () => void refresh?.(nowS(), true));
  }

  if (role === "attest") {
    holdKey("AGATE_ATTESTER_KEY"); // out of process.env for the process's life (M3)
    const events = eventIndexer(w);
    const store = new LogStore(w.logDir);
    const sender = new TxSender({ pool: w.pool, to: w.index, keyEnv: "AGATE_ATTESTER_KEY", role, alerts: w.alerts, measured: measuredFromEnv(process.env), ...(maxFeeGwei() !== undefined ? { maxFeeGwei: maxFeeGwei()! } : {}), now: nowS, rebroadcastS: 30, replaceS: Math.max(120, c.slice / 4), lock: sendLock(w, "AGATE_ATTESTER_KEY") });
    const warn = oldGuardianLogWarning(w.home);
    if (warn) say(role, "warning", { message: warn });
    const rapi = await loadReaderApi();
    const att = new Attester({
      ...(rapi ? { readers: new ReaderBook(rapi, w.panels, c), readerCheck: readerCheckOf(rapi) } : {}), view: w.view, events, log: store, guardian: new GuardianLog(guardianLogDir(w.home, w.index)), alerts: w.alerts, sender, clock: c, panels: w.panels, decisionsPath: decisionsPath(w.home, w.index), announcedPath: announcedPath(w.home, w.index), pickPath: (g) => pickNotePath(w.home, w.index, g), heartbeat: hb, tickS: Math.max(1, Math.min(10, Math.floor(c.slice / 20))) });
    const period = Math.max(1, Math.min(10, Math.floor(c.slice / 20)));
    const waker = new Waker();
    const ws = wsWake(w, role, waker);
    await loop(role, period, async (now) => {
      await w.pool.tick(now);
      ws.tick();
      await att.tick(now);
    }, () => sender.resetNonce(), waker);
    ws.stop();
    return;
  }

  if (role === "keep") {
    holdKey("AGATE_KEEPER_KEY");
    const sender = new TxSender({ pool: w.pool, to: w.index, keyEnv: "AGATE_KEEPER_KEY", role, alerts: w.alerts, measured: measuredFromEnv(process.env), ...(maxFeeGwei() !== undefined ? { maxFeeGwei: maxFeeGwei()! } : {}), now: nowS, rebroadcastS: 30, replaceS: Math.max(120, c.slice / 4), lock: sendLock(w, "AGATE_KEEPER_KEY") });
    const period = Math.max(1, Math.min(30, Math.floor(c.slice / 12)));
    const keeper = new Keeper({ view: w.view, sender, clock: c, gpuIds: w.panels.map((p) => p.gpuId), alerts: w.alerts, heartbeat: hb, tickS: period, attesterPick: (g) => readPickNote(pickNotePath(w.home, w.index, g)) });
    const waker = new Waker();
    const ws = wsWake(w, role, waker);
    await loop(role, period, async (now) => {
      await w.pool.tick(now);
      ws.tick();
      await keeper.tick(now);
    }, () => sender.resetNonce(), waker);
    ws.stop();
    return;
  }

  if (role === "health") {
    const keys: { role: string; address: `0x${string}` }[] = [];
    const ws = await w.view.writers();
    keys.push({ role: "primary", address: ws[0] }, { role: "standby", address: ws[1] }, { role: "attester", address: await w.view.attester() });
    for (const [r, v] of [["keeper", "AGATE_KEEPER_ADDRESS"], ["guardian", "AGATE_GUARDIAN_ADDRESS"]] as const) if (process.env[v]) keys.push({ role: r, address: process.env[v] as `0x${string}` });
    if (process.env.AGATE_KEEPER_KEY) {
      holdKey("AGATE_KEEPER_KEY");
      keys.push({ role: "keeper", address: addressOfEnvKey("AGATE_KEEPER_KEY") });
    }
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
