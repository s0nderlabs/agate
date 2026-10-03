// Recheck r1: the Oct 3 repost window (8.1, A2) against a second user of the writer's key (8.5, A4).
// (1) While the writer cannot reach a node after the day ended, a thief with the same key posts the day's unposted
//     slices first; when the writer is back inside REPOST_END its reposts are E7-skipped. KEY_MISMATCH must name each
//     of those slices with both sides, whether the writer kept running or restarted.
// (2) The honest side: a lagging node after the outage hides bits that did land, so the writer reposts landed slices
//     in the grace window; they are E7-skipped and must raise no KEY_MISMATCH or KEY_UNVERIFIED, and nothing is
//     abandoned. TEST clock: DAY 2,400 s, 12 slices, REPOST_END = dayEnd + 2,200 s.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "@agate/report/types";
import { dayEnd, dayStart, type PageResult, repostEnd, reportHex, sliceStart } from "../../../src/core/index.ts";
import { PageReader } from "../../../src/pipeline/fetch.ts";
import { ReadingLog } from "../../../src/pipeline/log.ts";
import type { AlertInput } from "../../../src/pipeline/rpc.ts";
import { directSource } from "../../../src/pipeline/setup.ts";
import { Writer } from "../../../src/pipeline/writer.ts";
import { FakeIndex, INDEX, PRIMARY, SELECTOR, testClocks } from "../../helpers/fakeIndex.ts";
import { fakeSources, PAGES, PANELS } from "../../helpers/fakeSources.ts";

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const D = 20_727;
const THIEF_U = 9_990_000;

function fetcher() {
  return async (url: string): Promise<PageResult> => {
    const body = PAGES[url.split("/").pop()!];
    return body === undefined ? { ok: false, httpStatus: 503, body: "", bytes: 0, error: "HTTP 503" } : { ok: true, httpStatus: 200, body, bytes: body.length };
  };
}

function writer(idx: FakeIndex, logDir: string, alerts: AlertInput[], seed = 7) {
  let s = seed;
  return new Writer({
    role: "primary",
    chain: idx.view(PRIMARY),
    clock: idx.clock,
    chainSelector: SELECTOR,
    panels: PANELS,
    log: new ReadingLog(logDir, "primary"),
    source: directSource(fakeSources, PANELS, new PageReader(fetcher(), "http://replay.test")),
    rand: () => ((s = (s * 48_271) % 2_147_483_647) / 2_147_483_647),
    alert: (a) => void alerts.push(a),
  });
}

async function run(idx: FakeIndex, w: Writer, from: number, to: number, step = 5) {
  for (let t = from; t < to; t += step) {
    idx.time = t;
    await w.tick(t);
  }
}

/** The thief's report of slice h of day D: every panel GPU, every slot at THIEF_U, readAt inside the slice. */
function thief(idx: FakeIndex, h: number): Hex {
  const at = sliceStart(idx.clock, D, h) + 7;
  return reportHex(SELECTOR, INDEX, PANELS.map((p) => ({ gpuId: p.gpuId as Hex, dayId: D, slice: h, readAt: BigInt(at), values: p.slots.map(() => THIEF_U) })));
}

describe("A2 x A4: a thief fills the unposted slices of a day still open for reposts", () => {
  for (const restart of [false, true]) {
    test(`KEY_MISMATCH names every slice the thief took first (${restart ? "the writer restarts after the outage" : "the writer keeps running"})`, async () => {
      const idx = new FakeIndex(testClocks(), PANELS, D);
      idx.writers = [PRIMARY, ZERO];
      const c = idx.clock;
      const logDir = mkdtempSync(join(tmpdir(), "agate-r1-grace-"));
      const alerts: AlertInput[] = [];
      let w = writer(idx, logDir, alerts);
      await run(idx, w, dayStart(c, D), sliceStart(c, D, 9));
      idx.down = true; // the writer's URLs are down from slice 9 (it keeps reading and logging)
      await run(idx, w, sliceStart(c, D, 9), dayEnd(c, D) + 300);
      // the thief has a working node: it posts slices 9, 10 and 11 with the writer's key during the grace
      idx.down = false;
      idx.time = dayEnd(c, D) + 300;
      for (const h of [9, 10, 11]) expect(idx.post(PRIMARY, thief(idx, h)).ok).toBe(true);
      idx.down = true;
      const back = dayEnd(c, D) + 1_500; // inside REPOST_END (dayEnd + 2,200 s)
      await run(idx, w, dayEnd(c, D) + 300, back);
      idx.down = false;
      if (restart) w = writer(idx, logDir, alerts, 13);
      await run(idx, w, back, back + 2 * c.slice);
      expect(back + 2 * c.slice).toBeLessThan(repostEnd(c, D) + c.slice);
      // the writer's reposts of 9 to 11 were E7-skipped: one event per (gpu, slice), the thief's
      for (const h of [9, 10, 11]) for (const p of PANELS) expect(idx.events.filter((e) => e.slice === h && e.gpuId === p.gpuId && e.day === D).map((e) => e.values[0])).toEqual([THIEF_U]);
      const km = alerts.filter((a) => a.code === "KEY_MISMATCH" && a.day === D);
      for (const h of [9, 10, 11]) {
        for (const p of PANELS) {
          const a = km.find((x) => x.slot === h && x.gpuId === p.gpuId);
          expect(a).toBeDefined();
          const data = a!.data as { onchain: { values: number[] }; logged: { values: number[] } | null };
          expect(data.onchain.values.every((v) => v === THIEF_U)).toBe(true);
          expect(data.logged).not.toBeNull(); // the writer read and logged that slice: the alert carries both sides
          expect(data.logged!.values.some((v) => v !== THIEF_U)).toBe(true);
        }
      }
      expect(alerts.some((a) => a.code === "KEY_UNVERIFIED")).toBe(false);
    });
  }
});

describe("A2 x A4: no false alarm when a lagging node hides landed bits during the grace", () => {
  test("landed slices reposted in the grace are E7-skipped: no KEY_MISMATCH, no KEY_UNVERIFIED, nothing abandoned", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO];
    const c = idx.clock;
    const logDir = mkdtempSync(join(tmpdir(), "agate-r1-lag-"));
    const alerts: AlertInput[] = [];
    const w = writer(idx, logDir, alerts);
    await run(idx, w, dayStart(c, D), sliceStart(c, D, 9));
    idx.down = true;
    const back = dayEnd(c, D) + 900;
    await run(idx, w, sliceStart(c, D, 9), back);
    idx.down = false;
    idx.staleReads = 12; // the node the writer comes back to answers empty records for a while
    await run(idx, w, back, back + 3 * c.slice);
    for (const h of [...Array(12).keys()]) for (const p of PANELS) expect(idx.events.filter((e) => e.slice === h && e.gpuId === p.gpuId && e.day === D).length).toBe(1);
    expect(alerts.filter((a) => a.code === "KEY_MISMATCH" || a.code === "KEY_UNVERIFIED")).toEqual([]);
    const closed = idx.closes.find((x) => x.day === D && x.gpuId === PANELS[0]!.gpuId);
    expect(closed).toBeDefined();
    expect(closed!.bits).toBe((1n << 12n) - 1n);
  });
});
