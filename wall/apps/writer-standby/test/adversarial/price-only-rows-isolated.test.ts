// The price-only GPUs (wall spec 18) are read from the same pages as H100, H200 and B200. A layout change, a renamed
// row or an unreadable cell that touches only a B300, A100 or L40S row must cost that GPU its reading and nothing else:
// the writer's report for the market's three GPUs stays cell for cell what the unbroken page gives. Real archived
// pages (the logger's Oct 2 08 UTC hour), each broken in one price-only row, read through the writer's own reading
// run with the launch panel's six entries. Skips with a printed line when the archive is absent (AGATE_RAW_DIR).
import { describe, expect, test } from "bun:test";
import type { Entry, GpuModel } from "@agate/report/types";
import { archivePresent, listHours, pageTimeOf, readArchived } from "@agate/sources/io";
import * as api from "@agate/sources/pure";
import type { Panel, SourcesPureApi } from "@agate/sources/types";
import { neededSources, type PageResult, takeReading } from "../../src/core/index.ts";

const LAUNCH = (await Bun.file(`${import.meta.dir}/../../../../packages/sources/panels/launch.json`).json()) as { panels: Panel[] };
const SOURCES_API = api as unknown as SourcesPureApi;
const OLD: readonly GpuModel[] = ["H100", "H200", "B200"];
const hour = archivePresent() ? listHours().find((h) => h.date === "2026-10-02" && h.hour === "08") : undefined;
if (!hour) console.log("archive absent or without 2026-10-02T08: skipping the price-only isolation checks (set AGATE_RAW_DIR)");

/** Each case breaks exactly one price-only row of one source and names the GPU whose slot of that source must drop. */
const CASES: { source: string; gpu: GpuModel; what: string; mutate: (b: string) => string }[] = [
  { source: "p_verda", gpu: "B300", what: "the B300 rows renamed", mutate: (b) => b.replace(/"name":\s*"B300 SXM6 /g, '"name": "B300 XYZ6 ') },
  { source: "p_verda", gpu: "L40S", what: "the L40S row renamed", mutate: (b) => b.replace(/"name":\s*"L40S 48GB"/g, '"name": "L40S 48GB PCIe"') },
  { source: "p_verda", gpu: "A100", what: "the A100 80GB rows priced in euro", mutate: (b) => JSON.stringify((JSON.parse(b) as { model: string; currency: string }[]).map((r) => (r.model === "A100 80GB" ? { ...r, currency: "eur" } : r))) },
  { source: "p_nebius", gpu: "B300", what: "a second USD tab in the B300 section", mutate: (b) => b.replace(/(#### NVIDIA\S* B300 NVLink[^\n]*\n)/, '$1<Tab title="USD">\n</Tab>\n') },
  { source: "p_nebius", gpu: "B300", what: "the B300 unit changed", mutate: (b) => b.replace(/(\| NVIDIA\S* B300 NVLink \| [^|]+\|) 1 GPU hour/g, "$1 8 GPU hours") },
  { source: "p_lambda", gpu: "A100", what: "the 80 GB A100 row without its VRAM/GPU label", mutate: (b) => b.replace(/(data-plan="NVIDIA A100 SXM"><th[^>]*>NVIDIA A100 SXM<\/th>)<td data-label="VRAM\/GPU">80 GB<\/td>/, "$1<td>80 GB</td>") },
  { source: "p_lambda", gpu: "A100", what: "the 80 GB A100 price cell unreadable", mutate: (b) => b.replace(/(data-label="VRAM\/GPU">80 GB<\/td><td data-label="vCPUs">240<\/td><td data-label="RAM">1800 GiB<\/td><td data-label="STORAGE">19.5 TiB SSD<\/td><td data-label="PRICE\/GPU\/HR\*">)\$2\.79/, "$1call us") },
  { source: "p_coreweave", gpu: "A100", what: "the A100 row showing 40 GB", mutate: (b) => b.replace(/(data-product="nvidia-a100"[\s\S]{0,600}?<div class="table-v2-cell"><div>8<\/div><\/div>\s*<div class="table-v2-cell"><div>)80/, "$140") },
  { source: "p_coreweave", gpu: "L40S", what: "the L40S on-demand cell garbled", mutate: (b) => b.replace(/(data-product="nvidia-l40s"[\s\S]{0,2000}?)\$18\.00/, "$1$18.0O") },
  { source: "p_civo", gpu: "B300", what: "the B300 table captioned twice", mutate: (b) => b.replace(/<caption>NVIDIA B300 GPU pricing<\/caption>/, "<caption>NVIDIA B300 GPU pricing</caption><caption>NVIDIA B300 GPU pricing</caption>") },
  { source: "p_civo", gpu: "L40S", what: "every L40S row given a suffix", mutate: (b) => b.replace(/(\d) x NVIDIA L40S - 48GB</g, "$1 x NVIDIA L40S - 48GB HBM<") },
  { source: "p_hyperstack", gpu: "A100", what: "the A100 SXM row showing 40 GB", mutate: (b) => b.replace(/(NVIDIA A100 SXM<\/span>[\s\S]{0,400}?col2">\s*<span>)80/, "$140") },
  { source: "p_hyperstack", gpu: "B300", what: "the B300 price cell garbled", mutate: (b) => b.replace(/(NVIDIA B300<\/span>[\s\S]{0,3000}?col5">\s*<span>)\s*\$7\.40/, "$1call us") },
];

function pagesOf(over?: { source: string; body: string }): Record<string, PageResult> {
  const out: Record<string, PageResult> = {};
  for (const def of neededSources(SOURCES_API, LAUNCH.panels)) {
    const body = over?.source === def.id ? over.body : readArchived(hour!, def.id);
    if (body === null) throw new Error(`no archived ${def.id} page at 2026-10-02T08`);
    out[def.id] = { ok: true, httpStatus: 200, body, bytes: body.length, pageTime: pageTimeOf(hour!, def.id) };
  }
  return out;
}

function read(pages: Record<string, PageResult>): Map<GpuModel, Entry> {
  const defs = neededSources(SOURCES_API, LAUNCH.panels);
  const readAt = hour!.startSec + 3_000;
  const r = takeReading(SOURCES_API, LAUNCH.panels, defs, { dayId: 20_728, slice: 0, readAt }, pages, undefined);
  expect(r.entries.length).toBe(LAUNCH.panels.length);
  return new Map(LAUNCH.panels.map((p, i) => [p.gpu, r.entries[i]!]));
}

describe.skipIf(!hour)("a broken price-only row costs only that GPU's slot (launch panel, real pages)", () => {
  test("the launch panel holds six GPUs and the unbroken pages read every slot", () => {
    expect(LAUNCH.panels.map((p) => p.gpu)).toEqual([...api.GPUS]);
    const base = read(pagesOf());
    for (const p of LAUNCH.panels) {
      const e = base.get(p.gpu)!;
      // every slot carries its page's value, reserve slots too (onchain E8b ignores a reserve until it is live)
      p.slots.forEach((s, i) => expect({ gpu: p.gpu, source: s.sourceId, v: e.values[i]! > 0 }).toEqual({ gpu: p.gpu, source: s.sourceId, v: !(p.gpu === "B300" && s.sourceId === "p_coreweave") }));
    }
  });

  for (const c of CASES) {
    test(`${c.source}: ${c.what}`, () => {
      const base = read(pagesOf());
      const body = readArchived(hour!, c.source)!;
      const broken = c.mutate(body);
      expect(broken === body).toBe(false); // the archived row is still where the case expects it
      const after = read(pagesOf({ source: c.source, body: broken }));
      // the market's three GPUs: every cell as before
      for (const g of OLD) expect(after.get(g)!.values).toEqual(base.get(g)!.values);
      // the broken GPU: its slot of that source reads nothing; every other slot as before
      const panel = LAUNCH.panels.find((p) => p.gpu === c.gpu)!;
      const slot = panel.slots.findIndex((s) => s.sourceId === c.source);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(base.get(c.gpu)!.values[slot]).toBeGreaterThan(0);
      const want = base.get(c.gpu)!.values.map((v, i) => (i === slot ? 0 : v));
      expect(after.get(c.gpu)!.values).toEqual(want);
      // the other price-only GPUs: as before
      for (const g of api.GPUS) if (!OLD.includes(g) && g !== c.gpu) expect(after.get(g)!.values).toEqual(base.get(g)!.values);
    });
  }
});
