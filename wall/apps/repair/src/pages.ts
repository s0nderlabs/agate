// Saved pages the repair agent reads (BUILD-SPEC 15.2): the watcher's raw pages of an index (<logDir>/raw/<date>/
// <interval>/<sourceId>[.<sha8>].gz, 14 days), the logger archive (<AGATE_RAW_DIR>/<date>/<hour>/<sourceId>.<key>.gz,
// read only) and the pages the agent fetched itself at a moved source's new URL. Read only; never copied to the repo.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Line, WatchLog } from "@agate/pagecheck";

export interface SavedPage {
  id: string;
  origin: "watcher" | "archive" | "fetched";
  file: string;
  t: number; // the page's time (unix s)
  k?: number; // the index interval, for watcher and fetched pages
  utcDate: string;
  nowSec: number;
  line?: Line;
}

const utcDate = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/** The watcher's raw file name of a source for a URL (the registered URL: `<sourceId>.gz`). */
export function watcherRawName(sourceId: string, url?: string, registeredUrl?: string): string {
  if (!url || url === registeredUrl) return `${sourceId}.gz`;
  return `${sourceId}.${createHash("sha256").update(url).digest("hex").slice(0, 8)}.gz`;
}

export interface IntervalClock {
  slice: number;
  epochTs: number;
}

/** The watcher's saved page of one source in interval k (2xx pages only are saved), with its log line. */
export function watcherPage(logDir: string, log: WatchLog, c: IntervalClock, sourceId: string, k: number, rawName = `${sourceId}.gz`): SavedPage | null {
  const start = c.epochTs + k * c.slice;
  const file = join(logDir, "raw", utcDate(start), String(k), rawName);
  if (!existsSync(file)) return null;
  const line = log.at(sourceId, k).find((l) => l.httpStatus >= 200 && l.httpStatus < 300);
  const t = line && line.fetchedAt > 0 ? line.fetchedAt : start + Math.floor(c.slice / 2);
  const p: SavedPage = { id: `w:${k}`, origin: "watcher", file, t, k, utcDate: utcDate(t), nowSec: t };
  if (line) p.line = line;
  return p;
}

/** Watcher pages of intervals [kFrom, kTo], newest first. */
export function watcherPages(logDir: string, log: WatchLog, c: IntervalClock, sourceId: string, kFrom: number, kTo: number, rawName?: string, max = 200): SavedPage[] {
  const out: SavedPage[] = [];
  for (let k = kTo; k >= kFrom && out.length < max; k--) {
    const p = watcherPage(logDir, log, c, sourceId, k, rawName);
    if (p) out.push(p);
  }
  return out;
}

/** Logger archive pages of a source with hour start < before, newest first (`<sourceId>.all.gz` preferred). */
export function archivePages(rawDir: string, sourceId: string, before: number, max = 200): SavedPage[] {
  if (!existsSync(rawDir)) return [];
  const out: SavedPage[] = [];
  const dates = readdirSync(rawDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  for (const d of dates) {
    const hours = readdirSync(join(rawDir, d)).filter((h) => /^\d{2}$/.test(h)).sort().reverse();
    for (const h of hours) {
      if (out.length >= max) return out;
      const t = Date.parse(`${d}T${h}:00:00Z`) / 1000;
      if (!(t < before)) continue;
      const dir = join(rawDir, d, h);
      const names = readdirSync(dir).filter((f) => f.startsWith(`${sourceId}.`) && f.endsWith(".gz"));
      const name = names.includes(`${sourceId}.all.gz`) ? `${sourceId}.all.gz` : names.sort()[0];
      if (!name) continue;
      const nowSec = t + 60;
      out.push({ id: `a:${d}T${h}`, origin: "archive", file: join(dir, name), t: nowSec, utcDate: d, nowSec });
    }
  }
  return out;
}

/** Pages the agent fetched itself at a moved source's new URL: <repair>/fetched/<incidentId>/<k>.gz. */
export function fetchedPages(dir: string): SavedPage[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^(\d+)-(\d+)\.gz$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => {
      const t = Number(m[2]);
      return { id: `f:${m[1]}`, origin: "fetched" as const, file: join(dir, m[0]), t, k: Number(m[1]), utcDate: utcDate(t), nowSec: t };
    })
    .sort((a, b) => b.k! - a.k!);
}

/** The decoded text of a saved page (UTF-8), or null. */
export function pageText(p: SavedPage): string | null {
  try {
    const raw = readFileSync(p.file);
    return new TextDecoder("utf-8").decode(p.file.endsWith(".gz") ? Bun.gunzipSync(raw) : raw);
  } catch {
    return null;
  }
}

export function sha256Hex(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}
