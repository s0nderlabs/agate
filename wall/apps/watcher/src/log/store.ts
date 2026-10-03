// The watcher's log on disk (BUILD-SPEC 9.1): <dir>/log/<UTC date of interval start>.jsonl, one WatcherReading per
// source per interval. This reader folds it into cells for rule R, reading only the bytes appended since last time.
import { existsSync, openSync, readdirSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GpuModel, WatcherReading } from "@agate/report/types";
import type { LogCell, SlotLog } from "../rule/types.ts";

export interface LogSource {
  /** Cells of (source, gpu) for intervals [from, to], clipped at the newest logged interval of that source. urlAt(k):
   *  the URL whose line holds interval k's reading of this slot (8.6: the reader in force that day); undefined = the
   *  registered URL's line. A slot whose URL has no line in an interval is MISSED there (unknown, never dark). */
  slotLog(sourceId: string, gpu: GpuModel, from: number, to: number, urlAt?: (k: number) => string | undefined): SlotLog;
  /** some line of the source exists for interval k */
  has(sourceId: string, k: number): boolean;
  lastInterval(sourceId?: string): number;
}

export function cellOf(r: WatcherReading | undefined, gpu: GpuModel): LogCell {
  if (!r || r.attempts === 0) return "MISSED";
  const row = r.gpus[gpu];
  if (!row) return Object.keys(r.gpus).length === 0 ? "FAILED" : "NO_ROW";
  if (row.state === "VALID") return row.valueU;
  return row.state;
}

/** Fold rule: a non-MISSED line beats a MISSED one; otherwise the first line of an interval wins. */
function better(old: WatcherReading | undefined, nu: WatcherReading): boolean {
  if (!old) return true;
  return old.attempts === 0 && nu.attempts > 0;
}

export class LogStore implements LogSource {
  // sourceId -> interval -> URL key ("" = the registered URL: a line without `url`) -> line
  private readonly lines = new Map<string, Map<number, Map<string, WatcherReading>>>();
  private readonly offsets = new Map<string, number>();
  private readonly last = new Map<string, number>();
  private readonly partial = new Map<string, string>();

  constructor(readonly dir: string) {}

  get logDir(): string {
    return join(this.dir, "log");
  }

  /** Reads every new byte of every log file. Torn last lines wait for their newline. */
  refresh(): void {
    if (!existsSync(this.logDir)) return;
    for (const f of readdirSync(this.logDir).filter((x) => x.endsWith(".jsonl")).sort()) {
      const p = join(this.logDir, f);
      const size = statSync(p).size;
      const off = this.offsets.get(p) ?? 0;
      if (size <= off) continue;
      const fd = openSync(p, "r");
      const buf = Buffer.alloc(size - off);
      readSync(fd, buf, 0, buf.length, off);
      closeSync(fd);
      this.offsets.set(p, size);
      const text = (this.partial.get(p) ?? "") + buf.toString("utf8");
      const parts = text.split("\n");
      this.partial.set(p, parts.pop() ?? "");
      for (const ln of parts) {
        if (!ln.trim()) continue;
        try {
          this.add(JSON.parse(ln) as WatcherReading);
        } catch {
          // a corrupt line is skipped; its interval stays UNK
        }
      }
    }
  }

  add(r: WatcherReading): void {
    let m = this.lines.get(r.sourceId);
    if (!m) this.lines.set(r.sourceId, (m = new Map()));
    let byUrl = m.get(r.interval);
    if (!byUrl) m.set(r.interval, (byUrl = new Map()));
    const u = r.url ?? "";
    if (better(byUrl.get(u), r)) byUrl.set(u, r);
    this.last.set(r.sourceId, Math.max(this.last.get(r.sourceId) ?? -Infinity, r.interval));
  }

  /** The line of (source, interval, URL); url undefined = the registered URL's line. */
  get(sourceId: string, k: number, url?: string): WatcherReading | undefined {
    return this.lines.get(sourceId)?.get(k)?.get(url ?? "");
  }
  has(sourceId: string, k: number): boolean {
    return (this.lines.get(sourceId)?.get(k)?.size ?? 0) > 0;
  }
  lastInterval(sourceId?: string): number {
    if (sourceId !== undefined) return this.last.get(sourceId) ?? -Infinity;
    return Math.max(-Infinity, ...this.last.values());
  }

  slotLog(sourceId: string, gpu: GpuModel, from: number, to: number, urlAt?: (k: number) => string | undefined): SlotLog {
    const end = Math.min(to, this.lastInterval(sourceId));
    const cells: LogCell[] = [];
    for (let k = from; k <= end; k++) cells.push(cellOf(this.get(sourceId, k, urlAt?.(k)), gpu));
    return { k0: from, cells };
  }
}
