// The client: configuration and every read, returning the app's shapes (types.ts). The chain is the source of truth
// for prices, series, books, balances and positions (viem over the public RPC, batched through Multicall3); the Envio
// indexer adds what only events hold (index history, fills, candles, listing times, open orders, entry prices). When
// the indexer cannot be reached the reads still answer from the chain, as documented per read (README).
import { type Abi, type Address, type Chain, createPublicClient, decodeErrorResult, defineChain, fallback, type Hex, http, type PublicClient, toFunctionSelector } from "viem";
import { agateDollarAbi, agateFactoryAbi, agateIndexAbi, agateRouterAbi, agateSeriesAbi, agateTokenAbi, kuruMarginAccountAbi, kuruOrderBookAbi } from "./abi.ts";
import { decodeL2Book, type RawBook, toBook } from "./book.ts";
import { dayIdAt, dayStart, expectedClose, expectedFinal, type IndexClocks, type RecordTimes } from "./clock.ts";
import { DEFAULT_GRAPHQL_URL, type FixRow, type FlowRow, type GraphQL, graphql, IndexerError, type OrderRow, type PositionRow, Q, type SeriesRow, type TradeRow } from "./graphql.ts";
import { PANELS, TESTNET_DEPLOYMENTS, TESTNET_PRELAUNCH } from "./static.ts";
import type { Book, Candle, Deployments, FactoryRecord, Fill, Gpu, IndexDay, Market, MarketsSnapshot, OpenOrder, PanelGpu, PanelSlot, Position, Quote, Series, SourceReading, TickerItem, Wallet } from "./types.ts";
import { dateOfDay, daysIn, firstDayOf, iso, LOT, monthLabel, monthOfDay, monthOfLabel, monthShort, SIZE_PER_TOKEN, TICK, toNumber6, U, unitsToHours, ZERO_ADDRESS } from "./units.ts";

export const PUBLIC_RPC = "https://testnet-rpc.monad.xyz";
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
/** order ids per book that openOrders checks on chain beyond what the indexer has seen (or, without it, in all) */
export const SCAN_ORDERS = 500n;
/** rows per indexer page of a wallet's positions, router flows, trades and resting orders, and the most read of each */
export const WALLET_PAGE = 1000;
export const WALLET_MAX = 50_000;
/** trades per indexer read when only the newest (or oldest) one is wanted: a 24 h base price */
export const TRADE_PAGE = 100;
export const GPUS: Gpu[] = ["H100", "H200", "B200", "B300", "A100", "L40S"];
/** markets snapshot: the reads within this time share one request; a failed one rests this long; the longest wait;
 *  the oldest snapshot used (its age when the server answered) */
export const SNAPSHOT_SHARE_MS = 2_000;
export const SNAPSHOT_REST_MS = 60_000;
export const SNAPSHOT_TIMEOUT_MS = 2_500;
export const SNAPSHOT_MAX_AGE_MS = 60_000;

/** A markets snapshot (GET /api/markets) when it is one of this chain and index, young enough and well formed; else
 *  null. */
export function snapshotOf(j: unknown, chainId: number, index: string): MarketsSnapshot | null {
  const s = j as Partial<MarketsSnapshot> | null;
  if (!s || typeof s !== "object" || s.v !== 1 || s.chainId !== chainId || typeof s.index !== "string" || s.index.toLowerCase() !== index.toLowerCase()) return null;
  if (typeof s.ageMs !== "number" || !(s.ageMs >= 0) || s.ageMs > SNAPSHOT_MAX_AGE_MS) return null;
  if (!Array.isArray(s.markets) || s.markets.length !== GPUS.length || s.markets.some((m, i) => !m || m.gpu !== GPUS[i] || !Array.isArray(m.series) || !Array.isArray(m.history))) return null;
  if (!s.books || typeof s.books !== "object" || Array.isArray(s.books)) return null;
  for (const b of Object.values(s.books)) if (!b || !Array.isArray(b.asks) || !Array.isArray(b.bids) || typeof b.spread !== "number") return null;
  return s as MarketsSnapshot;
}

/** The GraphQL URL: the value given, else NEXT_PUBLIC_AGATE_GRAPHQL_URL (a public, build-time variable in the
 *  app), else the local default http://localhost:8080/v1/graphql, but only where "localhost" is this machine's own
 *  indexer: outside a browser, or on a page served from localhost itself. A page hosted elsewhere with no URL set
 *  reads the chain only (null), instead of asking each visitor's own machine. Pass null to read the chain only. */
export function resolveGraphqlUrl(v?: string | null): string | null {
  if (v === null) return null;
  if (v) return v;
  let env: string | undefined;
  try {
    env = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_AGATE_GRAPHQL_URL : undefined;
  } catch {
    env = undefined;
  }
  if (env) return env;
  return pageIsLocal() ? DEFAULT_GRAPHQL_URL : null;
}

/** Not a browser page, or a page served from this machine (localhost, 127.0.0.1, [::1]). */
export function pageIsLocal(): boolean {
  const loc = (globalThis as { location?: { hostname?: unknown } }).location;
  if (!loc || typeof loc.hostname !== "string" || loc.hostname === "") return true;
  return /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/.test(loc.hostname);
}

export interface ClientConfig {
  /** the deployments file's JSON (contracts/deployments/<chainId>.json); default: Monad testnet's */
  deployments?: Deployments;
  /** which factory entry: "real" (default) or "demo" */
  factory?: string;
  /** the RPC URL, or a comma list tried in order (a URL that fails, is rate limited or out of capacity passes the call
   *  to the next); default the public Monad testnet RPC. In a browser bundle only a key-free URL or a key the provider
   *  locks to the app's own origins (an allowlist), with a key-free URL after it. */
  rpcUrl?: string;
  /** default deployments.chainId */
  chainId?: number;
  /** the indexer's GraphQL URL; default NEXT_PUBLIC_AGATE_GRAPHQL_URL or http://localhost:8080/v1/graphql; null: chain only */
  graphqlUrl?: string | null;
  /** an existing viem public client (its chain must be the deployments' chain) */
  publicClient?: PublicClient;
  /** default: the launch panel of the six GPUs */
  panels?: PanelGpu[];
  fetch?: typeof fetch;
  /** a markets snapshot URL (agate's server, GET /api/markets): getMarkets, getMarket and book answer from it in one
   *  request while it is fresh, and read the chain and the indexer themselves when it is down, late or wrong */
  snapshotUrl?: string | null;
}

export class ReadError extends Error {
  override name = "ReadError";
}

type Call = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };
type HistoryRows = { DailyFix: (FixRow & { gpuId: string })[] };
/** the value of a result already checked ok */
const okValue = (r: Res): unknown => (r as { ok: true; value: unknown }).value;
/** marks a promise as handled (its own await still throws): for reads started early whose caller may fail first */
function early<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}
type Res<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

// Errors are matched by their class name along the cause chain, never by instanceof: an app that passes its own
// public client (or wallet client) may load another copy of viem, whose error classes are other objects.
interface ErrLike {
  name?: unknown;
  cause?: unknown;
  data?: unknown;
  raw?: unknown;
  signature?: unknown;
  reason?: unknown;
  shortMessage?: unknown;
  message?: unknown;
}
function causes(e: unknown): ErrLike[] {
  const out: ErrLike[] = [];
  let x: unknown = e;
  for (let i = 0; i < 25 && x !== null && typeof x === "object" && !out.includes(x as ErrLike); i++) {
    out.push(x as ErrLike);
    x = (x as ErrLike).cause;
  }
  return out;
}
const CALL_FAILURES = new Set(["ContractFunctionRevertedError", "ContractFunctionZeroDataError", "AbiDecodingZeroDataError"]);

/** A failure of the call itself (a revert, or no code at the address), never of the transport. */
export function isCallFailure(e: unknown): boolean {
  return causes(e).some((x) => typeof x.name === "string" && CALL_FAILURES.has(x.name));
}

/** Every custom error of the system's contracts and Kuru's, to name a revert that bubbled up from a nested call (Kuru's
 *  SlippageExceeded() through the router, say). */
const ALL_ERRORS = [...agateDollarAbi, ...agateTokenAbi, ...agateSeriesAbi, ...agateFactoryAbi, ...agateRouterAbi, ...agateIndexAbi, ...kuruOrderBookAbi, ...kuruMarginAccountAbi].filter((x) => x.type === "error") as Abi;
const typeOf = (p: { type: string; components?: readonly { type: string }[] }): string => (p.type.startsWith("tuple") ? `(${(p.components ?? []).map(typeOf).join(",")})${p.type.slice(5)}` : p.type);
const SELECTORS = new Map<string, string>();
for (const e of ALL_ERRORS as readonly { type: string; name: string; inputs: readonly { type: string; components?: readonly { type: string }[] }[] }[]) {
  SELECTORS.set(toFunctionSelector(`${e.name}(${e.inputs.map(typeOf).join(",")})`).toLowerCase(), e.name);
}
function nameOfRevert(data: unknown): string | null {
  if (typeof data !== "string" || !data.startsWith("0x") || data.length < 10) return null;
  try {
    return decodeErrorResult({ abi: ALL_ERRORS, data: data as Hex }).errorName;
  } catch {
    return SELECTORS.get(data.slice(0, 10).toLowerCase()) ?? null;
  }
}

/** The decoded revert name of a failed call ("NotReady", "IndexStartsAfterMonth"), else a short message. */
export function errorName(e: unknown): string {
  const xs = causes(e);
  const r = xs.find((x) => x.name === "ContractFunctionRevertedError");
  const decoded = r?.data as { errorName?: unknown } | undefined;
  // a require message or a panic reads better as its reason than as "Error" / "Panic"
  if ((decoded?.errorName === "Error" || decoded?.errorName === "Panic") && typeof r?.reason === "string" && r.reason) return r.reason;
  if (typeof decoded?.errorName === "string") return decoded.errorName;
  // raw revert data: the reverted error's own, or anywhere along the chain (a call or an estimate that reverted)
  for (const x of r ? [r, ...xs] : xs) {
    const n = nameOfRevert(x.raw) ?? nameOfRevert(x.signature) ?? nameOfRevert(x.data);
    if (n) return n;
  }
  if (r && typeof r.reason === "string" && r.reason) return r.reason;
  const top = xs[0];
  if (top && typeof top.shortMessage === "string") return top.shortMessage;
  if (top && typeof top.message === "string") return top.message;
  return String(e);
}

interface RecordView extends RecordTimes {
  value: bigint;
  status: number;
  source: Address;
  dropped: boolean;
}
interface GpuView {
  gpu: Gpu;
  gpuId: Hex;
  panel: PanelGpu;
  nSlots: number;
  firstDay: number;
  head: number;
  latest: { day: number; rec: RecordView } | null;
  prev: { day: number; rec: RecordView } | null;
  /** the record of the first day after `latest` (pending), when it exists */
  next: RecordView | null;
}
export interface SeriesTerms {
  series: Address;
  token: Address;
  gpuId: Hex;
  month: number;
  startDay: number;
  n: number;
  startTs: bigint;
  day: number;
  floor: bigint;
  cap: bigint;
  name: string;
  symbol: string;
}
/** A listed series with its live state, the raw input of Series. */
export interface SeriesLive {
  gpu: Gpu;
  terms: SeriesTerms;
  market: Address | null;
  k: number;
  S: bigint;
  tokenSupply: bigint;
  nextId: bigint;
  book: RawBook | null;
}

export class AgateClient {
  readonly deployments: Deployments;
  readonly factoryName: string;
  readonly f: FactoryRecord;
  readonly chain: Chain;
  readonly pub: PublicClient;
  readonly gql: GraphQL | null;
  readonly panels: PanelGpu[];
  private mcOk: boolean | null = null;
  private mcProbe: Promise<boolean> | null = null;
  /** true when the client made its own public client (an app's own client keeps the Multicall3 check) */
  private readonly ownPub: boolean;
  private memo = new Map<string, Promise<unknown>>();
  /** what never changes once seen: a listed month's series ("gpuId:month"), a series' terms, token, name and symbol */
  private listedAddr = new Map<string, Address>();
  private termsOf = new Map<string, SeriesTerms>();
  /** the market last read for a series: its book is read in the same round as marketOf, again only if it changed */
  private lastMarket = new Map<string, Address>();
  private readonly snapUrl: string | null;
  private readonly fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  private snap: { until: number; p: Promise<MarketsSnapshot | null> } | null = null;

  constructor(cfg: ClientConfig = {}) {
    this.deployments = cfg.deployments ?? TESTNET_DEPLOYMENTS;
    this.factoryName = cfg.factory ?? "real";
    const f = this.deployments.factories[this.factoryName];
    if (!f) throw new ReadError(`the deployments have no factory "${this.factoryName}"`);
    this.f = f;
    const chainId = cfg.chainId ?? this.deployments.chainId;
    if (chainId !== this.deployments.chainId) throw new ReadError(`chain ${chainId} is not the deployments' chain ${this.deployments.chainId}`);
    const rpcUrls = (cfg.rpcUrl ?? PUBLIC_RPC).split(",").map((u) => u.trim()).filter(Boolean);
    if (rpcUrls.length === 0) rpcUrls.push(PUBLIC_RPC);
    this.chain = defineChain({
      id: chainId,
      name: chainId === 10143 ? "Monad Testnet" : `chain ${chainId}`,
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: rpcUrls } },
      contracts: { multicall3: { address: MULTICALL3 } },
    });
    this.ownPub = !cfg.publicClient;
    const transport = rpcUrls.length === 1 ? http(rpcUrls[0], { timeout: 30_000, retryCount: 2 }) : fallback(rpcUrls.map((u) => http(u, { timeout: 15_000, retryCount: 1 })), { retryCount: 1 });
    this.pub = cfg.publicClient ?? (createPublicClient({ chain: this.chain, transport }) as PublicClient);
    const url = resolveGraphqlUrl(cfg.graphqlUrl);
    this.gql = url ? graphql(url, cfg.fetch ? { fetch: cfg.fetch } : {}) : null;
    this.panels = cfg.panels ?? PANELS;
    this.snapUrl = cfg.snapshotUrl?.trim() || null;
    this.fetchFn = cfg.fetch ?? ((url, init) => globalThis.fetch(url, init));
  }

  // ------------------------------------------------------------------ plumbing

  get dollar(): Address {
    return this.f.dollar as Address;
  }
  get router(): Address {
    return this.f.router as Address;
  }
  get index(): Address {
    return this.f.index as Address;
  }
  get factory(): Address {
    return this.f.factory as Address;
  }
  get marginAccount(): Address {
    return this.deployments.kuru.marginAccount as Address;
  }

  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.memo.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn();
      this.memo.set(key, p);
      p.catch(() => this.memo.delete(key));
    }
    return p;
  }

  /** Many views in as few round trips as possible (Multicall3, allowFailure); a revert is {ok: false}. */
  async mc(calls: Call[]): Promise<Res[]> {
    if (calls.length === 0) return [];
    if (this.mcOk === null) {
      // Monad testnet has Multicall3 at its usual address: no check (a round trip) on a client of our own; elsewhere,
      // and on an app's own client, one check shared by the reads that start together
      if (this.ownPub && this.chain.id === 10143) this.mcOk = true;
      else {
        this.mcProbe ??= this.pub.getCode({ address: MULTICALL3 }).then((code) => !!code && code !== "0x");
        this.mcProbe.catch(() => (this.mcProbe = null));
        this.mcOk = await this.mcProbe;
      }
    }
    if (!this.mcOk) {
      return Promise.all(
        calls.map(async (c) => {
          try {
            return { ok: true as const, value: await this.pub.readContract({ address: c.address, abi: c.abi, functionName: c.functionName, args: c.args as unknown[] } as never) };
          } catch (e) {
            if (!isCallFailure(e)) throw new ReadError(`the RPC failed: ${errorName(e)}`);
            return { ok: false as const, error: errorName(e) };
          }
        }),
      );
    }
    const out: Res[] = [];
    for (let i = 0; i < calls.length; i += 400) {
      const part = calls.slice(i, i + 400);
      // a transport failure (rate limit, timeout) comes back from viem as a failure of every call: retried, then
      // thrown, never read as a revert
      for (let attempt = 0; ; attempt++) {
        const r = (await this.pub.multicall({ contracts: part.map((c) => ({ address: c.address, abi: c.abi, functionName: c.functionName, args: c.args ?? [] })), allowFailure: true, multicallAddress: MULTICALL3, batchSize: 0 } as never)) as unknown as { status: "success" | "failure"; result?: unknown; error?: unknown }[];
        const transport = r.find((x) => x.status === "failure" && !isCallFailure(x.error));
        if (transport) {
          if (attempt < 4) {
            await new Promise((ok) => setTimeout(ok, 400 * 2 ** attempt));
            continue;
          }
          throw new ReadError(`the RPC failed: ${errorName(transport.error)}`);
        }
        for (const x of r) out.push(x.status === "success" ? { ok: true, value: x.result } : { ok: false, error: errorName(x.error) });
        break;
      }
    }
    return out;
  }

  private async must<T>(c: Call): Promise<T> {
    const [r] = await this.mc([c]);
    if (!r!.ok) throw new ReadError(`${c.functionName} at ${c.address} reverted: ${r!.error}`);
    return r!.value as T;
  }

  /** Chain time: the latest block's timestamp (a fork's clock is not the wall clock). */
  async chainTime(): Promise<bigint> {
    return (await this.pub.getBlock({ blockTag: "latest" })).timestamp;
  }

  clocks(): Promise<IndexClocks> {
    return this.once("clocks", async () => {
      const c = await this.must<{ day: number; slice: number; tPend: number; closeGrace: number; slices: number; minReadings: number; epochTs: bigint; epochDay: number }>({ address: this.index, abi: agateIndexAbi as Abi, functionName: "clocks" });
      return { day: Number(c.day), slice: Number(c.slice), tPend: Number(c.tPend), closeGrace: Number(c.closeGrace), slices: Number(c.slices), minReadings: Number(c.minReadings), epochTs: BigInt(c.epochTs), epochDay: Number(c.epochDay) };
    });
  }

  /** The factory's GPUs: gpuId (lowercase) to label ("H100"). The panels' GPU ids are asked in the same round as the
   *  list; a listed id outside the panels is asked after. */
  marketGpus(): Promise<Map<string, Gpu>> {
    return this.once("gpus", async () => {
      const F = agateFactoryAbi as Abi;
      const guess = this.panels.map((p) => p.gpuId.toLowerCase());
      const r = await this.mc([{ address: this.factory, abi: F, functionName: "gpuIds" }, ...guess.map((id) => ({ address: this.factory, abi: F, functionName: "labelOf", args: [id] }))]);
      if (!r[0]!.ok) throw new ReadError(`gpuIds at ${this.factory} reverted: ${r[0]!.error}`);
      const ids = r[0]!.value as readonly Hex[];
      const labels = new Map(guess.map((id, i) => [id, r[i + 1]!]));
      const extra = ids.filter((id) => !labels.has(id.toLowerCase()));
      const more = await this.mc(extra.map((id) => ({ address: this.factory, abi: F, functionName: "labelOf", args: [id] })));
      extra.forEach((id, i) => labels.set(id.toLowerCase(), more[i]!));
      const m = new Map<string, Gpu>();
      for (const id of ids) {
        const l = labels.get(id.toLowerCase())!;
        if (l.ok && GPUS.includes(l.value as Gpu)) m.set(id.toLowerCase(), l.value as Gpu);
      }
      return m;
    });
  }

  panelOf(gpu: Gpu): PanelGpu {
    const p = this.panels.find((x) => x.gpu === gpu);
    if (!p) throw new ReadError(`no panel for ${gpu}`);
    return p;
  }

  private gql_<T>(q: string, v: Record<string, unknown>): Promise<T | null> {
    if (!this.gql) return Promise.resolve(null);
    return this.gql.query<T>(q, v).catch((e) => {
      if (e instanceof IndexerError) return null;
      throw e;
    });
  }

  /** Whether the indexer answers (for a status line). */
  async indexerUp(): Promise<boolean> {
    if (!this.gql) return false;
    try {
      await this.gql.query("{ __typename }");
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ the index

  private recordOf(v: unknown): RecordView & { exists: boolean; isFinal: boolean } {
    const [exists, isFinal, r] = v as readonly [boolean, boolean, { value: number; status: number; source: Address; postedAt: bigint; finalAt: bigint; dropped: boolean }];
    return { exists, isFinal, value: BigInt(r.value), status: Number(r.status), source: r.source, postedAt: BigInt(r.postedAt), finalAt: BigInt(r.finalAt), dropped: r.dropped };
  }

  /** Per GPU: head, slot count, the newest final record and the one before it, the pending one after it. */
  async gpuViews(gpus: Gpu[] = GPUS): Promise<GpuView[]> {
    const ix = this.index;
    const A = agateIndexAbi as Abi;
    const panels = gpus.map((g) => this.panelOf(g));
    const base = await this.mc(panels.flatMap((p) => [
      { address: ix, abi: A, functionName: "head", args: [p.gpuId] },
      { address: ix, abi: A, functionName: "gpu", args: [p.gpuId] },
    ]));
    const heads = panels.map((p, i) => {
      const h = base[2 * i]!;
      const g = base[2 * i + 1]!;
      if (!g.ok) throw new ReadError(`gpu(${p.gpu}) reverted: ${g.error}`);
      const cfg = g.value as { nSlots: number; firstDay: number; head: number };
      return { head: h.ok ? Number(h.value) : Number(cfg.head), nSlots: Number(cfg.nSlots), firstDay: Number(cfg.firstDay) };
    });
    // the newest day that can be final is head - 1 (closed) or head - 2 (closeDay needs the day before final, so at
    // most one record is pending); three records cover the latest, the one before and the pending one
    const want: { i: number; d: number }[] = [];
    heads.forEach((h, i) => {
      for (const d of [h.head - 1, h.head - 2, h.head - 3]) if (d >= h.firstDay) want.push({ i, d });
    });
    const recs = await this.mc(want.map((w) => ({ address: ix, abi: A, functionName: "record", args: [panels[w.i]!.gpuId, w.d] })));
    return panels.map((p, i) => {
      const h = heads[i]!;
      const mine = want.map((w, j) => ({ ...w, r: recs[j]! })).filter((w) => w.i === i && w.r.ok).map((w) => ({ day: w.d, rec: this.recordOf(w.r.ok ? w.r.value : null) }));
      const finals = mine.filter((x) => x.rec.exists && x.rec.isFinal).sort((a, b) => b.day - a.day);
      const latest = finals[0] ?? null;
      const prev = finals[1] ?? null;
      const nextDay = latest ? latest.day + 1 : h.firstDay;
      const next = mine.find((x) => x.day === nextDay && x.rec.exists)?.rec ?? null;
      return { gpu: p.gpu as Gpu, gpuId: p.gpuId as Hex, panel: p, nSlots: h.nSlots, firstDay: h.firstDay, head: h.head, latest, prev, next };
    });
  }

  /** Each panel slot's price on the newest final day, from the source writer's stored readings (the day value the
   *  index used: the cent-rounded mean once the slot has minReadings readings, else the slot's held value, else the
   *  mean of what it has), and whether it is in the median (live). A slot with no price at all is left out. */
  private async sourcesFor(views: GpuView[], c: IndexClocks): Promise<Map<Gpu, { sources: SourceReading[]; liveCount: number; panel: PanelSlot[] }>> {
    const ix = this.index;
    const A = agateIndexAbi as Abi;
    const calls: Call[] = [];
    for (const v of views) {
      for (let s = 0; s < v.nSlots; s++) calls.push({ address: ix, abi: A, functionName: "slotState", args: [v.gpuId, s] }, { address: ix, abi: A, functionName: "slotWindow", args: [v.gpuId, s] });
      if (v.latest && v.latest.rec.source !== ZERO_ADDRESS) calls.push({ address: ix, abi: A, functionName: "readings", args: [v.gpuId, v.latest.day, v.latest.rec.source] });
    }
    const res = await this.mc(calls);
    const out = new Map<Gpu, { sources: SourceReading[]; liveCount: number; panel: PanelSlot[] }>();
    let j = 0;
    const today = dayIdAt(c, await this.chainTimeCached());
    for (const v of views) {
      const states: { e: bigint; inMedian: boolean; from: number; until: number }[] = [];
      for (let s = 0; s < v.nSlots; s++) {
        const st = res[j++]!;
        const w = res[j++]!;
        const x = st.ok ? (st.value as { e: number; inMedian: boolean }) : { e: 0, inMedian: false };
        const win = w.ok ? (w.value as readonly [number, number]) : [0xffffffff, 0xffffffff];
        states.push({ e: BigInt(x.e), inMedian: x.inMedian, from: Number(win[0]), until: Number(win[1]) });
      }
      let rd: { sums: readonly bigint[]; counts: readonly number[] } | null = null;
      if (v.latest && v.latest.rec.source !== ZERO_ADDRESS) {
        const r = res[j++]!;
        if (r.ok) rd = r.value as { sums: readonly bigint[]; counts: readonly number[] };
      }
      const sources: SourceReading[] = [];
      const panel: PanelSlot[] = [];
      let liveCount = 0;
      for (let s = 0; s < v.nSlots; s++) {
        const st = states[s]!;
        const fam = v.panel.slots[s]?.family ?? `slot ${s}`;
        // before the first final day nothing is in the median yet: count the slots whose window is open today
        const live = v.latest ? st.inMedian : st.from <= today && today < st.until;
        if (live) liveCount++;
        const cnt = rd ? Number(rd.counts[s] ?? 0) : 0;
        const sum = rd ? BigInt(rd.sums[s] ?? 0n) : 0n;
        let price: bigint | null = null;
        if (cnt >= c.minReadings && cnt > 0) price = cent(sum / BigInt(cnt));
        else if (st.e > 0n && st.inMedian) price = st.e;
        else if (cnt > 0) price = cent(sum / BigInt(cnt));
        if (price !== null && v.latest) sources.push({ family: fam, price: toNumber6(price), live: st.inMedian });
        panel.push({ family: fam, live, reserve: !(v.panel.slots[s]?.liveAtStart ?? true), price: price !== null && v.latest ? toNumber6(price) : null });
      }
      out.set(v.gpu, { sources, liveCount, panel });
    }
    return out;
  }

  private ctCache: { at: number; t: Promise<bigint> } | null = null;
  /** chain time, shared by the reads of one moment (1 s) */
  chainTimeCached(): Promise<bigint> {
    const nowMs = Date.now();
    if (!this.ctCache || nowMs - this.ctCache.at > 1000) {
      const t = this.chainTime();
      this.ctCache = { at: nowMs, t };
      t.catch(() => (this.ctCache = null));
    }
    return this.ctCache.t;
  }

  /** IndexDay[] per GPU: final and carried days only, oldest first, from the indexer's daily fixes (final by their
   *  finalAt against chain time, so the indexer's lagging FINAL state never hides a day), with the chain's newest final
   *  days merged in; chain records alone when the indexer is not reachable. Never a day before the GPU's firstDay.
   *  `rows`: the indexer's answer when it was asked earlier (historyRows with the same GPUs). */
  async history(views: GpuView[], now: bigint, rows_?: Promise<HistoryRows | null>): Promise<Map<Gpu, IndexDay[]>> {
    const out = new Map<Gpu, IndexDay[]>();
    const rows = await (rows_ ?? this.historyRows(views.map((v) => v.gpuId)));
    if (rows) {
      const byGpu = new Map<Gpu, Map<number, IndexDay>>();
      const missing: { v: GpuView; d: number }[] = [];
      for (const v of views) {
        const days = new Map<number, IndexDay>();
        for (const r of rows.DailyFix) {
          // never a day after the chain's newest final one: a vetoed post a lagging indexer still holds must not chart
          if (r.gpuId.toLowerCase() !== v.gpuId.toLowerCase() || r.day < v.firstDay || !v.latest || r.day > v.latest.day) continue;
          const carried = r.state === "CARRIED" || r.state === "CARRIED_UNVERIFIED" || r.status === "CARRIED";
          const final = r.state === "FINAL" || carried || (r.state === "PENDING" && r.finalAt !== null && BigInt(r.finalAt) <= now);
          if (!final || BigInt(r.value) === 0n) continue;
          days.set(r.day, { date: dateOfDay(r.day), price: toNumber6(BigInt(r.value)), status: carried ? "carried" : "final", example: false });
        }
        for (const x of [v.prev, v.latest]) if (x) days.set(x.day, dayOf(x.day, x.rec));
        // every day up to the newest final one is final (a day closes only after the one before is final): the days the
        // indexer has not reached yet are read from the chain, so a lagging indexer never leaves a gap in the chart
        if (v.latest) for (let d = v.firstDay; d < v.latest.day; d++) if (!days.has(d)) missing.push({ v, d });
        byGpu.set(v.gpu, days);
      }
      const recs = await this.mc(missing.map((w) => ({ address: this.index, abi: agateIndexAbi as Abi, functionName: "record", args: [w.v.gpuId, w.d] })));
      missing.forEach((w, i) => {
        const r = recs[i]!;
        if (!r.ok) return;
        const rec = this.recordOf(r.value);
        if (rec.exists && rec.isFinal && rec.value > 0n) byGpu.get(w.v.gpu)!.set(w.d, dayOf(w.d, rec));
      });
      for (const v of views) out.set(v.gpu, [...byGpu.get(v.gpu)!.entries()].sort((a, b) => a[0] - b[0]).map(([, d]) => d));
      return out;
    }
    const want: { v: GpuView; d: number }[] = [];
    for (const v of views) if (v.latest) for (let d = v.firstDay; d <= v.latest.day; d++) want.push({ v, d });
    const recs = await this.mc(want.map((w) => ({ address: this.index, abi: agateIndexAbi as Abi, functionName: "record", args: [w.v.gpuId, w.d] })));
    for (const v of views) out.set(v.gpu, []);
    want.forEach((w, i) => {
      const r = recs[i]!;
      if (!r.ok) return;
      const rec = this.recordOf(r.value);
      if (rec.exists && rec.isFinal && rec.value > 0n) out.get(w.v.gpu)!.push(dayOf(w.d, rec));
    });
    return out;
  }

  /** The indexer's daily fixes of these GPUs on this index (null without it). */
  historyRows(gpuIds: string[]): Promise<HistoryRows | null> {
    return this.gql_<HistoryRows>(Q.history, { index: this.index.toLowerCase(), gpus: gpuIds.map((g) => g.toLowerCase()) });
  }

  /** The production index's pre-launch days of a GPU (static.ts, display only), before its registered firstDay; none
   *  for any other index or chain. */
  private prelaunchOf(v: GpuView): IndexDay[] {
    if (this.chain.id !== TESTNET_PRELAUNCH.chainId || this.index.toLowerCase() !== TESTNET_PRELAUNCH.index) return [];
    return (TESTNET_PRELAUNCH.days[v.gpu] ?? []).filter((d) => d.day < v.firstDay).map((d) => ({ date: dateOfDay(d.day), price: toNumber6(BigInt(d.valueU)), status: d.status, example: false, onchain: false }));
  }

  // ------------------------------------------------------------------ series

  /** A series' terms from its terms(), token(), name() and symbol() answers, kept for the next read. */
  private keepTerms(series: Address, terms: unknown, token: Address, name: Res, symbol: Res): SeriesTerms {
    const x = terms as { gpuId: Hex; month: number; startDay: number; n: number; startTs: bigint; day: number; floor: number; cap: number };
    const out: SeriesTerms = {
      series,
      token,
      gpuId: x.gpuId.toLowerCase() as Hex,
      month: Number(x.month),
      startDay: Number(x.startDay),
      n: Number(x.n),
      startTs: BigInt(x.startTs),
      day: Number(x.day),
      floor: BigInt(x.floor),
      cap: BigInt(x.cap),
      name: name.ok ? String(name.value) : "",
      symbol: symbol.ok ? String(symbol.value) : "",
    };
    this.termsOf.set(series.toLowerCase(), out);
    return out;
  }

  /** seriesOf for (gpuId, month) pairs; the zero address is none. A listed month's series never changes (the factory
   *  writes it once), so only the months not seen listed are read. */
  async seriesAddresses(pairs: { gpuId: string; month: number }[]): Promise<(Address | null)[]> {
    const key = (p: { gpuId: string; month: number }) => `${p.gpuId.toLowerCase()}:${p.month}`;
    const todo = pairs.filter((p) => !this.listedAddr.has(key(p)));
    const r = await this.mc(todo.map((p) => ({ address: this.factory, abi: agateFactoryAbi as Abi, functionName: "seriesOf", args: [p.gpuId, p.month] })));
    todo.forEach((p, i) => this.keepListed(p.gpuId, p.month, r[i]!));
    return pairs.map((p) => this.listedAddr.get(key(p)) ?? null);
  }

  private keepListed(gpuId: string, month: number, r: Res): void {
    if (r.ok && (r.value as string).toLowerCase() !== ZERO_ADDRESS) this.listedAddr.set(`${gpuId.toLowerCase()}:${month}`, r.value as Address);
  }

  /** Every listed series' live state: market, k and S after a sync, token supply, next position id, the book. A series
   *  of a GPU the client does not know (a label outside the six) is left out. One round once the series' terms and
   *  market are known: the market is read every time (it can be replaced) and the last one's book beside it; a second
   *  round only for a series seen first (its name, symbol and supply) or a market that changed (its book). */
  async seriesLive(addrs: Address[]): Promise<SeriesLive[]> {
    const gpus = await this.marketGpus();
    const S = agateSeriesAbi as Abi;
    const T = agateTokenAbi as Abi;
    const K = kuruOrderBookAbi as Abi;
    const plan = addrs.map((a) => ({ a, t: this.termsOf.get(a.toLowerCase()) ?? null, m: this.lastMarket.get(a.toLowerCase()) ?? null }));
    const callsA: Call[] = [];
    const at = plan.map((p) => {
      const push = (c: Call) => callsA.push(c) - 1;
      const i = { mk: -1, pv: -1, st: -1, terms: -1, token: -1, ts: -1, book: -1 };
      i.mk = push({ address: this.factory, abi: agateFactoryAbi as Abi, functionName: "marketOf", args: [p.a] });
      i.pv = push({ address: p.a, abi: S, functionName: "previewSync" });
      i.st = push({ address: p.a, abi: S, functionName: "state" });
      if (p.t) i.ts = push({ address: p.t.token, abi: T, functionName: "totalSupply" });
      else {
        i.terms = push({ address: p.a, abi: S, functionName: "terms" });
        i.token = push({ address: p.a, abi: S, functionName: "token" });
      }
      if (p.m) i.book = push({ address: p.m, abi: K, functionName: "getL2Book" });
      return i;
    });
    const ra = await this.mc(callsA);
    const callsB: Call[] = [];
    const markets: (Address | null)[] = [];
    const bt = plan.map((p, j) => {
      const push = (c: Call) => callsB.push(c) - 1;
      const i = at[j]!;
      const b = { name: -1, symbol: -1, ts: -1, book: -1 };
      if (!p.t) {
        if (!ra[i.terms]!.ok || !ra[i.token]!.ok) throw new ReadError(`${p.a} is not a series`);
        const token = okValue(ra[i.token]!) as Address;
        b.name = push({ address: token, abi: T, functionName: "name" });
        b.symbol = push({ address: token, abi: T, functionName: "symbol" });
        b.ts = push({ address: token, abi: T, functionName: "totalSupply" });
      }
      const mk = ra[i.mk]!;
      const [market, venue] = mk.ok ? (mk.value as readonly [Address, number]) : [ZERO_ADDRESS as Address, 0];
      const usable = Number(venue) === 1 && market.toLowerCase() !== ZERO_ADDRESS ? market : null;
      markets.push(usable);
      if (usable && !(p.m && p.m.toLowerCase() === usable.toLowerCase())) b.book = push({ address: usable, abi: K, functionName: "getL2Book" });
      return b;
    });
    const rb = await this.mc(callsB);
    const live: SeriesLive[] = [];
    plan.forEach((p, j) => {
      const i = at[j]!;
      const b = bt[j]!;
      const t = p.t ?? this.keepTerms(p.a, okValue(ra[i.terms]!), okValue(ra[i.token]!) as Address, rb[b.name]!, rb[b.symbol]!);
      const market = markets[j]!;
      if (market) this.lastMarket.set(p.a.toLowerCase(), market);
      else this.lastMarket.delete(p.a.toLowerCase());
      if (!gpus.has(t.gpuId.toLowerCase())) return;
      const pv = ra[i.pv]!;
      const st = ra[i.st]!;
      const ts = p.t ? ra[i.ts]! : rb[b.ts]!;
      const bk = market ? (b.book >= 0 ? rb[b.book]! : ra[i.book]!) : null;
      const [k, sum] = pv.ok ? (pv.value as readonly [number, bigint]) : [0, 0n];
      const state = st.ok ? (st.value as readonly unknown[]) : [];
      live.push({
        gpu: gpus.get(t.gpuId.toLowerCase())!,
        terms: t,
        market,
        k: Number(k),
        S: BigInt(sum),
        tokenSupply: ts.ok ? BigInt(ts.value as bigint) : 0n,
        nextId: state.length > 6 ? BigInt(state[6] as bigint) : 1n,
        book: bk?.ok ? decodeL2Book(bk.value as Hex) : null,
      });
    });
    return live;
  }

  /** Series shapes for one GPU's months (listed ones live, others upcoming with their expected listing time). Two
   *  rounds once the months are listed and seen; `books` (optional) collects each listed month's book by
   *  "GPU YYYY-MM", as book() reads it. */
  async seriesFor(gpu: Gpu, months: number[], now: bigint, books?: Record<string, Book>): Promise<Series[]> {
    const gpus = await this.marketGpus();
    const gpuId = [...gpus.entries()].find(([, g]) => g === gpu)?.[0];
    if (!gpuId) return [];
    const F = agateFactoryAbi as Abi;
    const A = agateIndexAbi as Abi;
    const clocksP = early(this.clocks());
    // one round for the months not seen listed: where their series is, their listing preview, and the GPU's first
    // record day and registration (an upcoming month's expected listing time needs them)
    const open = months.filter((m) => !this.listedAddr.has(`${gpuId}:${m}`));
    const r = await this.mc(open.length === 0 ? [] : [
      ...open.flatMap((m) => [
        { address: this.factory, abi: F, functionName: "seriesOf", args: [gpuId, m] },
        { address: this.factory, abi: F, functionName: "previewListing", args: [gpuId, m] },
      ]),
      { address: this.index, abi: A, functionName: "firstRecordDay", args: [gpuId] },
      { address: this.index, abi: A, functionName: "gpu", args: [gpuId] },
    ]);
    open.forEach((m, i) => this.keepListed(gpuId, m, r[2 * i]!));
    const fr = r[2 * open.length];
    const g = r[2 * open.length + 1];
    const addrs = months.map((m) => this.listedAddr.get(`${gpuId}:${m}`) ?? null);
    const listed = addrs.filter((a): a is Address => a !== null);
    // an unlisted month lists later unless the index starts after it or it is outside the factory's two-month window
    // (IndexStartsAfterMonth; before the first record previewListing says NotReady, so the GPU's firstDay decides);
    // when its preview fails it lists once the record its band needs is final (RULE: the five days before the 1st of
    // the month before; SEEDED, an index younger than that: its first record), read beside the live state
    const upcoming: { m: number; anchor: number | null }[] = [];
    for (let i = 0; i < months.length; i++) {
      if (addrs[i]) continue;
      const m = months[i]!;
      const pv = r[2 * open.indexOf(m) + 1]!;
      if (!pv.ok && (pv.error === "IndexStartsAfterMonth" || pv.error === "MonthNotOpen" || pv.error === "UnknownGpu")) continue;
      if (!pv.ok && (g?.ok ? Number((g.value as { firstDay: number }).firstDay) : await this.gpuFirstDay(gpuId as Hex)) > firstDayOf(m)) continue;
      if (pv.ok) {
        upcoming.push({ m, anchor: null });
        continue;
      }
      if (!g!.ok) throw new ReadError(`gpu(${gpu}) reverted: ${g!.error}`);
      const first = fr!.ok && (fr!.value as readonly [boolean, number])[0] ? Number((fr!.value as readonly [boolean, number])[1]) : Number((g!.value as { firstDay: number }).firstDay);
      const a = firstDayOf(m - 1);
      upcoming.push({ m, anchor: first + 5 <= a ? a - 1 : first });
    }
    const anchored = upcoming.filter((u) => u.anchor !== null);
    const [live, extra, recs] = await Promise.all([
      this.seriesLive(listed),
      this.seriesExtras(listed),
      this.mc(anchored.map((u) => ({ address: this.index, abi: A, functionName: "record", args: [gpuId, u.anchor] }))),
    ]);
    const c = upcoming.length > 0 ? await clocksP : null;
    const out: Series[] = [];
    for (let i = 0; i < months.length; i++) {
      const a = addrs[i];
      const m = months[i]!;
      if (a) {
        const l = live.find((x) => x.terms.series.toLowerCase() === a.toLowerCase());
        if (!l) continue;
        out.push(this.seriesShape(l, now, extra));
        if (books && l.market) books[`${gpu} ${monthLabel(m)}`] = l.book ? toBook(l.book) : { asks: [], bids: [], spread: 0 };
        continue;
      }
      const u = upcoming.find((x) => x.m === m);
      if (!u) continue;
      let opensOn = iso(now);
      if (u.anchor !== null) {
        const rr = recs[anchored.indexOf(u)]!;
        const rec = rr.ok ? this.recordOf(rr.value) : null;
        opensOn = iso(rec?.isFinal ? now : expectedFinal(c!, u.anchor, rec, now));
      }
      out.push(this.upcomingShape(gpu, m, c!, opensOn));
    }
    return out;
  }

  /** What the indexer adds to series: listing time, long q in positions, the last trade. */
  async seriesExtras(addrs: Address[]): Promise<Map<string, { listedAt: string; qLong: bigint; lastPrice: bigint | null; lastAt: bigint | null }>> {
    const out = new Map<string, { listedAt: string; qLong: bigint; lastPrice: bigint | null; lastAt: bigint | null }>();
    if (addrs.length === 0) return out;
    const ids = addrs.map((a) => a.toLowerCase());
    const [s, p] = await Promise.all([
      this.gql_<{ Series: SeriesRow[] }>(Q.series, { ids }),
      this.gql_<{ PricePoint: { id: string; lastTradePriceU: string | null; lastTradeAt: string | null }[] }>(Q.lastTrades, { series: ids }),
    ]);
    for (const id of ids) {
      const sr = s?.Series.find((x) => x.id === id);
      const pp = p?.PricePoint.find((x) => x.id === id);
      out.set(id, {
        listedAt: sr ? iso(BigInt(sr.listedAt)) : "",
        qLong: sr ? BigInt(sr.qInPositionsLong) : 0n,
        lastPrice: pp?.lastTradePriceU ? BigInt(pp.lastTradePriceU) : null,
        lastAt: pp?.lastTradeAt ? BigInt(pp.lastTradeAt) : null,
      });
    }
    return out;
  }

  seriesShape(l: SeriesLive, now: bigint, extra: Map<string, { listedAt: string; qLong: bigint; lastPrice: bigint | null; lastAt: bigint | null }>): Series {
    const t = l.terms;
    const x = extra.get(t.series.toLowerCase());
    const endTs = t.startTs + BigInt(t.n) * BigInt(t.day);
    const phase: Series["phase"] = l.k >= t.n ? "settled" : now < t.startTs ? "trading" : "paying";
    return {
      gpu: l.gpu,
      month: monthLabel(t.month),
      name: t.name,
      symbol: t.symbol,
      n: t.n,
      floor: toNumber6(t.floor),
      cap: toNumber6(t.cap),
      phase,
      k: l.k,
      S: toNumber6(l.S),
      quote: l.market ? quoteOf(l.book, x?.lastPrice ?? null, x?.lastAt ?? null) : null,
      openInterest: toNumber6(l.tokenSupply + (x?.qLong ?? 0n)),
      listedAt: x?.listedAt ?? "",
      closesAt: iso(endTs),
      startsAt: iso(t.startTs),
      address: t.series.toLowerCase(),
      token: t.token.toLowerCase(),
      market: l.market ? l.market.toLowerCase() : null,
    };
  }

  /** An unlisted month's shape: its name and symbol as the factory will write them, N, and `opensOn`, when it is
   *  expected to list. */
  private upcomingShape(gpu: Gpu, m: number, c: IndexClocks, opensOn: string): Series {
    const tag = this.f.tag;
    const mon = monthShort(m);
    const y = Math.floor(m / 12);
    const name = `agate ${gpu} ${mon} ${y}${tag ? ` ${tag}` : ""}`;
    const symbol = `${tag ? tag[0] : ""}${gpu}-${mon.toUpperCase()}${String(y % 100).padStart(2, "0")}`;
    const startDay = firstDayOf(m);
    const n = daysIn(m);
    const startTs = dayStart(c, startDay);
    return {
      gpu,
      month: monthLabel(m),
      name,
      symbol,
      n,
      floor: 0,
      cap: 0,
      phase: "upcoming",
      opensOn,
      k: 0,
      S: 0,
      quote: null,
      openInterest: 0,
      listedAt: "",
      closesAt: iso(startTs + BigInt(n) * BigInt(c.day)),
      startsAt: iso(startTs),
      address: ZERO_ADDRESS,
      token: ZERO_ADDRESS,
      market: null,
    };
  }

  /** The first day the index can record for a GPU (registered, never changes). */
  gpuFirstDay(gpuId: Hex): Promise<number> {
    return this.once(`firstDay:${gpuId.toLowerCase()}`, async () => Number((await this.must<{ firstDay: number }>({ address: this.index, abi: agateIndexAbi as Abi, functionName: "gpu", args: [gpuId] })).firstDay));
  }

  /** The factory's current month (the index's calendar). */
  currentMonth(): Promise<number> {
    return this.must<number>({ address: this.factory, abi: agateFactoryAbi as Abi, functionName: "currentMonth" }).then(Number);
  }

  // ------------------------------------------------------------------ public reads

  /** The six GPUs (index price, sources, history; the two open months of the market GPUs): from the snapshot when one
   *  is configured and fresh, else read here. */
  async getMarkets(): Promise<Market[]> {
    const s = await this.snapshot();
    return s ? s.markets : this.markets(GPUS);
  }

  async getMarket(gpu: Gpu): Promise<Market> {
    if (!GPUS.includes(gpu)) throw new ReadError(`unknown GPU ${gpu}`);
    const hit = (await this.snapshot())?.markets.find((m) => m.gpu === gpu);
    return hit ?? (await this.markets([gpu]))[0]!;
  }

  /** getMarkets read here (never from a snapshot) with the book of every listed month that has a market, keyed
   *  "GPU YYYY-MM": what agate's server serves as the markets snapshot. */
  async marketsAndBooks(): Promise<{ markets: Market[]; books: Record<string, Book> }> {
    const books: Record<string, Book> = {};
    const markets = await this.markets(GPUS, books);
    return { markets, books };
  }

  private async markets(gpus: Gpu[], books?: Record<string, Book>): Promise<Market[]> {
    // what needs nothing else starts at once: the index state of every GPU (two rounds), the indexer's history, chain
    // time, the clocks, the current month and the factory's GPUs; the months of the market GPUs follow the current
    // month, beside the index's sources (four rounds the first time, three after)
    const viewsP = early(this.gpuViews(gpus));
    const rowsP = early(this.historyRows(gpus.map((g) => this.panelOf(g).gpuId)));
    const [now, c, cur, mg] = await Promise.all([this.chainTimeCached(), this.clocks(), this.currentMonth(), this.marketGpus()]);
    const tradable = new Set(mg.values());
    const seriesP = early(Promise.all(gpus.map((g) => (tradable.has(g) ? this.seriesFor(g, [cur, cur + 1], now, books) : Promise.resolve([] as Series[])))));
    const views = await viewsP;
    const [src, hist] = await Promise.all([this.sourcesFor(views, c), this.history(views, now, rowsP)]);
    const series = await seriesP;
    return views.map((v, i) => {
      const nextDay = v.latest ? v.latest.day + 1 : v.firstDay;
      const s = src.get(v.gpu)!;
      return {
        gpu: v.gpu,
        price: v.latest ? toNumber6(v.latest.rec.value) : 0,
        prevPrice: v.prev ? toNumber6(v.prev.rec.value) : v.latest ? toNumber6(v.latest.rec.value) : 0,
        updatedAt: v.latest ? iso(v.latest.rec.finalAt) : "",
        sources: s.sources,
        history: hist.get(v.gpu) ?? [],
        prelaunch: this.prelaunchOf(v),
        series: series[i]!,
        nextUpdateAt: iso(expectedFinal(c, nextDay, v.next, now)),
        nextCloseAt: iso(expectedClose(c, nextDay, v.next, now)),
        liveCount: s.liveCount,
        panelSize: v.nSlots,
        panel: s.panel,
        priceDate: v.latest ? dateOfDay(v.latest.day) : null,
        tradable: tradable.has(v.gpu),
      };
    });
  }

  /** Every series of the factory from the index's first month to next month, listed or upcoming. */
  async getSeries(gpu?: Gpu): Promise<Series[]> {
    if (gpu !== undefined && !(GPUS as readonly string[]).includes(gpu)) throw new ReadError(`unknown GPU "${gpu}"`);
    const [now, cur, mg] = await Promise.all([this.chainTimeCached(), this.currentMonth(), this.marketGpus()]);
    const firstDay = Math.min(...(await Promise.all([...mg.keys()].map((id) => this.gpuFirstDay(id as Hex)))));
    const months: number[] = [];
    for (let m = monthOfDay(firstDay); m <= cur + 1; m++) months.push(m);
    const gs = [...mg.values()].filter((g) => !gpu || g === gpu);
    return (await Promise.all(gs.map((g) => this.seriesFor(g, months, now)))).flat();
  }

  /** A listed series by GPU and "YYYY-MM"; throws ReadError when it is not listed (the writes need one): "price only"
   *  for a GPU the factory has no market for (B300, A100, L40S never list), "not listed" for a month not listed (yet). */
  async seriesAt(gpu: Gpu, month: string): Promise<SeriesLive> {
    const s = await this.listedAt(gpu, month);
    if (!s) {
      const tradable = new Set((await this.marketGpus()).values());
      if (!tradable.has(gpu)) throw new ReadError(`${gpu} is price only: it has an index price and no market, so it has no month to trade`);
      throw new ReadError(`${gpu} ${month} is not listed`);
    }
    return s;
  }

  /** A listed series by GPU and "YYYY-MM", or null when the month is not listed (yet) or the GPU has no market (the
   *  price-only GPUs). An unknown GPU is a ReadError, a month not written YYYY-MM an AmountError. */
  async listedAt(gpu: Gpu, month: string): Promise<SeriesLive | null> {
    const a = await this.listedAddress(gpu, month);
    if (!a) return null;
    return (await this.seriesLive([a]))[0] ?? null;
  }

  /** The series address of a listed month, or null (as listedAt, without its live state). */
  private async listedAddress(gpu: Gpu, month: string): Promise<Address | null> {
    if (!GPUS.includes(gpu)) throw new ReadError(`unknown GPU ${gpu}`);
    const m = monthOfLabel(month);
    const mg = await this.marketGpus();
    const gpuId = [...mg.entries()].find(([, g]) => g === gpu)?.[0];
    if (!gpuId) return null;
    const [a] = await this.seriesAddresses([{ gpuId, month: m }]);
    return a ?? null;
  }

  /** The Kuru book of one month: the real levels, sizes in GPU-hours. Empty when the month is not listed (an
   *  upcoming month, a price-only GPU) or the series has no market. */
  async book(gpu: Gpu, month: string): Promise<Book> {
    const hit = (await this.snapshot())?.books[`${gpu} ${month}`];
    if (hit) return hit;
    const s = await this.listedAt(gpu, month);
    return s?.book ? toBook(s.book) : { asks: [], bids: [], spread: 0 };
  }

  /** Recent fills of one month, newest first by block and log index (indexer; [] without it, and for a month not
   *  listed). */
  async recentFills(gpu: Gpu, month: string, limit = 50): Promise<Fill[]> {
    const a = await this.listedAddress(gpu, month);
    if (!a) return [];
    const series = a.toLowerCase();
    const r = await this.gql_<{ Trade: TradeRow[] }>(Q.trades, { series, limit, offset: 0, desc: "desc" });
    const rows = r ? await this.exactPage(series, r.Trade, limit, limit, "desc") : null;
    return rows ? rows.map(fillOf) : [];
  }

  /** Hourly candles of one month from its first trade's hour to the current hour; an hour without trades repeats the
   *  last close with volume 0. [] before the first trade, without the indexer, and for a month not listed. The hours
   *  between the listing and the first trade have no candle: no price was traded then (README). */
  async candles(gpu: Gpu, month: string): Promise<Candle[]> {
    const a = await this.listedAddress(gpu, month);
    if (!a) return [];
    const trades = await this.allTrades(a, 0n);
    if (trades === null) return [];
    return hourlyCandles(trades, await this.chainTimeCached());
  }

  /** A month's price 24 h before `now`: its last trade before then; when it traded only since, its first trade in the
   *  window; null when it never traded (or without the indexer). */
  async priceBefore(series: Address, now: bigint): Promise<bigint | null> {
    const s = series.toLowerCase();
    const cut = now - 86_400n;
    const before = await this.gql_<{ Trade: TradeRow[] }>(Q.tradesBefore, { series: s, before: cut.toString(), limit: TRADE_PAGE });
    const last = before ? await this.exactPage(s, before.Trade, TRADE_PAGE, 1, "desc") : null;
    if (!last) return null;
    if (last[0]) return BigInt(last[0].priceU);
    const since = await this.gql_<{ Trade: TradeRow[] }>(Q.tradesSince, { series: s, since: cut.toString(), limit: TRADE_PAGE, offset: 0 });
    const first = since ? await this.exactPage(s, since.Trade, TRADE_PAGE, 1, "asc") : null;
    return first?.[0] ? BigInt(first[0].priceU) : null;
  }

  /** The first `want` rows of one page of a series' trades, by (block, log index) in `dir`. The indexer breaks ties
   *  inside a block by the text id ("B-9" after "B-12"), so a full page (`page` rows) may hold the wrong rows of the
   *  block it ends in: when that block holds any of the wanted rows, it is read whole first. Null when that read fails. */
  private async exactPage(series: string, rows: TradeRow[], page: number, want: number, dir: "asc" | "desc"): Promise<TradeRow[] | null> {
    let all = rows;
    if (rows.length > 0 && rows.length >= page) {
      // the block the page ends in: the oldest in a newest-first page, the newest in an oldest-first one
      const edge = rows.map((t) => BigInt(t.block)).reduce((e, b) => ((dir === "desc" ? b < e : b > e) ? b : e));
      const whole = rows.filter((t) => BigInt(t.block) !== edge);
      if (whole.length < want) {
        const block = await this.blockTrades(series, edge);
        if (!block) return null;
        all = [...whole, ...block];
      }
    }
    return sortTrades(all, dir).slice(0, Math.max(0, want));
  }

  /** Every trade of one block of a series. */
  private async blockTrades(series: string, block: bigint): Promise<TradeRow[] | null> {
    const out: TradeRow[] = [];
    for (let offset = 0; offset < 100_000; offset += 1000) {
      const r = await this.gql_<{ Trade: TradeRow[] }>(Q.tradesInBlock, { series, block: block.toString(), limit: 1000, offset });
      if (!r) return null;
      out.push(...r.Trade);
      if (r.Trade.length < 1000) break;
    }
    return out;
  }

  private async allTrades(series: Address, since: bigint): Promise<TradeRow[] | null> {
    const out: TradeRow[] = [];
    for (let offset = 0; offset < 100_000; offset += 1000) {
      const r = await this.gql_<{ Trade: TradeRow[] }>(Q.tradesSince, { series: series.toLowerCase(), since: since.toString(), limit: 1000, offset });
      if (!r) {
        if (offset === 0) return null;
        break;
      }
      out.push(...r.Trade);
      if (r.Trade.length < 1000) break;
    }
    // each trade once (the pages are ordered by a unique key, so this only guards a candle's volume)
    const seen = new Set<string>();
    return sortTrades(out.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true))), "asc");
  }

  /** The strip: each GPU's index price against the final day before, then each listed month's last price against its
   *  price 24 h earlier (the last trade before then; the first trade since when it is younger; 0 % before any trade or
   *  without the indexer). */
  async ticker(): Promise<TickerItem[]> {
    const ms = await this.getMarkets();
    const now = await this.chainTimeCached();
    const out: TickerItem[] = [];
    for (const m of ms) if (m.priceDate) out.push({ label: m.gpu, price: m.price, change: pct(m.price, m.prevPrice) });
    const months = ms.flatMap((m) => m.series.filter((s) => s.quote && s.phase !== "upcoming"));
    const before = await Promise.all(months.map((s) => (s.quote!.lastAt === null ? Promise.resolve(null) : this.priceBefore(s.address as Address, now))));
    months.forEach((s, i) => {
      const b = before[i];
      out.push({ label: `${s.gpu} ${monthShort(monthOfLabel(s.month))}`, price: s.quote!.last, change: b === null || b === undefined ? 0 : pct(s.quote!.last, toNumber6(b)) });
    });
    return out;
  }

  // ------------------------------------------------------------------ the markets snapshot

  /** The configured markets snapshot while it answers and is fresh, shared by the reads of SNAPSHOT_SHARE_MS; null
   *  (the reads go to the chain and the indexer) when none is set, it fails, is late, or is of another chain or index.
   *  A failed snapshot rests SNAPSHOT_REST_MS before it is asked again. */
  private snapshot(): Promise<MarketsSnapshot | null> {
    if (!this.snapUrl) return Promise.resolve(null);
    const t = Date.now();
    if (this.snap && t < this.snap.until) return this.snap.p;
    const url = this.snapUrl;
    const p = (async () => {
      try {
        const r = await this.fetchFn(url, { signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) });
        return r.ok ? snapshotOf(await r.json(), this.chain.id, this.index) : null;
      } catch {
        return null;
      }
    })();
    this.snap = { until: t + SNAPSHOT_SHARE_MS, p };
    p.then((s) => {
      if (!s && this.snap?.p === p) this.snap = { until: Date.now() + SNAPSHOT_REST_MS, p };
    });
    return p;
  }

  // ------------------------------------------------------------------ the wallet

  /** Every listed series of the factory (the wallet's search space), live. */
  async listedSeries(): Promise<SeriesLive[]> {
    const [cur, mg] = await Promise.all([this.currentMonth(), this.marketGpus()]);
    const pairs: { gpuId: string; month: number }[] = [];
    for (const id of mg.keys()) for (let m = monthOfDay(await this.gpuFirstDay(id as Hex)); m <= cur + 1; m++) pairs.push({ gpuId: id, month: m });
    const addrs = (await this.seriesAddresses(pairs)).filter((a): a is Address => a !== null);
    return this.seriesLive(addrs);
  }

  async getWallet(address: string): Promise<Wallet> {
    const who = address as Address;
    const [now, mon, listed] = await Promise.all([this.chainTimeCached(), this.pub.getBalance({ address: who }), this.listedSeries()]);
    const D = agateDollarAbi as Abi;
    const S = agateSeriesAbi as Abi;
    const head = await this.mc([
      { address: this.dollar, abi: D, functionName: "balanceOf", args: [who] },
      { address: this.dollar, abi: D, functionName: "nextDripAt", args: [who] },
      { address: this.dollar, abi: D, functionName: "dripPeriod" },
      { address: this.marginAccount, abi: kuruMarginAccountAbi as Abi, functionName: "getBalance", args: [who, this.dollar] },
      ...listed.flatMap((l) => [
        { address: l.terms.token, abi: agateTokenAbi as Abi, functionName: "balanceOf", args: [who] },
        { address: l.terms.series, abi: S, functionName: "shortOf", args: [who] },
        { address: this.marginAccount, abi: kuruMarginAccountAbi as Abi, functionName: "getBalance", args: [who, l.terms.token] },
      ]),
    ]);
    const val = (i: number) => (head[i]!.ok ? BigInt(head[i]!.value as bigint) : 0n);
    const balance = val(0);
    const nextAt = val(1);
    const period = val(2);
    const margin = val(3);

    // the indexer: the newest position id it holds per series, then the user's open positions (ids and open times),
    // router flows and trades (entry prices), every page. The newest ids are read first: a position the indexer takes
    // in between the two reads is then in the rows, or above those ids and scanned on chain, never in neither.
    const newest = await this.newestPositionIds(listed.map((l) => l.terms.series));
    const ix = newest ? await this.walletRows(who.toLowerCase()) : null;
    // the indexer's open positions of the user, plus every id above its newest (ids are sequential per series, so a
    // position opened a moment ago is never missed), each once; without the indexer every id of every listed series is
    // scanned (one multicall per 400 ids)
    const candidates: { l: SeriesLive; id: bigint; openedAt: string }[] = [];
    for (const l of listed) {
      const sid = l.terms.series.toLowerCase();
      const known = ix ? newest?.get(sid) : undefined;
      const have = new Set<bigint>();
      if (known !== undefined) {
        for (const p of ix!.Position) {
          const id = BigInt(p.positionId);
          if (p.series_id !== sid || have.has(id)) continue;
          have.add(id);
          candidates.push({ l, id, openedAt: iso(BigInt(p.openedAt)) });
        }
      }
      for (let id = (known ?? 0n) + 1n; id < l.nextId; id++) if (!have.has(id)) candidates.push({ l, id, openedAt: "" });
    }
    const pr = await this.mc(candidates.flatMap((c) => [
      { address: c.l.terms.series, abi: S, functionName: "position", args: [c.id] },
      { address: c.l.terms.series, abi: S, functionName: "claimable", args: [c.id] },
    ]));
    const positions: Position[] = [];
    const trades = ix?.Trade ?? [];
    const flows = ix?.RouterFlow ?? [];
    candidates.forEach((c, i) => {
      const p = pr[2 * i]!;
      const cl = pr[2 * i + 1]!;
      if (!p.ok) return;
      const x = p.value as { owner: Address; side: number; daily: boolean; payee: Address; q: bigint; paid: bigint };
      if (x.owner.toLowerCase() !== who.toLowerCase()) return;
      const t = c.l.terms;
      const side = Number(x.side) === 0 ? "long" : "short";
      const flow = flows.find((f) => f.series_id === t.series.toLowerCase() && f.positionIds.map(String).includes(c.id.toString()));
      // a pay-me-daily long's entry is its own flow's buy (exact, per user: a smart account's bundle can carry other
      // users' trades); a short's is the router's sale in that transaction (its flow's dollarsOut also holds what the
      // new positions were paid at once, so the sale is read from the trades the router took there)
      const entry = !flow
        ? 0
        : flow.flow === "OPEN_LONG_DAILY"
          ? flowPrice([flow])
          : vwap(trades.filter((tr) => !!tr.txHash && tr.txHash.toLowerCase() === flow.txHash?.toLowerCase() && (tr.series_id ?? "") === t.series.toLowerCase() && tr.taker === this.router.toLowerCase() && !tr.takerIsBuy));
      positions.push({
        id: `${t.series.toLowerCase()}-${c.id}`,
        gpu: c.l.gpu,
        month: monthLabel(t.month),
        side,
        q: toNumber6(BigInt(x.q)),
        entry,
        daily: x.daily,
        paid: toNumber6(BigInt(x.paid)),
        openedAt: c.openedAt,
        kind: "position",
        inMargin: 0,
        series: t.series.toLowerCase(),
        positionId: c.id.toString(),
        claimable: cl.ok ? toNumber6(BigInt(cl.value as bigint)) : 0,
        payee: x.payee.toLowerCase(),
      });
    });
    listed.forEach((l, i) => {
      const t = l.terms;
      const wallet = val(4 + 3 * i);
      const shorts = val(5 + 3 * i);
      // tokens of the user's in Kuru's margin account (a filled limit buy, a cancelled ask) are the user's too
      const inMargin = val(6 + 3 * i);
      const tokens = wallet + inMargin;
      const sid = t.series.toLowerCase();
      const me = who.toLowerCase();
      const mine = trades.filter((tr) => (tr.series_id ?? "") === sid);
      // entry = the average price of how what is still held was acquired. Held tokens come from the user's buyLong
      // (the router's buys in its OPEN_LONG transactions) and from the user's own resting bids that were filled; a
      // pay-me-daily buy (its tokens became positions) or a close-short buy-back (its tokens were burned) never counts.
      // The router's buys are read from the user's OPEN_LONG flows (what Routed reports: dollarsIn - refund for the
      // tokens), never matched by txOrigin: a smart account's transactions come from a bundler, so txOrigin is not the
      // user. A resting bid counts when someone else's order filled it, not a fill inside the user's own transactions.
      const ownTx = new Set(flows.filter((f) => f.txHash).map((f) => f.txHash!.toLowerCase()));
      const fromOwnTx = (tr: TradeRow) => tr.txOrigin === me || (!!tr.txHash && ownTx.has(tr.txHash.toLowerCase()));
      const longFlows = flows.filter((f) => f.series_id === sid && f.flow === "OPEN_LONG" && BigInt(f.tokens) > 0n);
      const bidFills = mine.filter((tr) => tr.maker === me && !tr.takerIsBuy && !fromOwnTx(tr));
      // a short balance comes only from minted pairs whose tokens were sold through the user's own resting asks (a limit
      // short): those fills, never a router sale (a sale of bought tokens, or a short position's sale); 0 when none filled
      const sells = mine.filter((tr) => tr.maker === me && tr.takerIsBuy && !fromOwnTx(tr));
      if (tokens > 0n) {
        const firstAt = [...longFlows.map((f) => BigInt(f.timestamp)), ...bidFills.map((tr) => BigInt(tr.timestamp))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];
        positions.push({ id: `${sid}-long`, gpu: l.gpu, month: monthLabel(t.month), side: "long", q: toNumber6(tokens), entry: blendedPrice(longFlows, bidFills), daily: false, paid: 0, openedAt: firstAt !== undefined ? iso(firstAt) : "", kind: "tokens", series: sid, positionId: null, claimable: 0, payee: null, inMargin: toNumber6(inMargin) });
      }
      if (shorts > 0n) {
        positions.push({ id: `${sid}-short`, gpu: l.gpu, month: monthLabel(t.month), side: "short", q: toNumber6(shorts), entry: vwap(sells), daily: false, paid: 0, openedAt: "", kind: "shortBalance", series: sid, positionId: null, claimable: 0, payee: null, inMargin: 0 });
      }
    });
    return {
      signedIn: true,
      email: null,
      balance: toNumber6(balance),
      lastDrip: nextAt > 0n ? iso(nextAt - period) : null,
      positions,
      address: who.toLowerCase(),
      nextDrip: nextAt > 0n ? iso(nextAt) : null,
      canDrip: now >= nextAt,
      marginBalance: toNumber6(margin),
      mon: Number(mon / 10n ** 12n) / 1e6,
    };
  }

  /** A wallet's rows in the indexer, every page of each (oldest first, each row once): its open positions, its router
   *  flows and its trades (as the transaction's origin or as the maker). Null without the indexer, or when a page
   *  fails: the wallet then reads the chain alone, as documented, rather than entries from a partial list. */
  private async walletRows(a: string): Promise<{ Position: PositionRow[]; RouterFlow: FlowRow[]; Trade: TradeRow[] } | null> {
    const first = await this.gql_<{ Position: PositionRow[]; RouterFlow: FlowRow[]; Trade: TradeRow[] }>(Q.wallet, { a, limit: WALLET_PAGE });
    if (!first) return null;
    const rest = async <T extends { id?: string }>(rows: T[], q: string, key: string): Promise<T[] | null> => {
      const out = [...rows];
      let last = rows.length;
      while (last === WALLET_PAGE && out.length < WALLET_MAX) {
        const r = await this.gql_<Record<string, T[]>>(q, { a, limit: WALLET_PAGE, offset: out.length });
        if (!r) return null;
        const page = r[key] ?? [];
        out.push(...page);
        last = page.length;
      }
      const seen = new Set<string>();
      return out.filter((x) => (x.id === undefined ? true : seen.has(x.id) ? false : (seen.add(x.id), true)));
    };
    const [Position, RouterFlow, Trade] = await Promise.all([rest(first.Position ?? [], Q.morePositions, "Position"), rest(first.RouterFlow ?? [], Q.moreFlows, "RouterFlow"), rest(first.Trade ?? [], Q.moreTrades, "Trade")]);
    if (!Position || !RouterFlow || !Trade) return null;
    // a short's entry is the router's sale in its OPEN_SHORT transaction, read by those transactions (100 a query)
    const shortTx = [...new Set(RouterFlow.filter((f) => f.flow === "OPEN_SHORT" && f.txHash).map((f) => f.txHash!.toLowerCase()))];
    const have = new Set(Trade.map((t) => t.id));
    for (let i = 0; i < shortTx.length; i += 100) {
      const r = await this.gql_<{ Trade: TradeRow[] }>(Q.tradesByTx, { h: shortTx.slice(i, i + 100), router: this.router.toLowerCase(), limit: WALLET_PAGE });
      if (!r) return null;
      for (const t of r.Trade ?? []) {
        if (have.has(t.id)) continue;
        have.add(t.id);
        Trade.push(t);
      }
    }
    return { Position, RouterFlow, Trade };
  }

  /** The newest position id the indexer holds per series (0 when it holds none); null without the indexer (an empty
   *  map for no series). */
  private async newestPositionIds(series: Address[]): Promise<Map<string, bigint> | null> {
    if (series.length === 0) return new Map();
    const q = `query { ${series.map((s, i) => `s${i}: Position(where: {series_id: {_eq: "${s.toLowerCase()}"}}, order_by: {positionId: desc}, limit: 1) { positionId }`).join(" ")} }`;
    const r = await this.gql_<Record<string, { positionId: string }[]>>(q, {});
    if (!r) return null;
    return new Map(series.map((s, i) => [s.toLowerCase(), BigInt(r[`s${i}`]?.[0]?.positionId ?? 0)]));
  }

  /** The user's resting Kuru orders (the order ticket's OpenOrder[]); openOrdersResult says where they came from and
   *  whether the list is complete. */
  async openOrders(address: string): Promise<OpenOrder[]> {
    return (await this.openOrdersResult(address)).orders;
  }

  /** The user's resting Kuru orders: the indexer's candidates (every page) plus every order id above the newest the
   *  indexer has seen per book (an order placed a moment ago is never missed; the newest ids are read before the
   *  user's orders, so an order indexed in between is in one of the two), each checked on chain by Kuru's own status
   *  rule (BOTS-SPEC 3.6). Without the indexer: the newest SCAN_ORDERS ids of each listed book, from the chain.
   *  `complete` is false when a book holds older ids than the scan reached (without the indexer the market maker's
   *  requotes create ids continuously, so an older resting order of the user's may be missing: say "may be
   *  incomplete"), and when the indexer holds more of the user's orders than WALLET_MAX. */
  async openOrdersResult(address: string): Promise<{ orders: OpenOrder[]; complete: boolean; source: "indexer" | "chain" }> {
    const who = address.toLowerCase();
    const listed = await this.listedSeries();
    const byMarket = new Map(listed.filter((l) => l.market).map((l) => [l.market!.toLowerCase(), l]));
    const markets = [...byMarket.keys()];
    const cands: { market: Address; id: bigint; createdAt: bigint | null; size: bigint | null }[] = [];
    const seen = new Set<string>();
    const add = (c: { market: Address; id: bigint; createdAt: bigint | null; size: bigint | null }) => {
      const k = `${c.market.toLowerCase()}-${c.id}`;
      if (seen.has(k)) return;
      seen.add(k);
      cands.push(c);
    };
    const newest = markets.length ? await this.gql_<Record<string, { orderId: string }[]>>(`query { ${markets.map((m, i) => `m${i}: BookOrder(where: {market_id: {_eq: "${m}"}}, order_by: {orderId: desc}, limit: 1) { orderId }`).join(" ")} }`, {}) : null;
    const r = markets.length === 0 || newest ? await this.walletOrders(who) : null;
    const indexed = !!r && (markets.length === 0 || !!newest);
    if (indexed) for (const o of r!.rows) add({ market: o.market_id as Address, id: BigInt(o.orderId), createdAt: BigInt(o.createdAt), size: BigInt(o.size) });
    const counters = await this.mc(markets.map((m) => ({ address: m as Address, abi: kuruOrderBookAbi as Abi, functionName: "s_orderIdCounter" })));
    let complete = indexed ? r!.complete : true;
    markets.forEach((m, i) => {
      const top = counters[i]!.ok ? BigInt(counters[i]!.value as number) : 0n;
      const from = indexed ? BigInt(newest?.[`m${i}`]?.[0]?.orderId ?? 0) : 0n;
      let low = from;
      if (top - low > SCAN_ORDERS) {
        low = top - SCAN_ORDERS;
        complete = false;
      }
      for (let id = top; id > low; id--) add({ market: m as Address, id, createdAt: null, size: null });
    });
    const st = await this.orderStatus(cands.map((c) => ({ market: c.market, id: c.id })));
    const out: OpenOrder[] = [];
    cands.forEach((c, i) => {
      const s = st[i]!;
      if (!s || s.status !== "ACTIVE" || s.owner.toLowerCase() !== who) return;
      const l = byMarket.get(c.market.toLowerCase());
      if (!l) return;
      const size = c.size ?? s.remaining;
      out.push({
        id: c.id.toString(),
        gpu: l.gpu,
        month: monthLabel(l.terms.month),
        side: s.isBuy ? "long" : "short",
        price: toNumber6(s.price),
        q: unitsToHours(s.remaining),
        placedAt: c.createdAt !== null ? iso(c.createdAt) : "",
        filled: unitsToHours(size > s.remaining ? size - s.remaining : 0n),
        market: c.market.toLowerCase(),
      });
    });
    // newest first, as the indexer lists them
    out.sort((a, b) => (a.placedAt === b.placedAt ? Number(BigInt(b.id) - BigInt(a.id)) : a.placedAt === "" ? -1 : b.placedAt === "" ? 1 : b.placedAt.localeCompare(a.placedAt)));
    return { orders: out, complete, source: indexed ? "indexer" : "chain" };
  }

  /** A wallet's resting orders in the indexer, every page (WALLET_PAGE each, keyset on the id), at most WALLET_MAX
   *  (`complete` false when more remain). Null without the indexer, or when a page fails. */
  private async walletOrders(a: string): Promise<{ rows: OrderRow[]; complete: boolean } | null> {
    const rows: OrderRow[] = [];
    let after = "";
    for (;;) {
      const r = await this.gql_<{ BookOrder: OrderRow[] }>(Q.openOrders, { a, after, limit: WALLET_PAGE });
      if (!r) return null;
      rows.push(...r.BookOrder);
      if (r.BookOrder.length < WALLET_PAGE) return { rows, complete: true };
      if (rows.length >= WALLET_MAX) return { rows, complete: false };
      after = r.BookOrder[r.BookOrder.length - 1]!.id;
    }
  }

  /** Kuru's own order status: price 0 cancelled; price point head 0 or above the id filled; else active with its
   *  size as the remainder. */
  async orderStatus(orders: { market: Address; id: bigint }[]): Promise<({ owner: Address; isBuy: boolean; price: bigint; remaining: bigint; status: "ACTIVE" | "FILLED" | "CANCELED" } | null)[]> {
    const K = kuruOrderBookAbi as Abi;
    const raw = await this.mc(orders.map((o) => ({ address: o.market, abi: K, functionName: "s_orders", args: [Number(o.id)] })));
    const pts = await this.mc(raw.map((r, i) => {
      const o = r.ok ? (r.value as readonly [Address, bigint, number, number, number, number, number, boolean]) : null;
      return { address: orders[i]!.market, abi: K, functionName: o?.[7] ? "s_buyPricePoints" : "s_sellPricePoints", args: [BigInt(o?.[5] ?? 0)] };
    }));
    return raw.map((r, i) => {
      if (!r.ok) return null;
      const o = r.value as readonly [Address, bigint, number, number, number, number, number, boolean];
      const price = BigInt(o[5]);
      const head = pts[i]!.ok ? BigInt((pts[i]!.value as readonly [number, number])[0]) : 0n;
      const id = orders[i]!.id;
      const status = price === 0n ? "CANCELED" : head === 0n || head > id ? "FILLED" : "ACTIVE";
      return { owner: o[0], isBuy: o[7], price, remaining: status === "ACTIVE" ? BigInt(o[1]) : 0n, status };
    });
  }
}

export function createAgateClient(cfg: ClientConfig = {}): AgateClient {
  return new AgateClient(cfg);
}

// ------------------------------------------------------------------ pure helpers (exported for tests)

/** The index's cent rounding: half up to $0.01 (IndexFormula.cent). */
export function cent(v: bigint): bigint {
  return ((v + TICK / 2n) / TICK) * TICK;
}

function dayOf(d: number, rec: RecordView): IndexDay {
  return { date: dateOfDay(d), price: toNumber6(rec.value), status: rec.status === 4 ? "carried" : "final", example: false };
}

/** Quote from the book (bid, ask) and the last trade; before any trade, last is the mid (or the one side). */
export function quoteOf(book: RawBook | null, lastPrice: bigint | null, lastAt: bigint | null): Quote {
  const bid = book?.bids[0]?.[0] ?? 0n;
  const ask = book?.asks[0]?.[0] ?? 0n;
  let last = lastPrice;
  if (last === null) last = bid > 0n && ask > 0n ? (((bid + ask) / 2n) / TICK) * TICK : bid > 0n ? bid : ask;
  return { bid: toNumber6(bid), ask: toNumber6(ask), last: toNumber6(last), lastAt: lastPrice !== null && lastAt !== null ? iso(lastAt) : null };
}

/** Trades sorted by (block, log index) from their "<block>-<logIndex>" ids. */
export function sortTrades(rows: TradeRow[], dir: "asc" | "desc"): TradeRow[] {
  const key = (r: TradeRow) => {
    const [b, l] = r.id.split("-");
    return [BigInt(b ?? r.block), Number(l ?? 0)] as const;
  };
  const s = [...rows].sort((a, b) => {
    const [ba, la] = key(a);
    const [bb, lb] = key(b);
    return ba === bb ? la - lb : ba < bb ? -1 : 1;
  });
  return dir === "asc" ? s : s.reverse();
}

export function fillOf(r: TradeRow): Fill {
  const at = iso(BigInt(r.timestamp));
  return { time: at.slice(11, 16), side: r.takerIsBuy ? "buy" : "sell", price: toNumber6(BigInt(r.priceU)), size: toNumber6(BigInt(r.tokens)), at, txHash: r.txHash ?? "" };
}

/** Volume-weighted price of trade rows, dollars per GPU-hour; 0 for none. */
export function vwap(rows: TradeRow[]): number {
  return blendedPrice([], rows);
}

/** The price per token the user paid in these router buys (OPEN_LONG or OPEN_LONG_DAILY flows): dollarsIn - refund
 *  for `tokens`, in dollars. */
export function flowPrice(flows: FlowRow[]): number {
  return blendedPrice(flows, []);
}

/** The volume-weighted price of router buys (from their flows) and trades together, in dollars per GPU-hour. */
export function blendedPrice(flows: FlowRow[], rows: TradeRow[]): number {
  let n = 0n;
  let q = 0n;
  for (const f of flows) {
    n += (BigInt(f.dollarsIn) - BigInt(f.refund)) * U;
    q += BigInt(f.tokens);
  }
  for (const r of rows) {
    n += BigInt(r.priceU) * BigInt(r.tokens);
    q += BigInt(r.tokens);
  }
  return q === 0n ? 0 : toNumber6(n / q);
}

/** Hourly OHLCV from trades (ascending): from the first trade's hour to the hour of `now`, gaps carry the close. */
export function hourlyCandles(trades: TradeRow[], now: bigint): Candle[] {
  if (trades.length === 0) return [];
  const H = 3600n;
  const out: Candle[] = [];
  let i = 0;
  let h = (BigInt(trades[0]!.timestamp) / H) * H;
  const end = (now / H) * H;
  const lastTradeHour = (BigInt(trades[trades.length - 1]!.timestamp) / H) * H;
  const stop = end > lastTradeHour ? end : lastTradeHour;
  let close = BigInt(trades[0]!.priceU);
  for (; h <= stop; h += H) {
    let o: bigint | null = null;
    let hi = 0n;
    let lo = 0n;
    let v = 0n;
    while (i < trades.length && BigInt(trades[i]!.timestamp) < h + H) {
      const p = BigInt(trades[i]!.priceU);
      if (o === null) {
        o = p;
        hi = p;
        lo = p;
      }
      if (p > hi) hi = p;
      if (p < lo) lo = p;
      v += BigInt(trades[i]!.tokens);
      close = p;
      i++;
    }
    if (o === null) out.push({ t: iso(h), o: toNumber6(close), h: toNumber6(close), l: toNumber6(close), c: toNumber6(close), v: 0 });
    else out.push({ t: iso(h), o: toNumber6(o), h: toNumber6(hi), l: toNumber6(lo), c: toNumber6(close), v: toNumber6(v) });
  }
  return out;
}

function pct(a: number, b: number): number {
  return b === 0 ? 0 : Math.round(((a - b) / b) * 10_000) / 100;
}

// re-exported unit constants the reads use, for callers
export { LOT, SIZE_PER_TOKEN, U };
