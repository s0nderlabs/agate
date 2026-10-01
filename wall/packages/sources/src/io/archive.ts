// Reader for the logger's archive: <AGATE_RAW_DIR>/<UTC date>/<UTC hour>/<sourceId>.<key>.gz (gzip of the raw body).
// Raw pages stay in the archive; nothing here copies them anywhere.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { FxRate } from "../types.ts";
import { parseEcb } from "../pure/ecb.ts";

export interface ArchiveHour {
  date: string; // YYYY-MM-DD (UTC)
  hour: string; // HH (UTC)
  dir: string;
  startSec: number; // unix seconds of the hour's start
}

export function rawDir(): string {
  return process.env.AGATE_RAW_DIR || join(homedir(), ".agate-index-logger", "data", "raw");
}

export function archivePresent(dir = rawDir()): boolean {
  return existsSync(dir) && listHours(dir).length > 0;
}

export function listHours(dir = rawDir()): ArchiveHour[] {
  if (!existsSync(dir)) return [];
  const out: ArchiveHour[] = [];
  for (const date of readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
    for (const hour of readdirSync(join(dir, date)).filter((h) => /^\d{2}$/.test(h))) {
      const startSec = Date.parse(`${date}T${hour}:00:00Z`) / 1000;
      if (Number.isFinite(startSec)) out.push({ date, hour, dir: join(dir, date, hour), startSec });
    }
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

/** The decoded text of an archived page, or null when that hour has no such page (or a torn, unreadable file). */
export function readArchived(h: ArchiveHour, sourceId: string, key = "all"): string | null {
  const f = join(h.dir, `${sourceId}.${key}.gz`);
  if (!existsSync(f)) return null;
  try {
    return new TextDecoder("utf-8").decode(gunzipSync(readFileSync(f)));
  } catch {
    return null; // the logger may be writing this hour right now
  }
}

let fetchedAtCache: { file: string; map: Map<string, number> } | undefined;

/** The logger's own fetch time of a page (readings.jsonl beside the raw dir), else the middle of the hour. */
export function pageTimeOf(h: ArchiveHour, sourceId: string, dir = rawDir()): number {
  const file = join(dirname(dir), "readings.jsonl");
  if (fetchedAtCache?.file !== file) {
    const map = new Map<string, number>();
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as { slice_utc?: string; source?: string; fetches?: { key?: string; fetched_at_utc_s?: number }[] };
          const t = r.fetches?.find((f) => f.key === "all")?.fetched_at_utc_s;
          if (r.slice_utc && r.source && typeof t === "number") map.set(`${r.slice_utc}|${r.source}`, t);
        } catch {
          // a torn last line while the logger writes: ignore
        }
      }
    }
    fetchedAtCache = { file, map };
  }
  const t = fetchedAtCache.map.get(`${h.date}T${h.hour}|${sourceId}`);
  return t !== undefined && t >= h.startSec && t < h.startSec + 3600 ? t : h.startSec + 1800;
}

/** The FX rule over every archived ECB file (the logger keeps the daily file): the best rate for utcDate. */
export function archivedFx(utcDate: string, dir = rawDir()): FxRate | null {
  let best: FxRate | null = null;
  for (const h of listHours(dir)) {
    const body = readArchived(h, "fx_ecb");
    if (!body) continue;
    const fx = parseEcb(body, utcDate);
    if (fx && (!best || fx.date > best.date)) best = fx;
  }
  return best;
}
