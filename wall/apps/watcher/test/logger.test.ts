// The watcher's logger (BUILD-SPEC 9.1, 13.4): one random read per interval, one retry inside the interval, honest
// catch-up after a restart or a sleep (MISSED, never a fetch for an ended interval), raw pages gzipped, heartbeat,
// the per-key lock. Synthetic pages only.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceDef } from "@agate/sources/types";
import { AlertSink } from "../src/alerts.ts";
import { Heartbeat, LockHeld, takeLock } from "../src/fsutil.ts";
import { httpFetchPage, Logger, type LoggerApi, type Page } from "../src/log/logger.ts";
import { cellOf, LogStore } from "../src/log/store.ts";

const rule = { product: "x", form: "SXM", priceClass: "on-demand", instance: "per-GPU of the 8-GPU instance, else of the 1-GPU instance", rentable: "assumed-rentable", effectiveDate: "a price shown from date X counts from 00:00 UTC of X", tax: "excluding VAT", notes: "" } as const;
const SOURCES: SourceDef[] = [
  { id: "p_a", company: "A", url: "https://a.example/p", currency: "USD", parserVersion: "1", rules: { H100: rule }, hosts: ["a.example"] },
  { id: "p_b", company: "B", url: "https://b.example/p", currency: "USD", parserVersion: "1", rules: { H100: rule, H200: rule }, hosts: ["b.example"] },
  { id: "p_eur", company: "E", url: "https://e.example/p", currency: "EUR", parserVersion: "1", rules: { H100: rule }, hosts: ["e.example"] },
];
const api: LoggerApi = {
  SOURCES,
  parse: (_id, body) => {
    const j = JSON.parse(body) as Record<string, number | string>;
    const out: Record<string, { state: "VALID" | "NOT_RENTABLE"; valueU: number }> = {};
    for (const [g, v] of Object.entries(j)) out[g] = v === "NR" ? { state: "NOT_RENTABLE", valueU: 0 } : { state: "VALID", valueU: Number(v) };
    return out;
  },
  parseEcb: (body, date) => (body.includes("rate") ? { date: `${date.slice(0, 8)}01`, usdPerEur: "1.1" } : null),
};
const page = (body: string, status = 200): Page => ({ ok: status === 200, httpStatus: status, body, bytes: body.length, sha256: "x", ...(status === 200 ? {} : { error: `HTTP ${status}` }) });

function setup(o: { slice?: number; fetch?: (url: string, n: number) => Page; rand?: () => number; dir?: string; fetchTakes?: number } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "agate-logger-"));
  const slice = o.slice ?? 200;
  const calls: { url: string; at: number }[] = [];
  let now = 0;
  const counts = new Map<string, number>();
  const store = new LogStore(dir);
  const alerts = new AlertSink(join(dir, "alerts.jsonl"), { now: () => now, print: false });
  const lg = new Logger({
    clock: { slice, epochTs: 0 },
    api,
    fetchPage: async (url) => {
      calls.push({ url, at: now });
      now += o.fetchTakes ?? 0;
      const n = (counts.get(url) ?? 0) + 1;
      counts.set(url, n);
      return o.fetch ? o.fetch(url, n) : url.includes("fx_ecb") || url.includes("ecb") ? page("rate") : page(JSON.stringify({ H100: 3_400_000, H200: 4_000_000 }));
    },
    dir,
    store,
    alerts,
    heartbeat: new Heartbeat(join(dir, "heartbeat.json"), "log", "0xindex"),
    rand: o.rand ?? Math.random,
    timeoutMs: 1000,
    tickS: 1,
    now: () => now,
  });
  const tick = async (t: number) => {
    now = t;
    await lg.tick(t);
    await lg.drain();
  };
  return { dir, lg, store, alerts, calls, tick, set: (t: number) => (now = t) };
}

describe("logger", () => {
  test("one read per source per interval, at a random second inside [slice/20, 19 slice/20)", async () => {
    const s = setup();
    for (let t = 1000; t < 1600; t++) await s.tick(t);
    for (const id of ["p_a", "p_b", "p_eur"]) {
      for (const k of [5, 6, 7]) {
        const r = s.store.get(id, k)!;
        expect(r.attempts).toBe(1);
        expect(r.scheduledAt).toBeGreaterThanOrEqual(k * 200 + 10);
        expect(r.scheduledAt).toBeLessThan(k * 200 + 190);
      }
    }
    expect(s.calls.filter((c) => !c.url.includes("ecb")).length).toBe(9);
    expect(cellOf(s.store.get("p_b", 6), "H200")).toBe(4_000_000);
    expect(cellOf(s.store.get("p_eur", 6), "H100")).toBe(3_400_000);
    expect(existsSync(join(s.dir, "heartbeat.json"))).toBe(true);
    const raw = join(s.dir, "raw", "1970-01-01", "6", "p_a.gz");
    expect(new TextDecoder().decode(Bun.gunzipSync(readFileSync(raw)))).toContain("3400000");
  });

  test("a failure is retried once inside the interval; a retry past the interval end is not made", async () => {
    const s = setup({ slice: 3_600, fetch: (url, n) => (url.includes("a.example") && n === 1 ? page("", 503) : page(JSON.stringify({ H100: 3_400_000, H200: 4_000_000 }))), rand: () => 0 });
    for (let t = 3_600; t < 7_200; t += 5) await s.tick(t);
    const r = s.store.get("p_a", 1)!;
    expect([r.attempts, cellOf(r, "H100")]).toEqual([2, 3_400_000]);
    // a read near the end that hangs 150 s: the retry would start after the interval: FAILED, one attempt
    const s2 = setup({ slice: 3_600, fetch: (url) => (url.includes("a.example") ? page("", 503) : page(JSON.stringify({ H100: 1 }))), rand: () => 0.999, fetchTakes: 150 });
    for (let t = 3_600; t < 7_400; t += 5) await s2.tick(t);
    const r2 = s2.store.get("p_a", 1)!;
    expect([r2.attempts, cellOf(r2, "H100")]).toEqual([1, "FAILED"]);
  });

  test("restart: ended intervals are written MISSED, never fetched; WATCHER_GAP; a later sleep raises CLOCK_JUMP", async () => {
    const s = setup();
    for (let t = 1000; t < 1400; t++) await s.tick(t);
    expect(s.store.lastInterval("p_a")).toBe(6);
    // a new process (restart) at interval 10
    const s2 = setup({ dir: s.dir });
    s2.store.refresh();
    await s2.tick(2_005);
    for (const k of [7, 8, 9]) for (const id of ["p_a", "p_b", "p_eur"]) expect(s2.store.get(id, k)?.attempts).toBe(0);
    expect(s2.calls.every((c) => c.at >= 2_000)).toBe(true);
    expect(s2.alerts.all().some((a) => a.code === "WATCHER_GAP")).toBe(true);
    expect(s2.alerts.all().some((a) => a.code === "CLOCK_JUMP")).toBe(false);
    for (let t = 2_006; t < 2_200; t++) await s2.tick(t);
    expect(s2.store.get("p_a", 10)!.attempts).toBe(1);
    await s2.tick(3_000); // slept 800 s inside the same process
    expect(s2.alerts.all().some((a) => a.code === "CLOCK_JUMP")).toBe(true);
    for (const k of [11, 12, 13, 14]) expect(s2.store.get("p_a", k)?.attempts).toBe(0);
    expect(s2.calls.filter((c) => c.at === 3_000 && !c.url.includes("ecb")).length).toBeLessThanOrEqual(3);
  });

  test("a restart late in an interval does not fetch for it; the interval becomes MISSED once it ends", async () => {
    const s = setup();
    await s.tick(1_195); // 19/20 of interval 5 has passed (190)
    expect(s.calls.length).toBe(0);
    for (let t = 1_196; t < 1_400; t++) await s.tick(t);
    expect(s.store.get("p_a", 5)).toBeUndefined(); // a fresh log starts at its first interval: no history invented
    expect(s.store.get("p_a", 6)!.attempts).toBe(1);
  });

  test("an EUR row without an ECB rate is FAILED (missing evidence), never an observed dark page", async () => {
    const s = setup({ fetch: (url) => (url.includes("ecb") ? page("", 500) : page(JSON.stringify({ H100: 3_400_000 }))) });
    for (let t = 1000; t < 1200; t++) await s.tick(t);
    const r = s.store.get("p_eur", 5)!;
    expect(cellOf(r, "H100")).toBe("FAILED");
    expect(r.error).toBe("no ECB rate");
  });

  test("an EUR line waiting on its ECB rate past the interval end is never written MISSED in between", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agate-logger-"));
    const store = new LogStore(dir);
    store.add({ sourceId: "p_eur", interval: 4, scheduledAt: 900, fetchedAt: 900, attempts: 1, httpStatus: 200, bytes: 1, sha256: "", gpus: { H100: { state: "VALID", valueU: 1 } } });
    let open = () => {};
    const gate = new Promise<void>((r) => (open = r));
    let now = 1_000;
    const lg = new Logger({
      clock: { slice: 200, epochTs: 0 },
      api,
      sourceIds: ["p_eur"],
      fetchPage: async (url) => {
        if (url.includes("ecb")) await gate;
        return url.includes("ecb") ? page("rate") : page(JSON.stringify({ H100: 3_400_000 }));
      },
      dir,
      store,
      alerts: new AlertSink(null, { now: () => now, print: false }),
      rand: () => 0.999, // read at the end of the interval
      timeoutMs: 1000,
      tickS: 1,
      now: () => now,
      writeRaw: false,
    });
    for (; now < 1_250; now++) {
      await lg.tick(now);
      await Bun.sleep(0);
    }
    const lines = () => readFileSync(join(dir, "log", "1970-01-01.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { interval: number; attempts: number });
    expect(existsSync(join(dir, "log", "1970-01-01.jsonl"))).toBe(false); // interval 5's line still waits on the rate
    expect(store.get("p_eur", 5)).toBeUndefined();
    open();
    await lg.drain();
    expect(lines().filter((l) => l.interval === 5)).toEqual([expect.objectContaining({ attempts: 1 })]);
    expect(cellOf(store.get("p_eur", 5), "H100")).toBe(3_400_000);
  });

  test("the log store folds lines: a real reading beats a MISSED line; torn lines wait", () => {
    const dir = mkdtempSync(join(tmpdir(), "agate-store-"));
    const st = new LogStore(dir);
    st.add({ sourceId: "x", interval: 3, scheduledAt: 0, fetchedAt: 0, attempts: 0, httpStatus: 0, bytes: 0, sha256: "", gpus: {} });
    st.add({ sourceId: "x", interval: 3, scheduledAt: 1, fetchedAt: 1, attempts: 1, httpStatus: 200, bytes: 1, sha256: "", gpus: { H100: { state: "NOT_RENTABLE", valueU: 0 } } });
    expect(cellOf(st.get("x", 3), "H100")).toBe("NOT_RENTABLE");
    expect(cellOf(st.get("x", 3), "H200")).toBe("NO_ROW");
    expect(st.slotLog("x", "H100", 1, 9)).toEqual({ k0: 1, cells: ["MISSED", "MISSED", "NOT_RENTABLE"] });
  });

  test("one process per key: a second lock on the same file is refused while the first holds it", () => {
    const dir = mkdtempSync(join(tmpdir(), "agate-lock-"));
    const fd = takeLock(join(dir, "x.lock"));
    expect(fd).toBeGreaterThan(0);
    expect(() => takeLock(join(dir, "x.lock"))).toThrow(LockHeld);
    const child = Bun.spawnSync(["bun", "-e", `import { takeLock } from "${join(import.meta.dir, "../src/fsutil.ts")}"; try { takeLock("${join(dir, "x.lock")}"); console.log("got"); } catch (e) { console.log(e.constructor.name); }`]);
    expect(child.stdout.toString().trim()).toBe("LockHeld");
    expect(readdirSync(dir)).toContain("x.lock");
  });

  test("a followed redirect is recorded as location (15.2's moved); a direct page has none", async () => {
    const srv = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req: Request): Response => (new URL(req.url).pathname === "/old" ? Response.redirect(`http://127.0.0.1:${new URL(req.url).port}/new`, 301) : new Response(JSON.stringify({ H100: 3_400_000 }))),
    });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const moved = await httpFetchPage(`${base}/old`, 5_000);
      expect([moved.ok, moved.httpStatus, moved.location]).toEqual([true, 200, `${base}/new`]);
      expect((await httpFetchPage(`${base}/new`, 5_000)).location).toBeUndefined();
      const s = setup({ fetch: (url) => ({ ...page(JSON.stringify({ H100: 3_400_000, H200: 4_000_000 })), ...(url.includes("a.example") ? { location: "https://a.example/new" } : {}) }) });
      for (let t = 1000; t < 1200; t++) await s.tick(t);
      expect(s.store.get("p_a", 5)!.location).toBe("https://a.example/new");
      expect(s.store.get("p_b", 5)!.location).toBeUndefined();
    } finally {
      srv.stop(true);
    }
  });
});
