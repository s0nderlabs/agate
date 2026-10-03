// Replay additions of Oct 3 (BUILD-SPEC 7.9): the "redesigned" page step, the page check's tracker routes, and a
// swapped reader still fetching /<sourceId>. A synthetic archive only (no third-party content).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { checkScenario, type ReplayScenario, startReplay } from "../src/io/replay.ts";
import { parse, parseWith } from "../src/pure/index.ts";
import { renderPage } from "../src/synthetic.ts";

const root = mkdtempSync(join(tmpdir(), "agate-replay-up-"));
const raw = join(root, "raw");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (d: string, h: string, name: string, body: string) => {
  mkdirSync(join(raw, d, h), { recursive: true });
  writeFileSync(join(raw, d, h, `${name}.all.gz`), gzipSync(body));
};
// GPUTable's own field names, synthetic numbers (15.1)
const gputable = (price: number) => ({ generated_at: "2026-10-01T00:00:00+00:00", data: [{ provider: "Lambda Labs", gpu: "H100 SXM", pricing_type: "on_demand", commitment_months: null, gpu_count: 8, price_per_hour_usd: price }] });
put("2026-10-01", "00", "p_lambda", renderPage("p_lambda", { H100: { price: "3.99" }, B200: { price: "6.69" } }));
put("2026-10-01", "00", "t_gputable", JSON.stringify(gputable(3.99)));
put("2026-10-01", "01", "p_lambda", renderPage("p_lambda", { H100: { price: "3.99" }, B200: { price: "6.69" } }));

const T0 = 1_800_000_000;
const clock = { t0: T0, daySec: 600, slices: 4 };
const get = async (url: string, t: number) => {
  const res = await fetch(url, { headers: { "x-agate-clock": String(t) } });
  return { status: res.status, body: await res.text(), pageTime: Number(res.headers.get("x-agate-page-time")), scripted: res.headers.get("x-agate-scripted"), type: res.headers.get("content-type") };
};
const ctxOf = (pageTime: number) => ({ utcDate: new Date(pageTime * 1000).toISOString().slice(0, 10), nowSec: pageTime });

const econ = (price: number) => ({ data_updated_at: "2026-10-01T00:00:00Z", prices: [{ provider_id: "lambda", price_type: "on_demand", status: "live", gpu_count: 8, usd_per_gpu_hour: price }] });

describe("replay: redesigned pages and trackers", () => {
  const scenario: ReplayScenario = {
    scripted: {
      p_lambda: {
        gpus: { H100: [{ from: { day: 2 }, price: "3.49" }] },
        page: [
          { from: { day: 1 }, state: "redesigned" },
          { from: { day: 3 }, state: "ok" },
        ],
      },
    },
    trackers: {
      gputable: [
        { from: { day: 2 }, body: gputable(3.49) },
        { from: { day: 4 }, status: 503 },
      ],
      gpuEconomy: { "h100-sxm": [{ from: { day: 0 }, body: econ(3.99) }, { from: { day: 2, slice: 2 }, body: econ(3.49) }] },
    },
  };
  const s = startReplay({ rawDir: raw, clock, scenario });
  afterAll(() => s.stop());

  test("a redesigned page reads NO_ROW for every GPU under lambda/1 and still carries the archived or scripted prices", async () => {
    const before = await get(`${s.url}/p_lambda`, T0 + 10);
    expect(parse("p_lambda", before.body, ctxOf(before.pageTime)).H100?.state).toBe("VALID");
    const d1 = await get(`${s.url}/p_lambda`, T0 + 600 + 10);
    expect(d1.scripted).toBe("1");
    const r1 = parseWith("lambda/1", d1.body, ctxOf(d1.pageTime));
    expect(r1.H100?.state).toBe("NO_ROW");
    expect(r1.B200?.state).toBe("NO_ROW");
    expect(d1.body).toContain("$3.99 per GPU per hour"); // the archived hour's price, in the new layout
    expect(d1.body).toContain("$6.69 per GPU per hour");
    const d2 = await get(`${s.url}/p_lambda`, T0 + 1200 + 10);
    expect(d2.body).toContain("$3.49 per GPU per hour"); // the scripted step, in the new layout
    expect(parse("p_lambda", d2.body, ctxOf(d2.pageTime)).H100?.state).toBe("NO_ROW");
    // from day 3 the old layout is back: v1 reads the scripted price again
    const d3 = await get(`${s.url}/p_lambda`, T0 + 1800 + 10);
    expect(parse("p_lambda", d3.body, ctxOf(d3.pageTime)).H100).toMatchObject({ state: "VALID", valueU: 3_490_000 });
  });

  test("a swapped reader fetches /<sourceId> like the registered one: the per-role path and the plain path agree", async () => {
    const a = await get(`${s.url}/p_lambda`, T0 + 10);
    const b = await get(`${s.url}/r/watcher/p_lambda`, T0 + 10);
    expect(b.body).toBe(a.body);
  });

  test("/t_gputable: the archived hour's file, then a scripted body from its step, then a scripted outage", async () => {
    const a = await get(`${s.url}/t_gputable`, T0 + 10);
    expect(a.status).toBe(200);
    expect(a.scripted).toBeNull();
    expect(JSON.parse(a.body)).toEqual(gputable(3.99));
    expect(a.type).toContain("application/json");
    expect(new Date(a.pageTime * 1000).toISOString().slice(0, 13)).toBe("2026-10-01T00");
    const b = await get(`${s.url}/t_gputable`, T0 + 1200 + 10);
    expect(b.scripted).toBe("1");
    expect(JSON.parse(b.body)).toEqual(gputable(3.49));
    expect((await get(`${s.url}/r/pagecheck/t_gputable`, T0 + 1200 + 10)).body).toBe(b.body);
    expect((await get(`${s.url}/t_gputable`, T0 + 2400 + 10)).status).toBe(503);
  });

  test("/t_gpu_economy/<file>: scripted only (by step, slice included); unscripted and unknown files are 404", async () => {
    const a = await get(`${s.url}/t_gpu_economy/h100-sxm`, T0 + 10);
    expect(a.status).toBe(200);
    expect(JSON.parse(a.body)).toEqual(econ(3.99));
    expect(JSON.parse((await get(`${s.url}/t_gpu_economy/h100-sxm`, T0 + 1200 + 10)).body)).toEqual(econ(3.99)); // slice 0 of day 2
    expect(JSON.parse((await get(`${s.url}/t_gpu_economy/h100-sxm`, T0 + 1200 + 300 + 10)).body)).toEqual(econ(3.49)); // slice 2
    expect((await get(`${s.url}/t_gpu_economy/h200`, T0 + 10)).status).toBe(404);
    expect((await get(`${s.url}/t_gpu_economy/a100`, T0 + 10)).status).toBe(404);
    expect((await get(`${s.url}/t_gpu_economy`, T0 + 10)).status).toBe(404);
    expect((await get(`${s.url}/t_gpu_economy/h100-sxm/x`, T0 + 10)).status).toBe(404);
    expect((await get(`${s.url}/t_gputable/x`, T0 + 10)).status).toBe(404);
  });

  test("without an archive and without a script the trackers answer 404", async () => {
    const t = startReplay({ clock, scenario: { archive: false } });
    try {
      expect((await get(`${t.url}/t_gputable`, T0 + 10)).status).toBe(404);
      expect((await get(`${t.url}/t_gpu_economy/b200`, T0 + 10)).status).toBe(404);
    } finally {
      t.stop();
    }
  });

  test("checkScenario refuses a tracker typo", () => {
    expect(() => checkScenario({ trackers: { gpuEconomy: { a100: [{ from: { day: 0 }, body: {} }] } as never } })).toThrow(/unknown file/);
    expect(() => checkScenario({ trackers: { gputablee: [] } as never })).toThrow(/unknown tracker/);
    expect(() => checkScenario({ trackers: { gputable: [{ from: { day: 0 } }] } })).toThrow(/JSON body/);
    expect(() => checkScenario({ trackers: { gputable: [{ from: { day: 0 }, status: 99 }] } })).toThrow(/bad status/);
    expect(() => checkScenario({ trackers: { gputable: [{ from: { day: -1 }, body: {} }] } })).toThrow(/bad step start/);
    expect(() => checkScenario({ scripted: { p_lambda: { page: [{ from: { day: 0 }, state: "redesigned" }] } } })).not.toThrow();
  });
});
