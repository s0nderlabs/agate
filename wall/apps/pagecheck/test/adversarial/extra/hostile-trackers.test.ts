// Recheck r1: the page check against tracker files and servers that are hostile (15.3: tracker files are
// untrusted input). (1) A GPU Economy file built to confuse the parser: prototype keys, Runpod rows dressed as a
// mapped provider, prices as objects, exponents, negatives, padded strings, duplicate providers, wrong types. Only
// the clean rows may be used, nothing may throw, no prototype may change. (2) The replay's page-time header was also
// honoured from a production tracker, so a tracker that sent x-agate-page-time decided what "stale" meant. Fixed (fix
// round 2): it is honoured only under TRACKER_BASE_URL (the replay), and a body is capped at MAX_TRACKER_BYTES.
import { afterAll, describe, expect, test } from "bun:test";
import { fetchInterval, httpFetchTracker, MAX_TRACKER_BYTES } from "../../../src/fetch.ts";
import { geUsable, parseGpuEconomy, parseGpuTable, trackerFor } from "../../../src/trackers.ts";
import { cleanup, geFile, geRow, gtFile, gtRow, iso } from "../../helpers.ts";

afterAll(cleanup);

describe("hostile tracker bodies", () => {
  test("only clean mapped rows survive; nothing throws; no prototype changes", () => {
    const at = Date.parse("2026-10-02T12:00:00Z") / 1000;
    const hostile = JSON.stringify({
      data_updated_at: iso(at - 60),
      prices: [
        geRow("lambda", "3.99"), // the one clean row
        { ...geRow("lambda", "1.00"), provider: "Runpod" }, // a Runpod row wearing a mapped provider_id
        { ...geRow("lambda", "1.00"), provider_id: "lambda", provider: "RunPod Community" },
        geRow("lambda", { valueOf: 1 } as unknown as string),
        geRow("lambda", "3.99e1"),
        geRow("lambda", "-3.99"),
        geRow("lambda", "  0.5  ", { gpu_count: 1 }), // padded: trimmed and read; 1-GPU rows lose to 8-GPU rows
        geRow("lambda", "99999999999999.99"), // more than 12 integer digits
        geRow("lambda", Number.NaN as unknown as string),
        geRow("lambda", 1e21 as unknown as string),
        { ...geRow("lambda", "2.00"), price_type: "spot" },
        { ...geRow("lambda", "2.00"), status: "stale" },
        { ...geRow("LAMBDA", "2.00") }, // provider ids are exact
        JSON.parse('{"__proto__": {"polluted": true}, "provider_id": "lambda", "price_type": "on_demand", "status": "live", "usd_per_gpu_hour": "7.77", "gpu_count": 8}'),
        null,
        [geRow("lambda", "1.11")],
        "lambda",
      ],
    });
    const before = Object.getOwnPropertyNames(Object.prototype).length;
    const f = parseGpuEconomy(hostile);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.prototype).length).toBe(before);
    const vals = f.rows.map((r) => r.row.valueU).sort((a, b) => a - b);
    // 3.99 (clean), 0.50 (padded, 1-GPU) and 7.77 (the __proto__ row is an own key: harmless, its fields are read)
    expect(vals).toEqual([500_000, 3_990_000, 7_770_000]);
    const t = { at, ge: { H100: f } };
    // the 8-GPU rows win over the 1-GPU one; the nearest to our value among them
    expect(trackerFor(t, "p_lambda", "H100", 3_990_000)?.valueU).toBe(3_990_000);
    expect(trackerFor(t, "p_lambda", "H100", 7_000_000)?.valueU).toBe(7_770_000);
    // GPUTable likewise
    const gt = parseGpuTable(gtFile([gtRow("Lambda Labs", "H100 SXM", 3.99), { ...gtRow("Lambda Labs", "H100 SXM", 1), commitment_months: 12 }, gtRow("Runpod", "H100 SXM", 1), gtRow("Together AI", "H100 SXM", 1), { ...gtRow("Lambda Labs", "H100 SXM", 1), price_per_hour_usd: [1] }]));
    expect(gt.ok && gt.rows.map((r) => r.row.valueU)).toEqual([3_990_000]);
    for (const body of ["", "[]", "null", '{"prices": {}}', '{"prices": "x"}', "{".repeat(10_000)]) expect(parseGpuEconomy(body).ok).toBe(false);
  });
});

describe("the page-time header from a production tracker (LOW, recheck r1)", () => {
  test("a tracker's x-agate-page-time is ignored without TRACKER_BASE_URL, and honoured under it (the replay)", async () => {
    const real = Date.parse("2026-10-09T06:00:00Z") / 1000;
    const updated = real - 3 * 86_400; // a GPU Economy file three days old
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(geFile(updated, [geRow("lambda", "3.99", { last_confirmed_at: iso(updated) })]), { headers: { "content-type": "application/json", "x-agate-page-time": String(updated + 60) } }),
    });
    try {
      // the production fetcher on the production URL, answered by the local server standing in for gpueconomy.com
      const viaLocal = (url: string, ms: number) => httpFetchTracker(url.replace(/^https:\/\/gpueconomy\.com/, `http://127.0.0.1:${srv.port}`), ms);
      const r = await fetchInterval({ fetch: viaLocal, timeoutMs: 5_000, rawDir: null, now: () => real, retryMs: 0 }, 0, real, ["H100"], () => false);
      expect(r.t.at).toBe(real); // the fetch time, not the server's header
      expect(geUsable(r.t, "p_lambda", "H100")).toEqual({ use: false, why: "stale" }); // a three-day-old file is stale
      // the replay (TRACKER_BASE_URL set) keeps its scripted time
      const replay = await fetchInterval({ fetch: httpFetchTracker, timeoutMs: 5_000, base: `http://127.0.0.1:${srv.port}`, rawDir: null, now: () => real, retryMs: 0 }, 0, real, ["H100"], () => false);
      expect(replay.t.at).toBe(updated + 60);
      expect(geUsable(replay.t, "p_lambda", "H100")).toEqual({ use: true });
    } finally {
      srv.stop(true);
    }
  });

  test("a body past MAX_TRACKER_BYTES is refused, with or without a content-length", async () => {
    const big = "x".repeat(MAX_TRACKER_BYTES + 1);
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        if (new URL(req.url).pathname === "/stream") {
          let sent = 0;
          const chunk = new TextEncoder().encode("y".repeat(1 << 20));
          return new Response(new ReadableStream({ pull(c) { if (sent > MAX_TRACKER_BYTES) return c.close(); sent += chunk.byteLength; c.enqueue(chunk); } }));
        }
        return new Response(big);
      },
    });
    try {
      for (const path of ["/whole", "/stream"]) {
        const p = await httpFetchTracker(`http://127.0.0.1:${srv.port}${path}`, 10_000);
        expect(p).toMatchObject({ ok: false, body: "", error: `body over ${MAX_TRACKER_BYTES} bytes` });
      }
      const ok = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response('{"prices":[]}') });
      try {
        expect(await httpFetchTracker(`http://127.0.0.1:${ok.port}/`, 5_000)).toMatchObject({ ok: true, body: '{"prices":[]}' });
      } finally {
        ok.stop(true);
      }
    } finally {
      srv.stop(true);
    }
  });
});
