// Replay additions of Oct 3 (BUILD-SPEC 7.9): the "redesigned" page step, the page check's tracker routes, a swapped
// reader still fetching /<sourceId>, and the price-only GPUs (18.4). A synthetic archive only (no third-party content).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { checkScenario, GPU_ECONOMY_FILES, GPUTABLE_GPU, type ReplayScenario, startReplay } from "../src/io/replay.ts";
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

describe("replay: the price-only GPUs (18.4)", () => {
  const six = { H100: { price: "3.66" }, H200: { price: "4.78" }, B200: { price: "6.99" }, B300: { price: "8.71" }, A100: { price: "1.79" }, L40S: { price: "1.56" } } as const;
  const raw6 = join(root, "raw6");
  mkdirSync(join(raw6, "2026-10-02", "08"), { recursive: true });
  writeFileSync(join(raw6, "2026-10-02", "08", "p_verda.all.gz"), gzipSync(renderPage("p_verda", six)));
  writeFileSync(join(raw6, "2026-10-02", "08", "p_coreweave.all.gz"), gzipSync(renderPage("p_coreweave", { H100: { price: "6.155" }, B300: { state: "not-rentable" }, A100: { price: "2.70" }, L40S: { price: "2.25" } })));
  const gtRows = (gpu: string, price: number) => ({ provider: "Verda", gpu, pricing_type: "on_demand", commitment_months: null, gpu_count: 8, price_per_hour_usd: price });
  writeFileSync(join(raw6, "2026-10-02", "08", "t_gputable.all.gz"), gzipSync(JSON.stringify({ data: [gtRows("A100 SXM", 1.79), gtRows("B300", 8.71), gtRows("H100 SXM", 3.66)] })));
  const econ6 = (price: number) => ({ data_updated_at: "2026-10-02T08:00:00Z", prices: [{ provider_id: "verda", price_type: "on_demand", status: "live", gpu_count: 8, usd_per_gpu_hour: price }] });
  const scenario: ReplayScenario = {
    scripted: { p_verda: { gpus: { A100: [{ from: { day: 2 }, price: "1.99" }] } } },
    trackers: { gpuEconomy: { b300: [{ from: { day: 0 }, body: econ6(8.71) }], "a100-80": [{ from: { day: 0 }, body: econ6(1.79) }], l40s: [{ from: { day: 0 }, body: econ6(1.56) }] } },
  };
  const s = startReplay({ rawDir: raw6, clock, scenario });
  afterAll(() => s.stop());

  test("an archived page serves all six GPUs; a scripted step on one new GPU keeps the other five", async () => {
    const a = await get(`${s.url}/p_verda`, T0 + 10);
    expect(a.scripted).toBeNull();
    const before = parse("p_verda", a.body, ctxOf(a.pageTime));
    expect(Object.keys(before).sort()).toEqual(["A100", "B200", "B300", "H100", "H200", "L40S"]);
    expect(before).toMatchObject({ B300: { valueU: 8_710_000 }, A100: { valueU: 1_790_000 }, L40S: { valueU: 1_560_000 } });
    const b = await get(`${s.url}/p_verda`, T0 + 1200 + 10);
    expect(b.scripted).toBe("1");
    const after = parse("p_verda", b.body, ctxOf(b.pageTime));
    expect(after.A100).toMatchObject({ state: "VALID", valueU: 1_990_000 });
    for (const g of ["H100", "H200", "B200", "B300", "L40S"] as const) expect(after[g], g).toEqual(before[g]);
    // CoreWeave's "Contact sales" B300 survives the synthetic re-render as NOT_RENTABLE
    const cw = await get(`${s.url}/p_coreweave`, T0 + 10);
    expect(parse("p_coreweave", cw.body, ctxOf(cw.pageTime))).toMatchObject({ B300: { state: "NOT_RENTABLE" }, A100: { valueU: 2_700_000 }, L40S: { valueU: 2_250_000 } });
  });

  test("/t_gpu_economy accepts b300, a100-80 and l40s; the archived GPUTable file follows a scripted A100 step", async () => {
    for (const [f, p] of [["b300", 8.71], ["a100-80", 1.79], ["l40s", 1.56]] as const) {
      const r = await get(`${s.url}/t_gpu_economy/${f}`, T0 + 10);
      expect(r.status, f).toBe(200);
      expect(JSON.parse(r.body)).toEqual(econ6(p));
    }
    expect(GPU_ECONOMY_FILES).toEqual(["h100-sxm", "h200", "b200", "b300", "a100-80", "l40s"]);
    expect(GPUTABLE_GPU).toEqual({ H100: "H100 SXM", H200: "H200", B200: "B200", B300: "B300", A100: "A100 SXM", L40S: "L40S" });
    expect((await get(`${s.url}/t_gpu_economy/a100`, T0 + 10)).status).toBe(404);
    const before = JSON.parse((await get(`${s.url}/t_gputable`, T0 + 10)).body) as { data: { gpu: string; price_per_hour_usd: number }[] };
    expect(before.data.find((r) => r.gpu === "A100 SXM")!.price_per_hour_usd).toBe(1.79);
    const after = await get(`${s.url}/t_gputable`, T0 + 1200 + 10);
    expect(after.scripted).toBe("1");
    const rows = (JSON.parse(after.body) as { data: { gpu: string; price_per_hour_usd: number }[] }).data;
    expect(rows.find((r) => r.gpu === "A100 SXM")!.price_per_hour_usd).toBe(1.99);
    expect(rows.find((r) => r.gpu === "B300")!.price_per_hour_usd).toBe(8.71);
  });

  test("checkScenario: the new GPUs only where the source has a rule; the new tracker files", () => {
    expect(() => checkScenario({ scripted: { p_verda: { gpus: { L40S: [{ from: { day: 0 }, price: "1.56" }] } } } })).not.toThrow();
    expect(() => checkScenario({ scripted: { p_civo: { gpus: { A100: [{ from: { day: 0 }, price: "1.79" }] } } } })).toThrow(/no rule for A100/);
    expect(() => checkScenario({ scripted: { p_hyperstack: { gpus: { L40S: [{ from: { day: 0 }, price: "1.00" }] } } } })).toThrow(/no rule for L40S/);
    expect(() => checkScenario({ trackers: { gpuEconomy: { l40s: [{ from: { day: 0 }, body: {} }] } } })).not.toThrow();
  });

  test("the default demo's scripted step stays on H100 only", async () => {
    const demo = (await Bun.file(join(import.meta.dir, "..", "replay", "demo.json")).json()) as ReplayScenario;
    expect(Object.keys(demo.scripted ?? {})).toEqual(["p_lambda"]);
    expect(Object.keys(demo.scripted!.p_lambda!.gpus ?? {})).toEqual(["H100"]);
    expect(() => checkScenario(demo)).not.toThrow();
  });
});
