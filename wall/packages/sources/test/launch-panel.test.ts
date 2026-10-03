// The launch panel (BUILD-SPEC 7.10): the panel tool's output with --include-over-cap over the archived hours
// 2026-09-30T17 to 2026-10-02T17, written to panels/launch.json. CoreWeave is live on all three GPUs; H200 and B200 go
// to 5 live; H100 keeps 5 live with Hyperstack as the reserve. The archive part is skipped when the archive is absent.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { GpuModel } from "@agate/report/types";
import { archivePresent, listHours } from "../src/io/archive.ts";
import { archiveValues, type HourValues, statsOf } from "../src/io/archiveValues.ts";
import { buildPanel } from "../src/panelTool.ts";
import { checkPanel, CRE_CAP_BYTES, GPUS, recipeHash, SOURCE_META } from "../src/pure/index.ts";
import type { Panel } from "../src/types.ts";

const DIR = join(import.meta.dir, "..", "panels");
const launch = (await Bun.file(join(DIR, "launch.json")).json()) as {
  flags: { includeEur: boolean; includeOverCap: boolean; reserve: Record<string, string> };
  archiveHours: number;
  archiveRange: [string, string];
  panels: Panel[];
  deploy: { gpu: GpuModel; gpuId: string; recipeHash: string; family: number[]; famQ: number[]; liveAtStartMask: number }[];
  choices: { gpu: GpuModel; live: string[]; reserve: string | null }[];
};
const flagless = (await Bun.file(join(DIR, "default.json")).json()) as { flags: { includeOverCap: boolean }; panels: Panel[] };

/** 7.10's table. */
const WANT: Record<GpuModel, { live: string[]; reserve: string | null }> = {
  H100: { live: ["p_verda", "p_nebius", "p_lambda", "p_coreweave", "p_civo"], reserve: "p_hyperstack" },
  H200: { live: ["p_verda", "p_nebius", "p_coreweave", "p_civo", "p_hyperstack"], reserve: null },
  B200: { live: ["p_verda", "p_nebius", "p_lambda", "p_coreweave", "p_hyperstack"], reserve: null },
};
const FROM = "2026-09-30T17";
const TO = "2026-10-02T17";

const liveOf = (p: Panel) => p.slots.filter((s) => s.liveAtStart).map((s) => s.sourceId);
const reserveOf = (p: Panel) => p.slots.find((s) => !s.liveAtStart)?.sourceId ?? null;

describe("panels/launch.json (7.10)", () => {
  test("flags: over-cap on, EUR off, no named reserve; the flagless default.json is unchanged", () => {
    expect(launch.flags).toEqual({ includeEur: false, includeOverCap: true, reserve: {} });
    expect(launch.archiveRange).toEqual([FROM, TO]);
    expect(launch.archiveHours).toBe(49);
    expect(flagless.flags.includeOverCap).toBe(false);
    expect(liveOf(flagless.panels.find((p) => p.gpu === "H100")!)).toEqual(["p_verda", "p_nebius", "p_lambda", "p_civo", "p_hyperstack"]);
    expect(flagless.panels.flatMap((p) => p.slots).some((s) => s.sourceId === "p_coreweave")).toBe(false);
  });

  test("the live sets and the reserve per GPU are 7.10's, odd and with CoreWeave live on every GPU", () => {
    expect(launch.panels.map((p) => p.gpu)).toEqual([...GPUS]);
    for (const p of launch.panels) {
      checkPanel(p);
      expect(liveOf(p), p.gpu).toEqual(WANT[p.gpu].live);
      expect(reserveOf(p), p.gpu).toBe(WANT[p.gpu].reserve);
      expect(liveOf(p).length % 2).toBe(1);
      expect(liveOf(p)).toContain("p_coreweave");
      const c = launch.choices.find((x) => x.gpu === p.gpu)!;
      expect(c.live).toEqual(WANT[p.gpu].live);
      expect(c.reserve).toBe(WANT[p.gpu].reserve);
    }
    // CoreWeave is the over-cap source the flag lets in; its page is above CRE's cap (so the primary runs --limits none)
    expect(SOURCE_META.p_coreweave!.bytes).toBeGreaterThan(CRE_CAP_BYTES);
  });

  test("each deploy entry is its panel's (recipeHash, families, famQ, live mask)", () => {
    for (const d of launch.deploy) {
      const p = launch.panels.find((x) => x.gpuId === d.gpuId)!;
      expect(d.recipeHash).toBe(recipeHash(p));
      expect(d.family).toEqual(p.slots.map((s) => s.family));
      expect(d.famQ).toEqual(p.families.map((f) => f.famQ));
      expect(d.liveAtStartMask).toBe(p.slots.reduce((m, s) => (s.liveAtStart ? m | (1 << s.slot) : m), 0));
    }
  });

  test("without the archive the flag alone makes CoreWeave eligible; without the flag it is display-only for its size", () => {
    for (const g of GPUS) {
      expect(buildPanel(g, null, { includeOverCap: true }).panel.slots.some((s) => s.sourceId === "p_coreweave")).toBe(true);
      const off = buildPanel(g, null, {});
      expect(off.panel.slots.some((s) => s.sourceId === "p_coreweave")).toBe(false);
      expect(off.displayOnly.find((d) => d.sourceId === "p_coreweave")!.reasons.join(" ")).toMatch(/over CRE's 250000-byte cap/);
    }
  });
});

const covered = archivePresent() && listHours().some((h) => `${h.date}T${h.hour}` === FROM) && listHours().some((h) => `${h.date}T${h.hour}` === TO);
if (!covered) console.log(`archive absent or not covering ${FROM} to ${TO}: skipping the archive part of the launch-panel test`);
const values: HourValues[] = covered ? archiveValues().filter((h) => h.hour >= FROM && h.hour <= TO) : [];

describe("the panel tool on the logger archive (7.10)", () => {
  test.skipIf(!covered)("49 hours, every listed source VALID in every hour; the tool's output is launch.json", () => {
    expect(values.length).toBe(49);
    const stats = statsOf(values);
    for (const g of GPUS) {
      const c = buildPanel(g, stats, { includeEur: false, includeOverCap: true, reserve: {} });
      expect(c.live).toEqual(WANT[g].live);
      expect(c.reserve).toBe(WANT[g].reserve);
      for (const id of [...WANT[g].live, ...(WANT[g].reserve ? [WANT[g].reserve!] : [])]) expect(stats.valid[id]?.[g], `${id} ${g}`).toBe(49);
      expect(c.panel).toEqual(launch.panels.find((p) => p.gpu === g)!);
      expect(c.deploy).toEqual(launch.deploy.find((d) => d.gpu === g)! as never);
    }
    // the flip of 17.4 item 1 keeps today's H100 set
    expect(buildPanel("H100", stats, { includeOverCap: true, reserve: { H100: "p_coreweave" } }).live).toEqual(["p_verda", "p_nebius", "p_lambda", "p_civo", "p_hyperstack"]);
  });

  test.skipIf(!covered)("Oct 2 08 UTC medians of the live sets: H100 3.99 with the flag (3.66 without), H200 4.78, B200 6.99", () => {
    const h = values.find((x) => x.hour === "2026-10-02T08")!;
    const median = (g: GpuModel, ids: string[]) => {
      const v = ids.map((id) => h.sources[id]!.rows[g]!).map((r) => (r.s === "VALID" ? r.v : Number.NaN)).sort((a, b) => a - b);
      expect(v.every(Number.isFinite)).toBe(true);
      return v[(v.length - 1) / 2]!;
    };
    expect(median("H100", WANT.H100.live)).toBe(3_990_000);
    expect(median("H100", ["p_verda", "p_nebius", "p_lambda", "p_civo", "p_hyperstack"])).toBe(3_660_000);
    expect(median("H200", WANT.H200.live)).toBe(4_780_000);
    expect(median("B200", WANT.B200.live)).toBe(6_990_000);
  });
});
