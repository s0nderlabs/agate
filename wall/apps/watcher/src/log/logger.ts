// The watcher's logger (BUILD-SPEC 9.1, no key): one fetch of every source page per interval at a cryptographically
// random second in [slice/20, 19 slice/20), one retry on FAILED while it still starts inside the interval, one
// WatcherReading line per source per interval, the raw body gzipped outside the repo. Never fetches for an interval
// that has ended; an interval that ended without a line is written MISSED (honest catch-up after sleep or restart).
import { join } from "node:path";
import type { GpuModel, ReadState, WatcherReading } from "@agate/report/types";
import type { FxRate, ParseResult, SourceDef } from "@agate/sources/types";
import { AlertCode } from "@agate/report/types";
import type { AlertSink } from "../alerts.ts";
import { intervalAt, intervalStart, utcDate } from "../clock.ts";
import { appendLine, type Heartbeat, writeAtomic } from "../fsutil.ts";
import { type ReadGroup, urlTag } from "../readers.ts";
import type { LogStore } from "./store.ts";

export const ECB_ID = "fx_ecb";
export const ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";
const GPUS: readonly GpuModel[] = ["H100", "H200", "B200"];
/** The in-flight key of a line parked on its ECB rate. */
const fxKey = (id: string, k: number) => `${id}:fx:${k}`;

export interface Page {
  ok: boolean;
  httpStatus: number;
  body: string;
  bytes: number;
  raw?: Uint8Array;
  sha256: string;
  pageTime?: number;
  error?: string;
  /** the final URL when the fetch followed a redirect to another URL (15.2: the repair agent's "moved") */
  location?: string;
}

export interface LoggerApi {
  SOURCES: readonly SourceDef[];
  parse(sourceId: string, body: string, ctx: { utcDate: string; nowSec: number; fx?: FxRate }): ParseResult;
  parseEcb(body: string, forUtcDate: string): FxRate | null;
  /** 8.6: parse with one installed parser version (a reader swap's); absent: only registered readers can be read */
  parseWith?(parserVersion: string, body: string, ctx: { utcDate: string; nowSec: number; fx?: FxRate }): ParseResult;
}

export interface LoggerOptions {
  clock: { slice: number; epochTs: number };
  api: LoggerApi;
  /** Which sources to read (default: every source in SOURCES). */
  sourceIds?: readonly string[];
  fetchPage: (url: string, timeoutMs: number) => Promise<Page>;
  /** Replay override: every page at `<base>/<sourceId>` (SOURCE_BASE_URL). */
  baseUrl?: string;
  dir: string; // <home>/watcher/<index>
  store: LogStore;
  alerts: AlertSink;
  heartbeat?: Heartbeat;
  rand: () => number; // uniform [0, 1), cryptographic in production
  timeoutMs: number;
  /** The loop's tick period in seconds: a gap of more than three of them is a wake (CLOCK_JUMP). */
  tickS: number;
  writeRaw?: boolean;
  /** the wall clock in seconds, read when a fetch completes (the retry is timed from its end) */
  now?: () => number;
  /** 8.6 (Oct 3): the reads of a source in interval k with the readers in force (ReaderBook.plan); absent or empty: one
   *  read of the registered URL with the registered parser */
  readers?: (sourceId: string, k: number) => ReadGroup[];
}

interface Sched {
  k: number;
  at: number;
  attempt: 1 | 2;
  /** first attempt's pages by URL (the retry fetches only the URLs that failed) */
  first?: Map<string, { page: Page; fetchedAt: number }>;
  scheduledAt: number;
}

export class Logger {
  private readonly sched = new Map<string, Sched>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly fetching = new Map<string, number>(); // source id -> the interval its in-flight fetch serves
  private lastTick: number | null = null;
  private fx: { date: string; rate: FxRate | null; at: number } | null = null;
  private fxFetch: Promise<void> | null = null;
  private readonly defs: SourceDef[];
  private readonly lastSuccess = new Map<string, number>();
  readonly log: string[] = []; // short event log for tests

  constructor(readonly o: LoggerOptions) {
    const want = o.sourceIds ? new Set(o.sourceIds) : null;
    this.defs = o.api.SOURCES.filter((s) => !want || want.has(s.id));
    if (want) for (const id of want) if (!this.defs.some((d) => d.id === id)) throw new Error(`unknown source ${id}`);
  }

  private get slice() {
    return this.o.clock.slice;
  }
  /** The URL fetched: the reader's, or under the replay override `<base>/<sourceId>` (one route per source, 7.9). */
  private url(def: { id: string; url: string }, readerUrl?: string) {
    return this.o.baseUrl ? `${this.o.baseUrl.replace(/\/+$/, "")}/${def.id}` : (readerUrl ?? def.url);
  }
  private plan(def: SourceDef, k: number): ReadGroup[] {
    const p = this.o.readers?.(def.id, k);
    if (p && p.length > 0) return p;
    return [{ url: def.url, registeredUrl: true, gpus: this.gpusOf(def).map((gpu) => ({ gpu, parserVersion: def.parserVersion, registeredParser: true })) }];
  }
  private file(k: number) {
    return join(this.o.dir, "log", `${utcDate(intervalStart(this.o.clock, k))}.jsonl`);
  }

  /** Resolves when every fetch started so far has been written. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0 || this.fxFetch) await Promise.all([...this.inFlight.values(), this.fxFetch]);
  }

  async tick(now: number): Promise<void> {
    this.o.store.refresh();
    const kNow = intervalAt(this.o.clock, now);
    if (this.lastTick === null || now - this.lastTick > 3 * this.o.tickS) {
      if (this.lastTick !== null)
        this.o.alerts.raise({ code: AlertCode.CLOCK_JUMP, severity: "info", message: `logger woke after ${now - this.lastTick} s (sleep or suspend)`, data: { slept: now - this.lastTick } });
    }
    this.lastTick = now;
    this.catchUp(kNow, now);
    for (const def of this.defs) this.schedule(def, kNow, now);
    for (const def of this.defs) {
      const s = this.sched.get(def.id);
      if (s && s.k === kNow && now >= s.at && !this.inFlight.has(def.id)) {
        const p = this.fetchOne(def, s, now).finally(() => this.inFlight.delete(def.id));
        this.inFlight.set(def.id, p);
        this.fetching.set(def.id, s.k);
      }
    }
    this.o.heartbeat?.beat(now, `interval ${kNow}`);
  }

  /** A line for (source, interval k) is on its way: its fetch, or (EUR) its ECB rate, is still in flight. */
  private pending(id: string, k: number): boolean {
    return (this.inFlight.has(id) && this.fetching.get(id) === k) || this.inFlight.has(fxKey(id, k));
  }

  /** Every interval before kNow without a line is written now: a pending first attempt as FAILED, else MISSED.
   *  Never a fetch for an ended interval. */
  private catchUp(kNow: number, now: number): void {
    const missedAll = new Map<number, number>();
    for (const def of this.defs) {
      const s = this.sched.get(def.id);
      if (s && s.k < kNow && !this.pending(def.id, s.k)) {
        if (!this.o.store.has(def.id, s.k)) {
          if (s.first) this.writeAll(def, s, s.first, 1);
          else this.writeMissed(def.id, s.k);
        }
        this.sched.delete(def.id);
      }
      const last = this.o.store.lastInterval(def.id);
      if (!Number.isFinite(last)) continue; // a fresh log starts at the current interval
      for (let k = last + 1; k < kNow; k++) {
        if (this.pending(def.id, k)) continue;
        if (this.o.store.has(def.id, k)) continue;
        this.writeMissed(def.id, k);
        missedAll.set(k, (missedAll.get(k) ?? 0) + 1);
      }
    }
    const ks = [...missedAll.entries()].filter(([, n]) => n === this.defs.length).map(([k]) => k).sort((a, b) => a - b);
    let run = 0;
    let longest = 0;
    for (let j = 0; j < ks.length; j++) {
      run = j > 0 && ks[j] === ks[j - 1]! + 1 ? run + 1 : 1;
      longest = Math.max(longest, run);
    }
    if (longest >= 2)
      this.o.alerts.raise({ code: AlertCode.WATCHER_GAP, severity: "action", deadline: now + Math.floor(this.slice * 6), message: `watcher missed ${ks.length} intervals for every source (${ks[0]} to ${ks[ks.length - 1]}): run R12's looks for the pages`, data: { from: ks[0], to: ks[ks.length - 1] } });
  }

  private schedule(def: SourceDef, kNow: number, now: number): void {
    const s = this.sched.get(def.id);
    if (s && s.k === kNow) return;
    if (this.o.store.has(def.id, kNow)) return;
    const start = intervalStart(this.o.clock, kNow);
    const lo = start + this.slice / 20;
    const hi = start + (19 * this.slice) / 20;
    let at = lo + this.o.rand() * (hi - lo);
    if (at < now) {
      if (now >= hi) return; // too late in this interval: it will be written MISSED once it ends
      at = now + this.o.rand() * (hi - now);
    }
    this.sched.set(def.id, { k: kNow, at: Math.floor(at), attempt: 1, scheduledAt: Math.floor(at) });
  }

  /** One fetch per distinct URL in force (8.6); a URL that failed is retried once if the retry still starts inside
   *  the interval. A group whose every reader this build may not use is not fetched (its line says why). */
  private async fetchOne(def: SourceDef, s: Sched, now: number): Promise<void> {
    const pages = new Map(s.first ?? []);
    for (const g of this.plan(def, s.k)) {
      if (g.gpus.every((x) => x.problem)) continue;
      if (pages.get(g.url)?.page.ok) continue; // the retry fetches only what failed
      pages.set(g.url, { page: await this.safeFetch(this.url(def, g.url)), fetchedAt: now });
    }
    const doneAt = this.o.now ? Math.floor(this.o.now()) : now;
    const end = intervalStart(this.o.clock, s.k + 1);
    const failed = [...pages.values()].some((x) => !x.page.ok);
    if (!failed || s.attempt === 2) {
      this.writeAll(def, s, pages, s.attempt);
      this.sched.set(def.id, { ...s, at: Infinity });
      return;
    }
    const gap = ((30 + this.o.rand() * 90) * this.slice) / 3_600;
    const retryAt = Math.ceil(Math.max(doneAt, now) + gap);
    if (retryAt < end) this.sched.set(def.id, { ...s, attempt: 2, at: retryAt, first: pages });
    else {
      this.writeAll(def, s, pages, 1);
      this.sched.set(def.id, { ...s, at: Infinity });
    }
  }

  private writeAll(def: SourceDef, s: Sched, pages: Map<string, { page: Page; fetchedAt: number }>, attempts: number): void {
    for (const g of this.plan(def, s.k)) {
      const got = pages.get(g.url);
      if (got) this.writeLine(def, s, got.page, got.fetchedAt, attempts, g);
      else if (g.gpus.every((x) => x.problem)) this.writeRefused(def, s, g);
    }
  }

  /** 8.6: a reader this build may not use reads as no reading: MISSED (unknown to rule R, never dark), with why. */
  private writeRefused(def: SourceDef, s: Sched, g: ReadGroup): void {
    const gpus: WatcherReading["gpus"] = {};
    for (const x of g.gpus) gpus[x.gpu] = { state: "MISSED", valueU: 0 };
    const line: WatcherReading = { sourceId: def.id, interval: s.k, scheduledAt: s.scheduledAt, fetchedAt: 0, attempts: 0, httpStatus: 0, bytes: 0, sha256: "", gpus, error: g.gpus.map((x) => `${x.gpu} ${x.problem!.code === "missing" ? "READER_MISSING" : "READER_REFUSED"}: ${x.problem!.why}`).join("; ") };
    if (!g.registeredUrl) line.url = g.url;
    line.parsers = Object.fromEntries(g.gpus.map((x) => [x.gpu, x.parserVersion]));
    this.persist(def, line, { ok: false, httpStatus: 0, body: "", bytes: 0, sha256: "" });
  }

  private async safeFetch(url: string): Promise<Page> {
    try {
      return await this.o.fetchPage(url, this.o.timeoutMs);
    } catch (e) {
      return { ok: false, httpStatus: 0, body: "", bytes: 0, sha256: "", error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async fxFor(date: string, now: number): Promise<FxRate | null> {
    if (this.fx?.date === date && (this.fx.rate || now - this.fx.at < this.slice / 2)) return this.fx.rate;
    if (!this.fxFetch) {
      this.fxFetch = (async () => {
        const page = await this.safeFetch(this.url({ id: ECB_ID, url: ECB_URL }));
        let rate: FxRate | null = null;
        if (page.ok) {
          try {
            rate = this.o.api.parseEcb(page.body, date);
          } catch {
            rate = null;
          }
          if (this.o.writeRaw !== false) this.saveRaw(ECB_ID, intervalAt(this.o.clock, now), page);
        }
        this.fx = { date, rate, at: now };
      })().finally(() => {
        this.fxFetch = null;
      });
    }
    await this.fxFetch;
    return this.fx?.rate ?? null;
  }

  private gpusOf(def: SourceDef): GpuModel[] {
    return GPUS.filter((g) => def.rules[g] !== undefined);
  }

  private writeLine(def: SourceDef, s: Sched, page: Page, fetchedAt: number, attempts: number, group?: ReadGroup): void {
    const gpus: WatcherReading["gpus"] = {};
    const line: WatcherReading = {
      sourceId: def.id,
      interval: s.k,
      scheduledAt: s.scheduledAt,
      fetchedAt,
      attempts,
      httpStatus: page.httpStatus,
      bytes: page.bytes,
      sha256: page.sha256,
      gpus,
    };
    if (page.error) line.error = page.error;
    if (page.location) line.location = page.location;
    // 8.6: the GPUs this URL is read for, each with its parser in force; a GPU whose reader may not be used is MISSED
    const reads = group?.gpus ?? this.gpusOf(def).map((gpu) => ({ gpu, parserVersion: def.parserVersion, registeredParser: true }));
    if (group && !group.registeredUrl) line.url = group.url;
    if (reads.some((x) => !x.registeredParser)) line.parsers = Object.fromEntries(reads.map((x) => [x.gpu, x.parserVersion]));
    const usable = reads.filter((x) => !("problem" in x) || !x.problem);
    const refused = reads.filter((x) => "problem" in x && x.problem);
    for (const x of refused) gpus[x.gpu] = { state: "MISSED", valueU: 0 };
    if (refused.length > 0) line.error = [line.error, ...refused.map((x) => `${x.gpu} ${"problem" in x && x.problem!.code === "missing" ? "READER_MISSING" : "READER_REFUSED"}: ${"problem" in x ? x.problem!.why : ""}`)].filter(Boolean).join("; ");
    const set = (state: ReadState, v = 0) => {
      for (const x of usable) gpus[x.gpu] = { state, valueU: v };
    };
    if (!page.ok) set("FAILED");
    else {
      const nowSec = page.pageTime ?? fetchedAt;
      const date = utcDate(nowSec);
      const parse = (fx?: FxRate) => {
        const ctx = fx ? { utcDate: date, nowSec, fx } : { utcDate: date, nowSec };
        const byVersion = new Map<string, ParseResult>();
        for (const x of usable) {
          let res = byVersion.get(x.parserVersion);
          if (!res) {
            try {
              res = x.registeredParser || !this.o.api.parseWith ? this.o.api.parse(def.id, page.body, ctx) : this.o.api.parseWith(x.parserVersion, page.body, ctx);
            } catch (e) {
              res = {};
              line.error = `parser threw: ${String(e)}`;
            }
            byVersion.set(x.parserVersion, res);
          }
          const r = res[x.gpu];
          gpus[x.gpu] = r ? { state: r.state, valueU: r.state === "VALID" ? r.valueU : 0 } : { state: "NO_ROW", valueU: 0 };
        }
      };
      if (def.currency === "EUR") {
        // written after the rate resolves; a missing rate is FAILED here (not NO_ROW) so rule R reads it as missing
        // evidence, never as an observed dark page (HF-1)
        const p = this.fxFor(date, fetchedAt).then((fx) => {
          if (fx) {
            line.fxDate = fx.date;
            parse(fx);
          } else {
            set("FAILED");
            line.error = "no ECB rate";
          }
          this.persist(def, line, page);
        });
        const key = fxKey(def.id, s.k);
        this.inFlight.set(key, p.finally(() => this.inFlight.delete(key)));
        return;
      }
      parse();
    }
    this.persist(def, line, page);
  }

  private persist(def: SourceDef, line: WatcherReading, page: Page): void {
    if ((this.o.store.get(def.id, line.interval, line.url)?.attempts ?? 0) > 0) return;
    appendLine(this.file(line.interval), line);
    this.o.store.add(line);
    if (page.ok && this.o.writeRaw !== false) this.saveRaw(line.url ? `${def.id}.${urlTag(line.url)}` : def.id, line.interval, page);
    if (page.ok) this.lastSuccess.set(def.id, line.fetchedAt);
    writeAtomic(join(this.o.dir, "status", `${def.id}.json`), JSON.stringify({ sourceId: def.id, interval: line.interval, at: line.fetchedAt, states: line.gpus, lastSuccess: this.lastSuccess.get(def.id) ?? null }));
    this.log.push(`${def.id}@${line.interval}:${Object.values(line.gpus).map((g) => g?.state).join(",") || "?"}`);
  }

  private writeMissed(sourceId: string, k: number): void {
    const line: WatcherReading = { sourceId, interval: k, scheduledAt: 0, fetchedAt: 0, attempts: 0, httpStatus: 0, bytes: 0, sha256: "", gpus: {} };
    appendLine(this.file(k), line);
    this.o.store.add(line);
    this.log.push(`${sourceId}@${k}:MISSED`);
  }

  private saveRaw(sourceId: string, k: number, page: Page): void {
    const date = utcDate(intervalStart(this.o.clock, k));
    const bytes = page.raw ?? new TextEncoder().encode(page.body);
    writeAtomic(join(this.o.dir, "raw", date, String(k), `${sourceId}.gz`), Bun.gzipSync(bytes as Uint8Array<ArrayBuffer>));
  }
}

/** The production fetcher: honest user agent, a timeout, the page's own time header (7.7, 7.9). */
export async function httpFetchPage(url: string, timeoutMs: number): Promise<Page> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "agate-wall/watcher/0.1 (+https://github.com/s0nderlabs/agate)", accept: "*/*" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    const raw = new Uint8Array(await res.arrayBuffer());
    const pt = res.headers.get("x-agate-page-time");
    const page: Page = {
      ok: res.status >= 200 && res.status < 300 && raw.length > 0,
      httpStatus: res.status,
      body: new TextDecoder("utf-8").decode(raw),
      bytes: raw.length,
      raw,
      sha256: new Bun.CryptoHasher("sha256").update(raw).digest("hex"),
    };
    if (pt && /^\d+$/.test(pt)) page.pageTime = Number(pt);
    if (res.redirected && res.url && res.url !== url) page.location = res.url;
    if (!page.ok) page.error = `HTTP ${res.status}`;
    return page;
  } catch (e) {
    return { ok: false, httpStatus: 0, body: "", bytes: 0, sha256: "", error: e instanceof Error ? e.message : String(e) };
  }
}

export function cryptoRand(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
}
