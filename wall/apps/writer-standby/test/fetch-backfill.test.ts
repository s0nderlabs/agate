import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clockOf, dayStart, entryToJson, sliceStart } from "../src/core/index.ts";
import { backfill } from "../src/pipeline/backfill.ts";
import { fetchOnce, makeFetcher, PageReader } from "../src/pipeline/fetch.ts";
import { ReadingLog } from "../src/pipeline/log.ts";
import { FakeIndex, INDEX, PRIMARY, SELECTOR, testClocks } from "./helpers/fakeIndex.ts";
import { FAKE_SOURCES, PAGES, PANELS } from "./helpers/fakeSources.ts";

const seen: { path: string; ua: string | null }[] = [];
let failures = 0;
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname.slice(1);
    seen.push({ path, ua: req.headers.get("user-agent") });
    if (path === "flaky" && failures++ === 0) return new Response("busy", { status: 503 });
    if (path === "slow") return new Promise<Response>((r) => setTimeout(() => r(new Response("late")), 1_500));
    const body = PAGES[path] ?? (path === "flaky" ? "{}" : undefined);
    if (body === undefined) return new Response("no", { status: 404 });
    return new Response(body, { headers: { "x-agate-page-time": "1790812800" } });
  },
});
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

describe("page fetch (7.7)", () => {
  test("honest user agent, sha256, page time header", async () => {
    const p = await fetchOnce(`${base}/f_a`, "standby", 5_000);
    expect(p).toMatchObject({ ok: true, httpStatus: 200, pageTime: 1_790_812_800, attempts: 1 });
    expect(p.sha256).toBe(new Bun.CryptoHasher("sha256").update(PAGES.f_a!).digest("hex"));
    expect(seen.at(-1)!.ua).toBe("agate-wall/standby/0.1 (+https://github.com/s0nderlabs/agate)");
  });

  test("one retry inside the slice, none when it would start after the slice", async () => {
    const c = clockOf(testClocks());
    const sleeps: number[] = [];
    const f = makeFetcher({ role: "standby", timeoutMs: 5_000, now: () => 0, retryBefore: () => 1_000, sleep: async (ms) => void sleeps.push(ms), rand: () => 0 }, c);
    const r = await f(`${base}/flaky`);
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    expect(sleeps).toEqual([Math.round(((30 * c.slice) / 3_600) * 1000)]); // 30 to 120 s scaled by slice / 3,600
    const g = makeFetcher({ role: "standby", timeoutMs: 5_000, now: () => 999, retryBefore: () => 1_000, sleep: async () => {} }, c);
    expect(await g(`${base}/missing`)).toMatchObject({ ok: false, httpStatus: 404, attempts: 1 });
  });

  test("timeout is FAILED with no status", async () => {
    const p = await fetchOnce(`${base}/slow`, "standby", 200);
    expect(p).toMatchObject({ ok: false, httpStatus: 0 });
  });

  test("PageReader: each page once per run, the ECB file once per UTC day, replay paths by source id", async () => {
    let calls: string[] = [];
    const reader = new PageReader(async (url) => {
      calls.push(url.split("/").pop()!);
      return { ok: true, httpStatus: 200, body: PAGES[url.split("/").pop()!]!, bytes: 1 };
    }, base);
    const t = Date.UTC(2026, 9, 1, 5) / 1000;
    await reader.readAll(FAKE_SOURCES, t);
    expect(calls.sort()).toEqual(["f_a", "f_b", "f_c", "f_e", "fx_ecb"]);
    calls = [];
    await reader.readAll(FAKE_SOURCES, t + 3_600);
    expect(calls.includes("fx_ecb")).toBe(false);
    await reader.readAll(FAKE_SOURCES, t + 86_400);
    expect(calls.includes("fx_ecb")).toBe(true);
  });
});

describe("launch backfill (8.4)", () => {
  const clocks = testClocks();
  const c = clockOf(clocks);
  const D = 20_727;

  function logged(dir: string) {
    const log = new ReadingLog(dir, "primary");
    for (const d of [D, D + 1]) {
      for (let h = 0; h < c.slices; h++) {
        const readAt = sliceStart(c, d, h) + 30;
        log.append({
          kind: "reading",
          index: INDEX,
          role: "primary",
          dayId: d,
          slice: h,
          readAt,
          entries: PANELS.map((p) => entryToJson({ gpuId: p.gpuId as `0x${string}`, dayId: d, slice: h, readAt: BigInt(readAt), values: p.slots.map(() => 3_000_000) })),
          sources: [],
          via: "direct",
        });
      }
    }
    return log;
  }

  test("posts every logged slice the index lacks, with its original readAt, from firstDay", async () => {
    const idx = new FakeIndex(clocks, PANELS, D);
    idx.time = dayStart(c, D + 2) + 100;
    const log = logged(mkdtempSync(join(tmpdir(), "agate-bf-")));
    const res = await backfill({ chain: idx.view(PRIMARY), clock: c, chainSelector: SELECTOR, panels: PANELS, log, role: "primary", now: idx.time });
    expect(res.posted.length).toBe(24);
    expect(res.posted.every((p) => p.ok)).toBe(true);
    // the backfill is the one sender allowed after a day's window; its own limit is registration + GRACE
    expect(idx.metas.every((m) => m.action === "backfill" && m.deadline === idx.time + c.grace)).toBe(true);
    expect(idx.complete(PANELS[0]!.gpuId as `0x${string}`, D, PRIMARY)).toBe(true);
    expect(idx.posts[0]!.entries[0]!.readAt).toBe(sliceStart(c, D, 0) + 30);
    const again = await backfill({ chain: idx.view(PRIMARY), clock: c, chainSelector: SELECTOR, panels: PANELS, log, role: "primary", now: idx.time });
    expect(again.posted.length).toBe(0);
  });

  test("refuses after GRACE (one DAY, v4.3) from registration, and accepts one second before it", async () => {
    const idx = new FakeIndex(clocks, PANELS, D);
    const view = idx.view(PRIMARY);
    const log = logged(mkdtempSync(join(tmpdir(), "agate-bf-")));
    const chain = { ...view, gpu: async (g: `0x${string}`) => ({ ...(await view.gpu(g)), registeredAt: BigInt(dayStart(c, D)) }) };
    expect(c.grace).toBe(c.day);
    const res = await backfill({ chain, clock: c, chainSelector: SELECTOR, panels: PANELS, log, role: "primary", now: dayStart(c, D) + c.grace });
    expect(res.posted.length).toBe(0);
    expect(res.skipped.length).toBe(3);
    idx.time = dayStart(c, D) + c.grace - 1;
    const ok = await backfill({ chain, clock: c, chainSelector: SELECTOR, panels: PANELS, log, role: "primary", now: idx.time, dryRun: true });
    expect(ok.posted.length).toBe(12);
  });
});
