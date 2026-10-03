// The whole wall on one local anvil, driven by one injected clock (BUILD-SPEC 11): the real AgateIndex, the replay
// server, both real Writers (the primary through the CRE path's mock forwarder or the direct path, the standby
// through postReport), the real watcher Logger, Attester, Keeper and Health, the page check (15.1) when a scenario
// asks for it, and the scripted guardian acting only through the guardian CLI's commands. Each step moves anvil's
// frozen clock to `now`, then ticks every process that is not paused, in order. Every process reaches the chain
// through two RPC proxies a chaos script can break. Since Oct 3 the processes are wired as production wires them:
// readers in force (8.6) in both writers, the logger, the attester and the guardian; per-index decisions and guardian
// log and the per-key send lock (13.7); writer alerts stamped with the index. Two Worlds can share one chain and one
// home (13.7's two indexes side by side), stepped together by runTogether.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RpcEndpoints, resolveRpcEndpoints, scrubSecrets } from "@agate/report/env";
import type { Address, GpuModel, Hex } from "@agate/report/types";
import { type ReplayScenario, startReplay } from "@agate/sources/io";
import { parse, parseEcb, parseWith, SOURCES, sourcesApi } from "@agate/sources/pure";
import type { Panel } from "@agate/sources/types";
import {
  addressOfEnvKey,
  AlertSink,
  announcedPath,
  Attester,
  decisionsPath,
  EventIndexer,
  GuardianLog,
  guardianLogDir,
  Health,
  Heartbeat,
  httpFetchPage,
  Keeper,
  keyLockPath,
  Logger,
  LogStore,
  type PanelRef,
  pickNotePath,
  type ReaderApi,
  ReaderBook,
  readerCheckOf,
  readerRefresher,
  readPickNote,
  RpcPool as WatchPool,
  type RoleBeat,
  SendLock,
  setFileScrubber,
  TxSender as WatchSender,
  ViemIndex,
  wallClock,
  type WallClock,
  writerBeatFile,
} from "@agate/watcher";
import {
  alertSink,
  type Clock,
  directSource,
  gasLimitFor,
  type IndexChain,
  indexChain,
  makeFetcher,
  MEASURED,
  PageReader,
  type ReadingSource,
  ReadingLog,
  reportHex,
  RpcPool as WritePool,
  type SenderTiming,
  sliceAt,
  startupChecks,
  type TickResult,
  Writer,
} from "@agate/writer-standby";
import { createPublicClient, encodeFunctionData, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { heartbeatPathOf, httpFetchTracker, PageCheck, WatchLog } from "../../apps/pagecheck/src/index.ts";
import { ADDR, type Anvil, anvilKey, type Deployed, deployIndex, type GpuReg, type Profile, ROLE, startAnvil } from "./chain.ts";
import { type RpcProxy, startProxy } from "./proxy.ts";
import { startGuardian, type GuardianHandle } from "./guardian.ts";
import { Truth } from "./truth.ts";

export type Proc = "primary" | "standby" | "log" | "attest" | "keep" | "health" | "guardian" | "pagecheck";
export const PROCS: Proc[] = ["health", "primary", "standby", "log", "pagecheck", "attest", "keep", "guardian"];

export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A writer as the script wants it: honest, or a stolen key rewriting what it posts. */
export interface WriterSpec {
  /** Rewrites the values one entry posts (a thief); honest = what the pages showed. */
  thief?: (x: { gpu: GpuModel; dayId: number; slice: number; values: number[] }) => number[];
  /** Slices this writer loses (its read fails: no entry, no post). */
  lose?: (dayId: number, slice: number) => boolean;
  /** The primary only: post through the CRE path's MockForwarder (onReport, tx.origin) like the CRE CLI does. */
  viaForwarder?: boolean;
  seed?: number;
}

export interface WorldOptions {
  name: string;
  profile: Profile;
  /** anvil's first block second */
  startTs: number;
  epochDay: number;
  /** PRODUCTION: 0; default: the deploy second minus 5 */
  epochTs?: number;
  firstDay?: number;
  gpus: GpuReg[];
  scenario: ReplayScenario;
  rawDir?: string;
  primary: WriterSpec | null;
  standby: WriterSpec | null;
  attester?: boolean;
  keeper?: boolean;
  health?: boolean;
  watcher?: boolean;
  guardian?: GuardianSpec | null;
  /** harness step in seconds (default max(1, slice / 20)); every process's tick period is set to it */
  step?: number;
  /** the logger's read-second draws (default a seeded LCG); () => 0.999 reads at the end of every interval */
  watcherRand?: () => number;
  /** pace the warped clock at one index second per real second (the demo's real-time behaviour) */
  realtime?: boolean;
  /** keep viem's default 4 s block-number cache in the watcher's clients (see the findings) */
  viemCache?: boolean;
  /** before the writers start: owner actions etc. */
  setup?: (w: World) => Promise<void>;
  home?: string;
  /** the panel file the index is registered from (default panels/default.json; launch.json is 7.10's panel) */
  panelsFile?: string;
  /** 8.6 readers in force in every process, as production runs them (default on) */
  readers?: boolean;
  /** run the page check (15.1) against the replay's tracker routes */
  pagecheck?: boolean;
  /** share another World's chain and RPC proxies (two indexes on one chain, 13.7) */
  chain?: { a: Anvil; proxies: RpcProxy[] };
  /** 13.6: put this fake key into every RPC URL's path, read the list through AGATE_RPC_URLS_CMD and wire the
   *  scrubbers the way the processes do at start */
  rpcSecret?: string;
  /** the logger saves every fetched page under watcher/<index>/raw (production does; the repair agent reads them) */
  writeRaw?: boolean;
}

export interface GuardianSpec {
  /** seconds after an action alert at which the guardian acts (must be under GUARD_ACT) */
  delay: number;
  looks: boolean;
  suspend: boolean;
  /** the guardian acts only from this second on (default: always) */
  from?: number;
  /** 8.5, R8 (d): on an open KEY_MISMATCH, run keycheck and suspend the writer when it is confirmed */
  keycheck?: boolean;
}

export interface WriterProc {
  role: "primary" | "standby";
  w: Writer;
  chain: IndexChain;
  addr: Address;
  results: TickResult[];
  spec: WriterSpec;
  /** every abandoned entry and every repost this writer reported, for the whole run */
  abandoned: (TickResult["abandoned"][number] & { at: number })[];
  reposts: (TickResult["reposts"][number] & { at: number })[];
  alerts: { code: string; severity?: string; gpuId?: string; day?: number; slot?: number; data?: unknown; at: number }[];
}

export const SENDER_TIMING: SenderTiming = { pollMs: 20, rebroadcastMs: 2_000, replaceMs: 6_000, waitMs: 3_000, lockWaitMs: 2_000 };

/** The contracts' published worst cases (4.14), the watcher's AGATE_GAS_MEASURED. */
export const WATCH_MEASURED = { attest: 413_775n, closeDay: 630_218n, veto: 114_750n } as const;

export const index8 = (index: string) => index.slice(2, 10).toLowerCase();

/** The reader API the watcher and guardian take from @agate/sources (8.6). */
export const READER_API = sourcesApi as unknown as ReaderApi;

/** 8.6: the attester's queue-time reader check (as the watcher's main builds it: the shared readerProblem rule). */
export const readerCheck = readerCheckOf(READER_API);

export class World {
  a!: Anvil;
  dep!: Deployed;
  clock!: Clock;
  wc!: WallClock;
  now = 0;
  home: string;
  replay!: ReturnType<typeof startReplay>;
  truth!: Truth;
  proxies: RpcProxy[] = [];
  writers: WriterProc[] = [];
  panels: PanelRef[] = [];
  step = 1;
  down: (p: Proc, t: number) => boolean = () => false;
  logger: Logger | null = null;
  attester: Attester | null = null;
  keeper: Keeper | null = null;
  health: Health | null = null;
  pagecheck: PageCheck | null = null;
  guardianTick: ((now: number) => Promise<void>) | null = null;
  watchPools: WatchPool[] = [];
  watcherDir = "";
  alerts!: AlertSink;
  timeline: { at: number; what: string }[] = [];
  errors: string[] = [];
  /** 13.6: the endpoints read through AGATE_RPC_URLS_CMD when rpcSecret is set */
  endpoints: RpcEndpoints | null = null;
  /** functions run by stop() (in-memory registry entries a scenario installed, the file scrubber) */
  cleanups: (() => void)[] = [];
  private ownsChain = true;
  private keeperPool!: WatchPool;
  private logPool: WatchPool | null = null;
  private logReaders: ((now: number, force?: boolean) => Promise<void>) | null = null;
  private nextHealth = 0;
  private lastTickOf = new Map<Proc, number>();

  constructor(readonly o: WorldOptions) {
    this.home = o.home ?? mkdtempSync(join(tmpdir(), `agate-e2e-${o.name}-`));
  }

  get readersOn(): boolean {
    return this.o.readers !== false;
  }

  get urls(): string[] {
    return this.proxies.map((p) => (this.o.rpcSecret ? `${p.url}/v2/${this.o.rpcSecret}` : p.url));
  }

  /** The URLs every process is given: the command's output when rpcSecret is set (13.6), else the proxies'. */
  get rpcUrls(): string[] {
    return this.endpoints?.http ?? this.urls;
  }

  private scrub(s: string): string {
    return this.endpoints ? scrubSecrets(s, this.endpoints) : s;
  }

  note(what: string): void {
    this.timeline.push({ at: this.now, what });
  }

  dayStart(d: number): number {
    return this.dep.epochTs + (d - this.dep.epochDay) * this.o.profile.day;
  }
  dayEnd(d: number): number {
    return this.dayStart(d + 1);
  }
  dayAt(t: number): number {
    return this.dep.epochDay + Math.floor((t - this.dep.epochTs) / this.o.profile.day);
  }
  sliceStart(d: number, h: number): number {
    return this.dayStart(d) + h * (this.o.profile.day / this.o.profile.slices);
  }

  static async create(o: WorldOptions): Promise<World> {
    const w = new World(o);
    await w.init();
    return w;
  }

  private async init(): Promise<void> {
    const o = this.o;
    process.env.AGATE_WALL_HOME = this.home;
    // Anvil's public default keys, local chain only; the watcher's sender reads them at the moment of signing
    process.env.AGATE_ATTESTER_KEY = anvilKey(ROLE.attester);
    process.env.AGATE_KEEPER_KEY = anvilKey(ROLE.keeper);
    process.env.AGATE_GUARDIAN_KEY = anvilKey(ROLE.guardian);
    process.env.AGATE_KICK_KEY = anvilKey(ROLE.kick);
    if (o.rawDir) {
      // for the World's life only: the next scenario's archive view must start from the real archive again
      const prev = process.env.AGATE_RAW_DIR;
      process.env.AGATE_RAW_DIR = o.rawDir;
      this.cleanups.push(() => {
        if (prev === undefined) delete process.env.AGATE_RAW_DIR;
        else process.env.AGATE_RAW_DIR = prev;
      });
    }
    if (o.chain) {
      this.a = o.chain.a;
      this.proxies = o.chain.proxies;
      this.ownsChain = false;
    } else {
      this.a = await startAnvil(o.startTs);
      this.proxies = [startProxy(this.a.rpc, "rpc-a"), startProxy(this.a.rpc, "rpc-b")];
    }
    if (o.rpcSecret) {
      // the list comes from a command, as the plists give it (13.6); the scrubbers are wired as each process does
      const list = this.urls.join(",");
      this.endpoints = resolveRpcEndpoints({ AGATE_RPC_URLS_CMD: `printf '%s' '${list}'` });
      const e = this.endpoints;
      setFileScrubber((t) => scrubSecrets(t, e));
      this.cleanups.push(() => setFileScrubber(null));
    }
    this.now = await this.a.time();
    this.dep = await deployIndex(this.a, o.profile, { epochDay: o.epochDay, gpus: o.gpus, ...(o.epochTs !== undefined ? { epochTs: o.epochTs } : {}), ...(o.firstDay !== undefined ? { firstDay: o.firstDay } : {}), ...(o.panelsFile ? { panelsFile: o.panelsFile } : {}) });
    this.now = await this.a.time();
    this.step = o.step ?? Math.max(1, Math.floor(o.profile.day / o.profile.slices / 20));
    this.panels = this.dep.panels.map((p: Panel) => {
      const sources: string[] = [];
      for (const s of p.slots) sources[s.slot] = s.sourceId;
      return { gpu: p.gpu as GpuModel, gpuId: p.gpuId as Hex, sources };
    });
    mkdirSync(this.home, { recursive: true });
    writeFileSync(join(this.home, `panels-${index8(this.dep.index)}.json`), JSON.stringify(this.dep.panels));
    this.replay = startReplay({ clock: { t0: this.dep.epochTs, daySec: o.profile.day, slices: o.profile.slices }, now: () => this.now, scenario: o.scenario, ...(o.rawDir ? { rawDir: o.rawDir } : {}), hangMs: 3_000 });
    this.truth = new Truth(this.replay.replay, o.scenario);
    this.watcherDir = join(this.home, "watcher", this.dep.index.toLowerCase());
    this.alerts = this.watchAlerts("harness");

    const wpool = await this.watchPool("harness");
    const view = new ViemIndex(wpool, this.dep.index);
    const clocks = await view.clocks();
    this.wc = wallClock(clocks);
    // what every watcher process caches at start (config.ts clocksOf); the page check and the repair agent read it
    mkdirSync(this.watcherDir, { recursive: true });
    writeFileSync(join(this.watcherDir, "clocks.json"), JSON.stringify({ ...clocks, chainId: this.a.chainId }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    if (o.setup) await o.setup(this);
    for (const role of ["primary", "standby"] as const) {
      const spec = o[role];
      if (spec) this.writers.push(await this.makeWriter(role, spec));
    }
    if (o.watcher !== false) await this.makeLogger();
    if (o.pagecheck) this.makePagecheck();
    if (o.attester !== false) await this.makeAttester();
    if (o.keeper !== false) await this.makeKeeper();
    if (o.health !== false) await this.makeHealth();
    if (o.guardian) this.guardian = await startGuardian(this, o.guardian);
    this.startedAt = this.now;
  }
  startedAt = 0;
  guardian: GuardianHandle | null = null;

  async watchPool(role: string): Promise<WatchPool> {
    const pool = await WatchPool.create({
      urls: this.rpcUrls,
      expectChainId: this.a.chainId,
      timeoutMs: 600,
      staleS: Math.max(30, Math.floor(this.o.profile.day / this.o.profile.slices / 4)),
      alerts: this.watchAlerts(role),
      role,
      now: () => this.now,
      // viem caches eth_blockNumber for 4 real seconds by default; on a warped clock that is minutes of index time
      // (the events indexer then misses fresh closes). Real-time effect: see the e2e findings.
      ...(this.o.viemCache ? {} : { clientFor: (url: string, timeoutMs: number) => createPublicClient({ transport: http(url, { timeout: timeoutMs, retryCount: 0 }), cacheTime: 0 }) as PublicClient }),
    });
    this.watchPools.push(pool);
    return pool;
  }

  /** One process's alerts: the shared file, scoped to this index as connect() scopes them. */
  watchAlerts(role: string): AlertSink {
    return new AlertSink(join(this.home, "alerts", "alerts.jsonl"), { now: () => this.now, print: false, role, index: this.dep.index });
  }

  /** The watcher's sender, with the per-key send lock every watcher role and the guardian CLI take (13.7). */
  watchSender(pool: WatchPool, keyEnv: string, role: string, alerts: AlertSink): WatchSender {
    return new WatchSender({
      pool,
      to: this.dep.index,
      keyEnv,
      role,
      alerts,
      measured: { ...WATCH_MEASURED },
      now: () => this.now,
      sleep: (ms) => Bun.sleep(Math.min(ms, 20)),
      pollMs: 20,
      rebroadcastS: 30,
      replaceS: Math.max(120, Math.floor(this.wc.slice / 4)),
      lock: new SendLock(keyLockPath(this.home, addressOfEnvKey(keyEnv)), 5_000, (ms) => Bun.sleep(Math.min(ms, 20))),
    });
  }

  private async makeWriter(role: "primary" | "standby", spec: WriterSpec): Promise<WriterProc> {
    const key = anvilKey(role === "primary" ? ROLE.primary : ROLE.standby);
    const addr = ADDR[role === "primary" ? ROLE.primary : ROLE.standby]!;
    const seen: WriterProc["alerts"] = [];
    const sink = alertSink({ home: this.home, writer: addr, now: () => this.now, print: () => {}, index: this.dep.index, ...(this.endpoints ? { scrub: (s: string) => this.scrub(s) } : {}) });
    const alert: typeof sink = (a) => {
      seen.push({ ...(a as { code: string }), at: this.now });
      sink(a);
    };
    const say = (event: string, data?: Record<string, unknown>) => {
      if (/error|failed|abandon|skip|warning|wake/.test(event)) this.timeline.push({ at: this.now, what: this.scrub(`${role} ${event} ${JSON.stringify(data ?? {}, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 300)}`) });
    };
    const slice = this.o.profile.day / this.o.profile.slices;
    const pool = new WritePool({ urls: this.rpcUrls, expectChainId: this.a.chainId, timeoutMs: 600, staleS: Math.max(30, Math.floor(slice / 4)), alert, reprobeMs: 60_000 });
    await pool.init();
    const log = new ReadingLog(this.home, role, () => this.now);
    if (this.endpoints) log.scrub = (s: string) => this.scrub(s);
    const chain = indexChain({
      pool,
      index: this.dep.index,
      privateKey: key,
      journal: log,
      timing: SENDER_TIMING,
      alert,
      say,
      keyLockPath: join(this.home, "keys", `${addr.toLowerCase()}.lock`),
      nowS: () => this.now,
    });
    const info = await startupChecks(chain, this.dep.panels, sourcesApi, role === "primary" ? 0 : 1);
    this.clock = info.clock;
    const fetcher = makeFetcher({ role, timeoutMs: 2_000, retryBefore: () => sliceAt(info.clock, this.now).end, now: () => this.now, sleep: async () => {} }, info.clock);
    const direct = directSource(sourcesApi, info.panels, new PageReader(fetcher, `${this.replay.url}/r/${role}`));
    let source: ReadingSource = direct;
    if (spec.thief || spec.lose) source = this.rewrite(direct, spec);
    if (spec.viaForwarder) source = this.viaForwarder(source, chain, pool, info.chainSelector);
    const w = new Writer({
      role,
      chain,
      clock: info.clock,
      chainSelector: info.chainSelector,
      panels: info.panels,
      log,
      source,
      rand: lcg(spec.seed ?? (role === "primary" ? 11 : 22)),
      say,
      alert,
      heartbeatDir: join(this.home, role),
      tickS: this.step,
      ...(this.readersOn ? { api: sourcesApi, readerCache: join(this.home, role, `readers-${index8(this.dep.index)}.json`) } : {}),
    });
    return { role, w, chain, addr, results: [], spec, abandoned: [], reposts: [], alerts: seen };
  }

  /** A stolen key's source: the honest reading, then its values rewritten; a lost slice reads nothing. */
  private rewrite(direct: ReadingSource, spec: WriterSpec): ReadingSource {
    return {
      take: async (at) => {
        if (spec.lose?.(at.dayId, at.slice)) throw new Error(`scripted: slice ${at.dayId}/${at.slice} lost`);
        const r = await direct.take(at);
        if (!spec.thief) return r;
        const entries = r.reading.entries.map((e) => {
          const p = this.panels.find((x) => x.gpuId.toLowerCase() === e.gpuId.toLowerCase())!;
          return { ...e, values: spec.thief!({ gpu: p.gpu, dayId: e.dayId, slice: e.slice, values: [...e.values] }) };
        });
        return { ...r, reading: { ...r.reading, entries } };
      },
    };
  }

  /** The CRE path stand-in (8.2 on FAST): the same report through MockForwarder.forward, signed by the primary key
   *  while the writer's sender holds nothing in flight (as the runner hands the key to the CRE CLI). */
  private viaForwarder(inner: ReadingSource, chain: IndexChain, pool: WritePool, selector: bigint): ReadingSource {
    const fwdAbi = [
      { type: "function", name: "forward", stateMutability: "nonpayable", inputs: [{ name: "receiver", type: "address" }, { name: "metadata", type: "bytes" }, { name: "report", type: "bytes" }], outputs: [{ name: "ok", type: "bool" }] },
    ] as const;
    return {
      take: async (at) => {
        // 8.2 (4): the run is announced before the key leaves the writer, so the key check can tell it is ours
        const runId = `e2e-${at.dayId}-${at.slice}-${at.readAt}`;
        at.onRun?.(runId);
        const r = await inner.take(at);
        if (r.reading.entries.length === 0) return { ...r, runId };
        const report = reportHex(selector, this.dep.index, r.reading.entries);
        const data = encodeFunctionData({ abi: fwdAbi, functionName: "forward", args: [this.dep.index, "0x", report] });
        const sent = await chain.exclusive(async () => {
          const acct = privateKeyToAccount(anvilKey(ROLE.primary));
          try {
            const nonce = Number(BigInt((await pool.request("eth_getTransactionCount", [acct.address, "pending"])) as string));
            const gasPrice = BigInt((await pool.request("eth_gasPrice", [])) as string);
            // writeReport's gas limit: 13.4 with MEASURED onReport as the estimate, as the runner sets it (1,614,000)
            const g = gasLimitFor(MEASURED.onReport, MEASURED.onReport);
            const raw = await acct.signTransaction({ chainId: this.a.chainId, type: "eip1559", to: this.dep.forwarder, data, gas: g.ok ? g.limit : MEASURED.onReport, nonce, maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: gasPrice });
            const hash = (await pool.request("eth_sendRawTransaction", [raw])) as Hex;
            for (let i = 0; i < 50; i++) {
              const rc = (await pool.request("eth_getTransactionReceipt", [hash])) as { status: string } | null;
              if (rc) return { ok: rc.status === "0x1", sent: true, txHash: hash };
              await Bun.sleep(10);
            }
            return { ok: false, sent: true, txHash: hash, error: "no receipt" };
          } catch {
            return undefined; // nothing broadcast: the writer posts directly (the runner's fallback)
          }
        }, Date.now() + 5_000);
        return sent ? { ...r, via: "cre", sent, runId } : { ...r, via: "direct", runId };
      },
    };
  }

  private async makeLogger(): Promise<void> {
    const alerts = this.watchAlerts("log");
    const store = new LogStore(this.watcherDir);
    store.refresh();
    const ids = [...new Set(this.panels.flatMap((p) => p.sources))];
    let book: ReaderBook | null = null;
    if (this.readersOn) {
      // 8.6: the logger reads every slot's history from the chain at start and on wake, then at most once a slice
      this.logPool ??= await this.watchPool("log");
      const view = new ViemIndex(this.logPool, this.dep.index);
      const b = new ReaderBook(READER_API, this.panels, this.wc);
      book = b;
      // the watcher main's refresher (awaited here, so a run stays deterministic)
      this.logReaders = readerRefresher({ book: b, view, slice: this.wc.slice });
      await this.logReaders(this.now, true);
    }
    this.logger = new Logger({
      clock: { slice: this.wc.slice, epochTs: this.wc.epochTs },
      api: { SOURCES, parse, parseEcb, ...(book ? { parseWith } : {}) } as never,
      ...(book ? { readers: (id: string, k: number) => (book!.swapped ? book!.plan(id, k) : []) } : {}),
      sourceIds: ids,
      fetchPage: httpFetchPage,
      baseUrl: `${this.replay.url}/r/watcher`,
      dir: this.watcherDir,
      store,
      alerts,
      heartbeat: new Heartbeat(join(this.watcherDir, "heartbeat-log.json"), "log", this.dep.index),
      rand: this.o.watcherRand ?? lcg(33),
      timeoutMs: 2_000,
      tickS: this.step,
      writeRaw: this.o.writeRaw === true,
      now: () => this.now,
    });
  }

  /** 15.1: the page check of this index, reading the watcher's log and the replay's tracker routes (no RPC, no key). */
  private makePagecheck(): void {
    this.pagecheck = new PageCheck({
      index: this.dep.index,
      clock: { day: this.wc.day, slice: this.wc.slice, minReadings: this.wc.minReadings, epochTs: this.wc.epochTs },
      panels: this.dep.panels,
      log: new WatchLog(this.watcherDir),
      alerts: this.watchAlerts("pagecheck"),
      home: this.home,
      fetch: httpFetchTracker,
      trackerBaseUrl: `${this.replay.url}/r/pagecheck`,
      heartbeat: new Heartbeat(heartbeatPathOf(this.home, this.dep.index), "pagecheck", this.dep.index),
      now: () => this.now,
      retryMs: 0,
    });
  }

  private async makeAttester(): Promise<void> {
    const pool = await this.watchPool("attest");
    const alerts = this.watchAlerts("attest");
    this.attester = new Attester({
      view: new ViemIndex(pool, this.dep.index),
      events: new EventIndexer({ pool, address: this.dep.index, dir: join(this.watcherDir, "events"), fromBlock: this.dep.fromBlock, chunk: 5_000n }),
      log: new LogStore(this.watcherDir),
      guardian: new GuardianLog(guardianLogDir(this.home, this.dep.index)),
      alerts,
      sender: this.watchSender(pool, "AGATE_ATTESTER_KEY", "attest", alerts),
      clock: this.wc,
      panels: this.panels,
      decisionsPath: decisionsPath(this.home, this.dep.index),
      announcedPath: announcedPath(this.home, this.dep.index),
      pickPath: (g) => pickNotePath(this.home, this.dep.index, g),
      heartbeat: new Heartbeat(join(this.watcherDir, "heartbeat-attest.json"), "attest", this.dep.index),
      tickS: this.step,
      ...(this.readersOn ? { readers: new ReaderBook(READER_API, this.panels, this.wc), readerCheck } : {}),
    });
    this.attestPool = pool;
  }
  attestPool: WatchPool | null = null;

  private async makeKeeper(): Promise<void> {
    const pool = await this.watchPool("keep");
    this.keeperPool = pool;
    const alerts = this.watchAlerts("keep");
    this.keeper = new Keeper({
      view: new ViemIndex(pool, this.dep.index),
      sender: this.watchSender(pool, "AGATE_KEEPER_KEY", "keep", alerts),
      clock: this.wc,
      gpuIds: this.panels.map((p) => p.gpuId),
      alerts,
      heartbeat: new Heartbeat(join(this.watcherDir, "heartbeat-keep.json"), "keep", this.dep.index),
      tickS: this.step,
      attesterPick: (g) => readPickNote(pickNotePath(this.home, this.dep.index, g)),
    });
  }

  roleBeats(): RoleBeat[] {
    const c = this.wc;
    return [
      { role: "log", path: join(this.watcherDir, "heartbeat-log.json"), periodS: Math.max(c.slice, this.step) },
      { role: "attest", path: join(this.watcherDir, "heartbeat-attest.json"), periodS: Math.max(c.slice, this.step) },
      { role: "keep", path: join(this.watcherDir, "heartbeat-keep.json"), periodS: Math.max(c.keeperPeriod, this.step) },
      ...this.writers.map((w) => ({ role: w.role, path: writerBeatFile(this.home, w.role, this.dep.index), periodS: Math.max(c.slice, this.step) })),
      ...(this.o.pagecheck ? [{ role: "pagecheck", path: heartbeatPathOf(this.home, this.dep.index), periodS: Math.max(Math.min(3_600, c.slice), this.step) }] : []),
    ];
  }

  private async makeHealth(): Promise<void> {
    const pool = await this.watchPool("health");
    const alerts = this.watchAlerts("health");
    this.health = new Health({
      view: new ViemIndex(pool, this.dep.index),
      pool,
      clock: this.wc,
      alerts,
      roles: this.roleBeats(),
      gpuIds: this.panels.map((p) => p.gpuId),
      keys: [
        { role: "primary", address: ADDR[ROLE.primary]! },
        { role: "standby", address: ADDR[ROLE.standby]! },
        { role: "attester", address: ADDR[ROLE.attester]! },
        { role: "keeper", address: ADDR[ROLE.keeper]! },
      ],
      heartbeat: new Heartbeat(join(this.watcherDir, "heartbeat-health.json"), "health", this.dep.index),
    });
  }

  /** A crash and a launchd restart: the process is rebuilt from its files and the chain only (no memory kept). */
  async restart(p: Proc): Promise<void> {
    this.note(`restart ${p}`);
    if (p === "primary" || p === "standby") {
      const i = this.writers.findIndex((x) => x.role === p);
      if (i >= 0) {
        const old = this.writers[i]!;
        const fresh = await this.makeWriter(p, old.spec);
        // the run's records of abandoned entries, reposts and alerts span restarts
        fresh.abandoned = old.abandoned;
        fresh.reposts = old.reposts;
        fresh.alerts.push(...old.alerts);
        this.writers[i] = fresh;
      }
    } else if (p === "log") await this.makeLogger();
    else if (p === "attest") await this.makeAttester();
    else if (p === "keep") await this.makeKeeper();
    else if (p === "health") await this.makeHealth();
    else if (p === "pagecheck" && this.o.pagecheck) this.makePagecheck();
    else if (p === "guardian" && this.o.guardian) this.guardian = await startGuardian(this, this.o.guardian);
  }

  // ------------------------------------------------------------------ the loop

  private live(p: Proc): boolean {
    return !this.down(p, this.now);
  }

  private async tickProc(p: Proc, fn: () => Promise<void>): Promise<void> {
    if (!this.live(p)) return;
    try {
      await fn();
    } catch (e) {
      this.errors.push(this.scrub(`${this.now} ${p}: ${e instanceof Error ? e.message : String(e)}`));
    }
    this.lastTickOf.set(p, this.now);
  }

  async stepOnce(): Promise<void> {
    await this.tickAll(await this.a.warp(this.now + this.step));
  }

  /** Every live process ticks once at `now` (the chain is already there). */
  async tickAll(now: number): Promise<void> {
    this.now = now;
    if (this.health && now >= this.nextHealth) {
      await this.tickProc("health", async () => {
        await this.health!.tick(now);
        this.nextHealth = now + Math.max(this.step, Math.min(60, this.wc.slice));
      });
    }
    for (const w of this.writers)
      await this.tickProc(w.role, async () => {
        const r = await w.w.tick(now);
        w.results.push(r);
        for (const x of r.abandoned) w.abandoned.push({ ...x, at: now });
        for (const x of r.reposts) w.reposts.push({ ...x, at: now });
      });
    if (this.logger) {
      await this.tickProc("log", async () => {
        if (this.logPool) await this.logPool.tick(now);
        await this.logReaders?.(now);
        await this.logger!.tick(now);
        await this.logger!.drain();
      });
    }
    if (this.pagecheck) await this.tickProc("pagecheck", () => this.pagecheck!.tick(now));
    if (this.attester)
      await this.tickProc("attest", async () => {
        await this.attestPool!.tick(now);
        await this.attester!.tick(now);
      });
    if (this.keeper)
      await this.tickProc("keep", async () => {
        await this.keeperPool.tick(now);
        await this.keeper!.tick(now);
      });
    if (this.guardianTick) await this.tickProc("guardian", () => this.guardianTick!(now));
    for (const w of this.writers) if (w.results.length > 4) w.results.splice(0, w.results.length - 4);
  }

  async runUntil(t: number, each?: (w: World) => Promise<void> | void): Promise<void> {
    const real0 = Date.now() - this.now * 1000;
    while (this.now + this.step <= t) {
      if (this.o.realtime) {
        const wait = real0 + (this.now + this.step) * 1000 - Date.now();
        if (wait > 0) await Bun.sleep(wait);
      }
      await this.stepOnce();
      if (each) await each(this);
    }
  }

  /** Two or more Worlds on one chain (13.7): one warp per step (the smallest step of them), then each World ticks. */
  static async runTogether(ws: World[], t: number, each?: () => Promise<void> | void): Promise<void> {
    const a = ws[0]!.a;
    const step = Math.min(...ws.map((w) => w.step));
    let now = Math.max(...ws.map((w) => w.now));
    while (now + step <= t) {
      now = await a.warp(now + step);
      for (const w of ws) await w.tickAll(now);
      if (each) await each();
    }
  }

  stop(): void {
    for (const f of this.cleanups.splice(0)) {
      try {
        f();
      } catch {}
    }
    try {
      this.replay.stop();
    } catch {}
    if (!this.ownsChain) return;
    for (const p of this.proxies) p.stop();
    this.a.stop();
  }
}
