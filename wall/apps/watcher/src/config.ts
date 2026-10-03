// Environment, panels, the clock cache and the chain wiring shared by the four watcher processes and the guardian CLI.
// Env: AGATE_RPC_URLS_CMD (13.6, Oct 3: a command run once at start that prints the URL list; the Alchemy URL holds an
// API key, so every URL is a secret: redacted in every log line, alert and file) or AGATE_RPC_URLS (two or more,
// comma separated; AGATE_RPC_URL = one, raises RPC_SINGLE); ws(s):// entries are websocket endpoints, AGATE_INDEX,
// AGATE_PANELS (JSON Panel[] or {panels}), AGATE_WALL_HOME (default ~/.agate-wall), AGATE_CHAIN_ID (expected),
// AGATE_FROM_BLOCK (the index's deployment block), AGATE_LOG_CHUNK (getLogs range, default 100),
// AGATE_CONFIRMATIONS, AGATE_GAS_MEASURED (JSON {attest, closeDay, carryDay, veto, suspend}), AGATE_MAX_FEE_GWEI,
// AGATE_NOTIFY_CMD, AGATE_KEY_LOW_HOURS (health: KEY_LOW under that many hours of a key's recent spend, default 24),
// SOURCE_BASE_URL, AGATE_WATCH_SOURCES, AGATE_WATCHER_LOG_DIR (a log kept before the index existed:
// the logger runs without AGATE_INDEX on a profile clock, AGATE_PROFILE and AGATE_EPOCH_TS, 13.3 step 2).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installScrubber, type RpcEndpoints, resolveRpcEndpoints, scrubSecrets } from "@agate/report/env";
import type { Address, Clocks, Hex } from "@agate/report/types";
import type { Panel } from "@agate/sources/types";
import { AlertSink } from "./alerts.ts";
import { agateIndexAbi } from "@agate/report/abi";
import type { Abi } from "viem";
import { abiProblems } from "./chain/abi-check.ts";
import { RpcPool } from "./chain/rpc.ts";
import { EventIndexer, ViemIndex } from "./chain/viem-index.ts";
import { wallClock, type WallClock } from "./clock.ts";
import { setFileScrubber, wallHome, writeAtomic } from "./fsutil.ts";
import type { PanelRef } from "./scenario.ts";

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing environment variable ${name}`);
  return v;
}

export function loadPanels(path: string): PanelRef[] {
  const j = JSON.parse(readFileSync(path, "utf8")) as Panel[] | { panels: Panel[] };
  const panels = Array.isArray(j) ? j : j.panels;
  if (!Array.isArray(panels) || panels.length === 0) throw new Error(`${path}: no panels`);
  return panels.map((p) => {
    const sources: string[] = [];
    for (const s of p.slots) sources[s.slot] = s.sourceId;
    if (sources.some((x) => !x) || sources.length !== p.slots.length) throw new Error(`${path}: ${p.gpu} slots are not 0..n-1`);
    return { gpu: p.gpu, gpuId: p.gpuId as Hex, sources };
  });
}

export interface Wall {
  home: string;
  index: Address;
  dir: string; // <home>/watcher/<index>
  /** the watcher's log directory: AGATE_WATCHER_LOG_DIR (a logger started before the index existed), else dir */
  logDir: string;
  alerts: AlertSink;
  pool: RpcPool;
  view: ViemIndex;
  clock: WallClock;
  panels: PanelRef[];
  /** the endpoints read at start (13.6): http in failover order, ws for wake-up subscriptions */
  endpoints: RpcEndpoints;
}

/**
 * 13.6: the RPC endpoints from AGATE_RPC_URLS_CMD (run once), AGATE_RPC_URLS or AGATE_RPC_URL; both variables are then
 * deleted from env so no child inherits them. From here on every console line, stdout and stderr write (unless
 * `console` is false: tests), every file this process writes and every alert passes through scrubSecrets.
 */
export function readEndpoints(env: Record<string, string | undefined> = process.env, o: { console?: boolean; run?: (cmd: string) => string } = {}): RpcEndpoints {
  const e = o.run ? resolveRpcEndpoints(env, o.run) : resolveRpcEndpoints(env);
  if (o.console !== false) installScrubber(e);
  setFileScrubber((t) => scrubSecrets(t, e));
  return e;
}

/** The clocks and chain id an earlier start read from the chain (<dir>/clocks.json), or null. */
function cachedClocks(dir: string): { clocks: Clocks; chainId?: number } | null {
  try {
    const { chainId, ...j } = JSON.parse(readFileSync(join(dir, "clocks.json"), "utf8")) as Clocks & { chainId?: number };
    return { clocks: { ...j, epochTs: BigInt(j.epochTs), chainSelector: BigInt(j.chainSelector) }, ...(typeof chainId === "number" ? { chainId } : {}) };
  } catch {
    return null;
  }
}

/** Clocks from the chain, cached on disk with the pool's chain id so a process can start (the logger keeps logging)
 *  while every URL is down. */
async function clocksOf(view: ViemIndex, dir: string, chainId: number): Promise<Clocks> {
  const cache = join(dir, "clocks.json");
  try {
    const c = await view.clocks();
    writeAtomic(cache, JSON.stringify({ ...c, chainId }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    return c;
  } catch (e) {
    const hit = cachedClocks(dir);
    if (!hit) throw e;
    return hit.clocks;
  }
}

export async function connect(role: string, now: () => number, o: { endpoints?: RpcEndpoints; console?: boolean } = {}): Promise<Wall> {
  // first: no line may print a URL before the scrubber knows them
  const endpoints = o.endpoints ?? readEndpoints(process.env, o.console === false ? { console: false } : {});
  const stale = abiProblems(agateIndexAbi as Abi);
  if (stale.length > 0) throw new Error(`@agate/report's abi.ts is not the v4.3 interface (${stale.join("; ")}): run \`cd contracts && forge build\` then \`cd wall && bun run gen:abi\``);
  const home = wallHome();
  const index = env("AGATE_INDEX") as Address;
  const dir = join(home, "watcher", index.toLowerCase());
  const alerts = new AlertSink(join(home, "alerts", "alerts.jsonl"), { now, role, index, ...(process.env.AGATE_NOTIFY_CMD ? { notifyCmd: process.env.AGATE_NOTIFY_CMD } : {}) });
  const cachedId = cachedClocks(dir)?.chainId;
  const pool = await RpcPool.create({
    urls: endpoints.http,
    ...(process.env.AGATE_CHAIN_ID ? { expectChainId: Number(process.env.AGATE_CHAIN_ID) } : {}),
    ...(cachedId !== undefined ? { fallbackChainId: cachedId } : {}),
    timeoutMs: 10_000,
    staleS: 30,
    alerts,
    role,
    now,
  });
  const view = new ViemIndex(pool, index);
  const clock = wallClock(await clocksOf(view, dir, pool.chainId));
  // per-profile RPC timeout and stale bound (13.4): min(10 s, slice / 10), max(30 s, slice / 4)
  pool.retune(Math.min(10_000, Math.max(1_000, (clock.slice / 10) * 1000)), Math.max(30, clock.slice / 4));
  const panels = loadPanels(env("AGATE_PANELS"));
  return { home, index, dir, logDir: process.env.AGATE_WATCHER_LOG_DIR || dir, alerts, pool, view, clock, panels, endpoints };
}

export function eventIndexer(w: Wall): EventIndexer {
  return new EventIndexer({
    pool: w.pool,
    address: w.index,
    dir: join(w.dir, "events"),
    fromBlock: BigInt(env("AGATE_FROM_BLOCK", "0")),
    chunk: BigInt(env("AGATE_LOG_CHUNK", "100")),
    confirmations: BigInt(env("AGATE_CONFIRMATIONS", "0")),
  });
}

export function maxFeeGwei(): number | undefined {
  return process.env.AGATE_MAX_FEE_GWEI ? Number(process.env.AGATE_MAX_FEE_GWEI) : undefined;
}
