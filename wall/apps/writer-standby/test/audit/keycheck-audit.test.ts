// Audit (phase 2b, rules and liveness lens): KEY_MISMATCH (8.5) against a node that answers eth_getLogs for a range
// before it has the newest block's logs. Fixed in the fix round (L1): the newest blocks are rescanned each tick.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "@agate/report/types";
import { dayStart, type PageResult, reportHex, sliceStart } from "../../src/core/index.ts";
import type { IndexChain } from "../../src/pipeline/chain.ts";
import { PageReader } from "../../src/pipeline/fetch.ts";
import { ReadingLog } from "../../src/pipeline/log.ts";
import type { AlertInput } from "../../src/pipeline/rpc.ts";
import { directSource } from "../../src/pipeline/setup.ts";
import { Writer } from "../../src/pipeline/writer.ts";
import { FakeIndex, INDEX, PRIMARY, SELECTOR, testClocks } from "../helpers/fakeIndex.ts";
import { fakeSources, PAGES, PANELS } from "../helpers/fakeSources.ts";

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const D = 20_727;

function fetcher() {
  return async (url: string): Promise<PageResult> => {
    const body = PAGES[url.split("/").pop()!];
    return body === undefined ? { ok: false, httpStatus: 503, body: "", bytes: 0, error: "HTTP 503" } : { ok: true, httpStatus: 200, body, bytes: body.length };
  };
}

function writerOn(idx: FakeIndex, chain: IndexChain) {
  const logDir = mkdtempSync(join(tmpdir(), "agate-audit-keycheck-"));
  const alerts: AlertInput[] = [];
  let s = 11;
  const w = new Writer({
    role: "primary",
    chain,
    clock: idx.clock,
    chainSelector: SELECTOR,
    panels: PANELS,
    log: new ReadingLog(logDir, "primary"),
    source: directSource(fakeSources, PANELS, new PageReader(fetcher(), "http://replay.test")),
    rand: () => ((s = (s * 48_271) % 2_147_483_647) / 2_147_483_647),
    alert: (a) => void alerts.push(a),
  });
  return { w, alerts };
}

async function run(idx: FakeIndex, w: Writer, from: number, to: number, step = 5) {
  for (let t = from; t < to; t += step) {
    idx.time = t;
    await w.tick(t);
  }
}

describe("8.5 against a lagging eth_getLogs node", () => {
  test("a getLogs answer missing the newest block's logs once never hides a second user of the key for good", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO];
    const view = idx.view(PRIMARY);
    // the node behind the pool has not indexed the thief's block yet on the first scan that covers it: it answers
    // the range without that block's logs (as a load-balanced or failed-over node a block behind would)
    let lagged = false;
    const chain: IndexChain = {
      ...view,
      postedBy: async (wr, from, to) => {
        const evs = await view.postedBy!(wr, from, to);
        if (!lagged && evs.some((e) => e.day === D && e.slice === 3)) {
          lagged = true;
          return evs.filter((e) => !(e.day === D && e.slice === 3));
        }
        return evs;
      },
    };
    const { w, alerts } = writerOn(idx, chain);
    const c = idx.clock;
    await run(idx, w, dayStart(c, D), sliceStart(c, D, 3));
    idx.time = sliceStart(c, D, 3) + 1;
    const thief = reportHex(SELECTOR, INDEX, PANELS.map((p) => ({ gpuId: p.gpuId as Hex, dayId: D, slice: 3, readAt: BigInt(idx.time), values: p.slots.map(() => 9_990_000) })));
    expect(idx.post(PRIMARY, thief).ok).toBe(true);
    await run(idx, w, sliceStart(c, D, 3) + 1, sliceStart(c, D, 8));
    expect(lagged).toBe(true);
    // the audit expects the slice to be caught later (a rescan with overlap, or the accumulator backstop)
    expect(alerts.filter((a) => a.code === "KEY_MISMATCH" && a.day === D).length).toBeGreaterThan(0);
  });
});
