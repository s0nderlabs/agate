// The Alchemy compute-unit meter (Oct 4): the price list, the files, the 80% and 100% thresholds, the stop for the
// rest of the UTC day and the next day's resume, the sum across processes. A fake clock and a temp wall home: nothing
// here reaches a network.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALCHEMY_CU, cuOf, cuOfMethod, DEFAULT_DAILY_CU, dailyCuFromEnv, type MeterAlert, meterDay, meterDir, RpcMeter, UNKNOWN_CU, utcDate } from "../src/meter.ts";

const homes: string[] = [];
const home = () => {
  const h = mkdtempSync(join(tmpdir(), "agate-meter-"));
  homes.push(h);
  return h;
};
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

const T0 = Date.parse("2026-10-04T10:00:00Z");
const clock = (start = T0) => {
  const c = { t: start, now: () => c.t, add: (ms: number) => (c.t += ms) };
  return c;
};
const meter = (h: string, c: { now: () => number }, o: Partial<{ role: string; scope: string; dailyCu: number }> = {}) => {
  const alerts: MeterAlert[] = [];
  const said: { event: string; data: Record<string, unknown> }[] = [];
  const m = new RpcMeter({ home: h, role: o.role ?? "attest", scope: o.scope ?? "4193a0b1", dailyCu: o.dailyCu ?? 1_000, nowMs: c.now, alert: (a) => alerts.push(a), say: (event, data) => said.push({ event, data }) });
  return { m, alerts, said };
};

describe("the price list", () => {
  test("Alchemy's table, an unknown method at 26 CU, websocket bytes at 0.04 CU, rounded up", () => {
    expect(ALCHEMY_CU).toMatchObject({ eth_getLogs: 60, eth_call: 20, eth_getBlockByNumber: 20, eth_getTransactionReceipt: 20, eth_getTransactionCount: 20, eth_estimateGas: 20, eth_gasPrice: 20, eth_sendRawTransaction: 40, eth_blockNumber: 10, eth_feeHistory: 10, eth_subscribe: 10, eth_chainId: 0 });
    expect(cuOfMethod("eth_maxPriorityFeePerGas")).toBe(UNKNOWN_CU);
    expect(cuOfMethod("toString")).toBe(UNKNOWN_CU); // never an inherited property
    expect(cuOfMethod("constructor")).toBe(UNKNOWN_CU);
    // a send: estimate 20 + nonce 20 + send 40 + three receipt polls 60 = 140
    expect(cuOf({ methods: { eth_estimateGas: 1, eth_getTransactionCount: 1, eth_sendRawTransaction: 1, eth_getTransactionReceipt: 3 }, wsBytes: 0 })).toBe(140);
    expect(cuOf({ methods: { eth_subscribe: 2 }, wsBytes: 1_000 })).toBe(60);
    expect(cuOf({ methods: {}, wsBytes: 1 })).toBe(1); // 0.04 rounds up to a whole unit
    expect(cuOf({ methods: {}, wsBytes: 25 })).toBe(1);
    expect(cuOf({ methods: { eth_foo: 2 }, wsBytes: 0 })).toBe(52);
  });

  test("AGATE_ALCHEMY_DAILY_CU: default 400,000; a whole number above 0 or refused", () => {
    expect(dailyCuFromEnv({})).toBe(DEFAULT_DAILY_CU);
    expect(DEFAULT_DAILY_CU).toBe(400_000);
    expect(dailyCuFromEnv({ AGATE_ALCHEMY_DAILY_CU: " 250000 " })).toBe(250_000);
    for (const v of ["0", "-5", "1.5", "4e5", "lots", "99999999999999999999"]) expect(() => dailyCuFromEnv({ AGATE_ALCHEMY_DAILY_CU: v })).toThrow("AGATE_ALCHEMY_DAILY_CU must be a whole number");
  });
});

describe("the files", () => {
  test("<home>/rpc-meter/<UTC date>/<role>-<scope>.json, written atomically at most every 60 s", () => {
    const h = home();
    const c = clock();
    const { m } = meter(h, c);
    m.count("eth_sendRawTransaction");
    const f = join(h, "rpc-meter", "2026-10-04", "attest-4193a0b1.json");
    expect(m.file).toBe(f);
    expect(JSON.parse(readFileSync(f, "utf8"))).toMatchObject({ date: "2026-10-04", role: "attest", scope: "4193a0b1", methods: { eth_sendRawTransaction: 1 }, wsBytes: 0, cu: 40 });
    m.count("eth_getTransactionReceipt", 4);
    m.wsEvent(500);
    // within the 60 s: not written yet
    expect(JSON.parse(readFileSync(f, "utf8")).cu).toBe(40);
    c.add(60_000);
    m.count("eth_estimateGas");
    expect(JSON.parse(readFileSync(f, "utf8"))).toMatchObject({ methods: { eth_sendRawTransaction: 1, eth_getTransactionReceipt: 4, eth_estimateGas: 1 }, wsBytes: 500, cu: 40 + 80 + 20 + 20 });
    // no temp file left behind
    expect(readdirSync(join(h, "rpc-meter", "2026-10-04")).filter((x) => x.includes(".tmp"))).toEqual([]);
  });

  test("a restart the same day carries on from its file; a process that counted nothing writes nothing", () => {
    const h = home();
    const c = clock();
    const a = meter(h, c).m;
    a.count("eth_sendRawTransaction", 3);
    a.flush(true);
    const b = meter(h, c).m;
    expect(b.ownCu()).toBe(120);
    b.count("eth_sendRawTransaction");
    b.tick(true);
    expect(JSON.parse(readFileSync(b.file, "utf8")).methods.eth_sendRawTransaction).toBe(4);
    const idle = meter(h, c, { role: "keep" }).m;
    idle.tick(true);
    expect(existsSync(idle.file)).toBe(false);
  });

  test("the start function writes the last counts on stop", () => {
    const h = home();
    const c = clock();
    const { m } = meter(h, c);
    const stop = m.start();
    m.count("eth_sendRawTransaction");
    m.count("eth_getTransactionReceipt"); // within 60 s of the first write: held in memory
    stop();
    expect(JSON.parse(readFileSync(m.file, "utf8")).cu).toBe(60);
  });

  test("meterDay sums every process's file of a day and skips what is not a meter file", () => {
    const h = home();
    const dir = meterDir(h, "2026-10-04");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "attest-aaaaaaaa.json"), JSON.stringify({ methods: { eth_sendRawTransaction: 2 }, wsBytes: 1_000 }));
    writeFileSync(join(dir, "payer-market.json"), JSON.stringify({ methods: { eth_estimateGas: 5 }, wsBytes: 0, cu: 999_999 })); // cu recomputed from the counts
    writeFileSync(join(dir, "broken.json"), "{");
    writeFileSync(join(dir, ".alert-80"), "x");
    writeFileSync(join(dir, "x.json.123.tmp"), "{}");
    const d = meterDay(h, "2026-10-04");
    expect(d.files).toEqual([
      { name: "attest-aaaaaaaa.json", cu: 120 },
      { name: "payer-market.json", cu: 100 },
    ]);
    expect(d.total).toBe(220);
    expect(meterDay(h, "2026-10-05")).toEqual({ total: 0, files: [] });
  });

  test("role and scope are plain names (never a path)", () => {
    expect(() => new RpcMeter({ home: home(), role: "../x", scope: "market" })).toThrow();
    expect(() => new RpcMeter({ home: home(), role: "payer", scope: "a/b" })).toThrow();
  });
});

describe("the budget", () => {
  test("80%: one info alert; 100%: one action alert and the stop; both counted across every process's file", () => {
    const h = home();
    const c = clock();
    const att = meter(h, c, { dailyCu: 1_000 });
    const keep = meter(h, c, { role: "keep", dailyCu: 1_000 });
    // the keeper spends 600 CU (15 sends), the attester 200: 80%
    keep.m.count("eth_sendRawTransaction", 15);
    keep.m.flush(true);
    att.m.count("eth_sendRawTransaction", 5);
    expect(att.m.total).toBe(800);
    expect(att.alerts.map((a) => [a.severity, a.threshold])).toEqual([["info", 80]]);
    expect(att.alerts[0]!.message).toContain("passed 80% of AGATE_ALCHEMY_DAILY_CU (1,000)");
    expect(att.m.allowed()).toBe(true);
    // the keeper sums 60 s later: 80% again, but the alert is the attester's (one per threshold and day)
    c.add(60_000);
    expect(keep.m.allowed()).toBe(true);
    expect(keep.alerts).toEqual([]);
    expect(keep.said.map((s) => s.event)).toEqual(["alchemy_budget_80"]);
    // 200 more: 100%
    keep.m.count("eth_sendRawTransaction", 5);
    c.add(60_000);
    expect(keep.m.allowed()).toBe(false);
    expect(keep.alerts.map((a) => [a.severity, a.threshold, a.date, a.day])).toEqual([["action", 100, "2026-10-04", 20_730]]);
    expect(keep.alerts[0]!.message).toContain("until 00:00 UTC");
    // the attester learns at its next sum (60 s after its last)
    expect(att.m.allowed()).toBe(false);
    expect(att.alerts.map((a) => a.threshold)).toEqual([80]);
    expect(att.said.map((s) => s.event)).toEqual(["alchemy_budget_80", "alchemy_budget_stop"]);
    const marks = readdirSync(meterDir(h, "2026-10-04")).filter((f) => f.startsWith(".alert-")).sort();
    expect(marks).toEqual([".alert-100", ".alert-80"]);
  });

  test("stopped for the rest of the UTC day, resumed at 00:00 UTC with a fresh count and fresh alerts", () => {
    const h = home();
    const c = clock(Date.parse("2026-10-04T23:58:00Z"));
    const { m, alerts, said } = meter(h, c, { dailyCu: 100 });
    m.count("eth_sendRawTransaction", 3); // 120 CU: over the budget at once
    expect(m.allowed()).toBe(false);
    c.add(60_000); // 23:59
    expect(m.allowed()).toBe(false);
    c.add(60_000); // 00:00 the next day
    expect(m.allowed()).toBe(true);
    expect(said.map((s) => s.event)).toContain("alchemy_budget_resumed");
    expect(m.snapshot()).toMatchObject({ date: "2026-10-05", cu: 0, stopped: false });
    // the old day's file holds the old day's counts; the new day starts empty
    expect(JSON.parse(readFileSync(join(meterDir(h, "2026-10-04"), "attest-4193a0b1.json"), "utf8")).cu).toBe(120);
    m.count("eth_sendRawTransaction", 3);
    expect(m.allowed()).toBe(true); // summed at 00:00, the next sum a minute later
    c.add(60_000);
    expect(m.allowed()).toBe(false);
    expect(alerts.map((a) => [a.date, a.threshold])).toEqual([
      ["2026-10-04", 80],
      ["2026-10-04", 100],
      ["2026-10-05", 80],
      ["2026-10-05", 100],
    ]);
  });

  test("the sum runs at most every 60 s: another process's spend is seen within a minute", () => {
    const h = home();
    const c = clock();
    const a = meter(h, c, { dailyCu: 100 });
    expect(a.m.allowed()).toBe(true);
    const b = meter(h, c, { role: "payer", scope: "market", dailyCu: 100 });
    b.m.count("eth_sendRawTransaction", 3);
    expect(a.m.allowed()).toBe(true); // summed 0 s ago
    c.add(59_000);
    expect(a.m.allowed()).toBe(true);
    c.add(1_000);
    expect(a.m.allowed()).toBe(false);
  });

  test("utcDate is the UTC calendar date", () => {
    expect(utcDate(Date.parse("2026-10-04T23:59:59Z"))).toBe("2026-10-04");
    expect(utcDate(Date.parse("2026-10-05T00:00:00Z"))).toBe("2026-10-05");
  });
});

// review finding Oct 5: an ALCHEMY_BUDGET stop ends at 00:00 UTC, so the new day clears the earlier days' alerts
describe("the day roll clears earlier days' budget alerts", () => {
  test("clearBefore gets the new UTC day's number at the first count after midnight, once", () => {
    const c = clock(Date.parse("2026-10-04T23:59:00Z"));
    const cleared: number[] = [];
    const m = new RpcMeter({ home: home(), role: "attest", scope: "4193a0b1", dailyCu: 1_000, nowMs: c.now, clearBefore: (d) => cleared.push(d) });
    m.count("eth_sendRawTransaction");
    expect(cleared).toEqual([]);
    c.add(120_000); // 00:01 UTC Oct 5
    m.count("eth_sendRawTransaction");
    m.count("eth_sendRawTransaction");
    expect(cleared).toEqual([Math.floor(Date.parse("2026-10-05T00:00:00Z") / 86_400_000)]);
  });
});
