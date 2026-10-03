// A fix found by the integration run (wall/e2e owner-action-expired): `guardian status` reads the events
// itself before listing queued owner actions and reader swaps, so it never depends on another process having synced
// them (10: only queuedEta != 0, every live one).
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuardianLog, type WallEvent } from "@agate/watcher";
import { GUARDIAN, KEEPER, Pages, World } from "@agate/watcher/sim";
import { type CliDeps, run } from "../src/commands.ts";

const OCT1 = 20_727;
const T = 2_400;
const BASE = [3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000];

describe("guardian status syncs the events first", () => {
  test("a reader swap queued after the CLI's event store was last synced is listed", async () => {
    const w = new World({ firstDay: OCT1, pages: new Pages(BASE).fn, writers: [{ net: "w1" }], guardian: null });
    await w.run(OCT1 * T + 100);
    // the store as a fresh CLI process finds it: nothing synced yet
    let synced: readonly WallEvent[] = [];
    let syncs = 0;
    const events = { all: () => synced, sync: async () => void ((synced = [...w.chain.all()]), syncs++) };
    w.m.queueReaderSwap(w.panel.gpuId, 3, "https://s3.example/pricing", "s3/2", "queued while nobody synced", w.now);
    const lines: string[] = [];
    const d: CliDeps = {
      view: w.chain,
      events,
      log: w.log,
      glog: new GuardianLog(mkdtempSync(join(tmpdir(), "agate-guardian-"))),
      alerts: w.alerts,
      clock: w.c,
      panels: [w.panel],
      now: () => w.now,
      out: (l) => lines.push(l),
      prompt: async () => "",
      senderFor: (k) => w.chain.sender(k === "AGATE_KICK_KEY" ? KEEPER : GUARDIAN),
      writerRegion: "writer",
    };
    expect(await run(d, ["status"])).toBe(0);
    expect(syncs).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain('reader swap H100 slot 3 (s3): url https://s3.example/pricing parserVersion s3/2 reason "queued while nobody synced"');
  });
});
