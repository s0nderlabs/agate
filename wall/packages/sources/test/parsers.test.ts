// Every row state on hand-written synthetic pages (src/synthetic.ts), for every source.
import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import type { GpuModel } from "@agate/report/types";
import { GPUS, parse, parseWith, reasonOf, SOURCES } from "../src/pure/index.ts";
import { renderPage, type SynthGpu, type SynthPage, times } from "../src/synthetic.ts";
import type { ParseContext, SourceDef } from "../src/types.ts";

const NOW = Date.UTC(2026, 9, 1, 5, 17) / 1000; // 2026-10-01 05:17 UTC
const ctx: ParseContext = { utcDate: "2026-10-01", nowSec: NOW, fx: { date: "2026-09-30", usdPerEur: "1.1355" } };
const gpusOf = (d: SourceDef) => GPUS.filter((g) => d.rules[g]);
const all = (d: SourceDef, v: SynthGpu): SynthPage => Object.fromEntries(gpusOf(d).map((g) => [g, v]));
/** Expected valueU of a per-GPU native price through the page's own rounding path. */
const want = (d: SourceDef, price: string, count = 8) => {
  const perInstance = ["p_verda", "p_coreweave", "p_civo", "p_gcore"].includes(d.id);
  const n = perInstance ? times(price, count) : price;
  const g = perInstance ? BigInt(count) : 1n;
  const micro = (s: string) => BigInt(s.split(".")[0]!) * 1_000_000n + BigInt((s.split(".")[1] ?? "").padEnd(6, "0"));
  const X = micro(n) * (d.currency === "EUR" ? 1_135_500n : 1_000_000n);
  return Number(((2n * X + 10_000_000_000n * g) / (20_000_000_000n * g)) * 10_000n);
};

for (const d of SOURCES) {
  describe(`${d.id} (${d.currency})`, () => {
    test("8-GPU (or per-GPU) price read on the cent grid", () => {
      const r = parse(d.id, renderPage(d.id, all(d, { price: "3.99" })), ctx);
      expect(Object.keys(r).sort()).toEqual(gpusOf(d).sort());
      for (const g of gpusOf(d)) expect(r[g]).toMatchObject({ state: "VALID", valueU: want(d, "3.99") });
    });

    test("falls back to the 1-GPU instance when there is no 8-GPU one", () => {
      const r = parse(d.id, renderPage(d.id, all(d, { price: "2.57", count: 1 })), ctx);
      for (const g of gpusOf(d)) expect(r[g]).toMatchObject({ state: "VALID", valueU: want(d, "2.57", 1) });
    });

    test("sold out / not orderable, missing row, unreadable cell", () => {
      const gs = gpusOf(d);
      const page: SynthPage = { [gs[0]!]: { state: "not-rentable" }, [gs[1]!]: { state: "missing" } };
      if (gs[2]) page[gs[2]] = { state: "garbled" };
      const r = parse(d.id, renderPage(d.id, page), ctx);
      // Verda's API has no stock state: a not-rentable instance is simply absent (NO_ROW).
      if (d.id === "p_verda") expect(r[gs[0]!]).toMatchObject({ state: "NO_ROW", valueU: 0 });
      else expect(r[gs[0]!]).toMatchObject({ state: "NOT_RENTABLE", valueU: 0 });
      expect(r[gs[1]!]).toMatchObject({ state: "NO_ROW", valueU: 0 });
      expect(reasonOf(r[gs[1]!])).toBe("missing-row");
      if (gs[2]) {
        expect(r[gs[2]]).toMatchObject({ state: "NO_ROW", valueU: 0 });
        expect(reasonOf(r[gs[2]])).toBe("parse-error");
      }
    });

    test("a layout change is detected: nothing is read", () => {
      const r = parse(d.id, renderPage(d.id, all(d, { price: "3.99" }), { broken: true }), ctx);
      for (const g of gpusOf(d)) {
        expect(r[g]!.state).toBe("NO_ROW");
        expect(reasonOf(r[g])).toBe("layout-changed");
      }
    });

    test("absurd values are BAD_VALUE, more than 6 decimals too", () => {
      const [g0, g1] = gpusOf(d) as [GpuModel, GpuModel];
      const sym = (a: string) => (d.id === "p_seeweb" || d.id === "p_verda" ? a : d.currency === "EUR" ? `\u20ac${a}` : d.id === "p_nebius" ? `\\$${a}` : `$${a}`);
      const r = parse(d.id, renderPage(d.id, { [g0]: { raw: sym("99999.00"), count: 1 }, [g1]: { raw: sym("0.01"), count: 1 } }), ctx);
      expect(r[g0]).toMatchObject({ state: "BAD_VALUE", valueU: 0 });
      expect(r[g1]).toMatchObject({ state: "BAD_VALUE", valueU: 0 });
      const p = parse(d.id, renderPage(d.id, { [g0]: { raw: sym("3.1234567"), count: 1 } }), ctx);
      expect(p[g0]).toMatchObject({ state: "BAD_VALUE", valueU: 0 });
      expect(reasonOf(p[g0])).toBe("too-many-decimals");
    });

    test("a page served in another currency is never converted", () => {
      if (d.id === "p_verda") return; // JSON: covered by the currency field test below
      const g0 = gpusOf(d)[0]!;
      const raw = d.currency === "EUR" ? "$3.99" : "\u20ac3.99";
      const r = parse(d.id, renderPage(d.id, { [g0]: { raw, count: 1 } }), ctx);
      expect(r[g0]!.state).toBe("NO_ROW");
      expect(reasonOf(r[g0])).toBe(d.id === "p_seeweb" ? "other-currency" : "other-currency");
    });

    test("transport failures: gzip still compressed, empty, binary, bad context; unknown source", () => {
      const page = renderPage(d.id, all(d, { price: "3.99" }));
      const gz = new TextDecoder("latin1").decode(gzipSync(page));
      for (const [body, reason] of [
        [gz, "not-text"],
        ["", "layout-changed"],
        ["\u0000\u0001\u0002\u0003\u0004\u0005binary", "not-text"],
      ] as const) {
        const r = parse(d.id, body, ctx);
        for (const g of gpusOf(d)) expect(reasonOf(r[g])).toBe(reason);
      }
      for (const bad of [{ ...ctx, nowSec: Number.NaN }, { ...ctx, utcDate: "2026-09-30" }, { ...ctx, nowSec: 12 }]) {
        const r = parse(d.id, page, bad);
        for (const g of gpusOf(d)) expect(reasonOf(r[g])).toBe("bad-context");
      }
      expect(parse("p_unknown", page, ctx)).toEqual({});
    });

    test("never throws and never reads a wrong number from a truncated page", () => {
      const page = renderPage(d.id, all(d, { price: "3.99" }));
      const expected = want(d, "3.99");
      for (let i = 0; i <= 300; i++) {
        const cut = Math.floor((page.length * i) / 300);
        const r = parse(d.id, page.slice(0, cut), ctx);
        for (const g of gpusOf(d)) {
          const row = r[g]!;
          expect(["VALID", "NO_ROW", "NOT_RENTABLE", "BAD_VALUE"]).toContain(row.state);
          if (row.state === "VALID") expect(row.valueU).toBe(expected);
          else expect(row.valueU).toBe(0);
        }
      }
    });
  });
}

describe("EUR sources", () => {
  for (const id of ["p_seeweb", "p_gcore"]) {
    test(`${id}: converted with the ECB rate; no usable rate gives NO_ROW`, () => {
      const page = renderPage(id, { H100: { price: "1.89" }, H200: { price: "2.60" } });
      const r = parse(id, page, ctx);
      expect(r.H100).toMatchObject({ state: "VALID", valueU: 2_150_000 }); // 1.89 * 1.1355 = 2.146095
      expect(r.H200).toMatchObject({ state: "VALID", valueU: 2_950_000 }); // 2.60 * 1.1355 = 2.9523
      const { fx: _fx, ...noFx } = ctx;
      for (const c of [noFx, { ...ctx, fx: { date: "2026-10-01", usdPerEur: "1.1355" } }, { ...ctx, fx: { date: "2026-09-30", usdPerEur: "5" } }]) {
        const n = parse(id, page, c);
        expect(n.H100!.state).toBe("NO_ROW");
        expect(reasonOf(n.H100)).toBe("no-fx");
      }
    });
  }
});

describe("source-specific rules", () => {
  test("Verda: never the spot, CC or PCIe rows; 8x over 1x; sizes must agree; currency field", () => {
    const rows = JSON.parse(renderPage("p_verda", { H100: { price: "3.627" } })) as Record<string, unknown>[];
    rows.push({ model: "H100", name: "H100 SXM5 80GB", currency: "usd", price_per_hour: "4.00", gpu: { number_of_gpus: 1, description: "1x H100 SXM5 80GB" } });
    rows.push({ model: "H100 CC", name: "H100 CC SXM5", currency: "usd", price_per_hour: "1.00", gpu: { number_of_gpus: 8, description: "8x H100 CC" } });
    expect(parse("p_verda", JSON.stringify(rows), ctx).H100).toMatchObject({ state: "VALID", valueU: 3_630_000, gpuCount: 8, raw: "29.016" });
    const two = [...rows, { model: "H100", name: "H100 SXM5 80GB", currency: "usd", price_per_hour: "30.00", gpu: { number_of_gpus: 8, description: "8x H100 SXM5 80GB" } }];
    expect(reasonOf(parse("p_verda", JSON.stringify(two), ctx).H100)).toBe("ambiguous");
    const pcie = rows.map((r) => (r.model === "H100" ? { ...r, name: "H100 PCIe 80GB" } : r));
    expect(reasonOf(parse("p_verda", JSON.stringify(pcie), ctx).H100)).toBe("layout-changed");
    const eur = rows.map((r) => (r.model === "H100" ? { ...r, currency: "eur" } : r));
    expect(reasonOf(parse("p_verda", JSON.stringify(eur), ctx).H100)).toBe("other-currency");
    const num = rows.map((r) => (r.model === "H100" ? { ...r, price_per_hour: 29.016 } : r));
    expect(reasonOf(parse("p_verda", JSON.stringify(num), ctx).H100)).toBe("parse-error"); // a float is never read
    expect(reasonOf(parse("p_verda", "{not json", ctx).H100)).toBe("layout-changed");
  });

  test("Nebius: the block in effect at the reading time (from X counts from 00:00 UTC of X)", () => {
    const page = renderPage("p_nebius", { H100: { price: "4.50" }, H200: { price: "5.40" }, B200: { price: "8.50" } }, { dated: { date: "2026-10-01", before: { H100: "3.85", H200: "4.50", B200: "7.15" } } });
    const at = (sec: number) => parse("p_nebius", page, { utcDate: new Date(sec * 1000).toISOString().slice(0, 10), nowSec: sec });
    const midnight = Date.UTC(2026, 9, 1) / 1000;
    expect(at(midnight - 1)).toMatchObject({ H100: { valueU: 3_850_000 }, H200: { valueU: 4_500_000 }, B200: { valueU: 7_150_000 } });
    expect(at(midnight)).toMatchObject({ H100: { valueU: 4_500_000 }, H200: { valueU: 5_400_000 }, B200: { valueU: 8_500_000 } });
    expect(at(midnight + 86_400 * 30)).toMatchObject({ H100: { valueU: 4_500_000 } });
  });

  test("Nebius: platforms must agree; never the ILS tab or Preemptible rows", () => {
    const page = renderPage("p_nebius", { B200: { price: "8.50" } });
    const second = page.replace("#### NVIDIA\u00ae B200 NVLink", "#### NVIDIA\u00ae B200 NVLink, gpu-b200-sxm-a\n\n<Tabs>\n  <Tab title=\"USD\">\n    | **Item** | **Price** | **Per** |\n    | - | - | - |\n    | NVIDIA\u00ae B200 NVLink | \\$9.00 | 1 GPU hour |\n  </Tab>\n</Tabs>\n\n#### NVIDIA\u00ae B200 NVLink, gpu-b200-sxm");
    expect(reasonOf(parse("p_nebius", second, ctx).B200)).toBe("ambiguous");
    const same = second.replace("\\$9.00", "\\$8.50");
    expect(parse("p_nebius", same, ctx).B200).toMatchObject({ state: "VALID", valueU: 8_500_000 });
    const perHour = page.replace("| 1 GPU hour |", "| 1 GPU minute |");
    expect(reasonOf(parse("p_nebius", perHour, ctx).B200)).toBe("layout-changed");
    const noUsd = page.replace('<Tab title="USD">', '<Tab title="EUR">');
    expect(reasonOf(parse("p_nebius", noUsd, ctx).B200)).toBe("layout-changed");
  });

  // The layout Nebius has used since Oct 8 2026: three dated blocks, the middle one a range ("from X until Y")
  const ranged = (blocks: { head: string; prices: Partial<Record<GpuModel, string>> }[]) => renderPage("p_nebius", { H100: { price: "1.00" } }, { blocks });
  const oct8 = ranged([
    { head: "from October 8, 2026", prices: { H100: "4.60" } },
    { head: "from October 1 until October 8, 2026", prices: { H100: "4.50" } },
    { head: "before October 1, 2026", prices: { H100: "3.85" } },
  ]);
  const read = (v: string, page: string, sec: number) => parseWith(v, page, { utcDate: new Date(sec * 1000).toISOString().slice(0, 10), nowSec: sec }).H100;
  const day = (m: number, d: number, y = 2026) => Date.UTC(y, m, d) / 1000;

  test("Nebius v1 refuses the Oct 8 layout (a range header read as a row would double every GPU)", () => {
    expect(read("nebius/1", oct8, day(9, 12))?.state).toBe("NO_ROW");
  });

  test("Nebius v2: the block in effect by date across the range layout, the on-demand row only", () => {
    expect(read("nebius/2", oct8, day(8, 30))).toMatchObject({ state: "VALID", valueU: 3_850_000 });
    expect(read("nebius/2", oct8, day(9, 1))).toMatchObject({ state: "VALID", valueU: 4_500_000 });
    expect(read("nebius/2", oct8, day(9, 8) - 1)).toMatchObject({ state: "VALID", valueU: 4_500_000 });
    expect(read("nebius/2", oct8, day(9, 8))).toMatchObject({ state: "VALID", valueU: 4_600_000 });
    expect(read("nebius/2", oct8, day(9, 12))).toMatchObject({ state: "VALID", valueU: 4_600_000 });
  });

  test("Nebius v2: a range counts only inside its dates; a year-less first date takes the year before only when it must", () => {
    const only = ranged([{ head: "from October 1 until October 8, 2026", prices: { H100: "4.50" } }]);
    expect(read("nebius/2", only, day(9, 5))).toMatchObject({ state: "VALID", valueU: 4_500_000 });
    expect(read("nebius/2", only, day(9, 8))?.state).toBe("NO_ROW");
    expect(read("nebius/2", only, day(8, 30))?.state).toBe("NO_ROW");
    const yearEnd = ranged([{ head: "from December 15 until January 5, 2027", prices: { H100: "4.40" } }]);
    expect(read("nebius/2", yearEnd, day(11, 20))).toMatchObject({ state: "VALID", valueU: 4_400_000 });
    expect(read("nebius/2", yearEnd, day(0, 5, 2027))?.state).toBe("NO_ROW");
    // the same day twice is an empty range, never a year-long one
    const empty = ranged([
      { head: "from October 8, 2026", prices: { H100: "4.60" } },
      { head: "from October 8 until October 8, 2026", prices: { H100: "9.99" } },
    ]);
    expect(reasonOf(read("nebius/2", empty, day(9, 7)))).toBe("layout-changed");
  });

  test("Nebius v2 places every date like Date.UTC (it computes days itself, since gate 1 forbids Date)", () => {
    const M = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    for (let y = 2024; y <= 2032; y++) {
      for (let m = 0; m < 12; m++) {
        for (const d of [1, 28, new Date(Date.UTC(y, m + 1, 0)).getUTCDate()]) {
          const page = ranged([{ head: `from ${M[m]} ${d}, ${y}`, prices: { H100: "4.50" } }]);
          const at = Date.UTC(y, m, d) / 1000;
          expect(read("nebius/2", page, at - 1)?.state, `${y}-${m + 1}-${d}`).toBe("NO_ROW");
          expect(read("nebius/2", page, at)?.state, `${y}-${m + 1}-${d}`).toBe("VALID");
        }
      }
    }
    expect(reasonOf(read("nebius/2", ranged([{ head: "from February 29, 2027", prices: { H100: "4.50" } }]), day(2, 1, 2027)))).toBe("layout-changed");
  });

  test("Nebius v2 refuses what it cannot place", () => {
    // an Item header it does not know is never read as a row
    const odd = oct8.replaceAll("from October 1 until October 8, 2026", "valid October 1 to October 8, 2026");
    expect(reasonOf(read("nebius/2", odd, day(9, 12)))).toBe("layout-changed");
    const backwards = ranged([{ head: "from October 9, 2026 until October 8, 2026", prices: { H100: "4.50" } }]);
    expect(reasonOf(read("nebius/2", backwards, day(9, 8)))).toBe("layout-changed");
    const clash = ranged([
      { head: "from October 1, 2026", prices: { H100: "4.60" } },
      { head: "from October 1 until October 8, 2026", prices: { H100: "4.50" } },
    ]);
    expect(reasonOf(read("nebius/2", clash, day(9, 5)))).toBe("layout-changed");
    // a range that ended replaced the older block: reading that block again would bring back an old price
    const ended = ranged([
      { head: "from October 1 until October 8, 2026", prices: { H100: "4.50" } },
      { head: "from September 1, 2026", prices: { H100: "3.00" } },
    ]);
    expect(reasonOf(read("nebius/2", ended, day(9, 10)))).toBe("layout-changed");
  });

  test("Nebius v2 reads every page nebius/1 reads to the same states and prices", () => {
    const states = (v: string, page: string, c: ParseContext) => Object.fromEntries(Object.entries(parseWith(v, page, c)).map(([g, r]) => [g, [r.state, r.valueU]]));
    const page = renderPage("p_nebius", { H100: { price: "4.50" }, H200: { price: "5.40" }, B200: { price: "8.50" } }, { dated: { date: "2026-10-01", before: { H100: "3.85", H200: "4.50", B200: "7.15" } } });
    for (const sec of [day(8, 30), day(9, 1), day(9, 20)]) {
      const c = { utcDate: new Date(sec * 1000).toISOString().slice(0, 10), nowSec: sec };
      expect(states("nebius/2", page, c)).toEqual(states("nebius/1", page, c));
    }
    for (const p of [renderPage("p_nebius", { B200: { price: "8.50" } }), renderPage("p_nebius", { B200: { price: "8.50" } }, { broken: true }), renderPage("p_nebius", { H100: { state: "missing" } as never })]) {
      expect(states("nebius/2", p, ctx)).toEqual(states("nebius/1", p, ctx));
    }
  });

  test("Lambda: 8x before 1x, never 4x or 2x, never the cluster table", () => {
    const page = renderPage("p_lambda", { H100: { price: "3.99" }, B200: { price: "6.99", count: 1 } });
    const r = parse("p_lambda", page, ctx);
    expect(r.H100).toMatchObject({ state: "VALID", valueU: 3_990_000 });
    expect(r.B200).toMatchObject({ state: "VALID", valueU: 6_990_000 });
    // An H100 row in the 1x tab too: the 8x one still wins.
    const both = page.replace(
      '<tbody><tr class="row" data-plan="NVIDIA B200 SXM6">',
      '<tbody><tr class="row" data-plan="NVIDIA H100 SXM"><th scope="row" data-label="Plan">NVIDIA H100 SXM</th><td data-label="PRICE/GPU/HR*">$4.29</td></tr><tr class="row" data-plan="NVIDIA B200 SXM6">',
    );
    expect(parse("p_lambda", both, ctx).H100).toMatchObject({ valueU: 3_990_000 });
    // Only a 4x row: never read.
    const four = parse("p_lambda", renderPage("p_lambda", { H100: { raw: "$3.79", count: 4 } }), ctx);
    expect(four.H100!.state).toBe("NO_ROW");
    expect(reasonOf(four.H100)).toBe("missing-row");
    const noTab = page.replace(">1x</button>", ">1 GPU</button>");
    expect(reasonOf(parse("p_lambda", noTab, ctx).H100)).toBe("layout-changed");
  });

  test("CoreWeave: North America only; the two copies of a row must agree; count from the row", () => {
    const page = renderPage("p_coreweave", { H100: { price: "6.155" } });
    expect(parse("p_coreweave", page, ctx).H100).toMatchObject({ state: "VALID", valueU: 6_160_000, raw: "49.24", gpuCount: 8 });
    const mobile = page.replace('<span class="item-value">$49.24</span>', '<span class="item-value">$19.71</span>');
    expect(reasonOf(parse("p_coreweave", mobile, ctx).H100)).toBe("layout-changed");
    const count = page.replace('<div class="table-meta-value">8</div><div>GPU Count</div>', '<div class="table-meta-value">4</div><div>GPU Count</div>');
    expect(reasonOf(parse("p_coreweave", count, ctx).H100)).toBe("layout-changed");
    const noNa = page.replace("REGION: NORTH AMERICA</strong></h5><div class=\"table-v2\">", "REGION: ASIA</strong></h5><div class=\"table-v2\">");
    expect(reasonOf(parse("p_coreweave", noNa, ctx).H100)).toBe("layout-changed");
    const four = renderPage("p_coreweave", { H100: { raw: "$24.62", count: 4 } });
    expect(reasonOf(parse("p_coreweave", four, ctx).H100)).toBe("missing-row");
  });

  test("Civo: 8x over 1x; never a commitment column; B200 with on-demand N/A is NOT_RENTABLE", () => {
    const page = renderPage("p_civo", { H100: { price: "2.99" }, B200: { state: "not-rentable" } });
    const r = parse("p_civo", page, ctx);
    expect(r.H100).toMatchObject({ state: "VALID", valueU: 2_990_000, raw: "23.92", gpuCount: 8 });
    expect(r.B200).toMatchObject({ state: "NOT_RENTABLE", valueU: 0 });
    const pcie = page.replace("8 x NVIDIA H100 - 80GB", "8 x NVIDIA H100 PCIe - 80GB").replace("1 x NVIDIA H100 - 80GB", "1 x NVIDIA H100 PCIe - 80GB");
    expect(reasonOf(parse("p_civo", pcie, ctx).H100)).toBe("missing-row");
  });

  test("Hyperstack: never the NVLink (PCIe) or plain H100 rows, never Reservation", () => {
    const r = parse("p_hyperstack", renderPage("p_hyperstack", { H200: { price: "3.99" } }), ctx);
    expect(reasonOf(r.H100)).toBe("missing-row"); // only "NVIDIA H100 NVLink" and "NVIDIA H100" exist, plus a Reservation row
  });

  test("Seeweb: Spot switch on or a non-default GPU count is refused", () => {
    const page = renderPage("p_seeweb", { H100: { price: "1.89" } });
    const sel = page.replace('<option value="8">8</option></select>', '<option value="8" selected>8</option></select>');
    expect(reasonOf(parse("p_seeweb", sel, ctx).H100)).toBe("layout-changed");
    const pci = page.replace("GPU SXM |", "GPU PCI |");
    expect(reasonOf(parse("p_seeweb", pci, ctx).H100)).toBe("missing-row");
  });

  test("Gcore: only the Virtual GPU table, 8x over 1x", () => {
    const r = parse("p_gcore", renderPage("p_gcore", { H100: { price: "2.36375" } }), ctx);
    expect(r.H100).toMatchObject({ state: "VALID", valueU: 2_680_000, raw: "18.91", gpuCount: 8 });
    expect(reasonOf(r.H200)).toBe("missing-row");
  });
});
