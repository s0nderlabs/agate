// BOTS-SPEC 2.5 and 4.1: the payer's incremental, persisted log scan, in the style of the wall's EventIndexer.
// One eth_getLogs per chunk with no address filter and topic0 in the six events the payer needs; a log is kept
// only when its emitter is a known factory, or a series a known factory's SeriesListed registered earlier in
// (block, logIndex) order (anyone can emit the same signatures). events.jsonl plus cursor.json, written atomically,
// deduplicated by "<block 12 digits>:<logIndex 6 digits>", the cursor moved only after the chunk's events are written,
// the tip = the `finalized` block (else latest - 3). A range error halves the chunk down to 10 and successes grow it
// back; a rate limit (HTTP 429, Alchemy's "compute units per second capacity") is a transport error that fails over
// (audit P-M2); chunks of one catch-up are paced. A node that refuses a filter without an address gets two calls per
// chunk (the factories, then the known series). cursor.json carries the chain id, the start block and the factory
// set, so a cursor of another chain or deployment (a fork rehearsal, a testnet reset) restarts the scan from the
// start block into a fresh events file instead of reading as caught up (audit P-M3). FixApplied is not scanned (the
// payer never reads it) and a large events file is compacted at start (audit S-L1).
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { type Abi, type Address, decodeEventLog, type Hex, toEventSelector } from "viem";
import { appendLine, RpcDown, type RpcPool, writeAtomic } from "@agate/watcher";
import { agateFactoryAbi, agateSeriesAbi } from "./abi.ts";

interface Base {
  key: string;
  block: number;
  logIndex: number;
  /** the emitter, lowercase */
  address: Address;
  tx: Hex | null;
}
export type ScanEvent =
  | (Base & { name: "SeriesListed"; series: Address; gpuId: Hex; month: number; token: Address; startDay: number; n: number; startTs: bigint; day: number; lastResort: bigint; floor: bigint; cap: bigint; x0: bigint; bandGrade: number; symbol: string })
  | (Base & { name: "MarketRecorded"; series: Address; market: Address; venue: number; created: boolean; by: Address; previous: Address })
  | (Base & { name: "PositionOpened"; id: bigint; owner: Address; payee: Address; side: number; q: bigint; paidNow: bigint; operator: Address; daily: boolean; k: number; to: Address })
  | (Base & { name: "Claimed"; id: bigint; payee: Address; amount: bigint; paidTotal: bigint; k: number })
  | (Base & { name: "PositionClosed"; id: bigint; owner: Address; kind: number; amount: bigint; to: Address; by: Address })
  | (Base & { name: "PayoutChanged"; id: bigint; payee: Address; daily: boolean })
  | (Base & { name: "FixApplied"; k: number; day: number; x: bigint; c: bigint; status: number; flags: number; sumAfter: bigint });
export type ScanEventName = ScanEvent["name"];

const FACTORY_EVENTS = ["SeriesListed", "MarketRecorded"] as const;
// FixApplied stays decodable (old events files hold it) but is not scanned: the payer never reads it (audit S-L1)
const SERIES_EVENTS = ["PositionOpened", "Claimed", "PositionClosed", "PayoutChanged"] as const;
const DECODED_SERIES_EVENTS = [...SERIES_EVENTS, "FixApplied"] as const;
const BIGINTS: Record<ScanEventName, readonly string[]> = {
  SeriesListed: ["startTs", "lastResort", "floor", "cap", "x0"],
  MarketRecorded: [],
  PositionOpened: ["id", "q", "paidNow"],
  Claimed: ["id", "amount", "paidTotal"],
  PositionClosed: ["id", "amount"],
  PayoutChanged: ["id"],
  FixApplied: ["x", "c", "sumAfter"],
};

function eventItem(abi: Abi, name: string) {
  const it = abi.find((x) => x.type === "event" && x.name === name);
  if (!it) throw new Error(`no event ${name} in the ABI`);
  return it;
}
const EVENTS_ABI = [...(agateFactoryAbi as Abi).filter((x) => x.type === "event" && (FACTORY_EVENTS as readonly string[]).includes(x.name)), ...(agateSeriesAbi as Abi).filter((x) => x.type === "event" && (DECODED_SERIES_EVENTS as readonly string[]).includes(x.name))] as Abi;
export const FACTORY_TOPICS: Hex[] = FACTORY_EVENTS.map((n) => toEventSelector(eventItem(agateFactoryAbi as Abi, n) as never));
export const SERIES_TOPICS: Hex[] = SERIES_EVENTS.map((n) => toEventSelector(eventItem(agateSeriesAbi as Abi, n) as never));
export const SCAN_TOPICS: Hex[] = [...FACTORY_TOPICS, ...SERIES_TOPICS];

export function scanKey(block: number | bigint, logIndex: number): string {
  return `${String(block).padStart(12, "0")}:${String(logIndex).padStart(6, "0")}`;
}

export interface RawLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint | null;
  logIndex: number | null;
  transactionHash: Hex | null;
}

/** Decodes one raw log into a ScanEvent, or null (another event, or malformed). */
export function decodeScanLog(l: RawLog): ScanEvent | null {
  if (l.blockNumber === null || l.logIndex === null) return null;
  let d: { eventName: string; args: Record<string, unknown> };
  try {
    d = decodeEventLog({ abi: EVENTS_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]], strict: true }) as unknown as typeof d;
  } catch {
    return null;
  }
  const a = d.args;
  const base: Base = { key: scanKey(l.blockNumber, l.logIndex), block: Number(l.blockNumber), logIndex: l.logIndex, address: l.address.toLowerCase() as Address, tx: l.transactionHash };
  const A = (x: unknown) => (x as string).toLowerCase() as Address;
  switch (d.eventName) {
    case "SeriesListed":
      return { ...base, name: "SeriesListed", series: A(a.series), gpuId: a.gpuId as Hex, month: Number(a.month), token: A(a.token), startDay: Number(a.startDay), n: Number(a.n), startTs: BigInt(a.startTs as bigint), day: Number(a.day), lastResort: BigInt(a.lastResort as bigint), floor: BigInt(a.floor as number), cap: BigInt(a.cap as number), x0: BigInt(a.x0 as number), bandGrade: Number(a.bandGrade), symbol: String(a.symbol) };
    case "MarketRecorded":
      return { ...base, name: "MarketRecorded", series: A(a.series), market: A(a.market), venue: Number(a.venue), created: Boolean(a.created), by: A(a.by), previous: A(a.previous) };
    case "PositionOpened":
      return { ...base, name: "PositionOpened", id: BigInt(a.id as bigint), owner: A(a.owner), payee: A(a.payee), side: Number(a.side), q: BigInt(a.q as bigint), paidNow: BigInt(a.paidNow as bigint), operator: A(a.operator), daily: Boolean(a.daily), k: Number(a.k), to: A(a.to) };
    case "Claimed":
      return { ...base, name: "Claimed", id: BigInt(a.id as bigint), payee: A(a.payee), amount: BigInt(a.amount as bigint), paidTotal: BigInt(a.paidTotal as bigint), k: Number(a.k) };
    case "PositionClosed":
      return { ...base, name: "PositionClosed", id: BigInt(a.id as bigint), owner: A(a.owner), kind: Number(a.kind), amount: BigInt(a.amount as bigint), to: A(a.to), by: A(a.by) };
    case "PayoutChanged":
      return { ...base, name: "PayoutChanged", id: BigInt(a.id as bigint), payee: A(a.payee), daily: Boolean(a.daily) };
    case "FixApplied":
      return { ...base, name: "FixApplied", k: Number(a.k), day: Number(a.day), x: BigInt(a.x as number), c: BigInt(a.c as number), status: Number(a.status), flags: Number(a.flags), sumAfter: BigInt(a.sumAfter as bigint) };
    default:
      return null;
  }
}

/** A line of events.jsonl back into a ScanEvent (bigint fields were written as decimal strings). */
export function reviveEvent(j: Record<string, unknown>): ScanEvent {
  const name = j.name as ScanEventName;
  if (!(name in BIGINTS)) throw new Error("unknown event");
  const out: Record<string, unknown> = { ...j };
  for (const f of BIGINTS[name]) out[f] = BigInt(j[f] as string);
  return out as unknown as ScanEvent;
}

/** A rate limit (HTTP 429, "too many requests", Alchemy's "exceeded its compute units per second capacity"): the
 *  provider is busy, not refusing the range, so the pool fails over to the next URL (audit P-M2). */
export const isRateLimit = (e: unknown): boolean => {
  const m = `${(e as Error)?.message ?? e} ${(e as { details?: unknown })?.details ?? ""} ${(e as { status?: unknown })?.status ?? ""}`;
  return /\b429\b|rate.?limit|too many requests|compute units|capacity|throughput|throttl/i.test(m);
};
export const isRangeError = (e: unknown): boolean => {
  const m = `${(e as Error)?.message ?? e}`;
  return !isRateLimit(e) && /(block range|range (is )?too (large|wide|big)|exceed|too many|more than|max(imum)? (block )?range|limit)/i.test(m);
};
const isAddressRefused = (e: unknown) => {
  const m = `${(e as Error)?.message ?? e}`;
  return !isRangeError(e) && /address/i.test(m) && /(required|missing|must|specify|empty|need)/i.test(m);
};

export interface ScannerOptions {
  pool: RpcPool;
  dir: string;
  fromBlock: bigint;
  factories: readonly Address[];
  /** blocks per eth_getLogs (default 100: the public RPC's limit) */
  chunk?: number;
  minChunk?: number;
  maxChunksPerSync?: number;
  /** finalized lags latest by this when a node refuses `finalized` (default 3) */
  finalizedLag?: number;
  /** ms between two chunks of one sync (a catch-up), so a burst stays under a provider's per-second budget (default 0) */
  paceMs?: number;
  /** successful chunks in a row before a halved chunk doubles back toward `chunk` (default 10) */
  growAfter?: number;
  /** the chain the cursor belongs to (default: the pool's) */
  chainId?: number;
  /** compact events.jsonl at start when it holds more lines than this (default 20,000) */
  compactAbove?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: string, data: Record<string, unknown>) => void;
}

/** What a cursor and the payer's state belong to: a cursor of another chain or deployment is never trusted (P-M3). */
export interface ScanIdentity {
  chainId: number;
  fromBlock: string;
  factories: string[]; // lowercase, sorted
}

export function scanIdentity(chainId: number, fromBlock: bigint, factories: readonly string[]): ScanIdentity {
  return { chainId, fromBlock: fromBlock.toString(), factories: [...new Set(factories.map((f) => f.toLowerCase()))].sort() };
}

/** null when they match; else what differs (field names only). */
export function identityMismatch(a: ScanIdentity, b: Partial<ScanIdentity> | undefined): string | null {
  if (!b || b.chainId === undefined || b.fromBlock === undefined || !Array.isArray(b.factories)) return "no identity";
  const out: string[] = [];
  if (b.chainId !== a.chainId) out.push("chainId");
  if (String(b.fromBlock) !== a.fromBlock) out.push("fromBlock");
  if (JSON.stringify([...b.factories].map((f) => String(f).toLowerCase()).sort()) !== JSON.stringify(a.factories)) out.push("factories");
  return out.length ? out.join(", ") : null;
}

/** A cursor this far past the chain's finalized tip cannot be this chain's (a reset to a lower height, another
 *  chain): the scan restarts from the start block. Far above any node lag the pool would tolerate (staleS 30 s). */
export const CURSOR_AHEAD_RESET = 10_000n;

/** The events the payer still needs (S-L1): factory events, and for each open position its PositionOpened, its newest
 *  Claimed and its newest PayoutChanged; a closed position's events and FixApplied are dropped. Order is kept. */
export function compactEvents(evs: readonly ScanEvent[]): ScanEvent[] {
  const closed = new Set<string>();
  const lastClaim = new Map<string, string>();
  const lastPayout = new Map<string, string>();
  const pk = (e: { address: string; id: bigint }) => `${e.address}:${e.id}`;
  for (const e of evs) {
    if (e.name === "PositionClosed") closed.add(pk(e));
    else if (e.name === "Claimed") lastClaim.set(pk(e), e.key);
    else if (e.name === "PayoutChanged") lastPayout.set(pk(e), e.key);
  }
  return evs.filter((e) => {
    switch (e.name) {
      case "SeriesListed":
      case "MarketRecorded":
        return true;
      case "FixApplied":
        return false;
      case "PositionOpened":
        return !closed.has(pk(e));
      case "Claimed":
        return !closed.has(pk(e)) && lastClaim.get(pk(e)) === e.key;
      case "PayoutChanged":
        return !closed.has(pk(e)) && lastPayout.get(pk(e)) === e.key;
      case "PositionClosed":
        return false;
      default:
        return true;
    }
  });
}

export class MarketScanner {
  private evs: ScanEvent[] = [];
  private readonly seen = new Set<string>();
  private readonly factories: Set<string>;
  private readonly series = new Set<string>();
  private cursor: bigint;
  private chunk: number;
  private readonly baseChunk: number;
  private okRun = 0;
  /** successes in a row before a halved chunk doubles; doubles itself each time a grown chunk fails again, so a node
   *  whose real limit is below the configured chunk costs a failed call ever more rarely */
  private growAfter: number;
  private justGrew = false;
  private split = false;
  private warnedSplit = false;
  /** the cursor file had no identity (an older payer): only the ahead-of-tip check can tell it is foreign */
  private legacy = false;
  readonly identity: ScanIdentity;
  /** the tip of the last sync; caughtUp once the cursor passed it */
  tip: bigint | null = null;
  calls = 0;
  /** how many times the scan started over (reset): a consumer that indexed into all() rebuilds when it changes */
  epoch = 0;

  constructor(readonly o: ScannerOptions) {
    this.factories = new Set(o.factories.map((f) => f.toLowerCase()));
    this.identity = scanIdentity(o.chainId ?? o.pool.chainId, o.fromBlock, o.factories);
    this.cursor = o.fromBlock;
    this.chunk = o.chunk ?? 100;
    this.baseChunk = this.chunk;
    this.growAfter = o.growAfter ?? 10;
    const cur = join(o.dir, "cursor.json");
    if (existsSync(cur)) {
      try {
        const j = JSON.parse(readFileSync(cur, "utf8")) as { next: string } & Partial<ScanIdentity>;
        const next = BigInt(j.next);
        const bad = identityMismatch(this.identity, j);
        if (bad === "no identity") {
          this.legacy = true;
          this.cursor = next;
        } else if (bad !== null) {
          this.reset(`cursor.json belongs to another chain or deployment (${bad} differ)`);
          return;
        } else this.cursor = next;
      } catch {
        this.cursor = o.fromBlock; // an unreadable cursor rescans: dedupe keeps the events once
      }
    }
    this.load();
  }

  private file(): string {
    return join(this.o.dir, "events.jsonl");
  }

  private load(): void {
    const file = this.file();
    if (!existsSync(file)) return;
    const all: ScanEvent[] = [];
    let lines = 0;
    for (const ln of readFileSync(file, "utf8").split("\n")) {
      if (!ln.trim()) continue;
      lines++;
      let e: ScanEvent;
      try {
        e = reviveEvent(JSON.parse(ln) as Record<string, unknown>);
      } catch {
        continue; // a torn last line: its chunk is rescanned (the cursor is written after the events)
      }
      all.push(e);
    }
    // compaction keeps the events at or after the cursor whole: their chunk may be scanned again
    const done = all.filter((e) => BigInt(e.block) < this.cursor);
    const open = all.filter((e) => BigInt(e.block) >= this.cursor);
    const keep = lines > (this.o.compactAbove ?? 20_000) ? [...compactEvents(done), ...open] : all.filter((e) => e.name !== "FixApplied");
    for (const e of keep) this.accept(e);
    if (lines > (this.o.compactAbove ?? 20_000)) {
      writeAtomic(file, keep.map((e) => JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).join("\n") + (keep.length ? "\n" : ""));
      this.say("scan_compacted", { lines, kept: keep.length });
    }
  }

  /** Starts over from the start block: the old events file is kept beside it, renamed. */
  private reset(why: string): void {
    const file = this.file();
    if (existsSync(file)) renameSync(file, join(this.o.dir, `events.stale-${Date.now()}.jsonl`));
    this.evs = [];
    this.seen.clear();
    this.series.clear();
    this.cursor = this.o.fromBlock;
    this.legacy = false;
    this.tip = null;
    this.epoch++;
    this.writeCursor();
    this.say("scan_reset", { why, fromBlock: this.o.fromBlock.toString() });
  }

  private writeCursor(): void {
    writeAtomic(join(this.o.dir, "cursor.json"), JSON.stringify({ next: this.cursor.toString(), ...this.identity }));
  }

  get next(): bigint {
    return this.cursor;
  }
  get caughtUp(): boolean {
    return this.tip !== null && this.cursor > this.tip;
  }
  get chunkSize(): number {
    return this.chunk;
  }
  all(): readonly ScanEvent[] {
    return this.evs;
  }
  knownSeries(): string[] {
    return [...this.series];
  }

  /** Keeps e when its emitter is known (registering series from a known factory's SeriesListed). */
  private accept(e: ScanEvent): boolean {
    if (this.seen.has(e.key)) return false;
    if (e.name === "FixApplied") return false; // not scanned any more; older files may still hold some
    const fromFactory = this.factories.has(e.address);
    if ((e.name === "SeriesListed" || e.name === "MarketRecorded") && !fromFactory) return false;
    if (e.name !== "SeriesListed" && e.name !== "MarketRecorded" && !this.series.has(e.address)) return false;
    this.seen.add(e.key);
    this.evs.push(e);
    if (e.name === "SeriesListed") this.series.add(e.series.toLowerCase());
    return true;
  }

  private say(event: string, data: Record<string, unknown> = {}): void {
    this.o.log?.(event, data);
  }

  private sleep(ms: number): Promise<void> {
    return this.o.sleep ? this.o.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  private async finalized(): Promise<bigint> {
    try {
      const b = await this.o.pool.call((c) => c.getBlock({ blockTag: "finalized" }), () => true);
      if (b.number !== null) return b.number;
    } catch (e) {
      if (e instanceof RpcDown) throw e;
    }
    const latest = await this.o.pool.call((c) => c.getBlockNumber({ cacheTime: 0 }));
    const lag = BigInt(this.o.finalizedLag ?? 3);
    return latest > lag ? latest - lag : 0n;
  }

  private async getLogs(from: bigint, to: bigint, address: readonly string[] | null, topics: Hex[]): Promise<RawLog[]> {
    this.calls++;
    const params: Record<string, unknown> = { fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [topics] };
    if (address) params.address = address;
    // a range error or a refused filter is the node's answer (no failover); a rate limit fails over like a timeout
    const raw = (await this.o.pool.call((c) => c.request({ method: "eth_getLogs", params: [params] } as never), (e) => isRangeError(e) || isAddressRefused(e))) as {
      address: Address;
      topics: Hex[];
      data: Hex;
      blockNumber: Hex | null;
      logIndex: Hex | null;
      transactionHash: Hex | null;
    }[];
    return raw.map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: l.blockNumber === null ? null : BigInt(l.blockNumber), logIndex: l.logIndex === null ? null : Number(BigInt(l.logIndex)), transactionHash: l.transactionHash }));
  }

  private async chunkLogs(from: bigint, to: bigint): Promise<RawLog[]> {
    if (!this.split) return this.getLogs(from, to, null, SCAN_TOPICS);
    const fac = await this.getLogs(from, to, [...this.factories], FACTORY_TOPICS);
    const listed = fac.map(decodeScanLog).filter((e): e is ScanEvent & { name: "SeriesListed" } => e?.name === "SeriesListed" && this.factories.has(e.address)).map((e) => e.series);
    const addrs = [...new Set([...this.series, ...listed])];
    const ser = addrs.length ? await this.getLogs(from, to, addrs, SERIES_TOPICS) : [];
    return [...fac, ...ser];
  }

  /** Pull new events up to the finalized tip (at most maxChunksPerSync chunks). Throws RpcDown; the caller retries. */
  async sync(): Promise<number> {
    const tip = await this.finalized();
    if (this.cursor > tip + CURSOR_AHEAD_RESET) this.reset(`the cursor ${this.cursor} is far past this chain's finalized block ${tip}${this.legacy ? " (a cursor without identity)" : ""}`);
    this.tip = tip;
    let n = 0;
    let added = 0;
    const max = this.o.maxChunksPerSync ?? 500;
    while (this.cursor <= tip && n < max) {
      if (n > 0 && (this.o.paceMs ?? 0) > 0) await this.sleep(this.o.paceMs!);
      const to = this.cursor + BigInt(this.chunk) - 1n < tip ? this.cursor + BigInt(this.chunk) - 1n : tip;
      let logs: RawLog[];
      try {
        logs = await this.chunkLogs(this.cursor, to);
      } catch (e) {
        this.okRun = 0;
        if (isAddressRefused(e) && !this.split) {
          this.split = true;
          if (!this.warnedSplit) this.say("scan_split", { why: "the node refused a log filter without an address; two calls per chunk from now on" });
          this.warnedSplit = true;
          continue;
        }
        if (isRangeError(e) && this.chunk > (this.o.minChunk ?? 10)) {
          if (this.justGrew) this.growAfter = Math.min(this.growAfter * 2, 100_000);
          this.justGrew = false;
          this.chunk = Math.max(this.o.minChunk ?? 10, Math.floor(this.chunk / 2));
          this.say("scan_chunk_halved", { chunk: this.chunk, error: (e as Error).message.split("\n")[0]!.slice(0, 120) });
          continue;
        }
        throw e;
      }
      const decoded = logs.map(decodeScanLog).filter((e): e is ScanEvent => e !== null);
      decoded.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const fresh: ScanEvent[] = [];
      for (const e of decoded) if (this.accept(e)) fresh.push(e);
      for (const e of fresh) appendLine(this.file(), e);
      added += fresh.length;
      this.cursor = to + 1n;
      this.legacy = false;
      this.writeCursor();
      n++;
      // a halved chunk grows back once the node has taken it for a while (a range error may have been a moment's
      // limit, or another URL's): never stuck at the floor for the life of the process (audit P-M2)
      this.justGrew = false;
      if (this.chunk < this.baseChunk && ++this.okRun >= this.growAfter) {
        this.chunk = Math.min(this.baseChunk, this.chunk * 2);
        this.okRun = 0;
        this.justGrew = true;
        this.say("scan_chunk_grown", { chunk: this.chunk });
      }
    }
    return added;
  }
}
