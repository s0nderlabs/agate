// The primary reads through CRE, whose consensus is a median per numeric field (writer core flatFields / flattenLogs /
// unflatten, wall spec 8.2). With six GPUs (wall spec 18) the launch panel's reading must survive that round trip for
// every GPU: every (source, GPU) cell a launch slot needs has its two fields, the flattened reading of every archived
// hour rebuilds the same six report entries, the observation stays far under CRE's consensus observation cap
// (25 kb), and on a three-node DON one node that reads every price-only cell from a neighbouring row (Verda's
// "B300 CC", Lambda's 40 GB A100, Hyperstack's PCIe A100, CoreWeave's L40, Civo's commitment price) is outvoted field by
// field, while H100, H200 and B200 never move. Real archived pages; skips with a printed line without them.
import { describe, expect, test } from "bun:test";
import type { Entry, GpuModel } from "@agate/report/types";
import { archivePresent, listHours, pageTimeOf, readArchived } from "@agate/sources/io";
import * as api from "@agate/sources/pure";
import type { Panel, SourcesPureApi } from "@agate/sources/types";
import { buildEntries, flatFields, flattenLogs, neededSources, type PageResult, takeReading, unflatten } from "../../src/core/index.ts";

const LAUNCH = (await Bun.file(`${import.meta.dir}/../../../../packages/sources/panels/launch.json`).json()) as { panels: Panel[] };
const API = api as unknown as SourcesPureApi;
const DEFS = neededSources(API, LAUNCH.panels);
const NEW: readonly GpuModel[] = ["B300", "A100", "L40S"];
const hours = archivePresent() ? listHours().filter((h) => DEFS.every((d) => readArchived(h, d.id) !== null)) : [];
const on = hours.length >= 64;
if (!on) console.log("archive absent or short: skipping the consensus round trip on archived pages (set AGATE_RAW_DIR)");

function pagesAt(h: (typeof hours)[number]): Record<string, PageResult> {
  const out: Record<string, PageResult> = {};
  for (const d of DEFS) {
    const body = readArchived(h, d.id)!;
    out[d.id] = { ok: true, httpStatus: 200, body, bytes: body.length, pageTime: pageTimeOf(h, d.id) };
  }
  return out;
}
const at = (h: (typeof hours)[number]) => ({ dayId: 20_728, slice: 1, readAt: h.startSec + 1_800 });
/** CRE's aggregation: the median of each field over the nodes' observations (odd node count). */
function median(obs: Record<string, number>[], fields: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of fields) {
    const v = obs.map((o) => o[f] ?? 0).sort((x, y) => x - y);
    out[f] = v[(v.length - 1) / 2]!;
  }
  return out;
}
const sameEntries = (a: Entry[], b: Entry[]) => expect(a.map((e) => [e.gpuId, e.values])).toEqual(b.map((e) => [e.gpuId, e.values]));

describe("CRE's per-field consensus carries the six-GPU reading", () => {
  test("every (source, GPU) cell a launch slot reads has its value and state fields", () => {
    const fields = new Set(flatFields(DEFS));
    for (const p of LAUNCH.panels) for (const s of p.slots) for (const k of ["v", "s"]) expect({ field: `${s.sourceId}.${p.gpu}.${k}`, in: fields.has(`${s.sourceId}.${p.gpu}.${k}`) }).toEqual({ field: `${s.sourceId}.${p.gpu}.${k}`, in: true });
    // and no field for a pair without a rule (Civo A100, Nebius L40S, Hyperstack L40S, Lambda B300)
    for (const f of ["p_civo.A100.v", "p_nebius.L40S.v", "p_hyperstack.L40S.v", "p_lambda.B300.v"]) expect(fields.has(f)).toBe(false);
  });

  test.skipIf(!on)("every archived hour: flattened, rebuilt and turned into the same six entries; the observation stays small", () => {
    let largest = 0;
    for (const h of hours) {
      const r = takeReading(API, LAUNCH.panels, DEFS, at(h), pagesAt(h), undefined);
      const flat = flattenLogs(r.sources);
      expect(Object.keys(flat).sort()).toEqual(flatFields(DEFS).sort());
      largest = Math.max(largest, JSON.stringify(flat).length);
      const back = unflatten(DEFS, flat);
      sameEntries(buildEntries(API, LAUNCH.panels, back.rows, at(h).dayId, at(h).slice, at(h).readAt), r.entries);
      expect(r.entries.length).toBe(6);
    }
    console.log(`${hours.length} archived hours round-tripped; largest observation ${largest} bytes of JSON (${flatFields(DEFS).length} fields)`);
    expect(largest).toBeLessThan(25_000 / 4);
  });

  test.skipIf(!on)("three nodes, one reading every price-only cell from a neighbouring row: the median is the honest reading", () => {
    const h = hours.find((x) => x.date === "2026-10-03" && x.hour === "08") ?? hours.at(-1)!;
    const pages = pagesAt(h);
    const honest = takeReading(API, LAUNCH.panels, DEFS, at(h), pages, undefined);
    // the neighbouring rows of 18.2, each moved into the rule's own row on the misled node's copy of the page
    const bad: Record<string, (b: string) => string> = {
      p_verda: (b) =>
        JSON.stringify(
          (JSON.parse(b) as { model: string; name: string; price_per_hour: string; gpu: { number_of_gpus: number } }[]).map((r) =>
            r.model === "B300" && r.gpu.number_of_gpus === 8 ? { ...r, price_per_hour: "71.77" } : r.model === "A100 80GB" && r.gpu.number_of_gpus === 8 ? { ...r, price_per_hour: "10.46" } : r,
          ),
        ),
      p_lambda: (b) => b.replace(/(data-label="VRAM\/GPU">80 GB<\/td>(?:<td[^>]*>[^<]*<\/td>){3}<td data-label="PRICE\/GPU\/HR\*">)\$2\.79/, "$1$$1.99"),
      p_hyperstack: (b) => b.replace(/(NVIDIA A100 SXM<\/span>[\s\S]{0,3000}?col5">\s*<span>)\s*\$1\.60/, "$1$$1.35"),
      p_coreweave: (b) => b.replace(/(data-product="nvidia-l40s"[\s\S]{0,2000}?)\$18\.00([\s\S]{0,1500}?)\$18\.00/, "$1$$9.20$2$$9.20"),
      p_civo: (b) => b.replace(/(<caption>NVIDIA B300 GPU pricing<\/caption>[\s\S]{0,3000}?class="price-value">)\$59\.92/, "$1$$43.92"),
    };
    const misled: Record<string, PageResult> = { ...pages };
    for (const [id, f] of Object.entries(bad)) {
      const body = f(pages[id]!.body);
      expect({ id, edited: body !== pages[id]!.body }).toEqual({ id, edited: true });
      misled[id] = { ...pages[id]!, body, bytes: body.length };
    }
    const wrong = takeReading(API, LAUNCH.panels, DEFS, at(h), misled, undefined);
    // the misled node really reads different price-only cells, and only those
    const differs = (g: GpuModel) => JSON.stringify(wrong.entries[LAUNCH.panels.findIndex((p) => p.gpu === g)]!.values) !== JSON.stringify(honest.entries[LAUNCH.panels.findIndex((p) => p.gpu === g)]!.values);
    for (const g of NEW) expect({ g, differs: differs(g) }).toEqual({ g, differs: true });
    for (const g of ["H100", "H200", "B200"] as const) expect({ g, differs: differs(g) }).toEqual({ g, differs: false });

    const fields = flatFields(DEFS);
    const obs = [flattenLogs(honest.sources), flattenLogs(wrong.sources), flattenLogs(honest.sources)];
    const agreed = unflatten(DEFS, median(obs, fields));
    sameEntries(buildEntries(API, LAUNCH.panels, agreed.rows, at(h).dayId, at(h).slice, at(h).readAt), honest.entries);
    // with two misled nodes of three the DON reports their cells: consensus guards against one node, not a majority
    const two = unflatten(DEFS, median([obs[1]!, obs[1]!, obs[0]!], fields));
    sameEntries(buildEntries(API, LAUNCH.panels, two.rows, at(h).dayId, at(h).slice, at(h).readAt), wrong.entries);
  });
});
