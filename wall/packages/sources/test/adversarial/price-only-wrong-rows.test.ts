// The price-only GPUs B300, A100 and L40S (BUILD-SPEC 18), attacked on the real archived pages: each test changes one
// archived page in memory so that a careless parser would read a neighbouring row (Verda "B300 CC" and A100 40GB,
// Lambda's 40 GB A100 that shares its plan name, CoreWeave's L40, GB300 and legacy A100 slugs, Hyperstack's PCIe
// A100 rows, Civo's GB300 and A100 tables, Seeweb's A100 card, Nebius's GB300 and L40S sections) and checks that
// nothing but the rule's own row is ever read, and that H100, H200 and B200 read as before. Then the whole price path
// (page, parse, slotValues, the live median) on every archived hour of the research range against the medians the
// independent research reader found. Pages stay in the archive; nothing here writes one. Skips without the archive.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GpuModel } from "@agate/report/types";
import { archivedFx, archivePresent, listHours, pageTimeOf, readArchived } from "../../src/io/archive.ts";
import { parse, reasonOf, slotValues } from "../../src/pure/index.ts";
import type { Panel, ParseContext, ParseResult } from "../../src/types.ts";

const OLD: readonly GpuModel[] = ["H100", "H200", "B200"];
const HOUR = { date: "2026-10-03", hour: "08" }; // the hour the research quoted every row from
const FROM = "2026-09-30T17";
const TO = "2026-10-03T08";

const all = archivePresent() ? listHours() : [];
const at = all.find((h) => h.date === HOUR.date && h.hour === HOUR.hour);
const range = all.filter((h) => `${h.date}T${h.hour}` >= FROM && `${h.date}T${h.hour}` <= TO);
const on = at !== undefined && range.length === 64;
if (!on) console.log(`archive absent or not covering ${FROM} to ${TO}: skipping the wrong-row attacks on archived pages (set AGATE_RAW_DIR)`);

function ctxOf(h: (typeof all)[number], id: string): ParseContext {
  const t = pageTimeOf(h, id);
  const fx = archivedFx(h.date);
  return { utcDate: new Date(t * 1000).toISOString().slice(0, 10), nowSec: t, ...(fx ? { fx } : {}) };
}
const page = (id: string): string => (at ? (readArchived(at, id) ?? "") : "");
const read = (id: string, body: string): ParseResult => parse(id, body, ctxOf(at!, id));

/** The rows of the GPUs a change did not touch are exactly the unchanged page's. */
function untouched(id: string, before: ParseResult, after: ParseResult, gpus: readonly GpuModel[]) {
  for (const g of gpus) expect({ id, g, row: after[g] }).toEqual({ id, g, row: before[g] });
}

/** Replaces the text once and insists it was there. */
function swap(body: string, from: string | RegExp, to: string): string {
  const out = body.replace(from, to);
  expect(out).not.toBe(body);
  return out;
}

describe("Verda: the model field and the name pattern keep the neighbours out", () => {
  type Row = { model: string; name: string; price_per_hour: string; gpu: { number_of_gpus: number } };
  const rows = (): Row[] => JSON.parse(page("p_verda")) as Row[];
  const base = () => read("p_verda", page("p_verda"));

  test.skipIf(!on)('"B300 CC" rows moved into the B300 model are a layout change, never their 71.77 / 8', () => {
    const r = read("p_verda", JSON.stringify(rows().map((x) => (x.model === "B300 CC" ? { ...x, model: "B300" } : x))));
    expect(reasonOf(r.B300)).toBe("layout-changed");
    const gone = read("p_verda", JSON.stringify(rows().filter((x) => x.model !== "B300").map((x) => (x.model === "B300 CC" ? { ...x, model: "B300" } : x))));
    expect(gone.B300?.state).not.toBe("VALID");
    untouched("p_verda", base(), r, [...OLD, "A100", "L40S"]);
  });

  test.skipIf(!on)("GB300 rows moved into the B300 model fail the name pattern", () => {
    const r = read("p_verda", JSON.stringify(rows().map((x) => (x.model === "GB300" ? { ...x, model: "B300" } : x))));
    expect(reasonOf(r.B300)).toBe("layout-changed");
  });

  test.skipIf(!on)("A100 40GB rows moved into the A100 80GB model are a layout change; with the 80GB rows gone, no A100", () => {
    const r = read("p_verda", JSON.stringify(rows().map((x) => (x.model === "A100 40GB" ? { ...x, model: "A100 80GB" } : x))));
    expect(reasonOf(r.A100)).toBe("layout-changed");
    const gone = read("p_verda", JSON.stringify(rows().filter((x) => x.model !== "A100 80GB")));
    expect(reasonOf(gone.A100)).toBe("missing-row");
    untouched("p_verda", base(), gone, [...OLD, "B300", "L40S"]);
  });

  test.skipIf(!on)("an L40 model row is not an L40S", () => {
    const extra = rows();
    const l40s = extra.find((x) => x.model === "L40S" && x.gpu.number_of_gpus === 8)!;
    extra.push({ ...l40s, model: "L40", name: "L40 48GB", price_per_hour: "4.00" });
    expect(read("p_verda", JSON.stringify(extra))).toEqual(base());
  });
});

describe("Lambda A100: only the 80 GB row of the shared plan name", () => {
  const r80 = /<tr\b[^<>]*data-plan="NVIDIA A100 SXM"><th\b[^<>]*>NVIDIA A100 SXM<\/th><td data-label="VRAM\/GPU">80 GB<\/td>.*?<\/tr>/;
  const r40 = /<tr\b[^<>]*data-plan="NVIDIA A100 SXM"><th\b[^<>]*>NVIDIA A100 SXM<\/th><td data-label="VRAM\/GPU">40 GB<\/td>.*?<\/tr>/g;
  const base = () => read("p_lambda", page("p_lambda"));

  test.skipIf(!on)("today: 2.79 from the 8x tab's 80 GB row", () => {
    expect(base().A100).toMatchObject({ state: "VALID", valueU: 2_790_000, raw: "2.79", gpuCount: 1 });
  });

  test.skipIf(!on)("the 80 GB row deleted: no A100, never the 40 GB rows of the 8x and 1x tabs ($1.99)", () => {
    const r = read("p_lambda", swap(page("p_lambda"), r80, ""));
    expect(reasonOf(r.A100)).toBe("missing-row");
    untouched("p_lambda", base(), r, ["H100", "B200"]);
  });

  test.skipIf(!on)("the 40 GB row moved above the 80 GB row: still 2.79", () => {
    const body = page("p_lambda");
    const row80 = r80.exec(body)![0];
    const row40 = [...body.matchAll(r40)][0]![0];
    const moved = swap(swap(body, row40, ""), row80, row40 + row80);
    expect(read("p_lambda", moved).A100).toMatchObject({ state: "VALID", valueU: 2_790_000 });
  });

  test.skipIf(!on)("the A100 PCIe rows relabelled 80 GB at $0.99: another plan, never read", () => {
    const body = page("p_lambda").replace(
      /(data-plan="NVIDIA A100 PCIe"><th\b[^<>]*>NVIDIA A100 PCIe<\/th><td data-label="VRAM\/GPU">)40 GB(<\/td>.*?<td data-label="PRICE\/GPU\/HR\*">)\$1\.99/g,
      "$180 GB$2$0.99",
    );
    expect(body).not.toBe(page("p_lambda"));
    expect(read("p_lambda", body).A100).toMatchObject({ state: "VALID", valueU: 2_790_000 });
  });

  test.skipIf(!on)("an 80 GB row of the 1x tab at $1.49 never beats the 8x tab's; it is only the fallback when the 8x tab has none (18.2, built)", () => {
    const body = page("p_lambda");
    const last40 = [...body.matchAll(r40)].at(-1)!;
    const as80 = last40[0].replace(">40 GB<", ">80 GB<").replace(">$1.99<", ">$1.49<");
    const oneX = body.slice(0, last40.index) + as80 + body.slice(last40.index! + last40[0].length);
    expect(read("p_lambda", oneX).A100).toMatchObject({ state: "VALID", valueU: 2_790_000 });
    expect(read("p_lambda", swap(oneX, r80, "")).A100).toMatchObject({ state: "VALID", valueU: 1_490_000 });
  });

  test.skipIf(!on)("a row of the plan without its VRAM/GPU cell: nothing is read for A100, H100 and B200 unchanged", () => {
    const body = page("p_lambda");
    const row40 = [...body.matchAll(r40)][0]![0];
    const r = read("p_lambda", swap(body, row40, row40.replace('<td data-label="VRAM/GPU">40 GB</td>', "")));
    expect(reasonOf(r.A100)).toBe("layout-changed");
    untouched("p_lambda", base(), r, ["H100", "B200"]);
  });
});

describe("CoreWeave: exact slugs in the North America block", () => {
  /** The page with its North America rows passed through `f` (the Europe block, the CPU tables and the pricing
   *  modals with the legacy slugs stay as they are). */
  function na(body: string, f: (rows: string[]) => string[]): string {
    const a = body.indexOf(">On-demand GPU instances</h2>");
    const s = body.indexOf("REGION: NORTH AMERICA</strong>", a);
    const e = body.indexOf("REGION:", s + 10);
    expect(a > 0 && s > a && e > s).toBe(true);
    const [head, ...rows] = body.slice(s, e).split('<div role="listitem"');
    return body.slice(0, s) + [head!, ...f(rows)].join('<div role="listitem"') + body.slice(e);
  }
  const without = (slug: string) => (rows: string[]) => {
    const kept = rows.filter((r) => !r.includes(`data-product="${slug}"`));
    expect(kept.length).toBeLessThan(rows.length);
    return kept;
  };
  const base = () => read("p_coreweave", page("p_coreweave"));

  test.skipIf(!on)("today: B300 NOT_RENTABLE (Contact sales), A100 2.70, L40S 2.25", () => {
    expect(base()).toMatchObject({ B300: { state: "NOT_RENTABLE", valueU: 0 }, A100: { state: "VALID", valueU: 2_700_000 }, L40S: { state: "VALID", valueU: 2_250_000 } });
    for (const slug of ["nvidia-a100-80gb", "a100-80gb-pcie", "nvidia-l40", "nvidia-gb300-nvl72"]) expect(page("p_coreweave")).toContain(`data-product="${slug}"`);
  });

  test.skipIf(!on)("no NA nvidia-a100 row: no A100 (never Europe's row, never the legacy nvidia-a100-80gb or a100-80gb-pcie)", () => {
    const r = read("p_coreweave", na(page("p_coreweave"), without("nvidia-a100")));
    expect(reasonOf(r.A100)).toBe("missing-row");
    untouched("p_coreweave", base(), r, [...OLD, "B300", "L40S"]);
    const legacy = read("p_coreweave", na(page("p_coreweave"), (rows) => rows.map((x) => x.replaceAll('data-product="nvidia-a100"', 'data-product="nvidia-a100-80gb"'))));
    expect(reasonOf(legacy.A100)).toBe("missing-row");
  });

  test.skipIf(!on)("no NA nvidia-l40s row: no L40S, never the L40 ($10.00 for 8)", () => {
    const r = read("p_coreweave", na(page("p_coreweave"), without("nvidia-l40s")));
    expect(reasonOf(r.L40S)).toBe("missing-row");
    untouched("p_coreweave", base(), r, [...OLD, "B300", "A100"]);
  });

  test.skipIf(!on)("no NA nvidia-b300 row: no B300, never GB300 NVL72", () => {
    const r = read("p_coreweave", na(page("p_coreweave"), without("nvidia-b300")));
    expect(reasonOf(r.B300)).toBe("missing-row");
    untouched("p_coreweave", base(), r, [...OLD, "A100", "L40S"]);
  });

  test.skipIf(!on)("the A100 row's VRAM cell at 40: not our A100", () => {
    const body = na(page("p_coreweave"), (rows) =>
      rows.map((x) => (x.includes('data-product="nvidia-a100"') ? x.replace(/(<div class="table-v2-cell">\s*<div[^<>]*>\s*8\s*<\/div>[\s\S]*?<div class="table-v2-cell">\s*<div[^<>]*>\s*)80(\s*<)/, "$140$2") : x)),
    );
    expect(body).not.toBe(page("p_coreweave"));
    const r = read("p_coreweave", body);
    expect(reasonOf(r.A100)).toBe("missing-row");
    untouched("p_coreweave", base(), r, [...OLD, "B300", "L40S"]);
  });

  test.skipIf(!on)("a second nvidia-a100 row with 40 GB and another price is left out: still the 80 GB row's 2.70", () => {
    const body = na(page("p_coreweave"), (rows) =>
      rows.flatMap((x) => {
        if (!x.includes('data-product="nvidia-a100"')) return [x];
        const forty = x.replace(/(<div class="table-v2-cell">\s*<div[^<>]*>\s*8\s*<\/div>[\s\S]*?<div class="table-v2-cell">\s*<div[^<>]*>\s*)80(\s*<)/, "$140$2").replaceAll("$21.60", "$9.92");
        expect(forty).not.toBe(x);
        return [forty, x];
      }),
    );
    const r = read("p_coreweave", body);
    expect(r.A100).toMatchObject({ state: "VALID", valueU: 2_700_000 });
    untouched("p_coreweave", base(), r, [...OLD, "B300", "L40S"]);
  });

  test.skipIf(!on)("B300 half-updated: a price in the mobile copy only stays NOT_RENTABLE; a price in the grid only is no reading", () => {
    const mobileOnly = na(page("p_coreweave"), (rows) =>
      rows.map((x) => (x.includes('data-product="nvidia-b300"') ? x.replace(/(On-Demand Price:\s*<span class="item-value">)(<\/span>)/, "$1$71.20$2") : x)),
    );
    expect(mobileOnly).not.toBe(page("p_coreweave"));
    expect(read("p_coreweave", mobileOnly).B300).toMatchObject({ state: "NOT_RENTABLE", valueU: 0 });
    const gridOnly = na(page("p_coreweave"), (rows) => rows.map((x) => (x.includes('data-product="nvidia-b300"') ? x.replace(/>(\s*)Contact sales(\s*)</, ">$1$71.20$2<") : x)));
    expect(gridOnly).not.toBe(page("p_coreweave"));
    const r = read("p_coreweave", gridOnly);
    expect(r.B300?.state).not.toBe("VALID");
    expect(r.B300?.valueU).toBe(0);
  });
});

describe("Hyperstack: the SXM A100 row and the B300 row by exact name", () => {
  const base = () => read("p_hyperstack", page("p_hyperstack"));

  test.skipIf(!on)("the SXM row gone and the PCIe rows' no-break spaces gone: still no A100 (never 1.40 or 1.35)", () => {
    const body = swap(page("p_hyperstack"), "<span>NVIDIA A100 SXM</span>", "<span>NVIDIA A100 SXM (sold)</span>").replaceAll("&nbsp;$", "$");
    const r = read("p_hyperstack", body);
    expect(reasonOf(r.A100)).toBe("missing-row");
    untouched("p_hyperstack", base(), r, [...OLD, "B300"]);
  });

  test.skipIf(!on)("the SXM row's VRAM at 40: not our A100", () => {
    const r = read("p_hyperstack", swap(page("p_hyperstack"), /(<span>NVIDIA A100 SXM<\/span>\s*<\/div>\s*<div class="page-price_card_row_item_col page-price_card_row_item_col2">\s*<span>)80/, "$140"));
    expect(reasonOf(r.A100)).toBe("missing-row");
  });

  test.skipIf(!on)("a second NVIDIA A100 SXM row with 40 GB and another price is left out: still the 80 GB row's 1.60", () => {
    const body = page("p_hyperstack");
    const ROW = '<div class="page-price_card_row_item df">';
    const i = body.indexOf("<span>NVIDIA A100 SXM</span>");
    const s = body.lastIndexOf(ROW, i);
    const e = body.indexOf(ROW, i);
    expect(s > 0 && e > i).toBe(true);
    const forty = body.slice(s, e).replace(/(<span>NVIDIA A100 SXM<\/span>\s*<\/div>\s*<div class="page-price_card_row_item_col page-price_card_row_item_col2">\s*<span>)80/, "$140").replace("$1.60", "$0.99");
    expect(forty).not.toBe(body.slice(s, e));
    const r = read("p_hyperstack", body.slice(0, s) + forty + body.slice(s));
    expect(r.A100).toMatchObject({ state: "VALID", valueU: 1_600_000 });
    untouched("p_hyperstack", base(), r, [...OLD, "B300"]);
  });

  test.skipIf(!on)("no B300 row: no B300, never the B200's 6.00; the L40 renamed L40S has no rule", () => {
    const r = read("p_hyperstack", swap(page("p_hyperstack"), "<span>NVIDIA B300</span>", "<span>NVIDIA GB300</span>"));
    expect(reasonOf(r.B300)).toBe("missing-row");
    expect(r.B200).toEqual(base().B200);
    expect(read("p_hyperstack", swap(page("p_hyperstack"), "<span>NVIDIA L40</span>", "<span>NVIDIA L40S</span>")).L40S).toBeUndefined();
  });
});

describe("Civo: the B300 row without a suffix, never the A100 tables", () => {
  const base = () => read("p_civo", page("p_civo"));

  test.skipIf(!on)("a GB300 row inside the B300 table is never read; a suffixed B300 row is no row", () => {
    const body = page("p_civo");
    const s = body.indexOf("<caption>NVIDIA B300 GPU pricing</caption>");
    const tr = /<tr>\s*<td data-title="Size">[\s\S]*?<\/tr>/.exec(body.slice(s))![0];
    const gb = tr.replace("8 x NVIDIA B300<", "8 x NVIDIA GB300<").replace("$59.92<", "$99.92<");
    const r = read("p_civo", body.slice(0, s) + body.slice(s).replace(tr, tr + gb));
    expect(r.B300).toEqual(base().B300);
    const suffixed = read("p_civo", swap(body, "8 x NVIDIA B300<", "8 x NVIDIA B300 - 288GB<"));
    expect(reasonOf(suffixed.B300)).toBe("missing-row");
    untouched("p_civo", base(), suffixed, [...OLD, "L40S"]);
  });

  test.skipIf(!on)("the A100 80GB table recaptioned as SXM: still no A100 rule", () => {
    expect(read("p_civo", swap(page("p_civo"), "<caption>NVIDIA A100 80GB GPU pricing</caption>", "<caption>NVIDIA A100 SXM GPU pricing</caption>")).A100).toBeUndefined();
  });
});

describe("Seeweb (EUR): the L40S card by name and its PCI form", () => {
  test.skipIf(!on)("the A100 card (GPU PCI, EUR 0.99) renamed L40S makes two disagreeing cards: no L40S, never 0.99", () => {
    const base = read("p_seeweb", page("p_seeweb"));
    expect(base.A100).toBeUndefined();
    const r = read("p_seeweb", swap(page("p_seeweb"), '<span class="cardname">NVIDIA A100</span>', '<span class="cardname">NVIDIA L40S</span>'));
    expect(r.L40S?.state).not.toBe("VALID");
    untouched("p_seeweb", base, r, ["H100", "H200"]);
  });
});

describe("Nebius: B300 by its NVLink section only", () => {
  const REG = String.fromCharCode(0xae); // the registered sign the page writes after NVIDIA
  const base = () => read("p_nebius", page("p_nebius"));

  test.skipIf(!on)("the B300 section renamed GB300: no B300; the L40S sections renamed NVLink: still no L40S rule", () => {
    const r = read("p_nebius", swap(page("p_nebius"), `#### NVIDIA${REG} B300 NVLink, gpu-b300-sxm`, `#### NVIDIA${REG} GB300 NVL72, gpu-gb300`));
    expect(reasonOf(r.B300)).toBe("missing-row");
    untouched("p_nebius", base(), r, OLD);
    expect(read("p_nebius", swap(page("p_nebius"), `#### NVIDIA${REG} L40S Intel`, `#### NVIDIA${REG} L40S NVLink`)).L40S).toBeUndefined();
  });

  test.skipIf(!on)("a second B300 platform section at another price: the sections disagree, nothing is read", () => {
    const body = page("p_nebius");
    const s = body.indexOf(`#### NVIDIA${REG} B300 NVLink, gpu-b300-sxm`);
    const e = body.indexOf("\n#### ", s + 5);
    const second = body.slice(s, e).replace("gpu-b300-sxm", "gpu-b300-sxm-a").replace("| \\$9.50 |", "| \\$5.50 |");
    const r = read("p_nebius", body.slice(0, e) + "\n" + second + body.slice(e));
    expect(reasonOf(r.B300)).toBe("ambiguous");
    untouched("p_nebius", base(), r, OLD);
  });
});

// ------------------------------------------------------------------ the whole price path, every hour of the range

/** The live set's median over the slots with a value (an odd count is expected; the contract's even rule is not
 *  needed here). */
function liveMedian(panel: Panel, values: readonly number[]): { n: number; median: number } {
  const xs = panel.slots.filter((s) => s.liveAtStart).map((s) => values[s.slot]!).filter((v) => v > 0).sort((a, b) => a - b);
  return { n: xs.length, median: xs.length % 2 === 1 ? xs[(xs.length - 1) >> 1]! : -1 };
}

/** The research reader's live medians per hour (its evidence file panel-medians-64h.txt), in u. */
function researchMedian(file: "launch.json" | "default.json", gpu: GpuModel, hour: string): number | undefined {
  if (gpu === "B300") return hour < "2026-10-01T00" ? 7_850_000 : hour < "2026-10-01T19" ? 8_620_000 : hour < "2026-10-02T18" ? 8_710_000 : 8_800_000;
  if (gpu === "A100") return file === "launch.json" ? 2_700_000 : hour < "2026-10-02T18" ? 1_790_000 : 1_800_000;
  // L40S: three live in launch.json; default.json's degenerate entry has Verda alone, which moved at the same hour
  if (gpu === "L40S") return hour < "2026-10-01T19" ? 1_540_000 : 1_560_000;
  return undefined;
}

describe("page, parse, slotValues and the live median on every archived hour of the range", () => {
  for (const file of ["launch.json", "default.json"] as const) {
    test.skipIf(!on)(`${file}: the new GPUs' live medians are the research reader's, hour by hour (64 hours)`, () => {
      const panels = (JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "panels", file), "utf8")) as { panels: Panel[] }).panels;
      let checked = 0;
      for (const h of range) {
        const rows: Record<string, ParseResult> = {};
        for (const id of new Set(panels.flatMap((p) => p.slots.map((s) => s.sourceId)))) {
          const body = readArchived(h, id);
          if (body !== null) rows[id] = parse(id, body, ctxOf(h, id));
        }
        for (const p of panels) {
          const want = researchMedian(file, p.gpu, `${h.date}T${h.hour}`);
          if (want === undefined) continue;
          const live = p.slots.filter((s) => s.liveAtStart).length;
          expect({ hour: `${h.date}T${h.hour}`, gpu: p.gpu, ...liveMedian(p, slotValues(p, rows)) }).toEqual({ hour: `${h.date}T${h.hour}`, gpu: p.gpu, n: live, median: want });
          checked++;
        }
      }
      expect(checked).toBe(64 * 3);
    });
  }
});
