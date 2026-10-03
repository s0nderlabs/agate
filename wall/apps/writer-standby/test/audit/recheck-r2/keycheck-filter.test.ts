// Recheck r2 (phase 2b, cold): KEY_MISMATCH's precision (BUILD-SPEC 8.5, A4). grace-thief proved the positive path
// (a thief filling unposted slices raises KEY_MISMATCH with both sides). This adds the precision guards the detector
// must keep: (1) the writer's OWN honestly-posted slices raise nothing (no self-mismatch), (2) a slice the thief did
// not touch raises nothing, and (3) a ReadingsPosted event with this key for a gpuId that is NOT one of this process's
// panels is ignored (checkEvents filters by panel before reading any field), so a second index's posts never alarm
// this one. TEST clock.
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
const OTHER_GPU = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as Hex;

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

function thief(idx: FakeIndex, h: number): Hex {
  const at = sliceStart(idx.clock, D, h) + 7;
  return reportHex(SELECTOR, INDEX, PANELS.map((p) => ({ gpuId: p.gpuId as Hex, dayId: D, slice: h, readAt: BigInt(at), values: p.slots.map(() => THIEF_U) })));
}

describe("A4: KEY_MISMATCH is precise", () => {
  test("only the thief's slices alarm; the writer's own slices and a non-panel gpuId do not", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO];
    const c = idx.clock;
    const logDir = mkdtempSync(join(tmpdir(), "agate-r2-keycheck-"));
    const alerts: AlertInput[] = [];
    const w = writer(idx, logDir, alerts);
    await run(idx, w, dayStart(c, D), sliceStart(c, D, 9));
    idx.down = true;
    await run(idx, w, sliceStart(c, D, 9), dayEnd(c, D) + 300);
    idx.down = false;
    idx.time = dayEnd(c, D) + 300;
    // the thief fills only slices 9 and 10 (slice 11 stays genuinely unposted: a no-alarm control)
    for (const h of [9, 10]) expect(idx.post(PRIMARY, thief(idx, h)).ok).toBe(true);
    // a second index's post of THIS key for a gpuId this process does not panel: a real on-chain event, must be ignored
    const anyBlock = Math.max(...idx.events.map((e) => e.block));
    (idx.events as { writer: Address; gpuId: Hex; day: number; slice: number; readAt: number; values: number[]; block: number; txHash: Hex }[]).push({
      writer: PRIMARY,
      gpuId: OTHER_GPU,
      day: D,
      slice: 5,
      readAt: sliceStart(c, D, 5) + 9,
      values: [THIEF_U],
      block: anyBlock,
      txHash: `0x${"e".repeat(64)}` as Hex,
    });
    idx.down = true;
    const back = dayEnd(c, D) + 1_500; // inside REPOST_END: the writer comes back and its keycheck scans day D
    await run(idx, w, dayEnd(c, D) + 300, back);
    idx.down = false;
    await run(idx, w, back, repostEnd(c, D) + c.slice);

    const km = alerts.filter((a) => a.code === "KEY_MISMATCH" && a.day === D);
    // slices 9 and 10 alarm for every panel GPU; slice 11 (unposted, not stolen) and 0..8 (the writer's own) do not
    const alarmed = new Set(km.map((a) => a.slot));
    expect([...alarmed].sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([9, 10]);
    for (const p of PANELS) for (const h of [9, 10]) expect(km.some((a) => a.gpuId === p.gpuId && a.slot === h)).toBe(true);
    // never for the non-panel gpuId, and the alarms are action-severity with a guard-act deadline
    expect(km.some((a) => a.gpuId?.toLowerCase() === OTHER_GPU.toLowerCase())).toBe(false);
    for (const a of km) {
      expect(a.severity).toBe("action");
      expect(typeof a.deadline).toBe("number");
    }
    expect(alerts.some((a) => a.code === "KEY_UNVERIFIED")).toBe(false);
  });
});
