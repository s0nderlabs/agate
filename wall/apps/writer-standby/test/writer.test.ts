// The writer pipeline against the in-memory index (fast; the anvil tests run the same paths on the real contract).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "@agate/report/types";
import { closableAt, dayEnd, dayStart, type PageResult, pendEnd, readWindow, sendDeadline, sliceStart } from "../src/core/index.ts";
import { PageReader } from "../src/pipeline/fetch.ts";
import { type LogLine, ReadingLog } from "../src/pipeline/log.ts";
import type { AlertInput } from "../src/pipeline/rpc.ts";
import { directSource } from "../src/pipeline/setup.ts";
import { type ReadingSource, Writer } from "../src/pipeline/writer.ts";
import { FakeIndex, PRIMARY, SELECTOR, STANDBY, testClocks } from "./helpers/fakeIndex.ts";
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

function setup(o: { role: "primary" | "standby"; idx: FakeIndex; seed?: number; source?: ReadingSource; logDir?: string; fetches?: { n: number }; tickS?: number }) {
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
    // every send carries the F1 deadline of its day, so a stuck one is cancelled, never sent late
    expect(idx.metas.filter((m) => m.action === "post" && m.dayId === D).map((m) => m.deadline)).toEqual(Array(12).fill(sendDeadline(c, D)));
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

  test("F1: nothing of a day is sent after dayEnd + CLOSE_GRACE - margin; what never landed is logged abandoned once", async () => {
    const idx = new FakeIndex(testClocks(), PANELS, D);
    idx.writers = [PRIMARY, ZERO];
    idx.swallow.set(PRIMARY.toLowerCase(), 10_000); // nothing lands: the writer keeps reposting until the window shuts
    const { w, logDir } = setup({ role: "primary", idx });
    const c = idx.clock;
    await run(idx, [w], dayStart(c, D) + 10 * c.slice, dayEnd(c, D) + 3 * c.slice, 3);
    const late = idx.calls.filter((x) => x.days.includes(D));
    expect(late.length).toBeGreaterThan(2);
    for (const x of late) expect(x.at).toBeLessThanOrEqual(sendDeadline(c, D));
    expect(late.some((x) => x.at > dayEnd(c, D))).toBe(true); // reposts inside the grace are allowed
    const ab = lines(logDir, "primary").filter((l) => l.kind === "abandon");
    expect(ab.map((l) => (l as { slice: number }).slice).sort((a, b) => a - b)).toEqual([10, 11]);
    expect(ab.every((l) => (l as { at: number }).at > sendDeadline(c, D))).toBe(true);
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
    expect(lines(logDir, "standby").filter((l) => l.kind === "reading").length).toBe(4);
    expect(idx.posts.length).toBe(1);
    idx.down = false;
    await run(idx, [w], sliceStart(c, D, 4), sliceStart(c, D, 5));
    expect(idx.accOf(H100, D, STANDBY).bits).toBe(0b11111n);
    // each slice landed once: no duplicate post of an entry
    const landed = idx.posts.flatMap((p) => p.entries.filter((e) => e.gpuId === H100).map((e) => e.slice));
    expect(landed.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
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
