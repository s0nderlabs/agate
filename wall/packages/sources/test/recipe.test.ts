import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toHex } from "viem";
import { type ArchiveStats, buildPanel } from "../src/panelTool.ts";
import {
  assertAllowed,
  CanonicalError,
  canonicalJson,
  checkPanel,
  CRE_CAP_BYTES,
  GPUS,
  gpuIdOf,
  PanelError,
  recipeHash,
  recipeObject,
  SOURCE_META,
  SOURCES,
  slotValues,
  specOf,
} from "../src/pure/index.ts";
import type { Panel } from "../src/types.ts";

const H100: Panel = {
  gpu: "H100",
  spec: "H100-SXM/on-demand-list/neocloud/v1",
  gpuId: gpuIdOf("H100-SXM/on-demand-list/neocloud/v1"),
  families: [
    { name: "Verda", famQ: 1 },
    { name: "Nebius", famQ: 1 },
  ],
  slots: [
    { slot: 0, sourceId: "p_verda", family: 0, liveAtStart: true },
    { slot: 1, sourceId: "p_nebius", family: 1, liveAtStart: false },
  ],
};

describe("canonical JSON (7.6)", () => {
  test("sorted keys at every level, no whitespace, integers as numbers, booleans as strings", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, "x", true], c: false } })).toBe('{"a":{"c":"false","d":[3,"x","true"]},"b":1}');
    expect(canonicalJson({ q: 'say "hi" \\ there' })).toBe('{"q":"say \\"hi\\" \\\\ there"}');
    expect(canonicalJson(-0)).toBe("0");
  });
  test("refuses what it cannot encode the same way everywhere", () => {
    for (const bad of [1.5, Number.NaN, 2 ** 60, null, undefined, { a: undefined }, "caf\u00e9", "tab\there", () => 1]) {
      expect(() => canonicalJson(bad)).toThrow(CanonicalError);
    }
  });
});

describe("gpuId and recipeHash", () => {
  test("gpuIdOf is keccak256 of the UTF-8 spec (same as viem's)", () => {
    for (const g of GPUS) expect(gpuIdOf(specOf(g))).toBe(keccak256(toHex(specOf(g))));
    expect(specOf("H200")).toBe("H200-SXM/on-demand-list/neocloud/v1");
  });

  test("recipeHash is stable under key order and object construction", () => {
    const shuffled: Panel = JSON.parse(
      JSON.stringify({
        slots: H100.slots.map((s) => ({ liveAtStart: s.liveAtStart, family: s.family, sourceId: s.sourceId, slot: s.slot })),
        families: H100.families.map((f) => ({ famQ: f.famQ, name: f.name })),
        gpuId: H100.gpuId,
        spec: H100.spec,
        gpu: "H100",
      }),
    );
    expect(recipeHash(shuffled)).toBe(recipeHash(H100));
    // The hash is over the canonical bytes of exactly the 7.6 object.
    expect(recipeHash(H100)).toBe(keccak256(toHex(canonicalJson(recipeObject(H100)))));
    const o = recipeObject(H100);
    expect(Object.keys(o).sort()).toEqual(["bounds", "fx", "rounding", "slots", "spec", "version"]);
    expect(o.bounds).toEqual([100_000, 1_000_000_000]);
    expect(o.fx).toEqual({ source: "ECB eurofxref-hist-90d", rule: "last ECB business day strictly before the page's UTC date", base: "USD per EUR" });
    expect(Object.keys((o.slots as object[])[0]!).sort()).toEqual(
      ["company", "currency", "famQ", "family", "liveAtStart", "parserVersion", "rule", "slot", "sourceId", "url"].sort(),
    );
  });

  test("anything that changes the method changes the hash", () => {
    const base = recipeHash(H100);
    const flip = { ...H100, slots: H100.slots.map((s) => ({ ...s, liveAtStart: true })) };
    expect(recipeHash(flip)).not.toBe(base);
    const swap: Panel = { ...H100, slots: [{ ...H100.slots[0]!, sourceId: "p_nebius" }, { ...H100.slots[1]!, sourceId: "p_verda" }] };
    expect(recipeHash(swap)).not.toBe(base);
  });

  test("checkPanel refuses an inconsistent panel", () => {
    const bad: [string, Panel][] = [
      ["gpuId", { ...H100, gpuId: gpuIdOf("H100-SXM/on-demand-list/neocloud/v2") }],
      ["spec", { ...H100, spec: "H200-SXM/on-demand-list/neocloud/v1", gpuId: gpuIdOf("H200-SXM/on-demand-list/neocloud/v1") }],
      ["order", { ...H100, slots: [H100.slots[1]!, H100.slots[0]!] }],
      ["unknown", { ...H100, slots: [H100.slots[0]!, { ...H100.slots[1]!, sourceId: "p_runpod" }] }],
      ["no rule", { ...H100, gpu: "H200", spec: specOf("H200"), gpuId: gpuIdOf(specOf("H200")), slots: [{ ...H100.slots[0]!, sourceId: "p_lambda" }], families: [H100.families[0]!] }],
      ["twice", { ...H100, slots: [H100.slots[0]!, { ...H100.slots[1]!, sourceId: "p_verda" }] }],
      ["family", { ...H100, slots: [H100.slots[0]!, { ...H100.slots[1]!, family: 5 }] }],
      ["empty family", { ...H100, families: [...H100.families, { name: "X", famQ: 1 }] }],
      ["famQ", { ...H100, families: [{ name: "Verda", famQ: 2 }, H100.families[1]!] }],
      ["none live", { ...H100, slots: H100.slots.map((s) => ({ ...s, liveAtStart: false })) }],
      ["too many", { ...H100, slots: Array.from({ length: 16 }, (_, i) => ({ slot: i, sourceId: "p_verda", family: 0, liveAtStart: true })) }],
    ];
    for (const [why, p] of bad) expect(() => checkPanel(p), why).toThrow(PanelError);
    expect(() => recipeHash(bad[0]![1])).toThrow(PanelError);
  });

  test("slotValues: VALID on-grid in-bounds values in slot order, 0 for everything else", () => {
    const rows = {
      p_verda: { H100: { state: "VALID" as const, valueU: 3_630_000 } },
      p_nebius: { H100: { state: "NOT_RENTABLE" as const, valueU: 0 } },
    };
    expect(slotValues(H100, rows)).toEqual([3_630_000, 0]);
    expect(slotValues(H100, {})).toEqual([0, 0]);
    expect(slotValues(H100, { p_verda: { H100: { state: "VALID", valueU: 3_635_000 } } })).toEqual([0, 0]); // off grid
    expect(slotValues(H100, { p_verda: { H100: { state: "VALID", valueU: 90_000 } } })).toEqual([0, 0]); // below P_MIN
    expect(slotValues(H100, { p_verda: { H100: { state: "BAD_VALUE", valueU: 3_630_000 } } })).toEqual([0, 0]);
    expect(slotValues(H100, { p_verda: { H200: { state: "VALID", valueU: 3_630_000 } } })).toEqual([0, 0]); // another GPU
    expect(() => slotValues({ ...H100, slots: [H100.slots[1]!, H100.slots[0]!] }, rows)).toThrow(PanelError);
  });
});

describe("sources", () => {
  test("no forbidden, held-out or tracker source anywhere in SOURCES", () => {
    for (const s of SOURCES) {
      expect(() => assertAllowed(s)).not.toThrow();
      expect(s.url.startsWith("https://")).toBe(true);
    }
    const hay = JSON.stringify(SOURCES).toLowerCase();
    for (const bad of ["runpod", "ccir", "crusoe", "ornn", "together", "scaleway", "deepinfra", "gpuprice", "gputable", "gpu.ai", "gpueconomy", "getdeploying"]) {
      expect(hay.includes(bad), bad).toBe(false);
    }
    for (const bad of [
      { id: "p_runpod", company: "Runpod", url: "https://www.runpod.io/pricing" },
      { id: "p_x", company: "X", url: "https://ccir.io/rates" },
      { id: "p_crusoe", company: "Crusoe", url: "https://crusoe.ai" },
      { id: "t_gpu", company: "T", url: "https://gpuprice.fyi/api" },
      { id: "p_ornn", company: "Ornn", url: "https://ornn.com" },
    ]) {
      expect(() => assertAllowed(bad)).toThrow();
    }
  });

  test("every source has a rule per GPU it prices, a measured size, and printable-ASCII recipe text", () => {
    expect(SOURCES.map((s) => s.id)).toEqual(["p_verda", "p_nebius", "p_lambda", "p_coreweave", "p_civo", "p_hyperstack", "p_seeweb", "p_gcore"]);
    for (const s of SOURCES) {
      expect(SOURCE_META[s.id]?.bytes).toBeGreaterThan(0);
      expect(Object.keys(s.rules).length).toBeGreaterThan(0);
      expect(() => canonicalJson(s.rules)).not.toThrow();
    }
    expect(SOURCE_META.fx_ecb!.bytes).toBeLessThan(CRE_CAP_BYTES);
  });
});

describe("panel tool defaults (14.1 items 3 to 5)", () => {
  const stats = (over: Record<string, Partial<Record<"H100" | "H200" | "B200", number>>> = {}): ArchiveStats => {
    const valid: ArchiveStats["valid"] = {};
    for (const s of SOURCES) valid[s.id] = Object.fromEntries(Object.keys(s.rules).map((g) => [g, 14]));
    valid.p_civo!.B200 = 0;
    valid.p_gcore!.H200 = 0;
    for (const [id, v] of Object.entries(over)) Object.assign(valid[id]!, v);
    return { hours: 14, valid, present: Object.fromEntries(SOURCES.map((s) => [s.id, 14])) };
  };

  test("USD under the cap with VALID hours, odd live count, reserve by fewest VALID hours (ties: last)", () => {
    const h100 = buildPanel("H100", stats());
    expect(h100.live).toEqual(["p_verda", "p_nebius", "p_lambda", "p_civo", "p_hyperstack"]);
    expect(h100.reserve).toBeNull();
    expect(h100.displayOnly.map((d) => d.sourceId)).toEqual(["p_coreweave", "p_seeweb", "p_gcore"]);
    const h200 = buildPanel("H200", stats());
    expect(h200.live).toEqual(["p_verda", "p_nebius", "p_civo"]);
    expect(h200.reserve).toBe("p_hyperstack");
    const h200b = buildPanel("H200", stats({ p_nebius: { H200: 9 } }));
    expect(h200b.reserve).toBe("p_nebius");
    const b200 = buildPanel("B200", stats());
    expect(b200.live).toEqual(["p_verda", "p_nebius", "p_lambda"]);
    expect(b200.reserve).toBe("p_hyperstack");
    expect(b200.displayOnly.find((d) => d.sourceId === "p_civo")!.reasons.join()).toMatch(/no VALID B200 hour/);
    for (const c of [h100, h200, b200]) {
      expect(c.live.length % 2).toBe(1);
      checkPanel(c.panel);
      expect(c.deploy.recipeHash).toBe(recipeHash(c.panel));
      expect(c.deploy.family).toEqual(c.panel.slots.map((s) => s.slot));
      expect(c.deploy.famQ.every((q) => q === 1)).toBe(true);
      expect(c.deploy.liveAtStartMask).toBe(c.panel.slots.reduce((m, s) => (s.liveAtStart ? m | (1 << s.slot) : m), 0));
    }
  });

  test("flags make EUR and over-cap sources live; a named reserve; bad reserve refused", () => {
    const all = buildPanel("H100", stats(), { includeEur: true, includeOverCap: true });
    expect(all.live.length + (all.reserve ? 1 : 0)).toBe(8);
    expect(all.live.length % 2).toBe(1);
    const eur = buildPanel("H200", stats(), { includeEur: true });
    expect(eur.live).toEqual(["p_verda", "p_nebius", "p_civo", "p_hyperstack", "p_seeweb"]); // Gcore H200: no VALID hour
    expect(buildPanel("B200", stats(), { reserve: { B200: "p_verda" } }).reserve).toBe("p_verda");
    expect(() => buildPanel("B200", stats(), { reserve: { B200: "p_civo" } })).toThrow(/not eligible/);
    expect(buildPanel("H100", null).warnings.join()).toMatch(/no archive/);
    expect(buildPanel("H100", stats()).warnings.join()).toMatch(/p_civo page is \d+ bytes/);
  });

  test("the committed panels/default.json is consistent with the recipe (regenerate with scripts/panel.ts)", () => {
    const doc = JSON.parse(readFileSync(join(import.meta.dir, "..", "panels", "default.json"), "utf8")) as {
      panels: Panel[];
      deploy: { gpu: string; gpuId: string; recipeHash: string; family: number[]; famQ: number[]; liveAtStartMask: number }[];
    };
    expect(doc.panels.map((p) => p.gpu)).toEqual(["H100", "H200", "B200"]);
    doc.panels.forEach((p, i) => {
      checkPanel(p);
      const d = doc.deploy[i]!;
      expect(d.gpuId).toBe(p.gpuId);
      expect(d.recipeHash).toBe(recipeHash(p));
      expect(p.slots.filter((s) => s.liveAtStart).length % 2).toBe(1);
      for (const s of p.slots) {
        const def = SOURCES.find((x) => x.id === s.sourceId)!;
        expect(def.currency).toBe("USD");
        expect(SOURCE_META[def.id]!.bytes).toBeLessThanOrEqual(CRE_CAP_BYTES);
      }
    });
  });
});
