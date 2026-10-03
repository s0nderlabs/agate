// The page check on the logger's real archive (AGATE_RAW_DIR, default ~/.agate-index-logger/data/raw): our own
// parsers on the clouds' archived pages against GPUTable's archived data.json of the same hour (the logger does not
// archive GPU Economy's data files, so this is the fallback path). Skipped when the archive is absent. Numbers only
// are written here, never page content.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GpuModel } from "@agate/report/types";
import { parse } from "@agate/sources/pure";
import type { Panel } from "@agate/sources/types";
import { GE_FILE, gapBps, type IntervalTrackers, isGap, parseGpuEconomy, parseGpuTable, TRACKER_MAP, trackerFor } from "../src/trackers.ts";
import { cleanup, H100_ID, makeCheck, ok, scripted, tmpHome, writeLine } from "./helpers.ts";

afterAll(cleanup);

const RAW = process.env.AGATE_RAW_DIR || join(homedir(), ".agate-index-logger", "data", "raw");
const HAVE = existsSync(join(RAW, "2026-09-30", "17", "t_gputable.all.gz")) && existsSync(join(RAW, "2026-10-02", "12", "t_gputable.all.gz"));
const GPUS: GpuModel[] = ["H100", "H200", "B200"];
/** The window checked by hand on Oct 3 (n = 51 hours); later hours are read but not pinned. */
const LAST_PINNED = "2026-10-02T18";

interface Hour {
  key: string;
  t: number;
  gt: string;
  own: Record<string, Partial<Record<GpuModel, number>>>;
}

function hours(): Hour[] {
  const out: Hour[] = [];
  for (const d of readdirSync(RAW).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort())
    for (const h of readdirSync(join(RAW, d)).filter((x) => /^\d{2}$/.test(x)).sort()) {
      const dir = join(RAW, d, h);
      if (!existsSync(join(dir, "t_gputable.all.gz"))) continue;
      const t = Date.parse(`${d}T${h}:00:00Z`) / 1000;
      const own: Hour["own"] = {};
      for (const sid of Object.keys(TRACKER_MAP)) {
        const f = join(dir, `${sid}.all.gz`);
        if (!existsSync(f)) continue;
        const res = parse(sid, new TextDecoder().decode(Bun.gunzipSync(readFileSync(f))), { utcDate: d, nowSec: t + 30 });
        own[sid] = {};
        for (const g of GPUS) if (res[g]?.state === "VALID") own[sid]![g] = res[g]!.valueU;
      }
      out.push({ key: `${d}T${h}`, t, gt: new TextDecoder().decode(Bun.gunzipSync(readFileSync(join(dir, "t_gputable.all.gz")))), own });
    }
  return out;
}

describe.skipIf(!HAVE)("archive backtest (GPUTable fallback)", () => {
  const hs = HAVE ? hours() : [];
  const compared: { key: string; sid: string; g: GpuModel; own: number; t: number; gap: boolean }[] = [];
  for (const h of hs) {
    const tr: IntervalTrackers = { at: h.t, ge: {}, gt: parseGpuTable(h.gt) };
    for (const [sid, gs] of Object.entries(h.own))
      for (const [g, own] of Object.entries(gs) as [GpuModel, number][]) {
        const row = trackerFor(tr, sid, g, own);
        if (row) compared.push({ key: h.key, sid, g, own, t: row.valueU, gap: isGap(own, row.valueU) });
      }
  }
  const pinned = compared.filter((c) => c.key <= LAST_PINNED);

  test("hand-checked tracker values (three hours)", () => {
    const at = (key: string, sid: string, g: GpuModel) => pinned.find((c) => c.key === key && c.sid === sid && c.g === g)?.t;
    // Oct 2 12 UTC: GPUTable's per-GPU on-demand rows, 8x where listed
    expect(at("2026-10-02T12", "p_verda", "H100")).toBe(3_662_500);
    expect(at("2026-10-02T12", "p_lambda", "H100")).toBe(3_990_000);
    expect(at("2026-10-02T12", "p_coreweave", "H100")).toBe(6_155_000);
    expect(at("2026-10-02T12", "p_civo", "H200")).toBe(3_490_000);
    expect(at("2026-10-02T12", "p_nebius", "B200")).toBe(8_500_000);
    expect(at("2026-10-02T12", "p_hyperstack", "B200")).toBe(6_000_000);
    // Sep 30 17 UTC: GPUTable already lists Nebius's Oct 1 prices
    expect(at("2026-09-30T17", "p_nebius", "H100")).toBe(4_500_000);
    expect(at("2026-09-30T17", "p_lambda", "B200")).toBe(6_690_000);
    // Oct 1 12 UTC: Nebius agrees again
    expect(at("2026-10-01T12", "p_nebius", "H100")).toBe(4_500_000);
    expect(at("2026-10-01T12", "p_verda", "B200")).toBe(6_917_500); // before Verda's +1% of Oct 1 19 UTC
  });

  test("Hyperstack H100 is never compared through GPUTable (40 of 40 false alarms in the brief)", () => {
    expect(compared.some((c) => c.sid === "p_hyperstack" && c.g === "H100")).toBe(false);
  });

  test("the only gaps in the pinned window are Nebius's 7 early hours (Sep 30 17 to 23 UTC), 3 GPUs each", () => {
    const gaps = pinned.filter((c) => c.gap);
    expect(gaps.length).toBe(21);
    expect(new Set(gaps.map((c) => c.sid))).toEqual(new Set(["p_nebius"]));
    expect(new Set(gaps.map((c) => c.key))).toEqual(new Set(["17", "18", "19", "20", "21", "22", "23"].map((h) => `2026-09-30T${h}`)));
    expect(gapBps(3_850_000, 4_500_000)).toBe(1_444);
    expect(pinned.length).toBeGreaterThan(700);
  });

  test("driven through the page check on a PRODUCTION clock: Nebius raises REVIEW, clears at 00 UTC, never FAULT", async () => {
    const home = tmpHome();
    const byT = new Map(hs.map((h) => [h.t, h]));
    const cur = { t: 0 };
    const f = scripted({ current: (u) => (u.endsWith("data.json") ? ok(byT.get(cur.t)!.gt) : undefined) });
    const panels: Panel[] = [
      { gpu: "H100", spec: "H100-SXM/on-demand-list/neocloud/v1", gpuId: H100_ID, families: [], slots: Object.keys(TRACKER_MAP).map((sourceId, slot) => ({ slot, sourceId, family: slot, liveAtStart: true })) },
    ];
    const clock = { day: 86_400, slice: 3_600, minReadings: 12, epochTs: 0 };
    const { pc, alerts, now } = makeCheck(home, f.fetch, { panels, clock });
    const reviews: string[] = [];
    for (const h of hs) {
      cur.t = h.t;
      const k = h.t / 3_600;
      for (const [sid, gs] of Object.entries(h.own)) if (gs.H100 !== undefined) writeLine(home, sid, k, { H100: gs.H100 }, { scheduledAt: h.t + 30, fetchedAt: h.t + 30 });
      now.t = h.t + 1_800;
      await pc.tick(now.t);
      now.t = h.t + 3_600 + 100; // before the next interval's fetch window opens (slice / 20 = 180 s)
      await pc.tick(now.t);
      for (const a of alerts.open()) if (a.code === "PAGECHECK_REVIEW") reviews.push(`${h.key}:${a.slot}`);
      expect(alerts.open().some((a) => a.code === "PAGECHECK_FAULT")).toBe(false);
    }
    const nebSlot = Object.keys(TRACKER_MAP).indexOf("p_nebius");
    const pinnedReviews = reviews.filter((r) => r.slice(0, 13) <= LAST_PINNED);
    expect(pinnedReviews).toEqual(["17", "18", "19", "20", "21", "22", "23"].map((x) => `2026-09-30T${x}:${nebSlot}`));
  });
});

// GPU Economy's per-GPU files are not in the logger archive; the source check of Oct 2 saved one read of each (outside
// the repo). AGATE_TRACKER_SAMPLES names that folder; unset, these tests are skipped. Compared with our parsers on the
// logger's 08 UTC pages.
const GE_DIR = process.env.AGATE_TRACKER_SAMPLES ?? "";
const HAVE_GE = GE_DIR !== "" && existsSync(join(GE_DIR, "gpueconomy_gpu_h100-sxm.gz")) && existsSync(join(RAW, "2026-10-02", "08", "p_lambda.all.gz"));
if (!HAVE_GE) console.log("GPU Economy samples absent: skipping their parity tests (set AGATE_TRACKER_SAMPLES to the saved files' folder)");

describe.skipIf(!HAVE_GE)("GPU Economy's saved files (Oct 2, n = 1 read)", () => {
  test("parse, select and agree with the clouds' own pages on 16 of 16 pairs (hand-checked values)", () => {
    const t: IntervalTrackers = { at: Date.parse("2026-10-02T08:00:00Z") / 1000, ge: {} };
    for (const g of GPUS) t.ge[g] = parseGpuEconomy(new TextDecoder().decode(Bun.gunzipSync(readFileSync(join(GE_DIR, `gpueconomy_gpu_${GE_FILE[g]}.gz`)))));
    for (const g of GPUS) expect(t.ge[g]!.ok).toBe(true);
    const got: Record<string, number> = {};
    let gaps = 0;
    for (const sid of Object.keys(TRACKER_MAP)) {
      const res = parse(sid, new TextDecoder().decode(Bun.gunzipSync(readFileSync(join(RAW, "2026-10-02", "08", `${sid}.all.gz`)))), { utcDate: "2026-10-02", nowSec: t.at + 30 });
      for (const g of GPUS) {
        const r = res[g];
        if (r?.state !== "VALID") continue;
        const row = trackerFor(t, sid, g, r.valueU);
        if (!row) continue;
        expect(row.tracker).toBe("gpueconomy");
        got[`${sid}:${g}`] = row.valueU;
        if (isGap(r.valueU, row.valueU)) gaps++;
      }
    }
    expect(Object.keys(got).length).toBe(16);
    expect(gaps).toBe(0);
    expect(got["p_verda:H100"]).toBe(3_662_500);
    expect(got["p_coreweave:H100"]).toBe(6_155_000);
    expect(got["p_nebius:B200"]).toBe(8_500_000);
    expect(got["p_hyperstack:H100"]).toBe(3_200_000); // GPU Economy lists Hyperstack's SXM price (GPUTable's row is never read)
    expect(got["p_civo:H200"]).toBe(3_490_000);
  });
});
