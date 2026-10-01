// A whole writer world on anvil: the real AgateIndex, the real @agate/sources parsers reading scripted synthetic
// pages from the replay server (archive off: nothing third-party), and Writers wired exactly as service.ts wires
// them (RPC pool, TxSender with the journal, key lock), all on one injected clock that also drives anvil.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agateIndexAbi } from "@agate/report/abi";
import type { Address, Hex, IndexRecord, Readings } from "@agate/report/types";
import { type ReplayScenario, startReplay } from "@agate/sources/io";
import { sourcesApi } from "@agate/sources/pure";
import { parseAbiItem } from "viem";
import { type Clock, dayStart, sliceAt } from "../../src/core/index.ts";
import { type IndexChain, indexChain } from "../../src/pipeline/chain.ts";
import { makeFetcher, PageReader } from "../../src/pipeline/fetch.ts";
import { ReadingLog, type Role } from "../../src/pipeline/log.ts";
import { type AlertInput, RpcPool } from "../../src/pipeline/rpc.ts";
import type { SenderTiming, TxSender } from "../../src/pipeline/sender.ts";
import { directSource, startupChecks } from "../../src/pipeline/setup.ts";
import { type ReadingSource, type TickResult, Writer } from "../../src/pipeline/writer.ts";
import { ADDR, type Anvil, type Deployed, type DeployOptions, deployIndex, KEYS, startAnvil, warp } from "./anvil.ts";

export const D = 20_727;
const price = (p: string) => [{ from: { day: 0 }, price: p, count: 8 as const }];

/** Every USD source of the default panels, a fixed on-demand price per GPU. */
export const PRICES: ReplayScenario = {
  archive: false,
  scripted: {
    p_verda: { gpus: { H100: price("3.63"), H200: price("4.73"), B200: price("6.92") } },
    p_nebius: { gpus: { H100: price("4.50"), H200: price("5.40"), B200: price("8.50") } },
    p_lambda: { gpus: { H100: price("3.99"), B200: price("6.69") } },
    p_civo: { gpus: { H100: price("2.99"), H200: price("3.49") } },
    p_hyperstack: { gpus: { H100: price("2.40"), H200: price("3.50"), B200: price("5.90") } },
  },
};

export const TIMING: SenderTiming = { pollMs: 20, rebroadcastMs: 2_000, replaceMs: 6_000, waitMs: 3_000, lockWaitMs: 2_000 };

export function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

export interface WriterHandle {
  role: Role;
  w: Writer;
  chain: IndexChain & { sender: TxSender };
  pool: RpcPool;
  log: ReadingLog;
  home: string;
  alerts: AlertInput[];
  events: { e: string; d?: Record<string, unknown> }[];
  addr: Address;
}

export interface WriterOptions {
  home?: string;
  urls?: string[];
  seed?: number;
  rand?: () => number;
  source?: (direct: ReadingSource, h: Omit<WriterHandle, "w">) => ReadingSource;
  tickS?: number;
  journalWrap?: (l: ReadingLog) => ReadingLog;
  chainWrap?: (c: IndexChain) => IndexChain;
  timing?: SenderTiming;
  /** false: no key lock file (a restart test drops a Writer without its process dying). */
  keyLock?: boolean;
  sendWaitS?: number;
}

export interface World {
  a: Anvil;
  dep: Deployed;
  clock: Clock;
  now: number;
  replay: ReturnType<typeof startReplay>;
  writer(role: Role, o?: WriterOptions): Promise<WriterHandle>;
  /** Moves anvil and the shared clock to t, then ticks each writer in order. */
  tickAll(ws: WriterHandle[], t: number): Promise<TickResult[]>;
  run(ws: WriterHandle[], from: number, to: number, step?: number): Promise<void>;
  readings(g: Hex, d: number, w: Address): Promise<Readings>;
  record(g: Hex, d: number): Promise<{ exists: boolean; isFinal: boolean; rec: IndexRecord }>;
  posted(w: Address): Promise<{ gpuId: Hex; day: number; slice: number; tx: Hex }[]>;
  skipped(): Promise<number>;
  txCount(w: Address): Promise<number>;
  attest(g: Hex, d: number): Promise<void>;
  stop(): void;
}

export async function makeWorld(o: { deploy?: DeployOptions; scenario?: ReplayScenario; anvilArgs?: string[] } = {}): Promise<World> {
  const a = await startAnvil({ ...(o.anvilArgs ? { args: o.anvilArgs } : {}) });
  const dep = await deployIndex(a, o.deploy);
  let now = Number((await a.pub.getBlock()).timestamp);
  const replay = startReplay({ clock: { t0: dep.epochTs, daySec: o.deploy?.profile?.day ?? 2_400, slices: o.deploy?.profile?.slices ?? 12 }, now: () => world.now, scenario: o.scenario ?? PRICES });
  const probe = await (async () => {
    const pool = new RpcPool({ urls: [a.rpc], timeoutMs: 2_000, staleS: 1e9 });
    await pool.init();
    return indexChain({ pool, index: dep.index, privateKey: KEYS[1], journal: new ReadingLog(mkdtempSync(join(tmpdir(), "agate-probe-")), "primary"), timing: TIMING });
  })();
  const info0 = await startupChecks(probe, dep.panels, sourcesApi, 0);
  const clock = info0.clock;

  const world: World = {
    a,
    dep,
    clock,
    now,
    replay,
    async writer(role, w = {}) {
      const key = role === "primary" ? KEYS[1] : KEYS[2];
      const home = w.home ?? mkdtempSync(join(tmpdir(), `agate-${role}-`));
      const alerts: AlertInput[] = [];
      const events: { e: string; d?: Record<string, unknown> }[] = [];
      const say = (e: string, d?: Record<string, unknown>) => void events.push({ e, ...(d ? { d } : {}) });
      const pool = new RpcPool({ urls: w.urls ?? [a.rpc], expectChainId: a.chainId, timeoutMs: 800, staleS: Math.max(30, Math.floor(clock.slice / 4)), alert: (x) => void alerts.push(x), reprobeMs: 60_000 });
      await pool.init();
      const base = new ReadingLog(home, role, () => Math.floor(Date.now() / 1000));
      const log = w.journalWrap ? w.journalWrap(base) : base;
      const chain = indexChain({
        pool,
        index: dep.index,
        privateKey: key,
        journal: log,
        timing: w.timing ?? TIMING,
        alert: (x) => void alerts.push(x),
        say,
        ...(w.keyLock === false ? {} : { keyLockPath: join(home, "keys", `${(role === "primary" ? ADDR[1] : ADDR[2])!.toLowerCase()}.lock`) }),
        nowS: () => world.now,
      });
      const info = await startupChecks(chain, dep.panels, sourcesApi, role === "primary" ? 0 : 1);
      const fetcher = makeFetcher({ role, timeoutMs: 2_000, retryBefore: () => sliceAt(clock, world.now).end, now: () => world.now, sleep: async () => {} }, clock);
      const direct = directSource(sourcesApi, info.panels, new PageReader(fetcher, `${replay.url}/r/${role}`));
      const h = { role, chain, pool, log, home, alerts, events, addr: chain.writer };
      const source = w.source ? w.source(direct, h) : direct;
      const writer = new Writer({
        role,
        chain: w.chainWrap ? w.chainWrap(chain) : chain,
        clock,
        chainSelector: info.chainSelector,
        panels: info.panels,
        log,
        source,
        rand: w.rand ?? lcg(w.seed ?? (role === "primary" ? 11 : 22)),
        say,
        alert: (x) => void alerts.push(x),
        heartbeatDir: join(home, role),
        tickS: w.tickS ?? 20,
        ...(w.sendWaitS !== undefined ? { sendWaitS: w.sendWaitS } : {}),
      });
      return { ...h, w: writer };
    },
    async tickAll(ws, t) {
      world.now = await warp(a, t);
      const out: TickResult[] = [];
      for (const x of ws) out.push(await x.w.tick(world.now));
      return out;
    },
    async run(ws, from, to, step = 20) {
      for (let t = from; t < to; t += step) await world.tickAll(ws, t);
    },
    readings: (g, d, w) => a.pub.readContract({ address: dep.index, abi: agateIndexAbi, functionName: "readings", args: [g, d, w] }) as Promise<Readings>,
    async record(g, d) {
      const [exists, isFinal, rec] = (await a.pub.readContract({ address: dep.index, abi: agateIndexAbi, functionName: "record", args: [g, d] })) as [boolean, boolean, IndexRecord];
      return { exists, isFinal, rec };
    },
    async posted(w) {
      const logs = await a.pub.getLogs({
        address: dep.index,
        event: parseAbiItem("event ReadingsPosted(bytes32 indexed gpuId, uint32 indexed day, address indexed writer, uint8 slice, uint64 readAt, uint32[] values, uint32 validMask, bool late)"),
        args: { writer: w },
        fromBlock: 0n,
      });
      return logs.map((l) => ({ gpuId: l.args.gpuId as Hex, day: Number(l.args.day), slice: Number(l.args.slice), tx: l.transactionHash! }));
    },
    async skipped() {
      const logs = await a.pub.getLogs({ address: dep.index, event: parseAbiItem("event EntrySkipped(bytes32 indexed gpuId, uint32 indexed day, address indexed writer, uint8 slice, uint8 reason)"), fromBlock: 0n });
      return logs.length;
    },
    txCount: (w) => a.pub.getTransactionCount({ address: w }),
    async attest(g, d) {
      const { rec } = await world.record(g, d);
      const wa = a.wallet(3);
      const hash = await wa.writeContract({ address: dep.index, abi: agateIndexAbi, functionName: "attest", args: [g, d, rec.source, rec.digest], account: wa.account!, chain: wa.chain });
      const rc = await a.pub.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error("attest failed");
    },
    stop() {
      replay.stop();
      a.stop();
    },
  };
  world.now = now;
  return world;
}

export const dayStartOf = (w: World, d: number) => dayStart(w.clock, d);
