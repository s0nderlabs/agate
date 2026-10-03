// Readers in force for the watcher (BUILD-SPEC 8.6, Oct 3): which URL and which parserVersion read each panel slot on
// a given day (the registered recipe's reader until the first executed swap, then the newest swap whose fromDay has
// begun), and whether this build may use it (https, host on the source's allowlist, version installed and of that
// source). A reader it may not use is never replaced by another: that slot reads as no reading (MISSED, with the
// reason), and the attester raises READER_MISSING or READER_REFUSED. The pure rules live in @agate/sources.
import type { GpuModel, Hex } from "@agate/report/types";
import { GPUS } from "@agate/sources/pure";
import type { ParseContext, ParseResult, ReaderRef, ReaderSwap, SourceDef } from "@agate/sources/types";
import type { IndexView } from "./chain/types.ts";
import type { PanelRef } from "./scenario.ts";

/** What the watcher needs from @agate/sources' reader registry. */
export interface ReaderApi {
  SOURCES: readonly SourceDef[];
  readerInForce(slot: { slot: number; sourceId: string; family: number; liveAtStart: boolean }, history: readonly ReaderSwap[], day: number): ReaderRef;
  readerAllowed(sourceId: string, r: ReaderRef): { ok: true } | { ok: false; why: string };
  /** the shared classification (the URL and host first, then the version), as the writers use it */
  readerProblem(sourceId: string, r: ReaderRef): { code: ReaderProblemCode; why: string } | null;
  sourceOfVersion(parserVersion: string): string | null;
  parseWith(parserVersion: string, body: string, ctx: ParseContext): ParseResult;
}

export type ReaderProblemCode = "missing" | "refused";

/** True when m carries every reader function the watcher uses (else this build reads with registered readers). */
export function isReaderApi(m: Partial<ReaderApi>): m is ReaderApi {
  return (["readerInForce", "readerAllowed", "readerProblem", "sourceOfVersion", "parseWith"] as const).every((k) => typeof m[k] === "function") && Array.isArray(m.SOURCES);
}

export interface GpuRead {
  gpu: GpuModel;
  parserVersion: string;
  /** the registered recipe's parserVersion */
  registeredParser: boolean;
  problem?: { code: ReaderProblemCode; why: string };
}

/** One fetch: a URL and the GPUs read from it (one WatcherReading line per (sourceId, URL), 8.6). */
export interface ReadGroup {
  url: string;
  registeredUrl: boolean;
  gpus: GpuRead[];
}

export function problemOf(api: Pick<ReaderApi, "readerProblem">, sourceId: string, r: ReaderRef): { code: ReaderProblemCode; why: string } | undefined {
  return api.readerProblem(sourceId, r) ?? undefined;
}

/** 8.6: the attester's check of a queued or executed swap's reader, by the same rule as the logger and the writers. */
export function readerCheckOf(api: Pick<ReaderApi, "readerProblem">): (sourceId: string, r: ReaderRef) => "ok" | ReaderProblemCode {
  return (sourceId, r) => api.readerProblem(sourceId, r)?.code ?? "ok";
}

export class ReaderBook {
  private readonly hist = new Map<string, ReaderSwap[]>();

  constructor(
    readonly api: ReaderApi,
    readonly panels: PanelRef[],
    readonly clock: { slices: number; epochDay: number },
  ) {}

  static key(gpuId: Hex, slot: number): string {
    return `${gpuId.toLowerCase()}:${slot}`;
  }

  setHistory(gpuId: Hex, slot: number, h: readonly ReaderSwap[]): void {
    this.hist.set(ReaderBook.key(gpuId, slot), [...h].sort((a, b) => a.fromDay - b.fromDay));
  }

  history(gpuId: Hex, slot: number): ReaderSwap[] {
    return this.hist.get(ReaderBook.key(gpuId, slot)) ?? [];
  }

  /** Any swap known at all (else every read is the registered one and nothing changes). */
  get swapped(): boolean {
    for (const h of this.hist.values()) if (h.length > 0) return true;
    return false;
  }

  dayOfInterval(k: number): number {
    return this.clock.epochDay + Math.floor(k / this.clock.slices);
  }

  private def(sourceId: string): SourceDef | undefined {
    return this.api.SOURCES.find((s) => s.id === sourceId);
  }

  /** The reader in force for one panel slot on `day`. */
  readerOf(p: PanelRef, slot: number, day: number): ReaderRef {
    return this.api.readerInForce({ slot, sourceId: p.sources[slot]!, family: 0, liveAtStart: true }, this.history(p.gpuId, slot), day);
  }

  /** The URL key rule R reads slot `slot` from on `day`: undefined for the registered URL's line. */
  urlKey(p: PanelRef, slot: number, day: number): string | undefined {
    const def = this.def(p.sources[slot]!);
    const r = this.readerOf(p, slot, day);
    return def && r.url === def.url ? undefined : r.url;
  }

  /** The reads of one source in interval k: one group per distinct URL in force for its GPUs. With no swap of this
   *  source in force, one group at the registered URL with the registered parser (the Oct 1 behaviour). */
  plan(sourceId: string, k: number): ReadGroup[] {
    const def = this.def(sourceId);
    if (!def) return [];
    const day = this.dayOfInterval(k);
    const gpus = GPUS.filter((g) => def.rules[g] !== undefined);
    const byGpu = new Map<GpuModel, ReaderRef>();
    for (const p of this.panels) {
      const slot = p.sources.indexOf(sourceId);
      if (slot < 0 || !gpus.includes(p.gpu)) continue;
      byGpu.set(p.gpu, this.readerOf(p, slot, day));
    }
    const groups = new Map<string, ReadGroup>();
    for (const g of gpus) {
      const r = byGpu.get(g) ?? { url: def.url, parserVersion: def.parserVersion };
      let grp = groups.get(r.url);
      if (!grp) groups.set(r.url, (grp = { url: r.url, registeredUrl: r.url === def.url, gpus: [] }));
      const reg = r.url === def.url && r.parserVersion === def.parserVersion;
      const problem = reg ? undefined : problemOf(this.api, sourceId, r);
      grp.gpus.push({ gpu: g, parserVersion: r.parserVersion, registeredParser: r.parserVersion === def.parserVersion, ...(problem ? { problem } : {}) });
    }
    // the registered URL's group first (it is the line `has` and the catch-up lines refer to)
    return [...groups.values()].sort((a, b) => Number(b.registeredUrl) - Number(a.registeredUrl));
  }
}

/** 8.6: every registered slot's reader history from the chain into the book: at start and on wake (force), then at most
 *  once per slice. The slots are read in parallel and the book changes only when every read answered. A failure (RPC
 *  down, or an index without readerHistory) keeps what is known and backs off, 5 s doubling up to one slice, never a
 *  call per tick; one line per run of failures. A call while a refresh runs gets that refresh, so a caller can leave
 *  it running off its tick path (the logger needs no RPC to fetch pages). */
export function readerRefresher(o: { book: ReaderBook; view: Pick<IndexView, "readerHistory">; slice: number; say?: (event: string, data?: Record<string, unknown>) => void }): (now: number, force?: boolean) => Promise<void> {
  let next = Number.NEGATIVE_INFINITY;
  let failures = 0;
  let running: Promise<void> | null = null;
  return (now, force = false) => {
    if (running) return running;
    if (!force && now < next) return Promise.resolve();
    running = (async () => {
      try {
        const reads = o.book.panels.flatMap((p) => p.sources.map((_s, i) => o.view.readerHistory(p.gpuId, i).then((h) => ({ g: p.gpuId, i, h }))));
        for (const r of await Promise.all(reads)) o.book.setHistory(r.g, r.i, r.h);
        if (failures > 0) o.say?.("reader_history_ok", { after: failures });
        failures = 0;
        next = now + o.slice;
      } catch (e) {
        failures += 1;
        const wait = Math.min(o.slice, 5 * 2 ** Math.min(failures - 1, 20));
        next = now + wait;
        if (failures === 1) o.say?.("reader_history_failed", { error: e instanceof Error ? e.message.split("\n")[0] : String(e), retryInS: wait });
      } finally {
        running = null;
      }
    })();
    return running;
  };
}

/** Rule R's URL key per (slot, day) for one panel from its ReaderSwapped events (fromDay, url, parserVersion); null
 *  when the GPU has no swap (every slot reads the registered line). Shared by the attester and the guardian CLI. */
export function readerUrlFromEvents(book: ReaderBook, p: PanelRef, swaps: readonly { slot: number; fromDay: number; url: string; parserVersion: string }[]): ((slot: number, day: number) => string | undefined) | null {
  if (swaps.length === 0) return null;
  for (let i = 0; i < p.sources.length; i++) book.setHistory(p.gpuId, i, swaps.filter((e) => e.slot === i).map((e) => ({ fromDay: e.fromDay, url: e.url, parserVersion: e.parserVersion })));
  return (slot, day) => book.urlKey(p, slot, day);
}

/** sha256(url) first 8 hex: the raw file of a second URL of one source is <sourceId>.<this>.gz (9.1). */
export function urlTag(url: string): string {
  return new Bun.CryptoHasher("sha256").update(url).digest("hex").slice(0, 8);
}
