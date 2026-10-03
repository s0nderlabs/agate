// The process around a Writer (both writers, D10): one process per role and index (flock), the key taken from the
// environment, the RPC pool checked, the startup checks retried while the chain is unreachable, then the tick loop
// with a heartbeat. Signals stop it between ticks.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Address, Hex } from "@agate/report/types";
import type { Panel, SourcesPureApi } from "@agate/sources/types";
import { privateKeyToAccount } from "viem/accounts";
import { type Clock, sliceAt, tickPeriod } from "../core/index.ts";
import { type IndexChain, indexChain } from "./chain.ts";
import { makeFetcher, PageReader, timeoutFor } from "./fetch.ts";
import { FileLock } from "./lock.ts";
import { ReadingLog, type Role, wallHome } from "./log.ts";
import { alertSink } from "./ops.ts";
import { type AlertFn, RpcDownError, RpcPool } from "./rpc.ts";
import { timingFor } from "./sender.ts";
import type { RpcEndpoints } from "@agate/report/env";
import { directSource, env, jsonSay, loadPanelFile, loadSourcesApi, maxFeeFromEnv, measuredFromEnv, redaction, rpcEndpointsFromEnv, type StartInfo, startupChecks, takeKey } from "./setup.ts";
import { type ReadingSource, Writer } from "./writer.ts";

export interface SourceContext {
  api: SourcesPureApi;
  panels: Panel[];
  clock: Clock;
  chain: IndexChain;
  info: StartInfo;
  home: string;
  pool: RpcPool;
  key: Hex;
  direct: ReadingSource;
  say: (event: string, data?: Record<string, unknown>) => void;
  alert: AlertFn;
  /** The writer's local log (the CRE runner logs its run lines here, 8.2 (4)). */
  log: ReadingLog;
  /** The RPC endpoints from AGATE_RPC_URLS_CMD or AGATE_RPC_URLS (secret: never into a file or a child, 13.6). */
  endpoints: RpcEndpoints;
  /** The panel file's flags (panels/launch.json: includeOverCap, 7.10). */
  panelFlags: { includeOverCap?: boolean; includeEur?: boolean };
  /** 13.6's scrub function for anything written to a file. */
  scrub: (s: string) => string;
}

export interface ServiceOptions {
  role: Role;
  keyEnv: "AGATE_PRIMARY_KEY" | "AGATE_STANDBY_KEY";
  expectSlot: 0 | 1;
  makeSource?: (ctx: SourceContext) => Promise<ReadingSource>;
}

const nowS = () => Math.floor(Date.now() / 1000);

interface Memo {
  chainId: number;
  info: StartInfo;
  panelsHash: string;
}

const hashPanels = (p: readonly Panel[]) => new Bun.CryptoHasher("sha256").update(JSON.stringify(p)).digest("hex");

/** The facts a start verified onchain, for a start with every RPC down (the clock and registrations never change). */
function remember(path: string, m: { chainId: number; info: StartInfo }) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const body: Memo = { ...m, info: { ...m.info, warnings: [] }, panelsHash: hashPanels(m.info.panels) };
    writeFileSync(`${path}.tmp`, JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)));
    renameSync(`${path}.tmp`, path);
  } catch {
    // a convenience: the next start without RPC simply waits
  }
}

function recall(path: string, panels: readonly Panel[]): Memo | undefined {
  try {
    const m = JSON.parse(readFileSync(path, "utf8"), (_k, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) as Memo;
    // only when AGATE_PANELS still holds the verified panels (a changed file must be checked against the chain)
    const still = m.info.panels.every((p) => panels.some((q) => JSON.stringify(q) === JSON.stringify(p)));
    return still && hashPanels(m.info.panels) === m.panelsHash ? m : undefined;
  } catch {
    return undefined;
  }
}

export async function runService(o: ServiceOptions): Promise<void> {
  // 13.6 first: the endpoints are read once (a command's output stays in memory) and every printed line is scrubbed
  const endpoints = rpcEndpointsFromEnv(process.env);
  const scrub = redaction(endpoints);
  const say = jsonSay(o.role);
  const home = wallHome();
  const index = env("AGATE_INDEX") as Address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(index)) throw new Error("AGATE_INDEX is not an address");
  const lock = FileLock.tryTake(join(home, o.role, `${index.toLowerCase()}.lock`), { role: o.role, index });
  if (!lock) {
    console.error(`another ${o.role} writer for ${index} holds ${join(home, o.role, `${index.toLowerCase()}.lock`)}: exiting`);
    process.exit(3);
  }
  const key = takeKey(o.keyEnv);
  const writerAddr = privateKeyToAccount(key).address;
  const alert = alertSink({ home, writer: writerAddr, index, scrub, ...(process.env.AGATE_NOTIFY_CMD ? { notifyCmd: process.env.AGATE_NOTIFY_CMD } : {}) });
  const urls = endpoints.http;
  const panelFile = loadPanelFile(env("AGATE_PANELS"));
  const panelsAll = panelFile.panels;
  const api = await loadSourcesApi();
  const expectChainId = process.env.AGATE_CHAIN_ID ? Number(process.env.AGATE_CHAIN_ID) : undefined;
  const pool = new RpcPool({ urls, ...(expectChainId ? { expectChainId } : {}), timeoutMs: 10_000, staleS: 30, alert });
  const log = new ReadingLog(home, o.role);
  log.scrub = scrub;
  let stop = false;
  for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => (stop = true));

  // the chain may be unreachable at boot (launchd starts us before the network). With the clock remembered from an
  // earlier start of this index (immutable onchain) the writer starts at once and reads and logs the pages; its
  // sends wait for an RPC. Without one it retries; it never exits for that.
  const memo = join(home, o.role, `start-${index.toLowerCase()}.json`);
  let info: StartInfo | undefined;
  for (let attempt = 0; !info && !stop; attempt++) {
    try {
      await pool.init();
      info = await startupChecks(indexChain({ pool, index, privateKey: key, journal: log, timing: timingFor(3_600), say }), panelsAll, api, o.expectSlot);
      remember(memo, { chainId: pool.chainId, info });
    } catch (e) {
      if (!(e instanceof RpcDownError)) throw e; // configuration (wrong chain, index, panel): no retry fixes it
      const m = recall(memo, panelsAll);
      if (m) {
        pool.assume(m.chainId);
        info = { ...m.info, warnings: [...m.info.warnings, `every RPC URL is down: started from the clock remembered in ${memo}`] };
        break;
      }
      say("start_retry", { attempt, error: e.message });
      for (let i = 0; i < Math.min(60, 5 * (attempt + 1)) * 10 && !stop; i++) await Bun.sleep(100);
    }
  }
  if (!info || stop) return;
  for (const w of info.warnings) say("warning", { message: w });
  const { clock, panels } = info;
  pool.tune(Math.min(10, Math.max(1, Math.floor(clock.slice / 10))) * 1000, Math.max(30, Math.floor(clock.slice / 4)));
  const real = indexChain({
    pool,
    index,
    privateKey: key,
    journal: log,
    timing: timingFor(clock.slice),
    alert,
    say,
    measured: measuredFromEnv(),
    ...(maxFeeFromEnv() !== undefined ? { maxFeeWei: maxFeeFromEnv()! } : {}),
    keyLockPath: join(home, "keys", `${writerAddr.toLowerCase()}.lock`),
  });

  const fetcher = makeFetcher({ role: o.role, timeoutMs: timeoutFor(clock), retryBefore: () => sliceAt(clock, nowS()).end }, clock);
  const direct = directSource(api, panels, new PageReader(fetcher, process.env.SOURCE_BASE_URL || undefined));
  const source = o.makeSource
    ? await o.makeSource({ api, panels, clock, chain: real, info, home, pool, key, direct, say, alert, log, endpoints, panelFlags: panelFile.flags, scrub })
    : direct;
  const tickS = tickPeriod(clock);
  const writer = new Writer({
    role: o.role,
    chain: real,
    clock,
    chainSelector: info.chainSelector,
    panels,
    log,
    source,
    rand: () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32,
    say,
    alert,
    heartbeatDir: join(home, o.role),
    tickS,
    api,
    readerCache: join(home, o.role, `readers-${index.slice(2, 10).toLowerCase()}.json`),
    keyCheck: {
      ...(process.env.AGATE_LOGS_CHUNK ? { chunk: Number(process.env.AGATE_LOGS_CHUNK) } : {}),
      ...(process.env.AGATE_LOGS_CALLS ? { callsPerTick: Number(process.env.AGATE_LOGS_CALLS) } : {}),
      ...(process.env.AGATE_LOGS_BACKLOG ? { backlogBlocks: Number(process.env.AGATE_LOGS_BACKLOG) } : {}),
    },
  });

  let lastInitError = "";
  say("start", { index, writer: writerAddr, slot: info.slot, day: clock.day, slices: clock.slices, tPend: clock.tPend, rpcs: pool.urls.length, gpus: panels.map((p) => p.gpu) });
  while (!stop) {
    try {
      if (!pool.verified) {
        await pool.init().then(
          () => say("rpc_verified", { rpcs: pool.urls.length, chainId: pool.chainId }),
          (e: Error) => {
            if (!(e instanceof RpcDownError) && e.message !== lastInitError) say("warning", { message: `RPC check: ${e.message}` });
            lastInitError = e.message;
          },
        );
      }
      await writer.tick(nowS());
    } catch (e) {
      say("tick_error", { error: e instanceof Error ? e.message : String(e) });
    }
    for (let i = 0; i < tickS * 10 && !stop; i++) await Bun.sleep(100);
  }
  say("stop");
  lock.release();
}
