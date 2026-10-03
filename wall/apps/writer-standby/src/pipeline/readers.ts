// Readers in force for the writers (BUILD-SPEC 8.6). The history of every registered slot is read from the index
// (readerHistory) at start, on wake and at most once per slice (just before a reading), and kept in a small file so a
// start with every RPC URL down still reads with the last known readers. Per reading day each swapped slot gets its
// reader in force when it is allowed (https, the source's hosts, installed for that source); otherwise the slot
// reads nothing (0) and READER_MISSING or READER_REFUSED is raised once per swap. A swap never applies mid-day: the
// day decides (fromDay is a next day start).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Hex } from "@agate/report/types";
import type { Panel, ReaderSwap, SourcesPureApi } from "@agate/sources/types";
import { type Clock, dayStart, type SlotReaders } from "../core/index.ts";
import type { IndexChain } from "./chain.ts";
import { type AlertFn, RpcDownError } from "./rpc.ts";

export interface ReaderBookOptions {
  chain: IndexChain;
  api: SourcesPureApi;
  panels: readonly Panel[];
  clock: Clock;
  alert?: AlertFn;
  say?: (event: string, data?: Record<string, unknown>) => void;
  /** Where the last known history is kept (per index). */
  cacheFile?: string;
}

const keyOf = (g: Hex, slot: number) => `${g.toLowerCase()}:${slot}`;

export class ReaderBook {
  private hist = new Map<string, ReaderSwap[]>();
  private lastRefresh = Number.NEGATIVE_INFINITY;
  private loaded = false;
  private unsupportedSaid = false;
  private readonly raised = new Set<string>();

  constructor(private readonly o: ReaderBookOptions) {
    if (o.cacheFile) {
      try {
        const j = JSON.parse(readFileSync(o.cacheFile, "utf8")) as Record<string, ReaderSwap[]>;
        for (const [k, v] of Object.entries(j)) if (Array.isArray(v)) this.hist.set(k, v);
        this.loaded = true;
      } catch {
        // no cache yet
      }
    }
  }

  /** True once a history was read from the chain or the cache file. */
  get known(): boolean {
    return this.loaded;
  }

  /** Re-reads every slot's history when forced (start, wake) or when the last read is a slice old. */
  async refresh(now: number, force = false): Promise<void> {
    if (!this.o.chain.readerHistory) return;
    if (!force && now - this.lastRefresh < this.o.clock.slice) return;
    const next = new Map<string, ReaderSwap[]>();
    try {
      for (const p of this.o.panels) {
        for (const s of p.slots) {
          const h = await this.o.chain.readerHistory(p.gpuId as Hex, s.slot);
          next.set(keyOf(p.gpuId as Hex, s.slot), h.map((x) => ({ fromDay: Number(x.fromDay), url: x.url, parserVersion: x.parserVersion })));
        }
      }
    } catch (e) {
      if (e instanceof RpcDownError) return; // keep what we know; the next tick tries again
      // an index built before the reader swap (or an ABI without it): nothing can be swapped there
      this.lastRefresh = now;
      if (!this.unsupportedSaid) {
        this.unsupportedSaid = true;
        this.o.say?.("warning", { message: `readerHistory unavailable, reading with the registered readers: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` });
      }
      return;
    }
    this.hist = next;
    this.lastRefresh = now;
    this.loaded = true;
    if (this.o.cacheFile) {
      try {
        mkdirSync(dirname(this.o.cacheFile), { recursive: true });
        writeFileSync(`${this.o.cacheFile}.tmp`, JSON.stringify(Object.fromEntries(this.hist)));
        renameSync(`${this.o.cacheFile}.tmp`, this.o.cacheFile);
      } catch {
        // a convenience only
      }
    }
  }

  history(g: Hex, slot: number): readonly ReaderSwap[] {
    return this.hist.get(keyOf(g, slot)) ?? [];
  }

  /** The readers of swapped slots for a reading of day d (undefined when no slot is swapped on d). Raises
   * READER_MISSING (deadline the swap's first day start, or at once once it has begun) or READER_REFUSED once per
   * swap: only executed swaps are in the history, so writers raise them after the execute (8.6). */
  readersFor(d: number, now: number): SlotReaders | undefined {
    const { api } = this.o;
    const out: Record<string, Record<string, SlotReaders[string][string]>> = {};
    for (const p of this.o.panels) {
      for (const s of p.slots) {
        const h = this.history(p.gpuId as Hex, s.slot);
        // every executed swap is checked, the future ones too: the reminder comes before its first day
        for (const sw of h) this.check(p, s.slot, s.sourceId, sw, now);
        const r = api.readerInForce(s, h, d);
        const def = api.SOURCES.find((x) => x.id === s.sourceId);
        if (!def || (r.url === def.url && r.parserVersion === def.parserVersion)) continue;
        const ok = api.readerAllowed(s.sourceId, r);
        (out[p.gpuId] ??= {})[String(s.slot)] = ok.ok ? { url: r.url, parserVersion: r.parserVersion } : { refused: ok.why };
      }
    }
    return Object.keys(out).length ? out : undefined;
  }

  private check(p: Panel, slot: number, sourceId: string, sw: ReaderSwap, now: number) {
    const { api, clock } = this.o;
    // the shared rule (the host first): the watcher and the attester classify the same swap the same way
    const problem = api.readerProblem(sourceId, sw);
    if (!problem) return;
    const missing = problem.code === "missing";
    const code = missing ? "READER_MISSING" : "READER_REFUSED";
    const id = `${code}:${p.gpuId}:${slot}:${sw.fromDay}:${sw.url}:${sw.parserVersion}`;
    if (this.raised.has(id)) return;
    this.raised.add(id);
    const start = dayStart(clock, sw.fromDay);
    this.o.alert?.({
      code,
      severity: "action",
      gpuId: p.gpuId as Hex,
      day: sw.fromDay,
      slot,
      deadline: missing && now < start ? start : now,
      message: missing
        ? `${p.gpu} slot ${slot} (${sourceId}): the reader swapped in from day ${sw.fromDay} needs parser ${sw.parserVersion}, which this build lacks; install it, commit and restart before its first day, else the slot reads nothing`
        : `${p.gpu} slot ${slot} (${sourceId}): the reader swapped in from day ${sw.fromDay} is refused (${problem.why}); the slot reads nothing from that day`,
      data: { sourceId, fromDay: sw.fromDay, parserVersion: sw.parserVersion, host: hostOnly(sw.url), why: problem.why },
    });
  }
}

/** The host of a URL for alerts (the path may be long; the host is what the operator checks against the allowlist). */
function hostOnly(url: string): string {
  const m = /^[a-z]+:\/\/([^/?#]*)/i.exec(String(url));
  return m ? m[1]! : "";
}
