// 8.6 for the watcher (Oct 3): the logger reads each slot with its reader in force for the interval's day, one line per
// (sourceId, URL) with `url` and `parsers` when not the registered ones; a version this build lacks reads as MISSED
// with READER_MISSING, a host off the allowlist as MISSED with READER_REFUSED; rule R reads each slot from its own
// URL's line; the attester alerts after an execute. Synthetic sources and pages only.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "@agate/report/types";
import { AlertCode } from "@agate/report/types";
import type { ParseResult, SourceDef } from "@agate/sources/types";
import { AlertSink } from "../src/alerts.ts";
import { Attester } from "../src/attester.ts";
import { Logger, type Page } from "../src/log/logger.ts";
import { cellOf, LogStore } from "../src/log/store.ts";
import { sourcesApi } from "@agate/sources/pure";
import { isReaderApi, problemOf, type ReaderApi, ReaderBook, readerCheckOf, readerRefresher, urlTag } from "../src/readers.ts";
import { ATTESTER, Pages, World } from "../src/sim/world.ts";

const rule = { product: "x", form: "SXM", priceClass: "on-demand", instance: "per-GPU of the 8-GPU instance, else of the 1-GPU instance", rentable: "assumed-rentable", effectiveDate: "a price shown from date X counts from 00:00 UTC of X", tax: "excluding VAT", notes: "" } as const;
const SOURCES: SourceDef[] = [
  { id: "p_a", company: "A", url: "https://a.example/p", currency: "USD", parserVersion: "a/1", rules: { H100: rule, H200: rule }, hosts: ["a.example"] },
  { id: "p_b", company: "B", url: "https://b.example/p", currency: "USD", parserVersion: "b/1", rules: { H100: rule }, hosts: ["b.example"] },
];
const INSTALLED: Record<string, string> = { "a/1": "p_a", "a/2": "p_a", "b/1": "p_b" };
/** pages are JSON {key: value}; a/1 reads keys "H100"/"H200", a/2 reads "v2H100"/"v2H200" (a redesigned page) */
function parseAs(version: string, body: string): ParseResult {
  const j = JSON.parse(body) as Record<string, number>;
  const pre = version === "a/2" ? "v2" : "";
  const out: ParseResult = {};
  for (const g of ["H100", "H200"] as const) {
    const v = j[`${pre}${g}`];
    if (v !== undefined) out[g] = { state: "VALID", valueU: v } as never;
  }
  return out;
}
const API: ReaderApi & { parse: (id: string, body: string) => ParseResult; parseEcb: () => null } = {
  SOURCES,
  parse: (id, body) => parseAs(SOURCES.find((s) => s.id === id)!.parserVersion, body),
  parseEcb: () => null,
  parseWith: (v, body) => (INSTALLED[v] ? parseAs(v, body) : {}),
  sourceOfVersion: (v) => INSTALLED[v] ?? null,
  readerProblem: (id, r) => {
    const host = /^https:\/\/([^/]+)/.exec(r.url)?.[1];
    const d = SOURCES.find((s) => s.id === id)!;
    if (!host || !d.hosts.includes(host)) return { code: "refused", why: `host ${host} not on ${id}'s hosts` };
    if (!INSTALLED[r.parserVersion]) return { code: "missing", why: `parser ${r.parserVersion} is not installed` };
    if (INSTALLED[r.parserVersion] !== id) return { code: "refused", why: "another source's parser" };
    return null;
  },
  readerAllowed: (id, r) => {
    const p = API.readerProblem(id, r);
    return p ? { ok: false, why: p.why } : { ok: true };
  },
  readerInForce: (slot, history, day) => {
    let best: { url: string; parserVersion: string } | null = null;
    let bd = -1;
    for (const h of history) if (h.fromDay <= day && h.fromDay > bd) [best, bd] = [{ url: h.url, parserVersion: h.parserVersion }, h.fromDay];
    const d = SOURCES.find((s) => s.id === slot.sourceId)!;
    return best ?? { url: d.url, parserVersion: d.parserVersion };
  },
};
const G100 = `0x${"10".repeat(32)}` as Hex;
const G200 = `0x${"20".repeat(32)}` as Hex;
const PANELS = [
  { gpu: "H100" as const, gpuId: G100, sources: ["p_a", "p_b"] },
  { gpu: "H200" as const, gpuId: G200, sources: ["p_a"] },
];
const SLICES = 12;
const SLICE = 200;
const D = 10; // epochDay 0: interval k belongs to day floor(k / 12)
const page = (body: string): Page => ({ ok: true, httpStatus: 200, body, bytes: body.length, sha256: "x" });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agate-readers-"));
  const store = new LogStore(dir);
  const alerts = new AlertSink(null, { now: () => 0, print: false });
  const book = new ReaderBook(API, PANELS, { slices: SLICES, epochDay: 0 });
  const calls: string[] = [];
  let now = 0;
  const lg = new Logger({
    clock: { slice: SLICE, epochTs: 0 },
    api: API,
    readers: (id, k) => (book.swapped ? book.plan(id, k) : []),
    fetchPage: async (url) => {
      calls.push(url);
      return url.includes("/v2") ? page(JSON.stringify({ v2H100: 4_100_000, v2H200: 5_100_000 })) : page(JSON.stringify({ H100: 3_400_000, H200: 4_000_000 }));
    },
    dir,
    store,
    alerts,
    rand: () => 0.5,
    timeoutMs: 1_000,
    tickS: 1,
    now: () => now,
  });
  const run = async (from: number, to: number) => {
    for (let t = from; t < to; t += 20) {
      now = t;
      await lg.tick(t);
      await lg.drain();
    }
  };
  return { dir, store, book, calls, run };
}
const kOf = (d: number, h: number) => d * SLICES + h;
const tOf = (k: number) => k * SLICE;

describe("8.6 the logger reads with the readers in force", () => {
  test("a swap applies from its fromDay only; two URLs of one source give two lines; rule R reads each slot from its own", async () => {
    const s = setup();
    // swap H100's p_a slot to a/2 on a new URL from day D + 1 (executed during day D: nothing changes that day)
    s.book.setHistory(G100, 0, [{ fromDay: D + 1, url: "https://a.example/v2", parserVersion: "a/2" }]);
    await s.run(tOf(kOf(D, 10)), tOf(kOf(D + 1, 2)));
    const kD = kOf(D, 11);
    const k1 = kOf(D + 1, 1);
    // day D: one line per source, the registered reader
    expect(s.store.get("p_a", kD)?.url).toBeUndefined();
    expect(s.store.get("p_a", kD, "https://a.example/v2")).toBeUndefined();
    expect(cellOf(s.store.get("p_a", kD), "H100")).toBe(3_400_000);
    // day D + 1: p_a read twice (H200 on the registered URL, H100 on the new one with a/2), p_b once
    const reg = s.store.get("p_a", k1)!;
    const v2 = s.store.get("p_a", k1, "https://a.example/v2")!;
    expect(Object.keys(reg.gpus)).toEqual(["H200"]);
    expect(reg.url).toBeUndefined();
    expect(cellOf(reg, "H200")).toBe(4_000_000);
    expect(v2.url).toBe("https://a.example/v2");
    expect(v2.parsers).toEqual({ H100: "a/2" });
    expect(cellOf(v2, "H100")).toBe(4_100_000);
    expect(s.calls.filter((u) => u.includes("a.example/v2")).length).toBeGreaterThan(0);
    // the raw body of the second URL: <sourceId>.<sha256(url) first 8 hex>.gz
    const raws = readdirSync(join(s.dir, "raw", "1970-01-01", String(k1)));
    expect(raws.sort()).toEqual(["p_a.gz", `p_a.${urlTag("https://a.example/v2")}.gz`, "p_b.gz"].sort());
    // rule R: slot 0 of H100 from the v2 line on D + 1, from the registered line on D
    const urlAt = (k: number) => s.book.urlKey(PANELS[0]!, 0, s.book.dayOfInterval(k));
    const log = s.store.slotLog("p_a", "H100", kD, k1, urlAt);
    expect([log.cells[0], log.cells[log.cells.length - 1]]).toEqual([3_400_000, 4_100_000]);
    // H200's slot keeps the registered line
    expect(s.store.slotLog("p_a", "H200", k1, k1, (k) => s.book.urlKey(PANELS[1]!, 0, s.book.dayOfInterval(k))).cells).toEqual([4_000_000]);
    // the lines on disk carry the optional fields
    const text = readFileSync(join(s.dir, "log", "1970-01-01.jsonl"), "utf8");
    expect(text).toContain('"url":"https://a.example/v2"');
    expect(text).toContain('"parsers":{"H100":"a/2"}');
  });

  test("an uninstalled version reads as MISSED with READER_MISSING; a host off the allowlist as MISSED with READER_REFUSED; never another reader", async () => {
    const s = setup();
    s.book.setHistory(G100, 0, [{ fromDay: D, url: "https://a.example/p", parserVersion: "a/9" }]);
    s.book.setHistory(G100, 1, [{ fromDay: D, url: "https://evil.example/p", parserVersion: "b/1" }]);
    await s.run(tOf(kOf(D, 0)), tOf(kOf(D, 2)));
    const k = kOf(D, 1);
    const a = s.store.get("p_a", k)!; // same URL: one line, H100 MISSED, H200 read with a/1
    expect(a.gpus.H100).toEqual({ state: "MISSED", valueU: 0 });
    expect(cellOf(a, "H100")).toBe("MISSED");
    expect(cellOf(a, "H200")).toBe(4_000_000);
    expect(a.error).toContain("H100 READER_MISSING: parser a/9 is not installed");
    expect(a.parsers).toEqual({ H100: "a/9", H200: "a/1" });
    const b = s.store.get("p_b", k, "https://evil.example/p")!;
    expect(b.gpus.H100).toEqual({ state: "MISSED", valueU: 0 });
    expect(b.error).toContain("READER_REFUSED");
    expect(s.calls.some((u) => u.includes("evil.example"))).toBe(false); // never fetched
    expect(s.store.get("p_b", k)).toBeUndefined(); // and never read with the registered reader instead
  });
});

describe("8.6 one rule for READER_MISSING and READER_REFUSED", () => {
  test("the watcher classifies by @agate/sources' readerProblem, as the writers do: a hostile URL is refused whatever version it names", () => {
    const check = readerCheckOf(sourcesApi);
    expect(check("p_lambda", { url: "https://evil.example/p", parserVersion: "lambda/9" })).toBe("refused");
    expect(check("p_lambda", { url: "https://lambda.ai/pricing", parserVersion: "lambda/9" })).toBe("missing");
    expect(check("p_lambda", { url: "https://lambda.ai/pricing", parserVersion: "lambda/1" })).toBe("ok");
    expect(problemOf(sourcesApi, "p_lambda", { url: "https://evil.example/p", parserVersion: "lambda/9" })?.code).toBe("refused");
    expect(isReaderApi(sourcesApi as unknown as Partial<ReaderApi>)).toBe(true);
    expect(isReaderApi({ ...(sourcesApi as unknown as ReaderApi), readerProblem: undefined } as unknown as Partial<ReaderApi>)).toBe(false);
  });
});

describe("8.6 the logger's reader history refresher", () => {
  const view = (fail: () => boolean, calls: { n: number }, hold?: Promise<void>) => ({
    readerHistory: async (g: Hex, slot: number) => {
      calls.n++;
      if (hold) await hold;
      if (fail()) throw new Error("every RPC URL failed");
      return g === G100 && slot === 0 ? [{ fromDay: D, url: "https://a.example/v2", parserVersion: "a/2", reason: "r" }] : [];
    },
  });

  test("once per slice; reads every slot in parallel; a failure keeps what is known and backs off (5 s doubling to a slice), one line per run", async () => {
    const book = new ReaderBook(API, PANELS, { slices: SLICES, epochDay: 0 });
    let down = false;
    const calls = { n: 0 };
    const said: string[] = [];
    const refresh = readerRefresher({ book, view: view(() => down, calls), slice: SLICE, say: (e) => void said.push(e) });
    await refresh(0, true);
    expect(calls.n).toBe(3); // H100's two slots and H200's one
    expect(book.history(G100, 0).map((h) => h.parserVersion)).toEqual(["a/2"]);
    await refresh(SLICE - 1);
    expect(calls.n).toBe(3);
    down = true;
    await refresh(SLICE);
    const failed = calls.n;
    for (let t = SLICE + 1; t < SLICE + 5; t++) await refresh(t); // no call per tick
    expect(calls.n).toBe(failed);
    await refresh(SLICE + 5); // 5 s later
    expect(calls.n).toBeGreaterThan(failed);
    const second = calls.n;
    await refresh(SLICE + 14); // then 10 s
    expect(calls.n).toBe(second);
    await refresh(SLICE + 15);
    expect(calls.n).toBeGreaterThan(second);
    expect(book.history(G100, 0).map((h) => h.parserVersion)).toEqual(["a/2"]); // kept
    expect(said).toEqual(["reader_history_failed"]);
    down = false;
    await refresh(SLICE + 15 + 20);
    expect(said).toEqual(["reader_history_failed", "reader_history_ok"]);
  });

  test("a call while a refresh runs shares it (the logger leaves it off its tick path)", async () => {
    const book = new ReaderBook(API, PANELS, { slices: SLICES, epochDay: 0 });
    const calls = { n: 0 };
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const refresh = readerRefresher({ book, view: view(() => false, calls, hold), slice: SLICE });
    const a = refresh(0, true);
    const b = refresh(1, true);
    expect(calls.n).toBe(3);
    release();
    await Promise.all([a, b]);
    expect(calls.n).toBe(3);
    expect(book.swapped).toBe(true);
  });
});

describe("8.6 the attester after an execute", () => {
  test("READER_MISSING, deadline the start of fromDay; READER_REFUSED at once; nothing for an installed reader", async () => {
    const w = new World({ firstDay: 20_727, pages: new Pages([3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000]).fn, writers: [{ net: "w1" }], attester: false, guardian: null });
    const alerts = new AlertSink(null, { now: () => w.now, print: false });
    const att = new Attester({ view: w.chain, events: w.chain, log: w.log, alerts, sender: w.chain.sender(ATTESTER), clock: w.c, panels: [w.panel], decisionsPath: null, tickS: 10, readerCheck: (_s, r) => (r.parserVersion === "s1/9" ? "missing" : r.url.includes("evil") ? "refused" : "ok") });
    await att.tick(w.now);
    const g = w.panel.gpuId;
    w.m.queueReaderSwap(g, 1, "https://s1.example/v9", "s1/9", "redesign", w.now);
    w.m.queueReaderSwap(g, 2, "https://s2.example/v2", "s2/2", "moved", w.now);
    w.m.queueReaderSwap(g, 3, "https://evil.example/x", "s3/2", "?", w.now);
    const t = w.now + w.c.timelock;
    const from1 = w.m.executeReaderSwap(g, 1, "https://s1.example/v9", "s1/9", t);
    w.m.executeReaderSwap(g, 2, "https://s2.example/v2", "s2/2", t);
    w.m.executeReaderSwap(g, 3, "https://evil.example/x", "s3/2", t);
    alerts.clearWhere(() => true);
    await att.tick(t + 1);
    const miss = alerts.open().filter((a) => a.code === AlertCode.READER_MISSING);
    expect(miss.map((a) => [a.slot, a.deadline])).toEqual([[1, w.c.epochTs + (from1 - w.c.epochDay) * w.c.day]]);
    expect(alerts.open().filter((a) => a.code === AlertCode.READER_REFUSED).map((a) => [a.slot, a.deadline])).toEqual([[3, t + 1]]);
    expect(alerts.open().filter((a) => a.message.startsWith("reader swap executed")).length).toBe(3);
  });
});
