// The page check's one exclusion for the price-only GPUs (wall spec 18.4): Hyperstack's A100 is never compared, in
// either tracker, because both list its PCIe card ($1.35) where the rule reads its SXM row ($1.60). Driven through
// the whole page check (fetch, watcher log, runs, alerts, compare log, status) with the real panel files
// (launch.json: Hyperstack the A100 reserve; default.json: Hyperstack live on A100) and the trackers' numbers of
// Oct 3 written as synthetic files in their own field names: a full DAY of honest readings raises nothing, every
// other new pair is compared from GPU Economy, and the exclusion is exactly one pair: a wrong cell on Hyperstack
// B300 or on Verda A100 still raises REVIEW then FAULT, while a wrong cell on Hyperstack A100 is not seen (the cost
// of the exclusion, pinned so it is never forgotten).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GpuModel } from "@agate/report/types";
import type { Panel } from "@agate/sources/types";
import { type CompareLine, readStatus, statusPath } from "../../src/pagecheck.ts";
import { cleanup, CLOCK, geFile, geRow, gtFile, gtRow, makeCheck, ok, type Script, scripted, tmpHome, writeLine } from "../helpers.ts";

afterAll(cleanup);

const U = (d: number) => Math.round(d * 1_000_000);
const PANELS_DIR = join(import.meta.dir, "../../../../packages/sources/panels");
const panelsOf = (f: string): Panel[] => (JSON.parse(readFileSync(join(PANELS_DIR, f), "utf8")) as { panels: Panel[] }).panels;

/** What the clouds' own pages read on Oct 3 08 UTC, per source and new GPU (numbers only). */
const OWN: Record<string, Partial<Record<GpuModel, number>>> = {
  p_verda: { B300: 8.8, A100: 1.8, L40S: 1.56 },
  p_nebius: { B300: 9.5 },
  p_lambda: { A100: 2.79 },
  p_coreweave: { A100: 2.7, L40S: 2.25 },
  p_civo: { B300: 7.49, L40S: 1.29 },
  p_hyperstack: { B300: 7.4, A100: 1.6 },
};

/** GPU Economy's per-GPU files and GPUTable as they listed these GPUs on Oct 3 (the research's one read). */
function trackers(): Script {
  const ge: Record<string, Record<string, unknown>[]> = {
    b300: [geRow("datacrunch", 8.795, { gpu_count: 1 }), geRow("nebius", 9.5, { gpu_count: 1 }), geRow("civo", 7.49), geRow("hyperstack", 7.4, { gpu_count: 1 })],
    "a100-80": [geRow("datacrunch", 1.797, { gpu_count: 1 }), geRow("lambda", 2.79), geRow("coreweave", 2.7), geRow("hyperstack", 1.35, { gpu_count: 1 }), geRow("civo", 1.79)],
    l40s: [geRow("datacrunch", 1.5575), geRow("civo", 1.29), geRow("coreweave", 2.25)],
  };
  const gt = gtFile([
    gtRow("Verda", "B300", 8.795),
    gtRow("Nebius", "B300", 9.5, { gpu_count: 1 }),
    gtRow("Hyperstack", "B300", 7.4, { gpu_count: 1 }),
    gtRow("Verda", "A100 SXM", 1.7975),
    gtRow("Lambda Labs", "A100 SXM", 2.79),
    gtRow("CoreWeave", "A100 SXM", 2.7),
    gtRow("Hyperstack", "A100 SXM", 1.35, { gpu_count: 1 }),
    gtRow("Civo", "A100 SXM", 1.79),
    gtRow("Verda", "L40S", 1.5575),
    gtRow("Civo", "L40S", 1.29),
    gtRow("CoreWeave", "L40S", 2.25),
  ]);
  return (url) => {
    if (url.endsWith("data.json")) return ok(gt);
    const m = /\/gpu\/([a-z0-9-]+)\/prices\.json$/.exec(url);
    return m && ge[m[1]!] ? ok(geFile(CLOCK.epochTs, ge[m[1]!]!)) : undefined;
  };
}

/** A DAY and two intervals of readings (k = 0..13); `own` may differ from OWN per (source, GPU). */
async function run(panels: Panel[], wrong: { sourceId: string; gpu: GpuModel; value: number }[] = []) {
  const home = tmpHome();
  const f = scripted({ current: trackers() });
  const { pc, alerts, step } = makeCheck(home, f.fetch, { panels });
  for (let k = 0; k < 14; k++) {
    for (const [sid, gs] of Object.entries(OWN)) {
      const mine: Partial<Record<GpuModel, number>> = {};
      for (const [g, v] of Object.entries(gs) as [GpuModel, number][]) mine[g] = U(wrong.find((w) => w.sourceId === sid && w.gpu === g)?.value ?? v);
      writeLine(home, sid, k, mine);
    }
    await step(k);
  }
  const file = join(pc.dir, "compare.jsonl");
  const lines = existsSync(file) ? (readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) as CompareLine[]) : [];
  return { home, pc, alerts, lines, urls: f.urls };
}
const slotOf = (panels: Panel[], gpu: GpuModel, sourceId: string) => panels.find((p) => p.gpu === gpu)!.slots.find((s) => s.sourceId === sourceId)!.slot;
const pairsSeen = (lines: CompareLine[]) => new Set(lines.map((l) => `${l.sourceId}:${l.gpu}:${l.tracker}`));

describe("Hyperstack A100 is never compared, through the whole page check", () => {
  for (const file of ["launch.json", "default.json"]) {
    test(`${file}: a DAY of honest readings raises nothing; the other new pairs are compared from GPU Economy every interval`, async () => {
      const panels = panelsOf(file);
      // the panel shapes this test is about (18.3): Hyperstack is A100's reserve in launch.json, live in default.json
      const a100 = panels.find((p) => p.gpu === "A100")!;
      const hs = a100.slots.find((s) => s.sourceId === "p_hyperstack")!;
      expect(hs.liveAtStart).toBe(file === "default.json");
      const { alerts, lines, urls } = await run(panels);
      expect(alerts.all().filter((x) => String(x.code).startsWith("PAGECHECK_"))).toEqual([]);
      expect(lines.some((l) => l.sourceId === "p_hyperstack" && l.gpu === "A100")).toBe(false);
      expect(lines.every((l) => !l.gap)).toBe(true);
      // every slot of the new GPUs with a tracker mapping, Hyperstack A100 aside, compared from GPU Economy
      const want = new Set<string>();
      for (const p of panels.filter((x) => ["B300", "A100", "L40S"].includes(x.gpu)))
        for (const s of p.slots) if (s.sourceId in OWN && OWN[s.sourceId]![p.gpu] !== undefined && !(s.sourceId === "p_hyperstack" && p.gpu === "A100")) want.add(`${s.sourceId}:${p.gpu}:gpueconomy`);
      expect(pairsSeen(lines)).toEqual(want);
      for (const k of want) expect(lines.filter((l) => `${l.sourceId}:${l.gpu}:${l.tracker}` === k).length).toBe(14);
      // the three new GPU Economy files are fetched every interval
      for (const seg of ["b300", "a100-80", "l40s"]) expect(urls.filter((u) => u.endsWith(`/gpu/${seg}/prices.json`)).length).toBe(14);
    });
  }

  test("launch.json: a wrong cell on Hyperstack B300 (-20%) and on Verda A100 (-28%) raises REVIEW then FAULT; Hyperstack A100 at half its price raises nothing", async () => {
    const panels = panelsOf("launch.json");
    const { home, alerts, lines } = await run(panels, [
      { sourceId: "p_hyperstack", gpu: "B300", value: 5.92 },
      { sourceId: "p_verda", gpu: "A100", value: 1.3 },
      { sourceId: "p_hyperstack", gpu: "A100", value: 0.8 },
    ]);
    const ids = (code: string) =>
      alerts
        .all()
        .filter((x) => x.code === code)
        .map((x) => `${panels.find((p) => p.gpuId === x.gpuId)!.gpu}:${x.slot}`)
        .sort();
    const hsB300 = `B300:${slotOf(panels, "B300", "p_hyperstack")}`;
    const verdaA100 = `A100:${slotOf(panels, "A100", "p_verda")}`;
    expect(ids("PAGECHECK_REVIEW")).toEqual([verdaA100, hsB300].sort());
    expect(ids("PAGECHECK_FAULT")).toEqual([verdaA100, hsB300].sort());
    expect(lines.some((l) => l.sourceId === "p_hyperstack" && l.gpu === "A100")).toBe(false);
    const st = readStatus(statusPath(home, "0x1234567890abcdef1234567890abcdef12345678"))!;
    const hsA100 = st.pairs.find((p) => p.gpu === "A100" && p.sourceId === "p_hyperstack")!;
    expect([hsA100.state, hsA100.t, hsA100.gapped]).toEqual(["unknown", null, 0]); // never compared: no tracker value, no run
    expect(st.pairs.find((p) => p.gpu === "B300" && p.sourceId === "p_hyperstack")!.state).toBe("fault");
  });

  test("Hyperstack H100 is still compared through GPU Economy (its GPUTable row alone is excluded); A100 through neither", async () => {
    const home = tmpHome();
    const panels = panelsOf("default.json"); // Hyperstack live on H100 and A100 there
    const script: Script = (url) => {
      if (url.endsWith("data.json")) return ok(gtFile([gtRow("Hyperstack", "H100 SXM", 2.4, { gpu_count: 1 }), gtRow("Hyperstack", "A100 SXM", 1.35, { gpu_count: 1 })]));
      if (url.endsWith("/gpu/h100-sxm/prices.json")) return ok(geFile(CLOCK.epochTs, [geRow("hyperstack", 3.2, { gpu_count: 1 })]));
      if (url.endsWith("/gpu/a100-80/prices.json")) return ok(geFile(CLOCK.epochTs, [geRow("hyperstack", 1.35, { gpu_count: 1 })]));
      return undefined;
    };
    const f = scripted({ current: script });
    const { pc, alerts, step } = makeCheck(home, f.fetch, { panels });
    for (let k = 0; k < 3; k++) {
      writeLine(home, "p_hyperstack", k, { H100: U(3.2), A100: U(1.6) });
      await step(k);
    }
    const lines = readFileSync(join(pc.dir, "compare.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) as CompareLine[];
    expect(lines.map((l) => `${l.gpu}:${l.tracker}:${l.gap}`)).toEqual(["H100:gpueconomy:false", "H100:gpueconomy:false", "H100:gpueconomy:false"]);
    expect(alerts.all().filter((x) => String(x.code).startsWith("PAGECHECK_"))).toEqual([]);
  });
});
