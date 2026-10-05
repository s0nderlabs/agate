// The writer pipeline against the in-memory index (fast; the anvil tests run the same paths on the real contract).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "@agate/report/types";
import { closableAt, dayEnd, dayStart, fullBits, type PageResult, pendEnd, readWindow, reportHex, repostEnd, sendDeadline, sliceStart } from "../src/core/index.ts";
import { PageReader } from "../src/pipeline/fetch.ts";
import { type LogLine, ReadingLog } from "../src/pipeline/log.ts";
import { alertId } from "../src/pipeline/ops.ts";
import type { AlertInput } from "../src/pipeline/rpc.ts";
import { directSource } from "../src/pipeline/setup.ts";
import { type ReadingSource, Writer } from "../src/pipeline/writer.ts";
import { FakeIndex, INDEX, PRIMARY, SELECTOR, STANDBY, testClocks } from "./helpers/fakeIndex.ts";
import { fakeSources, PAGES, PANELS } from "./helpers/fakeSources.ts";

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const D = 20_727;
const H100 = PANELS[0]!.gpuId as Hex;

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

function pagesFetcher(fail?: (id: string) => boolean, count?: { n: number }) {
  return async (url: string): Promise<PageResult> => {
    const id = url.split("/").pop()!;
    if (count && id !== "fx_ecb") count.n += 1;
    const body = PAGES[id];
    if (body === undefined || fail?.(id)) return { ok: false, httpStatus: 503, body: "", bytes: 0, error: "HTTP 503" };
    return { ok: true, httpStatus: 200, body, bytes: body.length };
  };
}

function setup(o: { role: "primary" | "standby"; idx: FakeIndex; seed?: number; source?: ReadingSource; logDir?: string; fetches?: { n: number }; tickS?: number; api?: boolean; keyCheck?: false | { backlogBlocks?: number }; rpcDownOpen?: boolean }) {
  const logDir = o.logDir ?? mkdtempSync(join(tmpdir(), "agate-writer-"));
  const log = new ReadingLog(logDir, o.role);
  const me = o.role === "primary" ? PRIMARY : STANDBY;
  const source = o.source ?? directSource(fakeSources, PANELS, new PageReader(pagesFetcher(undefined, o.fetches), "http://replay.test"));
  const alerts: AlertInput[] = [];
  const w = new Writer({
    role: o.role,
    chain: o.idx.view(me),
    clock: o.idx.clock,
    chainSelector: SELECTOR,
    panels: PANELS,
    log,
    source,
    rand: lcg(o.seed ?? 7),
    alert: (a) => void alerts.push(a),
    heartbeatDir: join(logDir, o.role),
    ...(o.tickS ? { tickS: o.tickS } : {}),
    ...(o.api ? { api: fakeSources } : {}),
    ...(o.keyCheck !== undefined ? { keyCheck: o.keyCheck } : {}),
    ...(o.rpcDownOpen ? { rpcDownOpen: true } : {}),
  });
  return { w, log, logDir, me, alerts };
}

async function run(idx: FakeIndex, writers: Writer[], from: number, to: number, step = 5) {
  for (let t = from; t < to; t += step) {
    idx.time = t;
    for (const w of writers) await w.tick(t);
  }
}

function lines(logDir: string, role: string): LogLine[] {
  const dir = join(logDir, role, "readings");
  return readdirSync(dir)
    .sort()
    .flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogLine);
}

describe("writer pipeline on the TEST profile (DAY 2,400 s, 12 slices)", () => {
  test("one honest day: one read per slice inside [slice/20, slice/2), values on the cent grid, close at C1", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO];
    const { w, logDir } = setup({ role: "primary", idx });
    const c = idx.clock;
    await run(idx, [w], dayStart(c, D), closableAt(c, D) + c.slice);

    const day = idx.posts.filter((p) => p.entries.some((e) => e.dayId === D));
    expect(day.length).toBe(12);
    for (const p of day) {
      expect(p.entries.length).toBe(3); // one entry per registered GPU, same (day, slice, readAt)
      const e = p.entries[0]!;
      const s0 = sliceStart(c, D, e.slice);
      expect(e.readAt).toBeGreaterThanOrEqual(s0);
      expect(e.readAt - s0).toBeLessThan(c.slice / 2);
      expect(p.at - s0).toBeGreaterThanOrEqual(c.slice / 20);
      expect(new Set(p.entries.map((x) => `${x.slice}:${x.readAt}`)).size).toBe(1);
    }
    // H100 slots: f_a 2.99, f_b 6.155 -> 6.16, f_c 3.10, f_e EUR 2.27 x 1.1734 = 2.663618 -> 2.66
    expect(day[0]!.entries.find((e) => e.gpuId === H100)!.values).toEqual([2_990_000, 6_160_000, 3_100_000, 2_660_000]);
    expect(day[0]!.entries[2]!.values).toEqual([5_250_000, 0]); // B200 slot 1 is sold out on f_b: no reading
    expect(idx.complete(H100, D, PRIMARY)).toBe(true);
    expect(idx.closes.filter((x) => x.gpuId === H100).length).toBe(1);
    const cl = idx.closes[0]!;
    expect(cl.at).toBeGreaterThanOrEqual(closableAt(c, D));
    expect(cl.at).toBeLessThan(closableAt(c, D) + c.slice / 20 + 10);
    // every send carries its day's REPOST_END (8.1, Oct 3), so a stuck one is cancelled, never sent after it
    expect(idx.metas.filter((m) => m.action === "post" && m.dayId === D).map((m) => m.deadline)).toEqual(Array(12).fill(repostEnd(c, D)));
    const hb = JSON.parse(readFileSync(join(logDir, "primary/heartbeat.json"), "utf8"));
    expect(hb).toMatchObject({ pid: process.pid, role: "primary", index: idx.view(PRIMARY).index });
    expect(hb.tick).toBeGreaterThan(400);
    expect(existsSync(join(logDir, "primary", `heartbeat-${idx.view(PRIMARY).index.slice(2, 10).toLowerCase()}.json`))).toBe(true);
  });

  test("the reading is logged before the chain is touched, with per-source states and the tx hash after", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    const { w, logDir } = setup({ role: "standby", idx });
    const c = idx.clock;
    const view = idx.view(STANDBY);
    let readingsAtSend = -1;
    (w as unknown as { c: { chain: typeof view } }).c.chain = {
      ...view,
      postReport: async (hex, meta) => {
        readingsAtSend = lines(logDir, "standby").filter((l) => l.kind === "reading").length;
        return view.postReport(hex, meta);
      },
    };
    await run(idx, [w], dayStart(c, D), dayStart(c, D) + c.slice);
    expect(readingsAtSend).toBe(1);
    const ls = lines(logDir, "standby");
    expect(ls[0]).toMatchObject({ kind: "wake", slept: null }); // a fresh start runs the wake routine first
    const rd = ls.find((l) => l.kind === "reading") as Extract<LogLine, { kind: "reading" }>;
    expect(rd.sources.find((s) => s.sourceId === "f_e")!.fxDate).toBe("2026-09-30");
    expect(rd.sources.find((s) => s.sourceId === "f_b")!.rows.B200!.state).toBe("NOT_RENTABLE");
    const send = ls.find((l) => l.kind === "send")!;
    expect(send).toMatchObject({ kind: "send", action: "post", ok: true, dayId: D, slice: 0 });
    expect((send as { txHash: string }).txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("a swallowed post (forwarder try/catch) is found by the read-back and reposted unchanged", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO];
    idx.swallow.set(PRIMARY.toLowerCase(), 1);
    const { w } = setup({ role: "primary", idx });
    const c = idx.clock;
    await run(idx, [w], dayStart(c, D), dayStart(c, D) + 2 * c.slice);
    const s0 = idx.posts.filter((p) => p.entries.some((e) => e.slice === 0 && e.dayId === D));
    expect(s0.length).toBe(1); // the applied repost
    expect(idx.calls.filter((x) => x.slices.includes(0)).length).toBe(2); // the swallowed post and the repost
    const e = s0[0]!.entries[0]!;
    expect(e.readAt - sliceStart(c, D, 0)).toBeLessThan(c.slice / 2); // original readAt, not the repost time
    expect(s0[0]!.at).toBeGreaterThanOrEqual(e.readAt + Math.floor(c.slice / 10) - 5);
  });

  test("REPOST_END: nothing of an open day is sent after graceStart + GRACE - slice; what never landed is abandoned once", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO];
    idx.swallow.set(PRIMARY.toLowerCase(), 10_000); // nothing lands, nobody can close: the day stays open
    const { w, logDir } = setup({ role: "primary", idx });
    const c = idx.clock;
    const end = repostEnd(c, D);
    expect(end).toBe(dayEnd(c, D) + c.grace - c.slice); // registered before the day: graceStart = dayEnd
    await run(idx, [w], dayStart(c, D) + 10 * c.slice, end + 3 * c.slice, 3);
    const late = idx.calls.filter((x) => x.days.includes(D));
    expect(late.length).toBeGreaterThan(2);
    for (const x of late) expect(x.at).toBeLessThanOrEqual(end);
    expect(late.some((x) => x.at > sendDeadline(c, D))).toBe(true); // the day is open: reposts go on after F1's point
    const ab = lines(logDir, "primary").filter((l) => l.kind === "abandon");
    expect(ab.map((l) => (l as { slice: number }).slice).sort((a, b) => a - b)).toEqual([10, 11]);
    expect(ab.every((l) => (l as { at: number }).at > end)).toBe(true);
    expect(ab.every((l) => /REPOST_END/.test((l as { reason: string }).reason))).toBe(true);
  });

  test("a slice-11 entry that only lands after midnight (inside the grace) completes the day", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO];
    const c = idx.clock;
    idx.refuseUntil.set(PRIMARY.toLowerCase(), dayEnd(c, D) + 5);
    const { w } = setup({ role: "primary", idx });
    await run(idx, [w], sliceStart(c, D, 11), closableAt(c, D) + c.slice);
    expect(idx.accOf(H100, D, PRIMARY).bits).toBe(1n << 11n);
    const landed = idx.posts.find((p) => p.entries.some((e) => e.slice === 11 && e.dayId === D))!;
    expect(landed.at).toBeGreaterThan(dayEnd(c, D));
    expect(landed.at).toBeLessThanOrEqual(sendDeadline(c, D));
  });

  test("v4.3 close: the first writer closes at C1 even with a slice missing; the complete standby waits for T_PEND", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    const c = idx.clock;
    const fetch = directSource(fakeSources, PANELS, new PageReader(pagesFetcher(), "http://replay.test"));
    const lossy: ReadingSource = { take: async (at) => (at.slice === 4 ? Promise.reject(new Error("process was down")) : fetch.take(at)) };
    const p = setup({ role: "primary", idx, seed: 1, source: lossy });
    const s = setup({ role: "standby", idx, seed: 2 });
    await run(idx, [p.w, s.w], dayStart(c, D), pendEnd(c, D) + c.slice);
    expect(idx.complete(H100, D, PRIMARY)).toBe(false);
    expect(idx.complete(H100, D, STANDBY)).toBe(true);
    const cl = idx.closes.filter((x) => x.gpuId === H100 && x.day === D);
    expect(cl.length).toBe(1);
    expect(cl[0]).toMatchObject({ caller: PRIMARY, source: PRIMARY });
    expect(cl[0]!.at).toBeGreaterThanOrEqual(closableAt(c, D));
    expect(cl[0]!.at).toBeLessThan(pendEnd(c, D));
    // independent random read seconds (HF-5)
    const at = (wr: Address) => idx.posts.filter((x) => x.writer === wr && x.entries[0]?.dayId === D).map((x) => x.entries[0]!.readAt);
    expect(at(PRIMARY)).not.toEqual(at(STANDBY).slice(0, at(PRIMARY).length));
  });

  test("v4.3 close: with the primary dark all day the standby is the first writer and closes at C1", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    const c = idx.clock;
    const s = setup({ role: "standby", idx });
    await run(idx, [s.w], dayStart(c, D), pendEnd(c, D) + c.slice);
    const cl = idx.closes.filter((x) => x.gpuId === H100 && x.day === D);
    expect(cl.length).toBe(1);
    expect(cl[0]).toMatchObject({ caller: STANDBY, source: STANDBY });
    expect(cl[0]!.at).toBeLessThan(closableAt(c, D) + c.slice / 20 + 10);
  });

  test("v4.3 close: a writer that is not the first writer closes from T_PEND if the day is still open", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    const c = idx.clock;
    const p = setup({ role: "primary", idx, seed: 3 });
    const s = setup({ role: "standby", idx, seed: 4 });
    await run(idx, [p.w, s.w], dayStart(c, D), dayEnd(c, D));
    // the primary goes away before its close: only the standby ticks from here
    await run(idx, [s.w], dayEnd(c, D), pendEnd(c, D) + c.slice);
    const cl = idx.closes.filter((x) => x.gpuId === H100 && x.day === D);
    expect(cl.length).toBe(1);
    expect(cl[0]).toMatchObject({ caller: STANDBY, source: PRIMARY });
    expect(cl[0]!.at).toBeGreaterThanOrEqual(pendEnd(c, D));
  });

  test("a restarted writer does not read a slice it already logged", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    const c = idx.clock;
    const a = setup({ role: "standby", idx });
    await run(idx, [a.w], dayStart(c, D), dayStart(c, D) + c.slice - 20);
    expect(idx.calls.length).toBe(1);
    const b = setup({ role: "standby", idx, logDir: a.logDir, seed: 99 });
    await run(idx, [b.w], dayStart(c, D) + c.slice - 20, dayStart(c, D) + c.slice);
    expect(idx.calls.length).toBe(1);
  });

  test("wake after a jump (machine asleep 3 slices): CLOCK_JUMP, no fetch for the slept slices, resume or skip by the read window", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    const c = idx.clock;
    const fetches = { n: 0 };
    const { w, logDir, alerts } = setup({ role: "standby", idx, fetches });
    await run(idx, [w], dayStart(c, D), sliceStart(c, D, 2));
    const before = fetches.n;
    expect(idx.calls.length).toBe(2);
    // asleep through slices 2, 3, 4; wakes 3/4 into slice 5 (after its read window): slice 5 is skipped too
    const [, hi] = readWindow(c);
    const wakeT = sliceStart(c, D, 5) + Math.floor(c.slice * 0.75);
    idx.time = wakeT;
    const r = await w.tick(wakeT);
    expect(r.wake?.slept).toBe(wakeT - (sliceStart(c, D, 2) - 5));
    expect(r.skipped).toMatchObject({ dayId: D, slice: 5 });
    expect(fetches.n).toBe(before);
    expect(alerts.some((a) => a.code === "CLOCK_JUMP" && (a.data as { slept: number }).slept === r.wake!.slept)).toBe(true);
    await run(idx, [w], wakeT + 5, sliceStart(c, D, 7));
    expect(idx.calls.map((x) => x.slices[0])).toEqual([0, 1, 6]); // nothing for 2..5, slice 6 read normally
    // a second sleep that ends inside slice 8's read window resumes slice 8 at a fresh second ahead
    const wake2 = sliceStart(c, D, 8) + Math.floor(hi / 2);
    idx.time = wake2;
    const r2 = await w.tick(wake2);
    expect(r2.skipped).toBeUndefined();
    await run(idx, [w], wake2 + 5, sliceStart(c, D, 9));
    expect(idx.calls.map((x) => x.slices[0])).toEqual([0, 1, 6, 8]);
    const e8 = idx.posts.at(-1)!.entries[0]!;
    expect(e8.readAt).toBeGreaterThanOrEqual(wake2 - 2);
    expect(e8.readAt - sliceStart(c, D, 8)).toBeLessThan(hi);
    expect(lines(logDir, "standby").filter((l) => l.kind === "skip").length).toBe(1);
  });

  test("a fresh start after the read window skips that slice and reads the next one", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    const c = idx.clock;
    const fetches = { n: 0 };
    const { w } = setup({ role: "standby", idx, fetches });
    const t0 = sliceStart(c, D, 3) + Math.floor(c.slice * 0.6);
    await run(idx, [w], t0, sliceStart(c, D, 5));
    expect(idx.calls.map((x) => x.slices[0])).toEqual([4]);
  });

  test("RPC down: the pages are still read and logged every slice; RPC_DOWN after two ticks; held entries land after", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    const c = idx.clock;
    const { w, logDir, alerts } = setup({ role: "standby", idx });
    await run(idx, [w], dayStart(c, D), sliceStart(c, D, 1));
    idx.down = true;
    await run(idx, [w], sliceStart(c, D, 1), sliceStart(c, D, 4));
    expect(alerts.filter((a) => a.code === "RPC_DOWN").length).toBe(1);
    expect(alerts.filter((a) => a.code === "RPC_DOWN" && a.clear).length).toBe(0);
    expect(lines(logDir, "standby").filter((l) => l.kind === "reading").length).toBe(4);
    expect(idx.posts.length).toBe(1);
    idx.down = false;
    await run(idx, [w], sliceStart(c, D, 4), sliceStart(c, D, 5));
    expect(idx.accOf(H100, D, STANDBY).bits).toBe(0b11111n);
    // Oct 5: the first tick that reaches the chain again clears the alert (it stayed open for hours before)
    const down = alerts.filter((a) => a.code === "RPC_DOWN");
    expect(down.length).toBe(2);
    expect(down[1]!.clear).toBe(true);
    // each slice landed once: no duplicate post of an entry
    const landed = idx.posts.flatMap((p) => p.entries.filter((e) => e.gpuId === H100).map((e) => e.slice));
    expect(landed.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  test("Oct 5: a writer started while its RPC_DOWN from an earlier process is open clears it at its first tick that reaches the chain, once", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    const c = idx.clock;
    const { w, alerts } = setup({ role: "standby", idx, rpcDownOpen: true });
    await run(idx, [w], dayStart(c, D), sliceStart(c, D, 2));
    const down = alerts.filter((a) => a.code === "RPC_DOWN");
    expect(down.length).toBe(1);
    expect(down[0]!.clear).toBe(true);
    // a fresh start with nothing open sends no clear
    const freshIdx = new FakeIndex(testClocks(), PANELS, D);
    const fresh = setup({ role: "standby", idx: freshIdx });
    await run(freshIdx, [fresh.w], dayStart(c, D), sliceStart(c, D, 2));
    expect(fresh.alerts.filter((a) => a.code === "RPC_DOWN")).toEqual([]);
  });

  test("CLOCK_SKEW: the chain head beyond max(5 s, slice / 20) from the local clock for three ticks, once per episode", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    const c = idx.clock;
    const { w, alerts } = setup({ role: "standby", idx });
    await run(idx, [w], dayStart(c, D), dayStart(c, D) + 20);
    idx.skew = 11; // limit on TEST: max(5, 10) = 10 s
    await run(idx, [w], dayStart(c, D) + 20, dayStart(c, D) + 30);
    expect(alerts.filter((a) => a.code === "CLOCK_SKEW").length).toBe(0);
    await run(idx, [w], dayStart(c, D) + 30, dayStart(c, D) + 60);
    expect(alerts.filter((a) => a.code === "CLOCK_SKEW").length).toBe(1);
    idx.skew = 10;
    await run(idx, [w], dayStart(c, D) + 60, dayStart(c, D) + 70);
    idx.skew = 11;
    await run(idx, [w], dayStart(c, D) + 70, dayStart(c, D) + 100);
    expect(alerts.filter((a) => a.code === "CLOCK_SKEW").length).toBe(2);
  });

  test("a failed page sends 0 for its slots and is logged FAILED", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    const source = directSource(fakeSources, PANELS, new PageReader(pagesFetcher((id) => id === "f_c"), "http://replay.test"));
    const { w } = setup({ role: "standby", idx, source });
    const c = idx.clock;
    await run(idx, [w], dayStart(c, D), dayStart(c, D) + c.slice);
    const e = idx.posts[0]!.entries.find((x) => x.gpuId === H100)!;
    expect(e.values).toEqual([2_990_000, 6_160_000, 0, 2_660_000]);
  });
});

// ---------------------------------------------------------------- Oct 3: 8.1 extended reposts, 8.5 KEY_MISMATCH, 8.6 readers

const H200 = PANELS[1]!.gpuId as Hex;
const B200 = PANELS[2]!.gpuId as Hex;
const dayCalls = (idx: FakeIndex, d: number) => idx.calls.filter((x) => x.days.includes(d));
const abandons = (logDir: string, role: string, d: number) => lines(logDir, role).filter((l) => l.kind === "abandon" && (l as { dayId: number }).dayId === d) as Extract<LogLine, { kind: "abandon" }>[];

describe("8.1 step 2 (Oct 3): reposts while the day is open, until REPOST_END", () => {
  test("reposts a logged entry while the day is open until graceStart + GRACE - slice", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO];
    const { w, logDir } = setup({ role: "primary", idx });
    const c = idx.clock;
    const end = repostEnd(c, D);
    await run(idx, [w], dayStart(c, D), sliceStart(c, D, 9));
    idx.down = true; // both RPC URLs down from slice 9 to 30 s before REPOST_END: nobody can close the day
    await run(idx, [w], sliceStart(c, D, 9), end - 30);
    expect(idx.accOf(H100, D, PRIMARY).bits).toBe(0b111111111n);
    expect(lines(logDir, "primary").filter((l) => l.kind === "reading" && (l as { dayId: number }).dayId === D).length).toBe(12);
    idx.down = false;
    await run(idx, [w], end - 30, end + 3 * c.slice);
    const late = dayCalls(idx, D).filter((x) => x.at > sendDeadline(c, D));
    expect(late.map((x) => x.slices[0])).toEqual([9, 10, 11]); // each once, in slice order, after F1's repost point
    for (const x of late) expect(x.at).toBeLessThanOrEqual(end);
    expect(idx.complete(H100, D, PRIMARY)).toBe(true);
    expect(idx.closes.find((x) => x.gpuId === H100 && x.day === D)!.bits).toBe(fullBits(c)); // computed from every slice
    expect(abandons(logDir, "primary", D)).toEqual([]);
  });

  test("abandons it after REPOST_END or once the day is closed or carried", async () => {
    const c0 = new FakeIndex(testClocks(), PANELS, D).clock;
    // (a) the outage outlasts REPOST_END: nothing of day D is sent after it, the three slices are abandoned once
    {
      const idx = new FakeIndex(testClocks(), PANELS, D);
      idx.writers = [PRIMARY, ZERO];
      const { w, logDir } = setup({ role: "primary", idx });
      const end = repostEnd(c0, D);
      await run(idx, [w], dayStart(c0, D), sliceStart(c0, D, 9));
      idx.down = true;
      await run(idx, [w], sliceStart(c0, D, 9), end + 10);
      idx.down = false;
      await run(idx, [w], end + 10, end + 2 * c0.slice);
      expect(dayCalls(idx, D).filter((x) => x.at > sendDeadline(c0, D))).toEqual([]);
      const ab = abandons(logDir, "primary", D);
      expect(ab.map((l) => l.slice)).toEqual([9, 10, 11]);
      expect(ab.every((l) => /REPOST_END/.test(l.reason) && l.at > end)).toBe(true);
    }
    // (b) the keeper carries the day while the writer cannot reach a node: nothing is sent after the carry
    {
      const idx = new FakeIndex(testClocks(), PANELS, D);
      idx.writers = [PRIMARY, ZERO];
      const { w, logDir } = setup({ role: "primary", idx });
      await run(idx, [w], dayStart(c0, D), sliceStart(c0, D, 9));
      idx.down = true;
      await run(idx, [w], sliceStart(c0, D, 9), dayEnd(c0, D) + 500);
      for (const p of PANELS) idx.carry(p.gpuId as Hex);
      await run(idx, [w], dayEnd(c0, D) + 500, dayEnd(c0, D) + 600);
      idx.down = false;
      await run(idx, [w], dayEnd(c0, D) + 600, dayEnd(c0, D) + 600 + 2 * c0.slice);
      expect(dayCalls(idx, D).filter((x) => x.at > sendDeadline(c0, D))).toEqual([]);
      const ab = abandons(logDir, "primary", D);
      expect(ab.map((l) => l.slice)).toEqual([9, 10, 11]);
      expect(ab.every((l) => /closed or was carried/.test(l.reason))).toBe(true);
    }
  });

  test("REPOST_END uses graceStart (registration time for a backfilled day)", async () => {
    const c = new FakeIndex(testClocks(), PANELS, D).clock;
    const late = dayEnd(c, D) + c.grace - c.slice + 300; // past dayEnd + GRACE - slice, before registeredAt + GRACE - slice
    for (const [registeredAt, sent] of [
      [dayEnd(c, D) + 1_000, true],
      [dayStart(c, D) - 10, false],
    ] as const) {
      const idx = new FakeIndex(testClocks(), PANELS, D);
      idx.writers = [PRIMARY, ZERO];
      idx.registeredAt = registeredAt;
      const { w, logDir } = setup({ role: "primary", idx });
      idx.down = true; // the whole day logged, nothing sent (as before a registration)
      await run(idx, [w], dayStart(c, D), late);
      idx.down = false;
      await run(idx, [w], late, late + 2 * c.slice);
      const after = dayCalls(idx, D);
      if (sent) {
        expect(repostEnd(c, D, registeredAt)).toBe(registeredAt + c.grace - c.slice);
        expect(after.map((x) => x.slices[0])).toEqual([...Array(12).keys()]);
        for (const x of after) expect(x.at).toBeLessThanOrEqual(repostEnd(c, D, registeredAt));
        expect(idx.complete(H100, D, PRIMARY)).toBe(true);
        expect(abandons(logDir, "primary", D)).toEqual([]);
      } else {
        expect(after).toEqual([]);
        expect(abandons(logDir, "primary", D).map((l) => l.slice)).toEqual([...Array(12).keys()]);
      }
    }
  });

  test("sends the backlog before the close after an outage", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO];
    const { w } = setup({ role: "primary", idx });
    const c = idx.clock;
    await run(idx, [w], dayStart(c, D), sliceStart(c, D, 9));
    idx.down = true;
    await run(idx, [w], sliceStart(c, D, 9), closableAt(c, D) + 2 * c.slice);
    idx.down = false;
    const back = closableAt(c, D) + 2 * c.slice;
    await run(idx, [w], back, back + 2 * c.slice);
    const cl = idx.closes.find((x) => x.gpuId === H100 && x.day === D)!;
    const backlog = dayCalls(idx, D).filter((x) => x.at > sendDeadline(c, D));
    expect(backlog.map((x) => x.slices[0])).toEqual([9, 10, 11]);
    expect(backlog.every((x) => x.seq < cl.seq && x.at === back)).toBe(true); // at the recovery, before the close
    // fix round (audit M3): the close waits one CLOSE_GRACE after the recovery, for the other writer's backlog
    expect(cl.at).toBeGreaterThanOrEqual(back + c.closeGrace);
    expect(cl.at).toBeLessThan(back + c.closeGrace + c.slice / 20 + 10);
    expect(cl.bits).toBe(fullBits(c));
  });

  test("after an outage past F1 the second writer's backlog lands before the first writer's close (fix round M3)", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, STANDBY];
    const p = setup({ role: "primary", idx });
    const sb = setup({ role: "standby", idx, seed: 11 });
    const c = idx.clock;
    await run(idx, [p.w, sb.w], dayStart(c, D), sliceStart(c, D, 9));
    idx.down = true; // both RPC URLs down from slice 9 to 1,800 s after the day (REPOST_END is 2,200 s after it)
    const back = dayEnd(c, D) + 1_800;
    await run(idx, [p.w, sb.w], sliceStart(c, D, 9), back);
    idx.down = false;
    await run(idx, [p.w, sb.w], back, back + 2 * c.slice);
    const cl = idx.closes.find((x) => x.gpuId === H100 && x.day === D)!;
    expect(cl.at).toBeGreaterThanOrEqual(back + c.closeGrace);
    expect(cl.at).toBeLessThanOrEqual(repostEnd(c, D));
    // both records complete, nothing abandoned by either writer (before the fix the standby abandoned 9, 10 and 11)
    expect(idx.complete(H100, D, PRIMARY)).toBe(true);
    expect(idx.complete(H100, D, STANDBY)).toBe(true);
    expect(abandons(p.logDir, "primary", D)).toEqual([]);
    expect(abandons(sb.logDir, "standby", D)).toEqual([]);
  });

  test("an outage that ended before the day did never delays the close", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO];
    const { w } = setup({ role: "primary", idx });
    const c = idx.clock;
    await run(idx, [w], dayStart(c, D), sliceStart(c, D, 4));
    idx.down = true;
    await run(idx, [w], sliceStart(c, D, 4), sliceStart(c, D, 6));
    idx.down = false;
    await run(idx, [w], sliceStart(c, D, 6), closableAt(c, D) + c.slice);
    const cl = idx.closes.find((x) => x.gpuId === H100 && x.day === D)!;
    expect(cl.at).toBeLessThan(closableAt(c, D) + c.slice / 20 + 10);
    expect(cl.bits).toBe(fullBits(c));
  });

  test("the extended window never delays a close while an RPC answers", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO];
    idx.dropSlices.add(11); // slice 11 never lands, every repost of it is mined and taken by nothing
    const { w, logDir } = setup({ role: "primary", idx });
    const c = idx.clock;
    await run(idx, [w], dayStart(c, D), closableAt(c, D) + 2 * c.slice);
    const cl = idx.closes.find((x) => x.gpuId === H100 && x.day === D)!;
    expect(cl.at).toBeGreaterThanOrEqual(closableAt(c, D));
    expect(cl.at).toBeLessThan(closableAt(c, D) + c.slice / 20 + 10); // not REPOST_END: the close does not wait
    expect(cl.bits).toBe(fullBits(c) & ~(1n << 11n));
    expect(dayCalls(idx, D).filter((x) => x.at > cl.at)).toEqual([]); // closed: no repost after it
    expect(abandons(logDir, "primary", D).map((l) => l.slice)).toEqual([11]);
  });
});

/** One report entry per panel at (D, h) with given values per GPU. */
function thiefReport(h: number, readAt: number, values: (p: (typeof PANELS)[number]) => number[]): Hex {
  return reportHex(
    SELECTOR,
    INDEX,
    PANELS.map((p) => ({ gpuId: p.gpuId as Hex, dayId: D, slice: h, readAt: BigInt(readAt), values: values(p) })),
  );
}

describe("8.5 KEY_MISMATCH: a second user of the writer's key", () => {
  test("KEY_MISMATCH when another sender posts my slice first with other values", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO];
    const { w, alerts } = setup({ role: "primary", idx });
    const c = idx.clock;
    await run(idx, [w], dayStart(c, D), sliceStart(c, D, 3));
    idx.time = sliceStart(c, D, 3) + 1;
    expect(idx.post(PRIMARY, thiefReport(3, idx.time, (p) => p.slots.map(() => 9_990_000))).ok).toBe(true); // the stolen key
    await run(idx, [w], sliceStart(c, D, 3) + 1, sliceStart(c, D, 5));
    const km = alerts.filter((a) => a.code === "KEY_MISMATCH");
    expect(km.map((a) => a.gpuId).sort()).toEqual([H100, H200, B200].sort());
    const a = km.find((x) => x.gpuId === H100)!;
    expect(a).toMatchObject({ severity: "action", day: D, slot: 3, writer: PRIMARY });
    expect(alertId(a)).toBe(`KEY_MISMATCH:${H100}:${D}:3:${PRIMARY}`);
    const data = a.data as { onchain: { values: number[] }; logged: { values: number[] }; txHash: string; via: string };
    expect(data.onchain.values).toEqual([9_990_000, 9_990_000, 9_990_000, 9_990_000]);
    expect(data.logged.values).toEqual([2_990_000, 6_160_000, 3_100_000, 2_660_000]);
    expect(data.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(data.via).toBe("events");
    expect(a.deadline).toBeGreaterThan(sliceStart(c, D, 3));
    expect(alerts.some((x) => x.code === "KEY_UNVERIFIED")).toBe(false);
    expect(idx.accOf(H100, D, PRIMARY).bits).toBe(0b11111n); // the writer kept running: slice 4 posted
  });

  test("KEY_MISMATCH when another sender posts a slice I never read", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO];
    const { w, alerts } = setup({ role: "primary", idx });
    const c = idx.clock;
    await run(idx, [w], dayStart(c, D), sliceStart(c, D, 5));
    // the writer is asleep through slice 5; the thief posts it
    idx.time = sliceStart(c, D, 5) + 30;
    idx.post(PRIMARY, thiefReport(5, idx.time, (p) => p.slots.map(() => 3_000_000)));
    await run(idx, [w], sliceStart(c, D, 6) + 5, sliceStart(c, D, 7));
    const km = alerts.filter((a) => a.code === "KEY_MISMATCH" && a.slot === 5);
    expect(km.length).toBe(3);
    expect((km[0]!.data as { logged: unknown }).logged).toBeNull();
    expect(km[0]!.message).toMatch(/never read/);
  });

  test("a node refusing wide getLogs ranges: the scan halves its range and still finds the second user", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO];
    idx.logsMaxRange = 2;
    const { w, alerts } = setup({ role: "primary", idx });
    const c = idx.clock;
    await run(idx, [w], dayStart(c, D), sliceStart(c, D, 2));
    idx.time = sliceStart(c, D, 2) + 1;
    idx.post(PRIMARY, thiefReport(2, idx.time, (p) => p.slots.map(() => 1_000_000)));
    await run(idx, [w], sliceStart(c, D, 2) + 1, sliceStart(c, D, 3));
    expect(alerts.filter((a) => a.code === "KEY_MISMATCH" && a.slot === 2).length).toBe(3);
    expect(alerts.some((a) => a.code === "KEY_MISMATCH" && (a.data as { via: string }).via === "accumulators")).toBe(false);
  });

  test("no KEY_MISMATCH when my own earlier send landed and the repost is E7-skipped", async () => {
    for (const logsFail of [false, true]) {
      const idx = new FakeIndex(testClocks(), PANELS, D);
      idx.writers = [PRIMARY, ZERO];
      idx.logsFail = logsFail; // the accumulator backstop must stay quiet too
      const { w, alerts } = setup({ role: "primary", idx });
      const c = idx.clock;
      await run(idx, [w], dayStart(c, D), sliceStart(c, D, 2));
      const before = idx.calls.length;
      // the read-back of slice 2 and the next sync come from a lagging node: the writer reposts a landed slice
      let armed = false;
      const view = idx.view(PRIMARY);
      const post = view.postReport;
      (w as unknown as { c: { chain: typeof view } }).c.chain = {
        ...view,
        postReport: async (hex, meta) => {
          const r = await post(hex, meta);
          if (!armed && meta.dayId === D && meta.slice === 2) {
            armed = true;
            idx.staleReads = 6;
          }
          return r;
        },
      };
      await run(idx, [w], sliceStart(c, D, 2), sliceStart(c, D, 4));
      // the lagging node hid every bit: landed slices were reposted and E7-skipped (no second event of any slice)
      expect(idx.calls.slice(before).filter((x) => x.slices[0]! <= 2).length).toBeGreaterThan(1);
      for (const h of [0, 1, 2, 3]) expect(idx.events.filter((e) => e.slice === h && e.gpuId === H100).length).toBe(1);
      expect(alerts.filter((a) => a.code === "KEY_MISMATCH" || a.code === "KEY_UNVERIFIED")).toEqual([]);
      expect(idx.logsCalls).toBeGreaterThan(0);
    }
  });

  test("KEY_UNVERIFIED for a CRE run whose output was not parsed", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO];
    const direct = directSource(fakeSources, PANELS, new PageReader(pagesFetcher(), "http://replay.test"));
    // the CLI posts (its own fetch saw other prices), its output cannot be parsed, the runner falls back to direct
    const cre: ReadingSource = {
      take: async (at) => {
        if (at.slice !== 3) return direct.take(at);
        at.onRun?.("run-3");
        idx.post(PRIMARY, thiefReport(3, at.readAt, (p) => p.slots.map(() => 4_440_000)));
        return { ...(await direct.take(at)), error: "simulate failed: unparseable result" };
      },
    };
    const { w, alerts, logDir } = setup({ role: "primary", idx, source: cre });
    const c = idx.clock;
    await run(idx, [w], dayStart(c, D), sliceStart(c, D, 5));
    expect(lines(logDir, "primary").some((l) => l.kind === "run" && (l as { slice: number }).slice === 3)).toBe(true);
    const un = alerts.filter((a) => a.code === "KEY_UNVERIFIED");
    expect(un.length).toBe(3);
    expect(un[0]).toMatchObject({ severity: "info", day: D, slot: 3 });
    expect(alerts.some((a) => a.code === "KEY_MISMATCH")).toBe(false);
  });

  test("a restart scans back at most AGATE_LOGS_BACKLOG blocks; the older part of the open day is left to the accumulators", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO];
    const c = idx.clock;
    const a = setup({ role: "primary", idx });
    await run(idx, [a.w], dayStart(c, D), sliceStart(c, D, 1));
    // the thief withholds slot 1 in slice 1 before the writer reads it, early in the day
    idx.time = sliceStart(c, D, 1) + 1;
    const honest = (lines(a.logDir, "primary").find((l) => l.kind === "reading") as Extract<LogLine, { kind: "reading" }>).entries;
    idx.post(PRIMARY, thiefReport(1, idx.time, (p) => honest.find((e) => e.gpuId === p.gpuId)!.values.map((v, i) => (i === 1 ? 0 : v))));
    await run(idx, [a.w], sliceStart(c, D, 1) + 1, sliceStart(c, D, 6));
    expect(a.alerts.filter((x) => x.code === "KEY_MISMATCH" && x.slot === 1).length).toBe(3); // found by the events
    // a restart with a two-block backlog: the thief's block is out of reach of the scan
    const b = setup({ role: "primary", idx, logDir: a.logDir, keyCheck: { backlogBlocks: 2 } });
    await run(idx, [b.w], sliceStart(c, D, 6), sliceStart(c, D, 7));
    expect(b.alerts.filter((x) => x.code === "KEY_MISMATCH" && x.slot === 1)).toEqual([]);
    const acc = b.alerts.filter((x) => x.code === "KEY_MISMATCH" && (x.data as { via: string }).via === "accumulators");
    // B200's slot 1 is sold out (0 either way): the accumulators cannot see that slice's other readAt, the events could
    expect(acc.map((x) => x.gpuId).sort()).toEqual([H100, H200].sort());
    expect((acc[0]!.data as { slots: number[] }).slots).toEqual([1]);
    expect(b.w.keys!.covers(D)).toBe(false);
    expect(b.w.keys!.covers(D + 1)).toBe(true); // the next day starts after the scan's first block
  });

  test("accumulator backstop catches a withheld slot when getLogs fails", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO];
    idx.logsFail = true;
    const { w, alerts, logDir } = setup({ role: "primary", idx });
    const c = idx.clock;
    await run(idx, [w], dayStart(c, D), sliceStart(c, D, 4));
    const honest = (lines(logDir, "primary").find((l) => l.kind === "reading" && (l as { slice: number }).slice === 3) as Extract<LogLine, { kind: "reading" }>).entries;
    idx.time = sliceStart(c, D, 4) + 1;
    // the thief posts slice 4 first with the honest values except slot 1 withheld (0)
    idx.post(PRIMARY, thiefReport(4, idx.time, (p) => honest.find((e) => e.gpuId === p.gpuId)!.values.map((v, i) => (i === 1 ? 0 : v))));
    await run(idx, [w], sliceStart(c, D, 4) + 1, sliceStart(c, D, 5));
    const km = alerts.filter((a) => a.code === "KEY_MISMATCH");
    expect(km.length).toBeGreaterThanOrEqual(1);
    const a = km.find((x) => x.gpuId === H100)!;
    expect(a.slot).toBeUndefined(); // the backstop knows the day, not the slice
    expect(alertId(a)).toBe(`KEY_MISMATCH:${H100}:${D}:-:${PRIMARY}`);
    const data = a.data as { slots: number[]; onchain: { counts: number[] }; logged: { counts: number[] }; via: string };
    expect(data.via).toBe("accumulators");
    expect(data.slots).toEqual([1]);
    expect(data.onchain.counts[1]).toBe(data.logged.counts[1]! - 1);
    expect(idx.logsCalls).toBeGreaterThan(0);
  });
});

describe("8.6 readers in force (writers)", () => {
  const V2_URL = "https://www.a.invalid/v2";
  const pages: Record<string, string> = {
    "https://a.invalid/p": PAGES.f_a!,
    [V2_URL]: JSON.stringify({ v2: { H100: "2.79", H200: "3.29", B200: "5.05" } }),
    "https://b.invalid/p": PAGES.f_b!,
    "https://c.invalid/p": PAGES.f_c!,
    "https://e.invalid/p": PAGES.f_e!,
    "http://replay.test/fx_ecb": PAGES.fx_ecb!,
    "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml": PAGES.fx_ecb!,
  };
  function urlFetcher(count: Map<string, number>) {
    return async (url: string): Promise<PageResult> => {
      count.set(url, (count.get(url) ?? 0) + 1);
      const body = pages[url];
      return body === undefined ? { ok: false, httpStatus: 404, body: "", bytes: 0, error: "HTTP 404" } : { ok: true, httpStatus: 200, body, bytes: body.length };
    };
  }
  const entryOf = (idx: FakeIndex, d: number, h: number, g: Hex) => idx.posts.flatMap((p) => p.entries).find((e) => e.dayId === d && e.slice === h && e.gpuId === g)!;

  test("a swap executed on day D reads from D + 1 on: per-day readers, one fetch per URL, parsers and urls logged", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO];
    const count = new Map<string, number>();
    const source = directSource(fakeSources, PANELS, new PageReader(urlFetcher(count)));
    const { w, logDir } = setup({ role: "primary", idx, source, api: true });
    const c = idx.clock;
    await run(idx, [w], dayStart(c, D), sliceStart(c, D, 2));
    idx.swap(H100, 0, D + 1, V2_URL, "f_a/2"); // executed in slice 2 of day D: from the next day start
    await run(idx, [w], sliceStart(c, D, 2), dayEnd(c, D));
    expect(entryOf(idx, D, 11, H100).values[0]).toBe(2_990_000); // all of day D with the registered reader
    expect(count.get(V2_URL) ?? 0).toBe(0);
    const before = count.get("https://a.invalid/p")!;
    await run(idx, [w], dayEnd(c, D), sliceStart(c, D + 1, 2));
    expect(entryOf(idx, D + 1, 0, H100).values[0]).toBe(2_790_000); // f_a/2 on the new URL
    expect(entryOf(idx, D + 1, 0, H200).values[0]).toBe(3_490_000); // H200's slot is not swapped: f_a/1, registered URL
    expect(count.get(V2_URL)).toBe(2); // one fetch per run per URL: slices 0 and 1 of D + 1
    expect(count.get("https://a.invalid/p")! - before).toBe(2);
    const rd = lines(logDir, "primary").filter((l) => l.kind === "reading" && (l as { dayId: number }).dayId === D + 1)[0] as Extract<LogLine, { kind: "reading" }>;
    const fa = rd.sources.find((s) => s.sourceId === "f_a")!;
    expect(fa.parsers).toEqual({ H100: "f_a/2", H200: "f_a/1", B200: "f_a/1" });
    expect(fa.urls).toEqual({ H100: V2_URL });
    expect(fa.extra?.map((x) => x.url)).toEqual([V2_URL]);
    expect(rd.sources.find((s) => s.sourceId === "f_b")!.parsers).toBeUndefined();
  });

  test("under a replay base a swapped slot still fetches /<sourceId>: one fetch per source per run", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    const count = new Map<string, number>();
    const both = JSON.stringify({ ...JSON.parse(PAGES.f_a!), v2: { H100: "2.79", H200: "3.29", B200: "5.05" } });
    const fetcher = async (url: string): Promise<PageResult> => {
      count.set(url, (count.get(url) ?? 0) + 1);
      const id = url.split("/").pop()!;
      const body = id === "f_a" ? both : PAGES[id];
      return body === undefined ? { ok: false, httpStatus: 404, body: "", bytes: 0 } : { ok: true, httpStatus: 200, body, bytes: body.length };
    };
    const source = directSource(fakeSources, PANELS, new PageReader(fetcher, "http://replay.test"));
    const { w } = setup({ role: "standby", idx, source, api: true });
    const c = idx.clock;
    idx.swap(H100, 0, D, V2_URL, "f_a/2");
    await run(idx, [w], dayStart(c, D), sliceStart(c, D, 2));
    expect(count.get("http://replay.test/f_a")).toBe(2);
    expect([...count.keys()].some((u) => u.includes("a.invalid"))).toBe(false);
    expect(entryOf(idx, D, 1, H100).values[0]).toBe(2_790_000);
    expect(entryOf(idx, D, 1, H200).values[0]).toBe(3_490_000);
  });

  test("READER_MISSING and READER_REFUSED after the execute: the slot reads nothing, never another reader", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO];
    const count = new Map<string, number>();
    const source = directSource(fakeSources, PANELS, new PageReader(urlFetcher(count)));
    const { w, alerts, logDir } = setup({ role: "primary", idx, source, api: true });
    const c = idx.clock;
    await run(idx, [w], dayStart(c, D), sliceStart(c, D, 1));
    idx.swap(H100, 1, D + 1, "https://b.invalid/p", "f_b/2"); // not installed in this build
    idx.swap(H100, 2, D + 1, "https://evil.invalid/p", "f_c/1"); // a host off f_c's list
    await run(idx, [w], sliceStart(c, D, 1), sliceStart(c, D + 1, 1));
    const miss = alerts.find((a) => a.code === "READER_MISSING")!;
    expect(miss).toMatchObject({ severity: "action", gpuId: H100, slot: 1, day: D + 1, deadline: dayStart(c, D + 1) });
    const ref = alerts.find((a) => a.code === "READER_REFUSED")!;
    expect(ref).toMatchObject({ severity: "action", gpuId: H100, slot: 2, day: D + 1 });
    expect(ref.deadline).toBeLessThan(dayStart(c, D + 1)); // at once
    expect(alerts.filter((a) => a.code === "READER_MISSING" || a.code === "READER_REFUSED").length).toBe(2); // once per swap
    expect(entryOf(idx, D, 11, H100).values).toEqual([2_990_000, 6_160_000, 3_100_000, 2_660_000]); // day D unchanged
    expect(entryOf(idx, D + 1, 0, H100).values).toEqual([2_990_000, 0, 0, 2_660_000]); // both slots read nothing
    expect([...count.keys()].some((u) => u.includes("evil"))).toBe(false); // a refused URL is never fetched
    const rd = lines(logDir, "primary").filter((l) => l.kind === "reading" && (l as { dayId: number }).dayId === D + 1)[0] as Extract<LogLine, { kind: "reading" }>;
    expect(rd.sources.find((s) => s.sourceId === "f_b")!.rows.H100).toEqual({ state: "MISSED", valueU: 0 });
    expect(rd.sources.find((s) => s.sourceId === "f_b")!.refused?.H100).toMatch(/not installed/);
    expect(rd.sources.find((s) => s.sourceId === "f_c")!.refused?.H100).toMatch(/host/);
    expect(rd.sources.find((s) => s.sourceId === "f_b")!.rows.B200!.state).toBe("NOT_RENTABLE"); // f_b's B200 slot: registered reader
  });

  test("a restart with every RPC URL down reads with the readers remembered from the last start", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    const c = idx.clock;
    const home = mkdtempSync(join(tmpdir(), "agate-readers-"));
    const cache = join(home, "readers.json");
    idx.swap(H100, 0, D, V2_URL, "f_a/2");
    const mk = () =>
      new Writer({
        role: "standby",
        chain: idx.view(STANDBY),
        clock: c,
        chainSelector: SELECTOR,
        panels: PANELS,
        log: new ReadingLog(home, "standby"),
        source: directSource(fakeSources, PANELS, new PageReader(urlFetcher(new Map()))),
        rand: lcg(5),
        api: fakeSources,
        readerCache: cache,
      });
    const a = mk();
    await run(idx, [a], dayStart(c, D), dayStart(c, D) + 20);
    expect(existsSync(cache)).toBe(true);
    idx.down = true;
    const b = mk(); // restarted during an outage: the chain cannot be asked
    await run(idx, [b], sliceStart(c, D, 1), sliceStart(c, D, 2));
    const rd = lines(home, "standby").filter((l) => l.kind === "reading" && (l as { slice: number }).slice === 1)[0] as Extract<LogLine, { kind: "reading" }>;
    expect(rd.entries.find((e) => e.gpuId === H100)!.values[0]).toBe(2_790_000);
  });

  test("a hostile URL naming a version this build lacks is READER_REFUSED, not READER_MISSING (the shared rule: the host first)", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO];
    const { w, alerts } = setup({ role: "primary", idx, source: directSource(fakeSources, PANELS, new PageReader(urlFetcher(new Map()))), api: true });
    const c = idx.clock;
    await run(idx, [w], dayStart(c, D), sliceStart(c, D, 1));
    idx.swap(H100, 1, D + 1, "https://evil.invalid/p", "f_b/9");
    await run(idx, [w], sliceStart(c, D, 1), sliceStart(c, D, 3));
    expect(alerts.filter((a) => a.code === "READER_MISSING")).toEqual([]);
    expect(alerts.find((a) => a.code === "READER_REFUSED")).toMatchObject({ gpuId: H100, slot: 1, day: D + 1 });
    expect(fakeSources.readerProblem("f_b", { url: "https://evil.invalid/p", parserVersion: "f_b/9" })?.code).toBe("refused");
    expect(fakeSources.readerProblem("f_b", { url: "https://b.invalid/p", parserVersion: "f_b/9" })?.code).toBe("missing");
  });

  test("during a known RPC outage a reading never waits on readerHistory: the pages are fetched with the last known readers (8.1, 8.6)", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    const c = idx.clock;
    const home = mkdtempSync(join(tmpdir(), "agate-readers-"));
    idx.swap(H100, 0, D, V2_URL, "f_a/2");
    const view = idx.view(STANDBY);
    let calls = 0;
    const w = new Writer({
      role: "standby",
      chain: { ...view, readerHistory: (g, s) => (calls++, view.readerHistory!(g, s)) },
      clock: c,
      chainSelector: SELECTOR,
      panels: PANELS,
      log: new ReadingLog(home, "standby"),
      source: directSource(fakeSources, PANELS, new PageReader(urlFetcher(new Map()))),
      rand: lcg(5),
      api: fakeSources,
    });
    await run(idx, [w], dayStart(c, D), sliceStart(c, D, 1));
    expect(calls).toBeGreaterThan(0);
    const before = calls;
    idx.down = true; // the first tick's poll sees it before any reading of slice 1 is due
    await run(idx, [w], sliceStart(c, D, 1), sliceStart(c, D, 4));
    expect(calls).toBe(before);
    const rds = lines(home, "standby").filter((l): l is Extract<LogLine, { kind: "reading" }> => l.kind === "reading" && [1, 2, 3].includes((l as { slice: number }).slice));
    expect(rds.length).toBe(3);
    for (const rd of rds) expect(rd.entries.find((e) => e.gpuId === H100)!.values[0]).toBe(2_790_000); // the swap, from memory
    idx.down = false;
    await run(idx, [w], sliceStart(c, D, 4), sliceStart(c, D, 6));
    expect(calls).toBeGreaterThan(before); // read again after the recovery
  });
});

describe("the writer log (13.7)", () => {
  test("one append per line: two processes appending long lines to one log never interleave inside a line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agate-append-"));
    const script = join(dir, "w.ts");
    const logTs = join(import.meta.dir, "../src/pipeline/log.ts");
    await Bun.write(
      script,
      `import { ReadingLog } from ${JSON.stringify(logTs)};
const log = new ReadingLog(${JSON.stringify(dir)}, "standby");
const me = process.argv[2];
for (let i = 0; i < 200; i++) log.append({ kind: "skip", index: "0x5FbDB2315678afecb367f032d93F642f64180aa3", role: "standby", at: 1790812800 + i, dayId: 20727, slice: i % 12, reason: me.repeat(20000) });
`,
    );
    const ps = ["a", "b", "c"].map((x) => Bun.spawn(["bun", "run", script, x], { stdout: "ignore", stderr: "pipe" }));
    for (const p of ps) expect(await p.exited).toBe(0);
    const text = readdirSync(join(dir, "standby", "readings")).map((f) => readFileSync(join(dir, "standby", "readings", f), "utf8")).join("");
    const ls = text.split("\n").filter(Boolean);
    expect(ls.length).toBe(600);
    for (const l of ls) {
      const j = JSON.parse(l) as { reason: string };
      expect(new Set(j.reason).size).toBe(1); // one writer's line, whole
    }
  }, 60_000);
});
