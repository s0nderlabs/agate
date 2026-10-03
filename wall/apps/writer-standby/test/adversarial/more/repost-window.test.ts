// Recheck r2: the Oct 3 repost window (BUILD-SPEC 8.1, A2) has a hard end, REPOST_END =
// graceStart + GRACE - slice. This probes the END of that window (recheck r1 M1 capped the keeper there; grace-thief
// probed a return INSIDE the window). Here the writer's outage ends AFTER REPOST_END: its logged-but-unposted slices
// must be ABANDONED, never reposted past the window, and no false KEY_MISMATCH for the writer's own slices. A control
// confirms the same outage ending one slice earlier (inside the window) does repost. TEST clock: DAY 2,400 s, 12
// slices of 200 s, REPOST_END = dayEnd + 2,200 s.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "@agate/report/types";
import { dayEnd, dayStart, type PageResult, repostEnd, sliceStart } from "../../../src/core/index.ts";
import { PageReader } from "../../../src/pipeline/fetch.ts";
import { ReadingLog } from "../../../src/pipeline/log.ts";
import type { AlertInput } from "../../../src/pipeline/rpc.ts";
import { directSource } from "../../../src/pipeline/setup.ts";
import { type TickResult, Writer } from "../../../src/pipeline/writer.ts";
import { FakeIndex, INDEX, PRIMARY, SELECTOR, testClocks } from "../../helpers/fakeIndex.ts";
import { fakeSources, PAGES, PANELS } from "../../helpers/fakeSources.ts";

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const D = 20_727;

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

async function run(idx: FakeIndex, w: Writer, from: number, to: number, out: TickResult["abandoned"], reposts: TickResult["reposts"], step = 5) {
  for (let t = from; t < to; t += step) {
    idx.time = t;
    const r = await w.tick(t);
    out.push(...r.abandoned);
    reposts.push(...r.reposts);
  }
}

describe("A2: an outage that ends past REPOST_END abandons the day's missing slices", () => {
  test("slices logged but unposted during an outage past REPOST_END are abandoned, never reposted", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO]; // one real writer: no other node fills its gaps
    const c = idx.clock;
    const logDir = mkdtempSync(join(tmpdir(), "agate-r2-abandon-"));
    const alerts: AlertInput[] = [];
    const w = writer(idx, logDir, alerts);
    const abandoned: TickResult["abandoned"] = [];
    const reposts: TickResult["reposts"] = [];
    // post slices 0..8, then go down through the end of the window
    await run(idx, w, dayStart(c, D), sliceStart(c, D, 9), abandoned, reposts);
    idx.down = true;
    const back = dayEnd(c, D) + 2_400; // past REPOST_END (dayEnd + 2,200 s)
    expect(back).toBeGreaterThan(repostEnd(c, D));
    await run(idx, w, sliceStart(c, D, 9), back, abandoned, reposts);
    idx.down = false;
    await run(idx, w, back, back + 3 * c.slice, abandoned, reposts);

    // the writer logged 9, 10 and 11 during the outage but never posted them, and posting past REPOST_END is refused:
    // no event for those slices on chain
    for (const h of [9, 10, 11]) for (const p of PANELS) expect(idx.events.filter((e) => e.slice === h && e.gpuId === p.gpuId && e.day === D).length).toBe(0);
    // they are abandoned with the REPOST_END reason (not "closed without it"): the window ended, not a close
    const ab = abandoned.filter((a) => a.dayId === D);
    for (const h of [9, 10, 11]) {
      const a = ab.find((x) => x.slice === h);
      expect(a).toBeDefined();
      expect(a!.reason).toContain("REPOST_END");
    }
    // no repost of an unposted day-D slice ever succeeded (the outage covered the whole window), and no false
    // KEY_MISMATCH for the writer's own slices
    expect(reposts.filter((r) => r.dayId === D && r.slice >= 9 && r.ok).length).toBe(0);
    expect(alerts.filter((a) => a.code === "KEY_MISMATCH" || a.code === "KEY_UNVERIFIED")).toEqual([]);
  });

  test("control: the same outage ending one slice INSIDE the window does repost those slices", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO];
    const c = idx.clock;
    const logDir = mkdtempSync(join(tmpdir(), "agate-r2-inside-"));
    const alerts: AlertInput[] = [];
    const w = writer(idx, logDir, alerts);
    const abandoned: TickResult["abandoned"] = [];
    const reposts: TickResult["reposts"] = [];
    await run(idx, w, dayStart(c, D), sliceStart(c, D, 9), abandoned, reposts);
    idx.down = true;
    const back = dayEnd(c, D) + 1_500; // inside REPOST_END
    expect(back).toBeLessThan(repostEnd(c, D));
    await run(idx, w, sliceStart(c, D, 9), back, abandoned, reposts);
    idx.down = false;
    await run(idx, w, back, repostEnd(c, D) + c.slice, abandoned, reposts);
    // every slice 9..11 landed once (reposted inside the window), nothing abandoned for day D
    for (const h of [9, 10, 11]) for (const p of PANELS) expect(idx.events.filter((e) => e.slice === h && e.gpuId === p.gpuId && e.day === D).length).toBe(1);
    expect(abandoned.filter((a) => a.dayId === D)).toEqual([]);
  });
});
