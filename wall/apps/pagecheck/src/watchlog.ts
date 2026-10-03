// Read-only view of one index's watcher log (BUILD-SPEC 9.1): <logDir>/log/<UTC date>.jsonl, one WatcherReading
// per (source, URL) per interval. Reads only the bytes appended since the last refresh; a torn last line waits.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GpuModel, WatcherReading } from "@agate/report/types";

/** A watcher line with the optional reader fields of 8.6. */
export type Line = WatcherReading & { url?: string; parsers?: Partial<Record<GpuModel, string>>; location?: string };

export class WatchLog {
  private readonly lines = new Map<string, Map<number, Line[]>>();
  private readonly offsets = new Map<string, number>();
  private readonly partial = new Map<string, string>();

  constructor(readonly logDir: string) {}

  refresh(): void {
    const dir = join(this.logDir, "log");
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort()) {
      const p = join(dir, f);
      const size = statSync(p).size;
      const off = this.offsets.get(p) ?? 0;
      if (size <= off) continue;
      const fd = openSync(p, "r");
      const buf = Buffer.alloc(size - off);
      readSync(fd, buf, 0, buf.length, off);
      closeSync(fd);
      this.offsets.set(p, size);
      const parts = ((this.partial.get(p) ?? "") + buf.toString("utf8")).split("\n");
      this.partial.set(p, parts.pop() ?? "");
      for (const ln of parts) {
        if (!ln.trim()) continue;
        try {
          this.add(JSON.parse(ln) as Line);
        } catch {
          // a corrupt line is skipped
        }
      }
    }
  }

  add(r: Line): void {
    if (typeof r?.sourceId !== "string" || !Number.isSafeInteger(r.interval)) return;
    let m = this.lines.get(r.sourceId);
    if (!m) this.lines.set(r.sourceId, (m = new Map()));
    const l = m.get(r.interval) ?? [];
    l.push(r);
    m.set(r.interval, l);
  }

  /** Every attempted line (not MISSED) of a source in interval k. */
  at(sourceId: string, k: number): Line[] {
    return (this.lines.get(sourceId)?.get(k) ?? []).filter((l) => l.attempts > 0);
  }

  /** All lines of a source in interval k, MISSED included. */
  raw(sourceId: string, k: number): Line[] {
    return this.lines.get(sourceId)?.get(k) ?? [];
  }

  intervals(sourceId: string): number[] {
    return [...(this.lines.get(sourceId)?.keys() ?? [])].sort((a, b) => a - b);
  }

  lastInterval(): number {
    let k = -Infinity;
    for (const m of this.lines.values()) for (const x of m.keys()) k = Math.max(k, x);
    return k;
  }

  /** The line a GPU of a source is read from in interval k: the only line, or, with two URLs of one source (only
   *  between two swaps of one batch, 8.6), the one that holds this GPU's cell (a URL-only swap writes no `parsers`),
   *  else the one whose parsers name it, else the registered one. */
  lineFor(sourceId: string, k: number, gpu: GpuModel): Line | undefined {
    const ls = this.at(sourceId, k);
    if (ls.length <= 1) return ls[0];
    return ls.find((l) => l.gpus?.[gpu] !== undefined) ?? ls.find((l) => l.parsers?.[gpu] !== undefined) ?? ls.find((l) => l.url === undefined) ?? ls[0];
  }

  /** The VALID value of a GPU of a source in interval k, or null. */
  validU(sourceId: string, k: number, gpu: GpuModel): number | null {
    const g = this.lineFor(sourceId, k, gpu)?.gpus[gpu];
    return g && g.state === "VALID" && g.valueU > 0 ? g.valueU : null;
  }
}
