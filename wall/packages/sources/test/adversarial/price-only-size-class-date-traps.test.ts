// The price-only GPUs B300, A100 and L40S (BUILD-SPEC 18) against traps of size, price class and date on the real
// archived pages of 2026-10-03 08 UTC: a rule's own row moved to a 2x or 4x tab, an 8x row gone with only 2x and 4x
// left, a price shown only in a commitment column, a reservation card or an inference copy, an instance of four GPUs,
// the in-effect dated block losing its row while the older block keeps one, and a preemptible row losing its prefix.
// Each case edits one page in memory; the rule must read nothing but its own row (else no reading), and H100, H200
// and B200 must read exactly as on the unedited page. Pages stay in the archive. Skips without it.
import { describe, expect, test } from "bun:test";
import type { GpuModel } from "@agate/report/types";
import { archivedFx, archivePresent, listHours, pageTimeOf, readArchived } from "../../src/io/archive.ts";
import { parse, reasonOf } from "../../src/pure/index.ts";
import type { ParseContext, ParseResult } from "../../src/types.ts";

const OLD: readonly GpuModel[] = ["H100", "H200", "B200"];
const at = archivePresent() ? listHours().find((h) => h.date === "2026-10-03" && h.hour === "08") : undefined;
const on = at !== undefined;
if (!on) console.log("archive hour 2026-10-03T08 absent: skipping the size, class and date traps (set AGATE_RAW_DIR)");

const page = (id: string): string => (at ? (readArchived(at, id) ?? "") : "");
function ctxOf(id: string): ParseContext {
  const t = pageTimeOf(at!, id);
  const fx = archivedFx(at!.date);
  return { utcDate: new Date(t * 1000).toISOString().slice(0, 10), nowSec: t, ...(fx ? { fx } : {}) };
}
const read = (id: string, body: string, ctx: ParseContext = ctxOf(id)): ParseResult => parse(id, body, ctx);
const U = (d: string) => Math.round(Number(d) * 100) * 10_000;

/** H100, H200 and B200 (and any other GPU listed) read exactly as on the unedited page. */
function untouched(id: string, after: ParseResult, also: readonly GpuModel[] = []) {
  const before = read(id, page(id));
  for (const g of [...OLD, ...also]) expect({ id, g, row: after[g] }).toEqual({ id, g, row: before[g] });
}
/** Never a VALID reading of any of these per-GPU values. */
function never(row: ParseResult[GpuModel], ...values: string[]) {
  for (const v of values) expect(row?.state === "VALID" && row.valueU === U(v)).toBe(false);
}
function once(body: string, from: string | RegExp, to: string): string {
  const out = body.replace(from, to);
  expect(out).not.toBe(body);
  return out;
}

describe("Verda: 8x, else 1x, never 2x or 4x", () => {
  type Row = { model: string; price_per_hour: string; gpu: { number_of_gpus: number } };
  const rows = (): Row[] => JSON.parse(page("p_verda")) as Row[];
  const NEW = ["B300", "A100 80GB", "L40S"];

  test.skipIf(!on)("today every new GPU reads its 8x row", () => {
    const r = read("p_verda", page("p_verda"));
    expect([r.B300, r.A100, r.L40S].map((x) => [x?.state, x?.valueU, x?.gpuCount])).toEqual([
      ["VALID", U("8.80"), 8],
      ["VALID", U("1.80"), 8],
      ["VALID", U("1.56"), 8],
    ]);
  });

  test.skipIf(!on)("the 8x rows gone: the 1x rows are read (8.795, 1.797, 1.558 per GPU-hour)", () => {
    const r = read("p_verda", JSON.stringify(rows().filter((x) => !(NEW.includes(x.model) && x.gpu.number_of_gpus === 8))));
    expect([r.B300, r.A100, r.L40S].map((x) => [x?.state, x?.valueU, x?.gpuCount])).toEqual([
      ["VALID", U("8.80"), 1],
      ["VALID", U("1.80"), 1],
      ["VALID", U("1.56"), 1],
    ]);
    untouched("p_verda", r);
  });

  test.skipIf(!on)("the 8x and 1x rows gone, the 2x and 4x rows repriced: nothing is read, never a 2x or 4x price", () => {
    const left = rows()
      .filter((x) => !(NEW.includes(x.model) && (x.gpu.number_of_gpus === 8 || x.gpu.number_of_gpus === 1)))
      .map((x) => (NEW.includes(x.model) ? { ...x, price_per_hour: (x.gpu.number_of_gpus * 0.5).toFixed(2) } : x));
    const r = read("p_verda", JSON.stringify(left));
    for (const g of ["B300", "A100", "L40S"] as const) {
      expect(r[g]?.state).toBe("NO_ROW");
      expect(reasonOf(r[g])).toBe("missing-row");
      never(r[g], "0.50");
    }
    untouched("p_verda", r);
  });
});

describe("Lambda A100: the 80 GB row of the 8x tab, else the 1x tab, never 4x or 2x", () => {
  const body = page("p_lambda");
  /** The panel id the tab labelled `label` controls (the instances tab list: 8x, 4x, 2x, 1x). */
  const panelOf = (label: string) => new RegExp(`aria-controls="([^"]+)"[^<>]*>${label}</button>`).exec(body)![1]!;
  const row80 = () => /<tr [^<>]*data-plan="NVIDIA A100 SXM"><th [^<>]*>NVIDIA A100 SXM<\/th><td data-label="VRAM\/GPU">80 GB<\/td>.*?<\/tr>/.exec(body)![0];
  /** Inserts a row first in the table body of the tab labelled `label`. */
  function into(b: string, label: string, tr: string): string {
    const p = b.indexOf(`id="${panelOf(label)}"`);
    const tb = b.indexOf(">", b.indexOf("<tbody", p)) + 1;
    expect(p > 0 && tb > p).toBe(true);
    return b.slice(0, tb) + tr + b.slice(tb);
  }

  test.skipIf(!on)("the tabs are where the trap needs them", () => {
    expect(["8x", "4x", "2x", "1x"].map(panelOf).length).toBe(4);
    expect(row80()).toContain("$2.79");
  });

  test.skipIf(!on)("the 80 GB row moved to the 4x and 2x tabs at $0.50: no A100 (the 1x tab has only the 40 GB row)", () => {
    const cheap = row80().replace("$2.79", "$0.50");
    let b = once(body, row80(), "");
    b = into(into(b, "4x", cheap), "2x", cheap);
    const r = read("p_lambda", b);
    expect(r.A100?.state).toBe("NO_ROW");
    expect(reasonOf(r.A100)).toBe("missing-row");
    never(r.A100, "0.50", "1.99");
    untouched("p_lambda", r);
  });

  test.skipIf(!on)("with an 80 GB row in the 1x tab as well, that one is the fallback (1x, $2.49), never the 4x or 2x rows", () => {
    const cheap = row80().replace("$2.79", "$0.50");
    let b = once(body, row80(), "");
    b = into(into(into(b, "4x", cheap), "2x", cheap), "1x", row80().replace("$2.79", "$2.49"));
    const r = read("p_lambda", b);
    expect([r.A100?.state, r.A100?.valueU, r.A100?.gpuCount]).toEqual(["VALID", U("2.49"), 1]);
    untouched("p_lambda", r);
  });
});

describe("Civo: the on-demand column of the 8x row, else 1x; never a commitment price, never 2x or 4x", () => {
  const body = page("p_civo");
  /** The table captioned `caption`, as [start, end) offsets. */
  const table = (b: string, caption: string): [number, number] => {
    const s = b.indexOf(`<caption>${caption}</caption>`);
    return [s, b.indexOf("</table>", s)];
  };
  /** Removes the <tr> of that table whose size cell reads `size`. */
  function drop(b: string, caption: string, size: string): string {
    const [s, e] = table(b, caption);
    const t = b.slice(s, e);
    const i = t.indexOf(`<div class="product-detail">${size}</div>`);
    expect(i).toBeGreaterThan(0);
    const from = t.lastIndexOf("<tr>", i);
    const to = t.indexOf("</tr>", i) + "</tr>".length;
    return b.slice(0, s) + t.slice(0, from) + t.slice(to) + b.slice(e);
  }

  test.skipIf(!on)("B300's on-demand hourly cell at N/A: NOT_RENTABLE, never its 12, 24 or 36 month prices", () => {
    const [s, e] = table(body, "NVIDIA B300 GPU pricing");
    const t = body.slice(s, e);
    const edited = once(t, '<div id="price-value-hourly" data-option="hourly" class="price-value">$59.92<span>per hour</span></div>', '<div id="price-value-hourly" data-option="hourly" class="price-value">N/A<span>per hour</span></div>');
    const r = read("p_civo", body.slice(0, s) + edited + body.slice(e));
    expect(r.B300?.state).toBe("NOT_RENTABLE");
    expect(r.B300?.valueU).toBe(0);
    never(r.B300, "6.49", "5.99", "5.49");
    untouched("p_civo", r, ["L40S"]);
  });

  test.skipIf(!on)("L40S without its 8x row reads its 1x row; without the 8x and 1x rows, nothing (never the 2x or 4x rows)", () => {
    const no8 = drop(body, "NVIDIA L40S 48GB GPU pricing", "8 x NVIDIA L40S - 48GB");
    const r1 = read("p_civo", no8);
    expect([r1.L40S?.state, r1.L40S?.valueU, r1.L40S?.gpuCount]).toEqual(["VALID", U("1.29"), 1]);
    const r0 = read("p_civo", drop(no8, "NVIDIA L40S 48GB GPU pricing", "1 x NVIDIA L40S - 48GB"));
    expect(r0.L40S?.state).toBe("NO_ROW");
    expect(reasonOf(r0.L40S)).toBe("missing-row");
    untouched("p_civo", r0, ["B300"]);
  });

  test.skipIf(!on)("B300 without its only (8x) row: no B300, nothing borrowed from another table", () => {
    const r = read("p_civo", drop(body, "NVIDIA B300 GPU pricing", "8 x NVIDIA B300"));
    expect(r.B300?.state).not.toBe("VALID");
    untouched("p_civo", r, ["L40S"]);
  });
});

describe("Hyperstack: the On-Demand GPU card only", () => {
  const body = page("p_hyperstack");
  const ROW = '<div class="page-price_card_row_item df">';
  /** Removes the on-demand card's rows named in `names`. */
  function dropOnDemand(b: string, names: string[]): string {
    const a = b.indexOf("<h3><span>On-Demand GPU</span> Pricing</h3>");
    const e = b.indexOf("<h3><span>", a + 10);
    const parts = b.slice(a, e).split(ROW);
    const kept = parts.filter((p, i) => i === 0 || !names.some((n) => new RegExp(`<span>${n}</span>`).test(p)));
    expect(kept.length).toBe(parts.length - names.length);
    return b.slice(0, a) + kept.join(ROW) + b.slice(e);
  }

  test.skipIf(!on)("the reservation card prices A100 SXM at $1.36: the trap is on the page", () => {
    const res = body.indexOf("<h3><span>Reservation</span> Pricing</h3>");
    expect(res).toBeGreaterThan(0);
    expect(body.indexOf("<span>NVIDIA A100 SXM</span>", res)).toBeGreaterThan(res);
    expect(body.slice(res, body.indexOf("<h3><span>", res + 10))).toContain("$1.36");
  });

  test.skipIf(!on)("the on-demand A100 SXM and B300 rows gone: no A100 and no B300, never the reservation card's $1.36", () => {
    const r = read("p_hyperstack", dropOnDemand(body, ["NVIDIA A100 SXM", "NVIDIA B300"]));
    for (const g of ["A100", "B300"] as const) {
      expect(r[g]?.state).toBe("NO_ROW");
      expect(reasonOf(r[g])).toBe("missing-row");
    }
    never(r.A100, "1.36", "1.40", "1.35");
    untouched("p_hyperstack", r);
  });
});

describe("CoreWeave: the on-demand price of an 8-GPU (or 1-GPU) instance, never spot or inference", () => {
  const body = page("p_coreweave");
  /** The North America listitem of `slug`, edited by `f`. */
  function editRow(b: string, slug: string, f: (row: string) => string): string {
    const na = b.indexOf("REGION: NORTH AMERICA</strong>", b.indexOf(">On-demand GPU instances</h2>"));
    const i = b.indexOf(`data-product="${slug}"`, na);
    const s = b.lastIndexOf('<div role="listitem"', i);
    const next = b.indexOf('<div role="listitem"', i);
    const eu = b.indexOf("REGION: EUROPE", na);
    const e = next > 0 && next < eu ? next : eu;
    const row = b.slice(s, e);
    const edited = f(row);
    expect(edited).not.toBe(row);
    return b.slice(0, s) + edited + b.slice(e);
  }

  test.skipIf(!on)('A100 at "Contact sales" while its inference copy still says $2.70: NOT_RENTABLE, never 2.70 or spot', () => {
    const b = editRow(body, "nvidia-a100", (row) =>
      row
        .replace(/<div>\$21\.60<\/div>\s*<a href="" class="table-pricing-url"><\/a>/, '<div></div>\n    <a href="/contact-us" class="table-pricing-url">Contact sales</a>')
        .replace('On-Demand Price: <span class="item-value">$21.60</span>', 'On-Demand Price: <span class="item-value"></span>'),
    );
    expect(b).toContain('Inference Single CPU Price: <span class="item-value">$2.70</span>');
    const r = read("p_coreweave", b);
    expect(r.A100?.state).toBe("NOT_RENTABLE");
    never(r.A100, "2.70", "1.21");
    untouched("p_coreweave", r, ["B300", "L40S"]);
  });

  test.skipIf(!on)("A100 and L40S as 4-GPU instances (both count copies): no reading, never 21.60 / 4 or 18.00 / 4", () => {
    const four = (row: string) => row.replace("<div class=\"table-v2-cell\"><div>8</div></div>", '<div class="table-v2-cell"><div>4</div></div>').replace(/<div class="table-meta-value">8<\/div>(\s*<div>GPU Count<\/div>)/, '<div class="table-meta-value">4</div>$1');
    const r = read("p_coreweave", editRow(editRow(body, "nvidia-a100", four), "nvidia-l40s", four));
    for (const g of ["A100", "L40S"] as const) {
      expect(r[g]?.state).toBe("NO_ROW");
      expect(reasonOf(r[g])).toBe("missing-row");
    }
    never(r.A100, "5.40");
    never(r.L40S, "4.50");
    untouched("p_coreweave", r, ["B300"]);
  });
});

describe("Nebius B300: the dated block in effect, its own row only", () => {
  const body = page("p_nebius");
  const REG = String.fromCharCode(0xae); // the registered sign Nebius writes after NVIDIA
  const OCT1 = Date.UTC(2026, 9, 1) / 1000;
  const ctxAt = (t: number): ParseContext => ({ utcDate: new Date(t * 1000).toISOString().slice(0, 10), nowSec: t });
  /** The B300 section's USD tab, edited by `f`. */
  function editUsd(b: string, f: (tab: string) => string): string {
    const s = b.indexOf(`#### NVIDIA${REG} B300 NVLink`);
    const o = b.indexOf('<Tab title="USD">', s);
    const c = b.indexOf("</Tab>", o);
    const tab = b.slice(o, c);
    const edited = f(tab);
    expect(edited).not.toBe(tab);
    return b.slice(0, o) + edited + b.slice(c);
  }

  test.skipIf(!on)("the boundary to the second: 7.85 until Oct 1 00:00:00 UTC, 9.50 from it (the same page)", () => {
    expect(read("p_nebius", body, ctxAt(OCT1 - 1)).B300).toMatchObject({ state: "VALID", valueU: U("7.85") });
    expect(read("p_nebius", body, ctxAt(OCT1)).B300).toMatchObject({ state: "VALID", valueU: U("9.50") });
  });

  test.skipIf(!on)("the in-effect block loses its B300 row: no reading, never the older block's 7.85 or the preemptible 4.30", () => {
    const b = editUsd(body, (tab) => {
      const from = tab.indexOf("from October 1, 2026");
      const line = `| NVIDIA${REG} B300 NVLink | \\$9.50 | 1 GPU hour |`;
      const i = tab.indexOf(line, from);
      expect(i).toBeGreaterThan(from);
      return tab.slice(0, tab.lastIndexOf("\n", i) + 1) + tab.slice(tab.indexOf("\n", i) + 1);
    });
    const r = read("p_nebius", b);
    expect(r.B300?.state).toBe("NO_ROW");
    expect(reasonOf(r.B300)).toBe("missing-row");
    never(r.B300, "7.85", "4.30");
    untouched("p_nebius", r);
  });

  test.skipIf(!on)("a preemptible row that loses its prefix makes two rows: ambiguous, never 4.30", () => {
    const b = editUsd(body, (tab) => tab.replace(`| Preemptible NVIDIA${REG} B300 NVLink | \\$4.30 |`, `| NVIDIA${REG} B300 NVLink | \\$4.30 |`));
    const r = read("p_nebius", b);
    expect(r.B300?.state).toBe("NO_ROW");
    expect(reasonOf(r.B300)).toBe("ambiguous");
    never(r.B300, "4.30");
    untouched("p_nebius", r);
  });

  test.skipIf(!on)("the USD tab's B300 rows gone: never read from the ILS tab", () => {
    const b = editUsd(body, (tab) =>
      tab
        .split("\n")
        .filter((l) => !l.includes(`B300 NVLink |`))
        .join("\n"),
    );
    const r = read("p_nebius", b);
    expect(r.B300?.state).toBe("NO_ROW");
    untouched("p_nebius", r);
  });
});
