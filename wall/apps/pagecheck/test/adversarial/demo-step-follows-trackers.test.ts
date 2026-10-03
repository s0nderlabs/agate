// The demo replay's scripted price step and the page check (15.1).
// A scripted step on a tracker-mapped cloud with no matching tracker script is a real-looking price change the trackers
// never show: after one demo day it raised PAGECHECK_FAULT ("likely parser fault") on a correct parser and opened a
// wrong_cell repair incident. Fixed: the replay's archived GPUTable rows follow the scripted step.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GPU_ECONOMY_FILE, GPUTABLE_GPU, GPUTABLE_PROVIDER, Replay, type ReplayScenario } from "@agate/sources/io";
import { GPUS } from "@agate/sources/pure";
import { GE_FILE, GT_GPU, isGap, TRACKER_MAP } from "../../src/trackers.ts";

const DEMO = join(import.meta.dir, "../../../../packages/sources/replay/demo.json");

interface Demo {
  scripted?: Record<string, { gpus?: Record<string, { from: unknown; price?: string }[]> }>;
  trackers?: { gputable?: unknown[]; gpuEconomy?: Record<string, unknown[]> };
}

describe("demo.json against the page check", () => {
  const demo = JSON.parse(readFileSync(DEMO, "utf8")) as Demo;
  const steps = Object.entries(demo.scripted ?? {}).flatMap(([src, s]) =>
    Object.entries(s.gpus ?? {}).flatMap(([gpu, list]) => list.filter((x) => x.price !== undefined).map((x) => ({ src, gpu, price: x.price! }))),
  );

  test("the demo scripts a price step on a cloud the page check compares (Lambda H100 3.49, archived 3.99: a gap)", () => {
    const lambda = steps.find((x) => x.src === "p_lambda" && x.gpu === "H100");
    expect(lambda?.price).toBe("3.49");
    expect(TRACKER_MAP.p_lambda).toBeDefined();
    expect(isGap(3_490_000, 3_990_000)).toBe(true); // 12.5% off the archived tracker row
  });

  test("every scripted price step on a tracker-mapped cloud is followed by the replay's GPUTable rows", () => {
    const mapped = steps.filter((x) => TRACKER_MAP[x.src]);
    expect(mapped.length).toBeGreaterThan(0);
    const replay = new Replay({ clock: { t0: 0, daySec: 600, slices: 12 }, scenario: { ...(demo as ReplayScenario), archive: false } });
    // an archived GPUTable hour in the tracker's own field names (synthetic numbers: Lambda 3.99 at 8x, 4.29 at 1x)
    const row = (provider: string, gpu: string, count: number, price: number) => ({ gpu, provider, gpu_count: count, price_per_hour_usd: price, pricing_type: "on_demand", commitment_months: null });
    const archived = JSON.stringify({ data: [row("Lambda Labs", "H100 SXM", 8, 3.99), row("Lambda Labs", "H100 SXM", 1, 4.29), row("Verda", "H100 SXM", 8, 3.63), { ...row("Lambda Labs", "H100 SXM", 8, 2.5), pricing_type: "reserved", commitment_months: 12 }] });
    // before the step (demo day 2) the archive is served as is
    expect(replay.followScriptedPrices(archived, 2, 11)).toBe(archived);
    for (const x of mapped) {
      const after = JSON.parse(replay.followScriptedPrices(archived, 3, 0)) as { data: { provider: string; gpu: string; price_per_hour_usd: number; pricing_type: string }[] };
      const gt = TRACKER_MAP[x.src]!.gt;
      const own = after.data.filter((r) => r.provider === gt && r.gpu === GT_GPU[x.gpu as "H100"] && r.pricing_type === "on_demand");
      expect(own.length).toBe(2);
      for (const r of own) expect(r.price_per_hour_usd).toBe(Number(x.price));
      // the step's page value and the tracker row now agree: no gap, so no REVIEW and no FAULT
      expect(isGap(Math.round(Number(x.price) * 1e6), Math.round(own[0]!.price_per_hour_usd * 1e6))).toBe(false);
      // other providers and non on-demand rows untouched
      expect(after.data.find((r) => r.provider === "Verda")!.price_per_hour_usd).toBe(3.63);
      expect(after.data.find((r) => r.pricing_type === "reserved")!.price_per_hour_usd).toBe(2.5);
    }
  });

  test("the replay's provider and GPU names are the page check's (15.1's table)", () => {
    for (const [id, m] of Object.entries(TRACKER_MAP)) expect(GPUTABLE_PROVIDER[id]).toBe(m.gt);
    expect(Object.keys(GPUTABLE_PROVIDER).sort()).toEqual(Object.keys(TRACKER_MAP).sort());
    expect(GPUTABLE_GPU).toEqual(GT_GPU as typeof GPUTABLE_GPU);
    // every GPU of the recipe, the price-only ones included (18.4), and the replay's GPU Economy routes are the files the page check asks for
    expect(Object.keys(GT_GPU).sort()).toEqual([...GPUS].sort());
    expect(GPU_ECONOMY_FILE).toEqual(GE_FILE as typeof GPU_ECONOMY_FILE);
  });
});
