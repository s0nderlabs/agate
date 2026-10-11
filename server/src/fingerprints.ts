// Page fingerprints for the developer API: per source row, the sha256 of the exact bytes of that cloud's price page,
// when it was fetched and the price read from it. They come from the watcher's log (wall/apps/watcher, one line per
// source page per hour in <dir>/log/<UTC date>.jsonl), the only reader whose fingerprints the server can read: the CRE
// writer hashes nothing and the standby writer keeps its own on another machine. So a row's page is the watcher's
// newest clean reading of that page on the price's day, the reading the attester judges each day against. Read only;
// a day's file is parsed again only when it changed, and any read problem is a null page, never an error.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Gpu, iso, PANELS, type PanelGpu, toNumber6 } from "@agate/client";

export type PageFingerprint = {
  /** hex sha256 of the page's bytes as fetched */
  sha256: string;
  /** when the page was fetched (ISO, UTC) */
  fetchedAt: string;
  /** the price read from that page, US dollars per GPU-hour */
  price: number;
};

export interface Fingerprints {
  /** the newest page of `date` (YYYY-MM-DD, UTC) this panel slot's GPU was read cleanly from; null when there is none */
  page(q: { gpu: Gpu; date: string; slot: number; company: string }): PageFingerprint | null;
}

/** the fields of a watcher log line read here (WatcherReading in wall/packages/report) */
type Line = {
  sourceId?: unknown;
  interval?: unknown;
  fetchedAt?: unknown;
  attempts?: unknown;
  sha256?: unknown;
  url?: unknown;
  gpus?: Record<string, { state?: unknown; valueU?: unknown } | undefined>;
};
type Day = { size: number; mtimeMs: number; checkedAt: number; pages: Map<string, { k: number; fp: PageFingerprint }> };

const SHA256 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One day's file: per "<sourceId> <GPU>", the newest interval read VALID with a fingerprint. Within an interval the
 *  watcher's fold rule picks the line: per source and URL the first one with an attempt (a MISSED line loses). */
export function pagesOfDay(text: string): Map<string, { k: number; fp: PageFingerprint }> {
  const won = new Map<string, Line>();
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let l: Line;
    try {
      l = JSON.parse(raw) as Line;
    } catch {
      continue; // a torn last line: its interval waits for the next read
    }
    if (typeof l.sourceId !== "string" || typeof l.interval !== "number") continue;
    const key = `${l.sourceId} ${l.interval} ${typeof l.url === "string" ? l.url : ""}`;
    const old = won.get(key);
    if (!old || (old.attempts === 0 && typeof l.attempts === "number" && l.attempts > 0)) won.set(key, l);
  }
  const out = new Map<string, { k: number; fp: PageFingerprint }>();
  for (const l of won.values()) {
    if (typeof l.sha256 !== "string" || !SHA256.test(l.sha256) || typeof l.fetchedAt !== "number" || !(l.fetchedAt > 0)) continue;
    for (const [gpu, row] of Object.entries(l.gpus ?? {})) {
      if (row?.state !== "VALID" || typeof row.valueU !== "number" || !Number.isSafeInteger(row.valueU) || row.valueU <= 0) continue;
      const key = `${l.sourceId} ${gpu}`;
      const k = l.interval as number;
      if ((out.get(key)?.k ?? -Infinity) >= k) continue;
      out.set(key, { k, fp: { sha256: l.sha256, fetchedAt: iso(Math.floor(l.fetchedAt)), price: toNumber6(BigInt(row.valueU)) } });
    }
  }
  return out;
}

/** Fingerprints from the watcher's log folder (AGATE_WATCHER_LOG_DIR, the folder holding log/). A panel slot is found
 *  by its index and must carry the row's company, so a slot the panels do not know has no page. A day's file is looked
 *  at again at most every recheckMs. */
export function watcherFingerprints(dir: string, o: { panels?: PanelGpu[]; recheckMs?: number; now?: () => number } = {}): Fingerprints {
  const root = dir.replace(/^~(?=\/|$)/, homedir());
  const panels = o.panels ?? PANELS;
  const recheck = o.recheckMs ?? 5_000;
  const now = o.now ?? Date.now;
  const days = new Map<string, Day>();

  const keep = (date: string, day: Day): Day => {
    days.delete(date);
    days.set(date, day);
    // the API asks for the newest final day; a few days are plenty
    while (days.size > 4) days.delete(days.keys().next().value!);
    return day;
  };
  const dayOf = (date: string): Day => {
    const t = now();
    const hit = days.get(date);
    if (hit && t - hit.checkedAt < recheck) return hit;
    try {
      const f = join(root, "log", `${date}.jsonl`);
      const st = statSync(f);
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
        hit.checkedAt = t;
        return hit;
      }
      return keep(date, { size: st.size, mtimeMs: st.mtimeMs, checkedAt: t, pages: pagesOfDay(readFileSync(f, "utf8")) });
    } catch {
      // no file (yet) or not readable: no pages until the next look
      return keep(date, { size: -1, mtimeMs: -1, checkedAt: t, pages: new Map() });
    }
  };

  return {
    page({ gpu, date, slot, company }) {
      if (!DATE.test(date)) return null;
      const s = panels.find((p) => p.gpu === gpu)?.slots.find((x) => x.slot === slot);
      if (!s || s.family !== company) return null;
      return dayOf(date).pages.get(`${s.sourceId} ${gpu}`)?.fp ?? null;
    },
  };
}
