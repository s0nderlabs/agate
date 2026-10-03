// The index over RPC: views through the failover pool, and an incremental event indexer that scans logs in chunks,
// persists them (restart-safe) and decodes them into WallEvents.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Abi, decodeEventLog, type Log, parseAbi } from "viem";
import { agateIndexAbi } from "@agate/report/abi";
import type { Address, Clocks, GpuConfig, Hex, IndexRecord, Readings, SlotState } from "@agate/report/types";
import { appendLine, writeAtomic } from "../fsutil.ts";
import type { RpcPool } from "./rpc.ts";
import { type Detail, type EventSource, evKey, type IndexView, type WallEvent } from "./types.ts";

/** The Oct 3 events and views (4.11, 4.15), so the watcher decodes them whether or not abi.ts was regenerated yet;
 *  an entry abi.ts already has is not added twice. */
const OCT3_ABI = parseAbi([
  "event ActionExecuted(bytes32 indexed id, (uint8 kind, uint8 slot, address addr, bytes32 gpuId, uint32 day, uint8 mode) action)",
  "event ActionCancelled(bytes32 indexed id)",
  "event ReaderSwapQueued(bytes32 indexed id, bytes32 indexed gpuId, uint8 slot, string url, string parserVersion, string reason, uint64 eta)",
  "event ReaderSwapped(bytes32 indexed id, bytes32 indexed gpuId, uint8 slot, uint32 fromDay, bytes32 readerHash, string url, string parserVersion, string reason)",
  "event ReaderSwapCancelled(bytes32 indexed id, bytes32 indexed gpuId, uint8 slot)",
  "function queuedEta(bytes32 id) view returns (uint64)",
  "function readerHistory(bytes32 gpuId, uint8 slot) view returns ((uint32 fromDay, uint64 executedAt, bytes32 readerHash, string url, string parserVersion, string reason)[])",
]);

export const WATCHER_ABI: Abi = [
  ...(agateIndexAbi as Abi),
  ...(OCT3_ABI as Abi).filter((x) => !(agateIndexAbi as Abi).some((y) => y.type === x.type && "name" in y && "name" in x && y.name === x.name)),
];

export class ViemIndex implements IndexView {
  constructor(
    readonly pool: RpcPool,
    readonly address: Address,
    readonly abi: Abi = WATCHER_ABI,
  ) {}
  private read<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.pool.call((c) => c.readContract({ address: this.address, abi: this.abi, functionName, args: args as unknown[] }) as Promise<T>);
  }
  async blockTime() {
    return Number((await this.pool.call((c) => c.getBlock({ blockTag: "latest" }))).timestamp);
  }
  clocks() {
    return this.read<Clocks>("clocks");
  }
  gpu(g: Hex) {
    return this.read<GpuConfig>("gpu", [g]);
  }
  async head(g: Hex) {
    return Number(await this.read<number>("head", [g]));
  }
  async record(g: Hex, d: number) {
    const [exists, isFinal, rec] = await this.read<[boolean, boolean, IndexRecord]>("record", [g, d]);
    return { exists, isFinal, rec };
  }
  async slotStates(g: Hex) {
    const [base, last] = await this.read<[SlotState[], SlotState[]]>("slotStates", [g]);
    return { base: [...base], last: [...last] };
  }
  async slotWindow(g: Hex, i: number) {
    const [liveFrom, liveUntil] = await this.read<[number, number]>("slotWindow", [g, i]);
    return { liveFrom: Number(liveFrom), liveUntil: Number(liveUntil) };
  }
  async familyOf(g: Hex, i: number) {
    const [family, famQ] = await this.read<[number, number]>("familyOf", [g, i]);
    return { family: Number(family), famQ: Number(famQ) };
  }
  readings(g: Hex, d: number, w: Address) {
    return this.read<Readings>("readings", [g, d, w]);
  }
  async previewRecord(g: Hex, d: number, w: Address) {
    const [ok, detail] = await this.read<[boolean, Detail]>("previewRecord", [g, d, w]);
    return { ok, detail: norm(detail) };
  }
  async previewFix(g: Hex) {
    const [ok, detail] = await this.read<[boolean, Detail]>("previewFix", [g]);
    return { ok, detail: norm(detail) };
  }
  writers() {
    return this.read<readonly [Address, Address]>("writers");
  }
  attester() {
    return this.read<Address>("attester");
  }
  guardians() {
    return this.read<readonly [Address, Address]>("guardians");
  }
  isSuspended(w: Address) {
    return this.read<boolean>("isSuspended", [w]);
  }
  isVoided(g: Hex, d: number, w: Address) {
    return this.read<boolean>("isVoided", [g, d, w]);
  }
  async reopenedAt(g: Hex, d: number) {
    return Number(await this.read<bigint>("reopenedAt", [g, d]));
  }
  async firstRecordDay(g: Hex) {
    const [exists, day] = await this.read<[boolean, number]>("firstRecordDay", [g]);
    return { exists, day: Number(day) };
  }
  balance(a: Address) {
    return this.pool.call((c) => c.getBalance({ address: a }));
  }
  async queuedEta(id: Hex) {
    return Number(await this.read<bigint>("queuedEta", [id]));
  }
  async readerHistory(g: Hex, slot: number) {
    const h = await this.read<readonly { fromDay: number; url: string; parserVersion: string; reason: string }[]>("readerHistory", [g, slot]);
    return h.map((x) => ({ fromDay: Number(x.fromDay), url: x.url, parserVersion: x.parserVersion, reason: x.reason }));
  }
}

function norm(d: Detail): Detail {
  return { rec: d.rec, p: [...d.p].map(Number), kinds: [...d.kinds], counts: [...d.counts].map(Number), post: [...d.post] };
}

const N = (x: unknown) => Number(x as bigint | number);

/** Decodes one AgateIndex log into a WallEvent (null for events rule R does not use). */
export function decodeWallEvent(log: Log, abi: Abi = WATCHER_ABI): WallEvent | null {
  let dec: { eventName: string; args: Record<string, unknown> };
  try {
    dec = decodeEventLog({ abi, data: log.data, topics: log.topics }) as never;
  } catch {
    return null;
  }
  const a = dec.args;
  const base = { key: evKey(Number(log.blockNumber), Number(log.logIndex)), gpuId: (a.gpuId ?? "0x") as Hex, day: N(a.day ?? 0), ...(log.transactionHash ? { tx: log.transactionHash as Hex } : {}) };
  switch (dec.eventName) {
    case "ReadingsPosted":
      return { ...base, name: "ReadingsPosted", writer: a.writer as Address, slice: N(a.slice), readAt: N(a.readAt), values: (a.values as number[]).map(Number), validMask: N(a.validMask), late: Boolean(a.late) };
    case "RecordSlots":
      return {
        ...base, name: "RecordSlots", source: a.source as Address, digest: a.digest as Hex, p: (a.p as number[]).map(Number), kinds: [...(a.kinds as never[])],
        counts: (a.counts as number[]).map(Number), post: (a.post as SlotState[]).map((s) => ({ e: N(s.e), miss: N(s.miss), inMedian: s.inMedian, wasIn: s.wasIn })),
      };
    case "DayClosed":
      return { ...base, name: "DayClosed", source: a.source as Address, value: N(a.value), changed: Boolean(a.changed), needsSign: Boolean(a.needsSign), digest: a.digest as Hex, incomplete: Boolean(a.incomplete) };
    case "DayCarried":
      return { ...base, name: "DayCarried", value: N(a.value), carryCase: N(a.carryCase), dropped: Boolean(a.dropped), missAdvanced: N(a.missAdvanced) };
    case "DaySkipped":
      return { ...base, name: "DaySkipped", carryCase: N(a.carryCase) };
    case "FixDropped":
      return { ...base, name: "FixDropped", source: a.source as Address, value: N(a.value), digest: a.digest as Hex };
    case "Vetoed":
      return { ...base, name: "Vetoed", by: a.by as Address, source: a.source as Address, digest: a.digest as Hex, value: N(a.value) };
    case "Attested":
      return { ...base, name: "Attested", by: a.by as Address, source: a.source as Address, digest: a.digest as Hex, finalAt: N(a.finalAt) };
    case "RecordReplaced":
      return { ...base, name: "RecordReplaced", by: a.by as Address, oldSource: a.oldSource as Address, newSource: a.newSource as Address, oldValue: N(a.oldValue), newValue: N(a.newValue), oldDigest: a.oldDigest as Hex, newDigest: a.newDigest as Hex };
    case "WriterSuspended":
      return { ...base, gpuId: "0x" as Hex, name: "WriterSuspended", writer: a.writer as Address, by: a.by as Address };
    case "ActionQueued":
      {
        const act = a.action as { kind?: unknown; slot?: unknown; addr?: unknown; gpuId?: unknown; day?: unknown; mode?: unknown } | undefined;
        return {
          ...base, gpuId: "0x" as Hex, day: 0, name: "ActionQueued", id: a.id as Hex, eta: N(a.eta),
          ...(act ? { kind: N(act.kind ?? 0), slot: N(act.slot ?? 0), addr: act.addr as Address, actionGpuId: act.gpuId as Hex, actionDay: N(act.day ?? 0), mode: N(act.mode ?? 0) } : {}),
        };
      }
    case "ActionExecuted": {
      const act = a.action as { kind?: unknown } | undefined;
      return { ...base, gpuId: "0x" as Hex, day: 0, name: "ActionExecuted", id: a.id as Hex, ...(act ? { kind: N(act.kind ?? 0) } : {}) };
    }
    case "ActionCancelled":
      return { ...base, gpuId: "0x" as Hex, day: 0, name: "ActionCancelled", id: a.id as Hex };
    case "ReaderSwapQueued":
      return { ...base, day: 0, name: "ReaderSwapQueued", id: a.id as Hex, slot: N(a.slot), url: String(a.url), parserVersion: String(a.parserVersion), reason: String(a.reason), eta: N(a.eta) };
    case "ReaderSwapped":
      return { ...base, day: 0, name: "ReaderSwapped", id: a.id as Hex, slot: N(a.slot), fromDay: N(a.fromDay), readerHash: a.readerHash as Hex, url: String(a.url), parserVersion: String(a.parserVersion), reason: String(a.reason) };
    case "ReaderSwapCancelled":
      return { ...base, day: 0, name: "ReaderSwapCancelled", id: a.id as Hex, slot: N(a.slot) };
    default:
      return null;
  }
}

export interface IndexerOptions {
  pool: RpcPool;
  address: Address;
  dir: string; // <home>/watcher/<index>/events
  fromBlock: bigint; // deployment block
  chunk: bigint; // getLogs block range per call (Monad's public RPC limits it)
  confirmations?: bigint;
  maxChunksPerSync?: number;
  abi?: Abi;
}

/** Incremental, persisted log scan: events.jsonl plus a cursor file; a restart resumes from the cursor. */
export class EventIndexer implements EventSource {
  private readonly evs: WallEvent[] = [];
  private readonly seen = new Set<string>();
  private cursor: bigint;

  constructor(readonly o: IndexerOptions) {
    this.cursor = o.fromBlock;
    const cur = join(o.dir, "cursor.json");
    if (existsSync(cur)) this.cursor = BigInt((JSON.parse(readFileSync(cur, "utf8")) as { next: string }).next);
    const file = join(o.dir, "events.jsonl");
    if (existsSync(file)) {
      for (const ln of readFileSync(file, "utf8").split("\n")) {
        if (!ln.trim()) continue;
        try {
          this.push(JSON.parse(ln) as WallEvent);
        } catch {
          // a torn last line is rescanned (the cursor is written after the events)
        }
      }
    }
  }

  private push(e: WallEvent): boolean {
    if (this.seen.has(e.key)) return false;
    this.seen.add(e.key);
    this.evs.push(e);
    return true;
  }

  all(): readonly WallEvent[] {
    return this.evs;
  }

  async sync(): Promise<void> {
    const latest = await this.o.pool.call((c) => c.getBlockNumber());
    const tip = latest - (this.o.confirmations ?? 0n);
    let n = 0;
    while (this.cursor <= tip && n < (this.o.maxChunksPerSync ?? 50)) {
      const to = this.cursor + this.o.chunk - 1n < tip ? this.cursor + this.o.chunk - 1n : tip;
      const logs = await this.o.pool.call((c) => c.getLogs({ address: this.o.address, fromBlock: this.cursor, toBlock: to }));
      const fresh: WallEvent[] = [];
      const decoded = logs.map((l) => decodeWallEvent(l as Log, this.o.abi)).filter((e): e is WallEvent => e !== null);
      decoded.sort((a, b) => (a.key < b.key ? -1 : 1)); // block order: EventIndex consumers rely on append order
      for (const e of decoded) if (this.push(e)) fresh.push(e);
      for (const e of fresh) appendLine(join(this.o.dir, "events.jsonl"), e);
      this.cursor = to + 1n;
      writeAtomic(join(this.o.dir, "cursor.json"), JSON.stringify({ next: this.cursor.toString() }));
      n++;
    }
  }
}
