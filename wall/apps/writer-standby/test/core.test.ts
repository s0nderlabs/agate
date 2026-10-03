import { describe, expect, test } from "bun:test";
import type { Hex } from "@agate/report/types";
import {
  asSourcesApi,
  buildEntries,
  cent,
  clockOf,
  attesterMargin,
  clockMismatches,
  closableAt,
  dayEnd,
  dayIdAt,
  dayStart,
  flatFields,
  flattenLogs,
  fullBits,
  graceStart,
  guardAct,
  lagMax,
  neededSources,
  type PageResult,
  pageUrl,
  parsePages,
  pendEnd,
  fetchesOf,
  planNotes,
  planReaders,
  readAtFor,
  readOffset,
  readWindow,
  reportHex,
  repostEnd,
  sendDeadline,
  sliceAt,
  takeReading,
  tickPeriod,
  unflatten,
  userAgent,
} from "../src/core/index.ts";
import { decodeReport } from "@agate/report";
import { testClocks } from "./helpers/fakeIndex.ts";
import { fakeSources, PAGES, PANELS } from "./helpers/fakeSources.ts";

const PROFILES = {
  PRODUCTION: { day: 86_400, slices: 24, epochTs: 0, epochDay: 0 },
  DEMO: { day: 600, slices: 4, epochTs: 1_790_900_000, epochDay: 20_758 },
  FAST: { day: 24, slices: 2, epochTs: 1_790_900_000, epochDay: 20_758, signAll: true },
  TEST: { day: 2_400, slices: 12, epochTs: 1_790_812_800, epochDay: 20_727 },
};

describe("clock (2.2 rule R v4.3, 3)", () => {
  test("derived clocks per profile: the table of 2.2", () => {
    const row = (c: ReturnType<typeof clockOf>) => [c.slice, c.minReadings, c.gap, c.pendFloor, c.tPend, c.closeGrace, c.grace, c.reopenWait, c.holdMove, c.holdMin, c.step, c.timelock];
    expect(row(clockOf(PROFILES.PRODUCTION))).toEqual([3_600, 12, 3, 10_860, 21_600, 3_600, 86_400, 21_600, 604_800, 64_800, 14_400, 172_800]);
    expect(row(clockOf(PROFILES.DEMO))).toEqual([150, 2, 1, 210, 210, 150, 600, 150, 4_200, 450, 100, 1_200]);
    expect(row(clockOf(PROFILES.FAST))).toEqual([12, 1, 1, 72, 6, 12, 24, 6, 168, 18, 4, 48]);
    expect(row(clockOf(PROFILES.TEST))).toEqual([200, 6, 1, 260, 600, 200, 2_400, 600, 16_800, 1_800, 400, 4_800]);
    expect(clockOf(PROFILES.FAST).signAll).toBe(true);
    expect(clockOf(PROFILES.DEMO).signAll).toBe(false);
  });

  test("the constructor's refusals: bad day, and PEND_FLOOR > DAY / 2 without signAll (T8)", () => {
    expect(() => clockOf({ day: 100, slices: 3, epochTs: 0, epochDay: 0 })).toThrow();
    expect(() => clockOf({ day: 120, slices: 7, epochTs: 0, epochDay: 0 })).toThrow();
    expect(() => clockOf({ ...PROFILES.FAST, signAll: false })).toThrow(/signAll/);
    expect(() => clockOf({ day: 24, slices: 0, epochTs: 0, epochDay: 0 })).toThrow();
  });

  test("LAG_MAX and GUARD_ACT (L1): 2 DAY on PRODUCTION and TEST, the bound B on DEMO and FAST", () => {
    expect([lagMax(clockOf(PROFILES.PRODUCTION)), lagMax(clockOf(PROFILES.DEMO)), lagMax(clockOf(PROFILES.FAST)), lagMax(clockOf(PROFILES.TEST))]).toEqual([172_800, 1_420, 64, 4_800]);
    expect(guardAct(clockOf(PROFILES.PRODUCTION))).toBe(21_600);
    expect([attesterMargin(clockOf(PROFILES.PRODUCTION)), attesterMargin(clockOf(PROFILES.DEMO))]).toEqual([300, 30]);
    expect([tickPeriod(clockOf(PROFILES.PRODUCTION)), tickPeriod(clockOf(PROFILES.DEMO)), tickPeriod(clockOf(PROFILES.FAST)), tickPeriod(clockOf(PROFILES.TEST))]).toEqual([20, 5, 1, 6]);
  });

  test("the chain's clocks() are taken as they are; a difference from 2.2 is reported, not hidden", () => {
    const chain = testClocks();
    expect(clockMismatches(chain)).toEqual([]);
    expect(clockOf(chain)).toEqual(clockOf({ day: 2_400, slices: 12, epochTs: 1_790_812_800, epochDay: 20_727 }));
    const odd = testClocks({ tPend: 999 });
    expect(clockOf(odd).tPend).toBe(999);
    expect(clockMismatches(odd)).toEqual(["tPend: chain 999, derived 600"]);
  });

  test("production dayId is the UTC day count; 20,727 is 2026-10-01", () => {
    const p = clockOf(PROFILES.PRODUCTION);
    const t = Date.UTC(2026, 9, 1, 14, 22, 17) / 1000;
    expect(dayIdAt(p, t)).toBe(20_727);
    expect(sliceAt(p, t)).toEqual({ dayId: 20_727, slice: 14, start: Date.UTC(2026, 9, 1, 14) / 1000, end: Date.UTC(2026, 9, 1, 15) / 1000 });
    expect(dayStart(p, 20_758)).toBe(Date.UTC(2026, 10, 1) / 1000);
  });

  test("slice boundaries on every profile", () => {
    for (const cfg of Object.values(PROFILES)) {
      const c = clockOf(cfg);
      const d = cfg.epochDay + 3;
      for (let h = 0; h < c.slices; h++) {
        const s = dayStart(c, d) + h * c.slice;
        expect(sliceAt(c, s)).toMatchObject({ dayId: d, slice: h });
        expect(sliceAt(c, s + c.slice - 1)).toMatchObject({ dayId: d, slice: h });
      }
      expect(sliceAt(c, dayEnd(c, d))).toMatchObject({ dayId: d + 1, slice: 0 });
      expect(dayIdAt(c, cfg.epochTs - 5)).toBe(cfg.epochDay);
      expect(fullBits(c)).toBe((1n << BigInt(c.slices)) - 1n);
    }
  });

  test("read offset stays in [slice/20, slice/2), also when it starts late (wake); readAt never leaves the slice", () => {
    for (const cfg of Object.values(PROFILES)) {
      const c = clockOf(cfg);
      const [lo, hi] = readWindow(c);
      for (const r of [0, 0.25, 0.5, 0.999999]) {
        const o = readOffset(c, r);
        expect(o).toBeGreaterThanOrEqual(lo);
        expect(o).toBeLessThan(hi);
        const late = readOffset(c, r, Math.floor(hi * 0.8));
        expect(late).toBeGreaterThanOrEqual(Math.min(hi - 1, Math.floor(hi * 0.8)));
        expect(late).toBeLessThan(hi);
      }
      const s0 = dayStart(c, cfg.epochDay + 1);
      expect(readAtFor(c, s0).readAt).toBe(s0);
      expect(readAtFor(c, s0 + 30, 2).readAt).toBe(Math.max(s0, s0 + 28));
    }
  });

  test("REPOST_END (Oct 3, 2.2): graceStart + GRACE - slice, graceStart = max(dayEnd, registeredAt)", () => {
    const offsets: [keyof typeof PROFILES, number][] = [
      ["PRODUCTION", 82_800],
      ["DEMO", 450],
      ["FAST", 12],
      ["TEST", 2_200],
    ];
    for (const [name, off] of offsets) {
      const c = clockOf(PROFILES[name]);
      const d = c.epochDay + 3;
      expect(repostEnd(c, d) - dayEnd(c, d)).toBe(off);
      expect(graceStart(c, d)).toBe(dayEnd(c, d));
      // a backfilled day: registered after it ended, its clocks start at the registration
      const reg = dayEnd(c, d) + 777;
      expect(graceStart(c, d, reg)).toBe(reg);
      expect(repostEnd(c, d, reg)).toBe(reg + off);
      // registered before the day ended: dayEnd decides
      expect(repostEnd(c, d, dayStart(c, d))).toBe(dayEnd(c, d) + off);
      expect(repostEnd(c, d)).toBeGreaterThan(sendDeadline(c, d));
    }
  });

  test("F1 deadlines: sends end one margin before the close becomes possible; others close from T_PEND", () => {
    const c = clockOf(PROFILES.TEST);
    expect(closableAt(c, 20_727)).toBe(dayEnd(c, 20_727) + 200);
    expect(sendDeadline(c, 20_727)).toBe(dayEnd(c, 20_727) + 200 - 16);
    expect(pendEnd(c, 20_727)).toBe(dayEnd(c, 20_727) + 600);
    const p = clockOf(PROFILES.PRODUCTION);
    expect(closableAt(p, 0) - sendDeadline(p, 0)).toBe(300);
    const d = clockOf(PROFILES.DEMO);
    expect(pendEnd(d, 20_758) - closableAt(d, 20_758)).toBe(60); // T8: a real minute for the first writer (C3)
  });
});

function ok(body: string, pageTime?: number): PageResult {
  return { ok: true, httpStatus: 200, body, bytes: body.length, ...(pageTime ? { pageTime } : {}) };
}
const T = Date.UTC(2026, 9, 1, 5) / 1000;
const defs = neededSources(fakeSources, PANELS);
const pages = () => Object.fromEntries(defs.map((d) => [d.id, ok(PAGES[d.id]!)]));

describe("reading (7.4, 7.5)", () => {
  test("every slot's source is fetched once, unknown sources are refused", () => {
    expect(defs.map((d) => d.id)).toEqual(["f_a", "f_b", "f_c", "f_e"]);
    expect(() => neededSources(fakeSources, [{ ...PANELS[0]!, slots: [{ slot: 0, sourceId: "p_runpod", family: 0, liveAtStart: true }] }])).toThrow();
  });

  test("entries: one per GPU, slot order, same (day, slice, readAt), 0 for anything not VALID", () => {
    const r = takeReading(fakeSources, PANELS, defs, { dayId: 20_727, slice: 5, readAt: T }, pages(), ok(PAGES.fx_ecb!));
    expect(r.entries.map((e) => e.values)).toEqual([
      [2_990_000, 6_160_000, 3_100_000, 2_660_000],
      [3_490_000, 3_800_000, 0],
      [5_250_000, 0],
    ]);
    expect(r.entries.every((e) => e.dayId === 20_727 && e.slice === 5 && e.readAt === BigInt(T))).toBe(true);
    const hex = reportHex(2183018362218727504n, "0x5FbDB2315678afecb367f032d93F642f64180aa3", r.entries);
    expect(decodeReport(hex).entries).toEqual(r.entries);
  });

  test("failed fetch, missing ECB rate, other-day rate, throwing parser", () => {
    const p = pages();
    p.f_c = { ok: false, httpStatus: 503, body: "", bytes: 0, error: "HTTP 503" };
    p.f_a = ok("THROW");
    const r = parsePages(fakeSources, defs, p, undefined, T);
    const log = Object.fromEntries(r.logs.map((l) => [l.sourceId, l]));
    expect(log.f_c!.rows).toEqual({ H100: { state: "FAILED", valueU: 0 }, H200: { state: "FAILED", valueU: 0 } });
    expect(r.rows.f_c).toBeUndefined();
    expect(log.f_e!.rows.H100!.state).toBe("NO_ROW"); // no ECB file: every EUR row is NO_ROW
    expect(log.f_a!.rows.H100!.state).toBe("NO_ROW");
    // replay page time decides the FX date: an archived 2026-09-30 page takes the 09-29 rate
    const q = pages();
    q.f_e = ok(PAGES.f_e!, Date.UTC(2026, 8, 30, 12) / 1000);
    const r2 = parsePages(fakeSources, defs, q, ok(PAGES.fx_ecb!), T);
    const e = r2.logs.find((l) => l.sourceId === "f_e")!;
    expect(e.fxDate).toBe("2026-09-29");
    expect(e.rows.H100!.valueU).toBe(2_660_000); // 2.27 x 1.17 = 2.6559 -> 2.66
  });

  test("CRE consensus round trip: flatten to numbers and back, off-grid medians snap to the cent", () => {
    const r = parsePages(fakeSources, defs, pages(), ok(PAGES.fx_ecb!), T);
    const flat = flattenLogs(r.logs);
    expect(Object.keys(flat).sort()).toEqual(flatFields(defs).sort());
    const back = unflatten(defs, flat);
    expect(back.logs).toEqual(r.logs.map((l) => ({ ...l, bytes: l.bytes })));
    expect(buildEntries(fakeSources, PANELS, back.rows, 1, 2, T)).toEqual(buildEntries(fakeSources, PANELS, r.rows, 1, 2, T));
    const off = { ...flat, "f_a.H100.v": 2_995_000 }; // the mean of 2.99 and 3.00 from an even node count
    expect(unflatten(defs, off).rows.f_a!.H100!.valueU).toBe(3_000_000);
    expect(cent(2_994_999)).toBe(2_990_000);
  });

  test("replay base URL and the honest user agent", () => {
    expect(pageUrl("p_lambda", "https://lambda.ai/pricing", "http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787/p_lambda");
    expect(pageUrl("p_lambda", "https://lambda.ai/pricing")).toBe("https://lambda.ai/pricing");
    expect(userAgent("standby")).toBe("agate-wall/standby/0.1 (+https://github.com/s0nderlabs/agate)");
  });

  test("asSourcesApi refuses a module without the pure API", () => {
    expect(() => asSourcesApi({})).toThrow(/does not export/);
    expect(asSourcesApi(fakeSources)).toBe(fakeSources);
  });

  test("gpuIds of the fake panels follow the spec strings", () => {
    expect(PANELS[0]!.gpuId as Hex).toBe("0x12aa97fa8c2e1cc1914a2e4d86b36c7b36fdccec7c4caacb5f202ccc6d9be955");
  });
});

describe("readers in force in the pure core (8.6)", () => {
  const defs = FAKE_SOURCES_ALL();
  const h100 = PANELS[0]!;

  test("planReaders: registered by default; an allowed swap is used; anything else is a refusal, whatever the caller passed", () => {
    const none = planReaders(fakeSources, defs, PANELS);
    expect(none.find((p) => p.def.id === "f_a")!.byGpu).toEqual({ H100: { url: "https://a.invalid/p", parserVersion: "f_a/1" }, H200: { url: "https://a.invalid/p", parserVersion: "f_a/1" }, B200: { url: "https://a.invalid/p", parserVersion: "f_a/1" } });
    const plans = planReaders(fakeSources, defs, PANELS, {
      [h100.gpuId.toUpperCase().replace("0X", "0x")]: {
        "0": { url: "https://www.a.invalid/v2", parserVersion: "f_a/2" },
        "1": { url: "https://evil.invalid/p", parserVersion: "f_b/1" },
        "2": { url: "https://c.invalid/p", parserVersion: "f_c/9" },
        "3": { refused: "the caller refused it" },
      },
    });
    const by = (id: string) => plans.find((p) => p.def.id === id)!.byGpu;
    expect(by("f_a").H100).toEqual({ url: "https://www.a.invalid/v2", parserVersion: "f_a/2" });
    expect(by("f_a").H200).toEqual({ url: "https://a.invalid/p", parserVersion: "f_a/1" }); // H200's slot is not swapped
    expect((by("f_b").H100 as { refused: string }).refused).toMatch(/host/);
    expect((by("f_c").H100 as { refused: string }).refused).toMatch(/not installed/);
    expect(by("f_e").H100).toEqual({ refused: "the caller refused it" });
    // each distinct URL once, the registered one first; under a replay base one fetch per source
    const f = fetchesOf(plans);
    expect(f.filter((x) => x.sourceId === "f_a").map((x) => x.fetchUrl)).toEqual(["https://a.invalid/p", "https://www.a.invalid/v2"]);
    expect(f.some((x) => x.fetchUrl.includes("evil"))).toBe(false);
    const fb = fetchesOf(plans, "http://replay.test");
    expect(new Set(fb.filter((x) => x.sourceId === "f_a").map((x) => x.fetchUrl))).toEqual(new Set(["http://replay.test/f_a"]));
    const notes = planNotes(plans);
    expect(notes.f_a).toEqual({ parsers: { H100: "f_a/2", H200: "f_a/1", B200: "f_a/1" }, urls: { H100: "https://www.a.invalid/v2" } });
    expect(notes.f_b!.refused!.H100).toMatch(/host/);
    expect(notes.f_c!.parsers).toEqual({ H200: "f_c/1" });
  });

  test("parsePages with plans: the swapped GPU reads its version at its URL; a refused one is MISSED and sends 0", () => {
    const plans = planReaders(fakeSources, defs, PANELS, { [h100.gpuId]: { "0": { url: "https://www.a.invalid/v2", parserVersion: "f_a/2" }, "1": { refused: "x" } } });
    const ok = (body: string): PageResult => ({ ok: true, httpStatus: 200, body, bytes: body.length });
    const pages: Record<string, PageResult> = {
      f_a: ok(PAGES.f_a!),
      "f_a https://www.a.invalid/v2": ok(JSON.stringify({ v2: { H100: "2.79" } })),
      f_b: ok(PAGES.f_b!),
      f_c: ok(PAGES.f_c!),
      f_e: ok(PAGES.f_e!),
    };
    const r = takeReading(fakeSources, PANELS, defs, { dayId: 20_727, slice: 1, readAt: 1_790_813_000 }, pages, ok(PAGES.fx_ecb!), plans);
    expect(r.entries.find((e) => e.gpuId === h100.gpuId)!.values).toEqual([2_790_000, 0, 3_100_000, 2_660_000]);
    const fa = r.sources.find((x) => x.sourceId === "f_a")!;
    expect(fa.rows.H100).toEqual({ state: "VALID", valueU: 2_790_000 });
    expect(fa.extra).toEqual([{ url: "https://www.a.invalid/v2", httpStatus: 200, bytes: pages["f_a https://www.a.invalid/v2"]!.bytes }]);
    const fb = r.sources.find((x) => x.sourceId === "f_b")!;
    expect(fb.rows.H100).toEqual({ state: "MISSED", valueU: 0 });
    expect(fb.rows.B200).toEqual({ state: "NOT_RENTABLE", valueU: 0 }); // f_b's B200 slot: registered reader
    // flattened for CRE's consensus and back: the states and values survive, the notes come back from the plan
    const back = unflatten(defs, flattenLogs(r.sources));
    expect(back.logs.find((x) => x.sourceId === "f_b")!.rows.H100).toEqual({ state: "MISSED", valueU: 0 });
    expect(back.rows.f_b!.H100).toBeUndefined();
    expect(back.rows.f_a!.H100).toEqual({ state: "VALID", valueU: 2_790_000 });
  });
});

function FAKE_SOURCES_ALL() {
  return neededSources(fakeSources, PANELS);
}
