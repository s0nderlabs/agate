// The writers on the real AgateIndex (builder A's forge build, libraries linked) with the real @agate/sources parsers
// reading scripted synthetic pages from the replay server. Anvil's default test keys on a private local chain only.
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agateIndexAbi } from "@agate/report/abi";
import { encodeMetadata, encodeReport, makeReport } from "@agate/report";
import type { Hex } from "@agate/report/types";
import { closableAt, dayEnd, dayStart, fullBits, pendEnd, readWindow, sendDeadline, sliceStart } from "../src/core/index.ts";
import { reportHex } from "../src/core/index.ts";
import type { LogLine } from "../src/pipeline/log.ts";
import type { ReadingSource } from "../src/pipeline/writer.ts";
import { ADDR, haveAnvil, MOCK_FORWARDER_ABI, SELECTOR } from "./helpers/anvil.ts";
import { D, makeWorld, PRICES, type World } from "./helpers/world.ts";

function logLines(dir: string): LogLine[] {
  return readdirSync(dir)
    .sort()
    .flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogLine);
}

let world: World | undefined;
afterEach(() => {
  world?.stop();
  world = undefined;
});

const PRIMARY = ADDR[1]!;
const STANDBY = ADDR[2]!;

describe.skipIf(!haveAnvil)("writers on the real AgateIndex", () => {
  test("two honest writers, one TEST day: complete, the real parsers' values summed, the primary closes at C1 (v4.3)", async () => {
    const w = (world = await makeWorld());
    const c = w.clock;
    const p = await w.writer("primary");
    const s = await w.writer("standby");
    await w.run([p, s], dayStart(c, D) + 1, pendEnd(c, D) + c.slice);
    const [h100, h200, b200] = w.dep.panels.map((x) => x.gpuId as Hex);
    for (const g of [h100!, h200!, b200!]) {
      for (const who of [PRIMARY, STANDBY]) {
        const r = await w.readings(g, D, who);
        expect(r.sliceBits).toBe(fullBits(c));
        expect(r.anyValid).toBe(true);
      }
    }
    const r100 = await w.readings(h100!, D, PRIMARY);
    expect([...r100.counts]).toEqual([12, 12, 12, 12, 12]);
    expect(r100.sums.map(Number)).toEqual([3_630_000, 4_500_000, 3_990_000, 2_990_000, 2_400_000].map((v) => 12 * v));
    const r200 = await w.readings(h200!, D, STANDBY);
    expect([...r200.counts]).toEqual([12, 12, 12, 0]); // slot 3 (Hyperstack) is the reserve: not readable (E8b)
    expect(await w.skipped()).toBe(0); // no E5/E6 from readAt, no E7 duplicate
    // exactly one post per slice per writer, and nothing else from the standby (it never needed to close)
    const pp = await w.posted(PRIMARY);
    const sp = await w.posted(STANDBY);
    expect(pp.filter((x) => x.day === D).length).toBe(36);
    expect(sp.filter((x) => x.day === D).length).toBe(36);
    for (const list of [pp, sp]) expect(new Set(list.map((x) => `${x.gpuId}:${x.day}:${x.slice}`)).size).toBe(list.length);
    // one transaction per slice read, plus the primary's three closes: no repost, no duplicate, no close by the standby
    expect(await w.txCount(STANDBY)).toBe(new Set(sp.map((x) => x.tx)).size);
    expect(await w.txCount(PRIMARY)).toBe(new Set(pp.map((x) => x.tx)).size + 3);
    const { exists, rec } = await w.record(h100!, D);
    expect(exists).toBe(true);
    expect(rec.source.toLowerCase()).toBe(PRIMARY.toLowerCase());
    expect(rec.value).toBe(3_630_000);
    expect(rec.needsSign).toBe(true); // the first record is a change: countersign needed
    expect(rec.finalAt).toBe(0n);
    expect(Number(rec.postedAt)).toBeGreaterThanOrEqual(closableAt(c, D));
    expect(Number(rec.postedAt)).toBeLessThan(closableAt(c, D) + c.slice / 20 + 25);
    expect((await w.record(h200!, D)).rec.value).toBe(4_730_000);
    expect((await w.record(b200!, D)).rec.value).toBe(6_920_000);
    // explicit gas limits: ceil(1.5 x MEASURED) for both shapes
    expect((await w.a.pub.getTransaction({ hash: (await w.posted(STANDBY))[0]!.tx })).gas).toBe(769_077n);
  }, 120_000);

  test("day two unchanged: closes without needsSign and is final T_PEND after; the closeDay gas limit is ceil(1.5 x 630,218)", async () => {
    const w = (world = await makeWorld());
    const c = w.clock;
    const p = await w.writer("primary");
    const s = await w.writer("standby");
    await w.run([p, s], dayStart(c, D) + 1, closableAt(c, D) + c.slice);
    for (const pn of w.dep.panels) await w.attest(pn.gpuId as Hex, D);
    await w.run([p, s], closableAt(c, D) + c.slice, closableAt(c, D + 1) + c.slice);
    const g = w.dep.panels[0]!.gpuId as Hex;
    const { rec } = await w.record(g, D + 1);
    expect(rec.changed).toBe(false);
    expect(rec.needsSign).toBe(false);
    expect(rec.finalAt).toBe(rec.postedAt + BigInt(c.tPend));
    const sendLines = logLines(p.log.dir).filter((l) => l.kind === "send" && l.action === "close" && l.ok) as { gasLimit?: string }[];
    expect(sendLines.length).toBeGreaterThan(0);
    expect(sendLines.every((l) => l.gasLimit === "945327")).toBe(true);
  }, 120_000);

  test("v4.3 C3: a first writer below quorum cannot close; the complete standby closes from T_PEND and its record needs the countersign", async () => {
    // every page answers 503 to the primary from slice 3: it posts all 12 slices, only 3 with values (below 6)
    const scripted = PRICES.scripted!;
    const dark = Object.fromEntries(Object.entries(scripted).map(([id, x]) => [id, { ...x, page: [{ from: { day: 0, slice: 3 }, state: "http-503" as const }] }]));
    const w = (world = await makeWorld({ scenario: { archive: false, scripted, roles: { primary: dark } } }));
    const c = w.clock;
    const p = await w.writer("primary");
    const s = await w.writer("standby");
    await w.run([p, s], dayStart(c, D) + 1, pendEnd(c, D) + c.slice);
    const g = w.dep.panels[0]!.gpuId as Hex;
    const pr = await w.readings(g, D, PRIMARY);
    expect(pr.sliceBits).toBe(fullBits(c));
    expect([...pr.counts]).toEqual([3, 3, 3, 3, 3]);
    const { rec } = await w.record(g, D);
    expect(rec.source.toLowerCase()).toBe(STANDBY.toLowerCase());
    expect(rec.needsSign).toBe(true); // the source is not the day's first writer (T4 E)
    expect(rec.finalAt).toBe(0n);
    expect(Number(rec.postedAt)).toBeGreaterThanOrEqual(pendEnd(c, D));
    // the primary's close attempts before T_PEND were refused by eth_call (never broadcast); from T_PEND either
    // writer may close (C4), and C3 then names the complete standby whoever calls
    const closes = p.events.filter((x) => x.e === "close");
    expect(closes.some((x) => /C3_BelowQuorum/.test(String(x.d?.error)))).toBe(true);
    const sent = logLines(p.log.dir).filter((l) => l.kind === "send" && l.action === "close" && l.sent) as { at: number }[];
    for (const l of sent) expect(l.at).toBeGreaterThanOrEqual(pendEnd(c, D));
  }, 120_000);

  test("CRE path through the forwarder: a report swallowed by its try/catch is found by the read-back and reposted directly", async () => {
    const w = (world = await makeWorld());
    const c = w.clock;
    const wallet = w.a.wallet(1);
    let n = 0;
    // stands in for the CRE CLI: reads the pages, sends forwarder.forward(index, metadata, report) with the primary key
    // (tx.origin = the writer, TX_ORIGIN mode); the third report carries a wrong chain selector, so A3 reverts inside
    const viaForwarder = (direct: ReadingSource): ReadingSource => ({
      async take(at) {
        const r = await direct.take(at);
        const bad = n++ === 2;
        const hex = bad ? encodeReport(makeReport(SELECTOR + 1n, w.dep.index, r.reading.entries)) : reportHex(SELECTOR, w.dep.index, r.reading.entries);
        const meta = encodeMetadata(`0x${"11".repeat(32)}`, `0x${"22".repeat(10)}`, PRIMARY);
        const hash = await wallet.writeContract({ address: w.dep.forwarder, abi: MOCK_FORWARDER_ABI, functionName: "forward", args: [w.dep.index, meta, hex], account: wallet.account!, chain: wallet.chain, gas: 777_371n });
        const rc = await w.a.pub.waitForTransactionReceipt({ hash });
        return { ...r, via: "cre", sent: { ok: rc.status === "success", sent: true, txHash: hash } };
      },
    });
    const p = await w.writer("primary", { source: (direct) => viaForwarder(direct) });
    await w.run([p], dayStart(c, D) + 1, sliceStart(c, D, 4));
    const g = w.dep.panels[0]!.gpuId as Hex;
    expect((await w.readings(g, D, PRIMARY)).sliceBits).toBe(0b1111n);
    const posted = await w.posted(PRIMARY);
    const s2 = posted.filter((x) => x.day === D && x.slice === 2);
    expect(s2.length).toBe(3);
    const tx = await w.a.pub.getTransaction({ hash: s2[0]!.tx });
    expect(tx.to!.toLowerCase()).toBe(w.dep.index.toLowerCase()); // the repost: postReport, not the forwarder
    expect(await w.skipped()).toBe(0);
    expect(p.events.filter((x) => x.e === "repost").length).toBe(1);
  }, 120_000);

  test("machine asleep: nothing posted for the slept slices, the woken slice skipped after its window, CLOCK_JUMP, the day closes incomplete", async () => {
    const w = (world = await makeWorld());
    const c = w.clock;
    const s = await w.writer("standby");
    await w.run([s], dayStart(c, D) + 1, sliceStart(c, D, 3));
    const [, hi] = readWindow(c);
    const wake = sliceStart(c, D, 7) + hi + 5;
    const [r] = await w.tickAll([s], wake);
    expect(r!.wake?.slept).toBeGreaterThan(3 * 20);
    expect(r!.skipped?.slice).toBe(7);
    expect(s.alerts.some((a) => a.code === "CLOCK_JUMP")).toBe(true);
    await w.run([s], wake + 20, closableAt(c, D) + c.slice);
    const g = w.dep.panels[0]!.gpuId as Hex;
    const bits = (await w.readings(g, D, STANDBY)).sliceBits;
    expect(bits).toBe(fullBits(c) & ~0b11111000n); // slices 3..6 slept through, 7 skipped
    const { rec } = await w.record(g, D);
    expect(rec.source.toLowerCase()).toBe(STANDBY.toLowerCase()); // the only writer with readings is the first writer
    expect(rec.incomplete).toBe(true);
    expect(await w.skipped()).toBe(0);
    // the day closed at C1 (the standby is its first writer): every send of day D went before F1's repost point
    const sends = (await w.posted(STANDBY)).filter((x) => x.day === D);
    for (const x of sends) {
      const b = await w.a.pub.getBlock({ blockNumber: (await w.a.pub.getTransactionReceipt({ hash: x.tx })).blockNumber });
      expect(Number(b.timestamp)).toBeLessThanOrEqual(sendDeadline(c, D) + 2);
    }
  }, 120_000);
});
