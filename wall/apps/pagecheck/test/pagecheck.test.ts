// BUILD-SPEC 15.1 tests. Synthetic tracker JSON in the trackers' field names; never a copy of a tracker file.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pruneRaw, rawFile } from "../src/fetch.ts";
import { main } from "../src/main.ts";
import { type CompareLine, readStatus, statusPath } from "../src/pagecheck.ts";
import { type Line, WatchLog } from "../src/watchlog.ts";
import { forbiddenProvider, gapBps, geRowsFor, isGap, type IntervalTrackers, parseGpuEconomy, parseGpuTable, pickRow, trackerFor, trackerMicro } from "../src/trackers.ts";
import { CLOCK, cleanup, geFile, geRow, gtFile, gtRow, H100_ID, INDEX, iso, makeCheck, ok, PANELS, type Script, scripted, start, tmpHome, writeLine } from "./helpers.ts";

afterAll(cleanup);

const U = (d: number) => Math.round(d * 1_000_000);

describe("row selection (15.1)", () => {
  const ge = parseGpuEconomy(
    geFile(CLOCK.epochTs, [
      geRow("lambda", 3.99, { gpu_count: 1 }),
      geRow("lambda", 4.29, { gpu_count: 8 }),
      geRow("lambda", 2.1, { gpu_count: 8, price_type: "spot" }),
      geRow("lambda", 3.1, { gpu_count: 8, price_type: "reserved" }),
      geRow("lambda", 3.0, { gpu_count: 8, status: "withheld" }),
      geRow("civo", 2.99),
      geRow("vast-ai", 1.2),
    ]),
  );
  test("provider map, on_demand and live only", () => {
    if (!ge.ok) throw new Error("parse");
    expect(geRowsFor(ge, "p_lambda").map((r) => r.valueU)).toEqual([U(3.99), U(4.29)]);
    expect(geRowsFor(ge, "p_civo").map((r) => r.valueU)).toEqual([U(2.99)]);
    expect(geRowsFor(ge, "p_seeweb")).toEqual([]); // no mapping: never compared
    expect(ge.rows.some((r) => r.providerId === "vast-ai")).toBe(false); // providers not in the map are ignored
  });
  test("8-GPU rows first, then 1-GPU, then all; the nearest to our value", () => {
    const r = (v: number, n: number | null) => ({ tracker: "gpueconomy" as const, valueU: U(v), gpuCount: n });
    expect(pickRow([r(3.99, 1), r(4.29, 8)], U(3.99))!.valueU).toBe(U(4.29)); // the 8x row wins although farther
    expect(pickRow([r(3.99, 1), r(4.5, 1), r(9, 2)], U(4.4))!.valueU).toBe(U(4.5));
    expect(pickRow([r(3, 2), r(5, 4)], U(4.9))!.valueU).toBe(U(5));
    expect(pickRow([r(3, 8), r(5, 8)], U(4))!.valueU).toBe(U(3)); // equal distance: the lower
    expect(pickRow([], 1)).toBeNull();
  });
});

describe("the watcher line a GPU is read from (8.6, two URLs of one source)", () => {
  const line = (o: Partial<Line> & { gpus: Line["gpus"] }): Line => ({ sourceId: "p_lambda", interval: 7, attempts: 1, httpStatus: 200, ...o }) as Line;
  test("a URL-only swap (no parsers on its line): each GPU from the line that holds its cell, never the registered line", () => {
    const log = new WatchLog("/nonexistent");
    log.add(line({ gpus: { B200: { state: "VALID", valueU: 5_990_000 } } })); // registered URL: B200 only
    log.add(line({ url: "https://lambda.ai/pricing-2026", gpus: { H100: { state: "VALID", valueU: 2_990_000 } } })); // H100 moved, same parser
    expect(log.lineFor("p_lambda", 7, "H100")?.url).toBe("https://lambda.ai/pricing-2026");
    expect(log.validU("p_lambda", 7, "H100")).toBe(2_990_000);
    expect(log.lineFor("p_lambda", 7, "B200")?.url).toBeUndefined();
    expect(log.validU("p_lambda", 7, "B200")).toBe(5_990_000);
  });
  test("a parser swap at the registered URL beside a URL-only swap: still the line holding the cell", () => {
    const log = new WatchLog("/nonexistent");
    log.add(line({ parsers: { B200: "lambda/2" }, gpus: { B200: { state: "VALID", valueU: 5_990_000 } } }));
    log.add(line({ url: "https://lambda.ai/pricing-2026", gpus: { H100: { state: "NO_ROW", valueU: 0 } } }));
    expect(log.lineFor("p_lambda", 7, "H100")?.url).toBe("https://lambda.ai/pricing-2026");
    expect(log.validU("p_lambda", 7, "H100")).toBeNull();
    expect(log.lineFor("p_lambda", 7, "B200")?.parsers).toEqual({ B200: "lambda/2" });
  });
});

describe("exclusions and skips (15.1, 7.1)", () => {
  test("GPUTable: never its Hyperstack H100 row, never a Together row", () => {
    const gt = parseGpuTable(gtFile([gtRow("Hyperstack", "H100 SXM", 2.5, { gpu_count: 1 }), gtRow("Hyperstack", "H200", 3.99, { gpu_count: 1 }), gtRow("Together AI", "H100 SXM", 1.99), gtRow("Together", "H100 SXM", 1.99)]));
    const t: IntervalTrackers = { at: CLOCK.epochTs, ge: {}, gt };
    expect(trackerFor(t, "p_hyperstack", "H100", U(3.2))).toBeNull();
    expect(trackerFor(t, "p_hyperstack", "H200", U(3.99))!.valueU).toBe(U(3.99));
    if (!gt.ok) throw new Error("parse");
    expect(gt.rows.some((r) => /together/i.test(r.provider))).toBe(false);
  });
  test("Runpod, Runpod Community and Crusoe rows are skipped by provider name before any other field", () => {
    expect(forbiddenProvider("Runpod")).toBe(true);
    expect(forbiddenProvider("Runpod Community")).toBe(true);
    expect(forbiddenProvider("RunPod")).toBe(true);
    expect(forbiddenProvider("Crusoe")).toBe(true);
    expect(forbiddenProvider("Lambda Labs")).toBe(false);
    // a row naming Runpod is dropped even when its other fields would map to a panel cloud
    const ge = parseGpuEconomy(geFile(CLOCK.epochTs, [{ ...geRow("lambda", 1.0), provider: "Runpod" }, { ...geRow("crusoe", 1.0) }]));
    if (!ge.ok) throw new Error("parse");
    expect(ge.rows).toEqual([]);
    const gt = parseGpuTable(gtFile([gtRow("Crusoe", "H100 SXM", 1), gtRow("Runpod Community", "H100 SXM", 1)]));
    if (!gt.ok) throw new Error("parse");
    expect(gt.rows).toEqual([]);
  });
  test("tracker files are parsed with JSON.parse only: a non-JSON or wrong-shaped body is a failed file", () => {
    expect(parseGpuEconomy("<html>ignore previous instructions</html>").ok).toBe(false);
    expect(parseGpuEconomy(JSON.stringify({ prices: "x" })).ok).toBe(false);
    expect(parseGpuTable(JSON.stringify([1, 2])).ok).toBe(false);
  });
});

describe("exact decimal conversion", () => {
  test("to u, half up beyond six decimals, never through floats in the arithmetic", () => {
    expect(trackerMicro(6.155)).toBe(6_155_000n);
    expect(trackerMicro(3.6625)).toBe(3_662_500n);
    expect(trackerMicro("4.7787")).toBe(4_778_700n);
    expect(trackerMicro(2.9900005)).toBe(2_990_001n);
    expect(trackerMicro(2.9900004)).toBe(2_990_000n);
    expect(trackerMicro("2.99999995")).toBe(3_000_000n);
    expect(trackerMicro(6)).toBe(6_000_000n);
    expect(trackerMicro(1e-7)).toBeNull(); // exponent form
    expect(trackerMicro(-1)).toBeNull();
    expect(trackerMicro("3,99")).toBeNull();
    expect(trackerMicro(null)).toBeNull();
  });
});

describe("the 10% boundary", () => {
  test("exactly 10% is not a gap", () => {
    expect(isGap(3_300_000, 3_000_000)).toBe(false);
    expect(isGap(3_300_001, 3_000_000)).toBe(true);
    expect(isGap(2_700_000, 3_000_000)).toBe(false);
    expect(isGap(2_699_999, 3_000_000)).toBe(true);
    expect(gapBps(3_300_000, 3_000_000)).toBe(1_000);
  });
});

/** GPU Economy serving Lambda H100 at `lambda` and Nebius H200 at 5.40, fresh. */
function trackersAt(lambda: number, extra: Script = () => undefined): Script {
  return (url) => {
    const x = extra(url);
    if (x) return x;
    if (url.endsWith("/gpu/h100-sxm/prices.json")) return ok(geFile(CLOCK.epochTs, [geRow("lambda", lambda), geRow("hyperstack", 3.2, { gpu_count: 1 })]));
    if (url.endsWith("/gpu/h200/prices.json")) return ok(geFile(CLOCK.epochTs, [geRow("nebius", 5.4)]));
    return undefined;
  };
}

describe("runs and alerts", () => {
  test("REVIEW on the first gap of a run (once), FAULT at DAY with MIN_READINGS gaps and not before", async () => {
    const home = tmpHome();
    const script = { current: trackersAt(3.0) };
    const f = scripted(script);
    const { alerts, step } = makeCheck(home, f.fetch);
    for (let k = 0; k < 13; k++) {
      writeLine(home, "p_lambda", k, { H100: U(3.99), B200: U(6.69) });
      await step(k);
      const open = alerts.open();
      const review = open.filter((a) => a.code === "PAGECHECK_REVIEW");
      const fault = open.filter((a) => a.code === "PAGECHECK_FAULT");
      expect(review.length).toBe(1);
      // start(k) - start(0) >= DAY (2,400 s = 12 intervals) first at k = 12
      expect(fault.length).toBe(k >= 12 ? 1 : 0);
    }
    const review = alerts.open().find((a) => a.code === "PAGECHECK_REVIEW")!;
    expect(review.id).toBe(`PAGECHECK_REVIEW:${H100_ID}:-:0:-@${INDEX.toLowerCase()}`);
    expect(review.severity).toBe("info");
    const fault = alerts.open().find((a) => a.code === "PAGECHECK_FAULT")!;
    expect(fault.severity).toBe("action");
    expect(fault.deadline).toBeUndefined();
    expect(fault.message).toMatch(/the gpueconomy row was last confirmed [\d.]+ h before this reading|row age unknown/); // fix round L3
    expect(alerts.all().filter((a) => a.code === "PAGECHECK_REVIEW").length).toBe(1); // raised once, never rewritten
    const st = readStatus(statusPath(home, INDEX))!;
    const p = st.pairs.find((x) => x.sourceId === "p_lambda")!;
    expect(p.state).toBe("fault");
    expect(p.gapped).toBe(13);
    expect(p.runStartK).toBe(0);
  });

  test("a day of gap with fewer than MIN_READINGS gapped comparisons is not a fault yet", async () => {
    const home = tmpHome();
    const f = scripted({ current: trackersAt(3.0) });
    const { alerts, step } = makeCheck(home, f.fetch);
    // gapped comparisons only at k = 0, 4, 8, 12, 16, 20 (the rest: no VALID reading)
    for (let k = 0; k <= 20; k++) {
      writeLine(home, "p_lambda", k, k % 4 === 0 ? { H100: U(3.99) } : { H100: "NO_ROW" });
      await step(k);
      const faults = alerts.open().filter((a) => a.code === "PAGECHECK_FAULT").length;
      expect(faults).toBe(k >= 20 ? 1 : 0); // the 6th gapped comparison is at k = 20
    }
  });

  test("a run is ended by a comparison within 10%: both alerts resolve", async () => {
    const home = tmpHome();
    const script = { current: trackersAt(3.0) };
    const f = scripted(script);
    const { alerts, step } = makeCheck(home, f.fetch);
    for (let k = 0; k <= 12; k++) {
      writeLine(home, "p_lambda", k, { H100: U(3.99) });
      await step(k);
    }
    expect(alerts.open().filter((a) => a.code.startsWith("PAGECHECK_")).length).toBe(2);
    script.current = trackersAt(3.99);
    writeLine(home, "p_lambda", 13, { H100: U(3.99) });
    await step(13);
    expect(alerts.open().filter((a) => a.code.startsWith("PAGECHECK_")).length).toBe(0);
    const p = readStatus(statusPath(home, INDEX))!.pairs.find((x) => x.sourceId === "p_lambda")!;
    expect([p.state, p.runStartK, p.gapped]).toEqual(["ok", null, 0]);
  });

  test("intervals without a comparison neither end nor extend a run", async () => {
    const home = tmpHome();
    const f = scripted({ current: trackersAt(3.0) });
    const { alerts, step, pc } = makeCheck(home, f.fetch);
    writeLine(home, "p_lambda", 0, { H100: U(3.99) });
    await step(0);
    for (const k of [1, 2, 3]) {
      if (k === 2) writeLine(home, "p_lambda", k, { H100: "FAILED" }, { httpStatus: 503, attempts: 2 });
      if (k === 3) writeLine(home, "p_lambda", k, { H100: "NOT_RENTABLE" });
      await step(k); // k = 1: MISSED (no line)
    }
    writeLine(home, "p_lambda", 4, { H100: U(3.99) });
    await step(4);
    const p = pc.status().find((x) => x.sourceId === "p_lambda")!;
    expect(p.runStartK).toBe(0);
    expect(p.gapped).toBe(2);
    expect(alerts.open().filter((a) => a.code === "PAGECHECK_REVIEW").length).toBe(1);
  });

  test("an interval the page check did not see is never compared (no late tracker read)", async () => {
    const home = tmpHome();
    const f = scripted({ current: trackersAt(3.0) });
    const { pc, now } = makeCheck(home, f.fetch);
    writeLine(home, "p_lambda", 0, { H100: U(3.99) });
    now.t = start(0) + 195; // past 19/20 of the interval: too late to fetch it
    await pc.tick(now.t);
    now.t = start(1) + 6;
    await pc.tick(now.t);
    expect(f.urls.length).toBe(0);
    expect(existsSync(join(pc.dir, "compare.jsonl"))).toBe(false);
  });

  test("TRACKERS_DOWN after DAY/4 of intervals with no tracker row for any pair; cleared when rows return", async () => {
    const home = tmpHome();
    const script: { current: Script } = { current: () => undefined };
    const f = scripted(script);
    const { alerts, step } = makeCheck(home, f.fetch);
    for (let k = 0; k < 3; k++) {
      writeLine(home, "p_lambda", k, { H100: U(3.99) });
      await step(k);
      expect(alerts.open().filter((a) => a.code === "PAGECHECK_TRACKERS_DOWN").length).toBe(k >= 2 ? 1 : 0); // 3 x 200 s >= 600 s
    }
    script.current = trackersAt(3.99);
    writeLine(home, "p_lambda", 3, { H100: U(3.99) });
    await step(3);
    expect(alerts.open().filter((a) => a.code === "PAGECHECK_TRACKERS_DOWN").length).toBe(0);
  });
});

describe("fallback to GPUTable, per pair (15.1)", () => {
  const gt = () => ok(gtFile([gtRow("Lambda Labs", "H100 SXM", 3.99), gtRow("Nebius", "H200", 5.4), gtRow("Hyperstack", "H100 SXM", 2.5, { gpu_count: 1 })]));
  test("a missing GPU Economy file: GPUTable", async () => {
    const home = tmpHome();
    const f = scripted({ current: (u) => (u.endsWith("data.json") ? gt() : undefined) });
    const { pc, step } = makeCheck(home, f.fetch);
    writeLine(home, "p_lambda", 0, { H100: U(3.99) });
    await step(0);
    const lines = readFileSync(join(pc.dir, "compare.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as CompareLine);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({ tracker: "gputable", own: U(3.99), t: U(3.99), gap: false, fallback: "file-failed", row: { gpu_count: 8 } });
  });
  test("a stale data_updated_at (older than 26 h): GPUTable", async () => {
    const home = tmpHome();
    const f = scripted({ current: (u) => (u.endsWith("data.json") ? gt() : u.includes("h100-sxm") ? ok(geFile(CLOCK.epochTs - 27 * 3_600, [geRow("lambda", 3.0)])) : undefined) });
    const { pc, step } = makeCheck(home, f.fetch);
    writeLine(home, "p_lambda", 0, { H100: U(3.99) });
    await step(0);
    const l = JSON.parse(readFileSync(join(pc.dir, "compare.jsonl"), "utf8").trim()) as CompareLine;
    expect([l.tracker, l.fallback, l.gap]).toEqual(["gputable", "stale", false]);
  });
  test("fix round (audit L3): a row whose last_confirmed_at is older than 26 h inside a fresh file is no row: GPUTable for that pair", async () => {
    const home = tmpHome();
    const stuck = geRow("lambda", 3.0, { last_confirmed_at: iso(CLOCK.epochTs - 27 * 3_600) });
    const f = scripted({ current: (u) => (u.endsWith("data.json") ? gt() : u.includes("h100-sxm") ? ok(geFile(CLOCK.epochTs, [stuck])) : undefined) });
    const { pc, step } = makeCheck(home, f.fetch);
    writeLine(home, "p_lambda", 0, { H100: U(3.99) });
    await step(0);
    const l = JSON.parse(readFileSync(join(pc.dir, "compare.jsonl"), "utf8").trim()) as CompareLine;
    expect([l.tracker, l.fallback, l.t, l.gap]).toEqual(["gputable", "stale-row", U(3.99), false]);
    // a row confirmed 25 h before is still used
    const home2 = tmpHome();
    const fresh = geRow("lambda", 3.99, { last_confirmed_at: iso(CLOCK.epochTs - 25 * 3_600) });
    const f2 = scripted({ current: (u) => (u.endsWith("data.json") ? gt() : u.includes("h100-sxm") ? ok(geFile(CLOCK.epochTs, [fresh])) : undefined) });
    const c2 = makeCheck(home2, f2.fetch);
    writeLine(home2, "p_lambda", 0, { H100: U(3.99) });
    await c2.step(0);
    const l2 = JSON.parse(readFileSync(join(c2.pc.dir, "compare.jsonl"), "utf8").trim()) as CompareLine;
    expect(l2.tracker).toBe("gpueconomy");
  });
  test("a missing row in GPU Economy: GPUTable for that pair only; GPUTable is not fetched when no pair needs it", async () => {
    const home = tmpHome();
    const f = scripted({ current: (u) => (u.endsWith("data.json") ? gt() : u.includes("h100-sxm") ? ok(geFile(CLOCK.epochTs, [geRow("civo", 2.99)])) : u.includes("h200") ? ok(geFile(CLOCK.epochTs, [geRow("nebius", 5.4)])) : undefined) });
    const { pc, step } = makeCheck(home, f.fetch);
    writeLine(home, "p_lambda", 0, { H100: U(3.99) });
    writeLine(home, "p_nebius", 0, { H200: U(5.4) });
    await step(0);
    const lines = readFileSync(join(pc.dir, "compare.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as CompareLine);
    expect(lines.map((l) => `${l.sourceId}:${l.tracker}`).sort()).toEqual(["p_lambda:gputable", "p_nebius:gpueconomy"]);
    // the next interval with every pair served by GPU Economy: one fetch per GPU file, no GPUTable fetch
    const g = scripted({ current: trackersAt(3.99) });
    const h2 = tmpHome();
    const c2 = makeCheck(h2, g.fetch);
    writeLine(h2, "p_lambda", 0, { H100: U(3.99) });
    // hyperstack (reserve) has a GPU Economy row too, so nothing falls back
    await c2.step(0);
    expect(g.urls.filter((u) => u.endsWith("data.json")).length).toBe(0);
    expect(g.urls.length).toBe(2);
  });
  test("Hyperstack H100 is never compared through GPUTable", async () => {
    const home = tmpHome();
    const f = scripted({ current: (u) => (u.endsWith("data.json") ? gt() : undefined) });
    const { pc, step } = makeCheck(home, f.fetch);
    writeLine(home, "p_hyperstack", 0, { H100: U(3.2) });
    await step(0);
    expect(existsSync(join(pc.dir, "compare.jsonl"))).toBe(false);
  });
});

describe("files", () => {
  test("raw bodies gzipped per interval, compare lines with the row fields, status for others, a heartbeat-free core", async () => {
    const home = tmpHome();
    const f = scripted({ current: trackersAt(3.99) });
    const { pc, step } = makeCheck(home, f.fetch);
    writeLine(home, "p_lambda", 0, { H100: U(3.99) });
    await step(0);
    const date = new Date(start(0) * 1000).toISOString().slice(0, 10);
    const gz = rawFile(join(pc.dir, "raw"), date, 0, "gpueconomy", "H100");
    expect(existsSync(gz)).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(gz)))).prices.length).toBe(2);
    const l = JSON.parse(readFileSync(join(pc.dir, "compare.jsonl"), "utf8").trim()) as CompareLine;
    expect(l).toMatchObject({ k: 0, gpu: "H100", sourceId: "p_lambda", slot: 0, own: U(3.99), t: U(3.99), tracker: "gpueconomy", gapBps: 0, gap: false });
    expect(l.row.listed_since).toBe("2026-09-07T00:58:28+00:00");
    const st = readStatus(statusPath(home, INDEX))!;
    expect(st.pairs.map((p) => p.sourceId)).toEqual(["p_lambda", "p_hyperstack", "p_nebius"]); // p_seeweb has no tracker mapping
    expect(st.lastComparedK).toBe(0);
  });
  test("raw folders older than 14 days are removed", () => {
    const home = tmpHome();
    const raw = join(home, "raw");
    for (const d of ["2026-09-01", "2026-09-18", "2026-09-19", "2026-10-02"]) mkdirSync(join(raw, d), { recursive: true });
    const gone = pruneRaw(raw, Date.parse("2026-10-03T12:00:00Z") / 1000);
    expect(gone.sort()).toEqual(["2026-09-01", "2026-09-18"]);
    expect(readdirSync(raw).sort()).toEqual(["2026-09-19", "2026-10-02"]);
  });
  test("a restart keeps the run (status.json) and compares an interval fetched before it", async () => {
    const home = tmpHome();
    const f = scripted({ current: trackersAt(3.0) });
    const a = makeCheck(home, f.fetch);
    writeLine(home, "p_lambda", 0, { H100: U(3.99) });
    await a.step(0);
    writeLine(home, "p_lambda", 1, { H100: U(3.99) });
    a.now.t = start(1) + 100;
    await a.pc.tick(a.now.t); // fetched k = 1, then "crashed"
    const b = makeCheck(home, f.fetch);
    b.now.t = start(2) + 6;
    await b.pc.tick(b.now.t);
    const p = b.pc.status().find((x) => x.sourceId === "p_lambda")!;
    expect([p.runStartK, p.gapped]).toEqual([0, 2]);
  });
});

describe("DEMO page time through the replay routes", () => {
  test("TRACKER_BASE_URL routes, the page time header decides staleness, GPU Economy 404 falls back to GPUTable", async () => {
    const pageTime = Date.parse("2026-10-01T12:00:00Z") / 1000; // the archived hour, far before the demo clock
    const hits: string[] = [];
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const p = new URL(req.url).pathname;
        hits.push(p);
        const h = { "x-agate-page-time": String(pageTime), "content-type": "application/json" };
        if (p === "/t_gpu_economy/h200") return new Response(geFile(pageTime - 3_600, [geRow("nebius", 5.4)]), { headers: h }); // fresh against the page time
        if (p === "/t_gputable") return new Response(gtFile([gtRow("Lambda Labs", "H100 SXM", 3.99)]), { headers: h });
        return new Response("not found", { status: 404, headers: h });
      },
    });
    try {
      const home = tmpHome();
      const { httpFetchTracker } = await import("../src/fetch.ts");
      const { pc, step } = makeCheck(home, httpFetchTracker, { base: `http://127.0.0.1:${srv.port}/` });
      writeLine(home, "p_lambda", 0, { H100: U(3.99) });
      writeLine(home, "p_nebius", 0, { H200: U(5.4) });
      await step(0);
      expect(hits.sort()).toEqual(["/t_gpu_economy/h100-sxm", "/t_gpu_economy/h100-sxm", "/t_gpu_economy/h200", "/t_gputable"]); // one retry on the 404
      const lines = readFileSync(join(pc.dir, "compare.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as CompareLine);
      expect(lines.map((l) => `${l.sourceId}:${l.tracker}`).sort()).toEqual(["p_lambda:gputable", "p_nebius:gpueconomy"]);
    } finally {
      srv.stop(true);
    }
  });
});

describe("guards", () => {
  test("refuses to start with a key variable in its environment", async () => {
    const home = tmpHome();
    const panels = join(home, "panels.json");
    writeFileSync(panels, JSON.stringify(PANELS));
    let err: unknown;
    try {
      await main({ AGATE_INDEX: INDEX, AGATE_PANELS: panels, AGATE_WALL_HOME: home, AGATE_ATTESTER_KEY: "0xsecretvalue" });
    } catch (e) {
      err = e;
    }
    expect(String(err)).toContain("AGATE_ATTESTER_KEY");
    expect(String(err)).not.toContain("secretvalue");
    expect(existsSync(join(home, "pagecheck"))).toBe(false);
  });
  test("never imported by a writer, the watcher or the guardian's price path", () => {
    const wall = join(import.meta.dir, "../../..");
    const roots = ["apps/watcher/src", "apps/writer-standby/src", "apps/writer-cre/src", "apps/writer-cre/workflow", "packages/sources/src", "packages/report/src"];
    const bad: string[] = [];
    const walk = (d: string) => {
      if (!existsSync(d)) return;
      for (const f of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, f.name);
        if (f.isDirectory()) {
          if (f.name !== "node_modules" && f.name !== "dist") walk(p);
        } else if (/\.(ts|js)$/.test(f.name) && /@agate\/(pagecheck|repair)|apps\/(pagecheck|repair)|\.\.\/(pagecheck|repair)\//.test(readFileSync(p, "utf8"))) bad.push(p);
      }
    };
    for (const r of roots) walk(join(wall, r));
    expect(bad).toEqual([]);
  });
});
