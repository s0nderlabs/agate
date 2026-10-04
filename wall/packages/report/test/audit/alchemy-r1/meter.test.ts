// Recheck r1 (Oct 4): the Alchemy meter's budget across processes, on a fake clock. How late another process stops
// after one crosses the budget (the files are written and summed at most every 60 s), a process started after the stop,
// the day's roll at 00:00 UTC (the old day's file keeps its last counts), and files that cannot lower the day's total.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cuOf, meterDay, meterDir, RpcMeter } from "../../../src/meter.ts";

const made: string[] = [];
const home = () => {
  const d = mkdtempSync(join(tmpdir(), "agate-recheck-r1-meter-"));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const T0 = Date.parse("2026-10-04T10:00:00Z");

describe("the budget across processes (recheck r1)", () => {
  test("one process crosses the budget: every other one stops within two minutes of the crossing", () => {
    const h = home();
    let now = T0;
    const clock = () => now;
    const a = new RpcMeter({ home: h, role: "attest", scope: "aaaaaaaa", dailyCu: 10_000, nowMs: clock });
    const b = new RpcMeter({ home: h, role: "keep", scope: "aaaaaaaa", dailyCu: 10_000, nowMs: clock });
    a.allowed();
    b.allowed();
    // a spends 10,000 CU (500 receipts) in one second; b only ticks
    now += 1_000;
    for (let i = 0; i < 500; i++) a.count("eth_getTransactionReceipt");
    expect(a.ownCu()).toBe(10_000);
    let aStop = -1;
    let bStop = -1;
    for (let s = 1; s <= 300; s++) {
      now += 1_000;
      if (aStop < 0 && !a.allowed()) aStop = s;
      if (bStop < 0 && !b.allowed()) bStop = s;
    }
    console.log(JSON.stringify({ recheck: "seconds to stop after the crossing", a: aStop, b: bStop }));
    expect(aStop).toBeGreaterThan(0);
    expect(aStop).toBeLessThanOrEqual(60);
    expect(bStop).toBeGreaterThan(0);
    expect(bStop).toBeLessThanOrEqual(120);
  });

  test("a process that starts after the day's stop never uses Alchemy that day", () => {
    const h = home();
    let now = T0;
    const a = new RpcMeter({ home: h, role: "attest", scope: "bbbbbbbb", dailyCu: 100, nowMs: () => now });
    for (let i = 0; i < 10; i++) a.count("eth_estimateGas");
    a.tick(true);
    expect(a.allowed()).toBe(false);
    now += 5_000;
    const late = new RpcMeter({ home: h, role: "payer", scope: "market", dailyCu: 100, nowMs: () => now });
    expect(late.allowed()).toBe(false);
    // and the same role restarted carries on from its file: still stopped, its count kept
    const again = new RpcMeter({ home: h, role: "attest", scope: "bbbbbbbb", dailyCu: 100, nowMs: () => now });
    expect(again.ownCu()).toBe(200);
    expect(again.allowed()).toBe(false);
  });

  test("00:00 UTC: the old day's file keeps every count of that day, the new day starts at zero and Alchemy comes back", () => {
    const h = home();
    let now = Date.parse("2026-10-04T23:59:30Z");
    const a = new RpcMeter({ home: h, role: "keep", scope: "cccccccc", dailyCu: 100, nowMs: () => now });
    for (let i = 0; i < 6; i++) a.count("eth_sendRawTransaction");
    a.tick(true);
    expect(a.allowed()).toBe(false);
    now += 20_000; // 23:59:50, inside the 60 s write period
    a.count("eth_sendRawTransaction"); // counted while stopped (a call already in flight)
    now += 15_000; // 00:00:05
    expect(a.allowed()).toBe(true);
    const old = JSON.parse(readFileSync(join(meterDir(h, "2026-10-04"), "keep-cccccccc.json"), "utf8")) as { methods: Record<string, number> };
    expect(old.methods.eth_sendRawTransaction).toBe(7);
    expect(a.ownCu()).toBe(0);
    expect(meterDay(h, "2026-10-05").total).toBe(0);
  });

  test("a file cannot lower the day's total: negative, NaN or non-numeric counts are dropped, the cu field is ignored", () => {
    const h = home();
    const dir = meterDir(h, "2026-10-04");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x-a.json"), JSON.stringify({ methods: { eth_call: -1000, eth_getLogs: "9" }, wsBytes: -5, cu: -1_000_000 }));
    writeFileSync(join(dir, "y-b.json"), JSON.stringify({ methods: { eth_sendRawTransaction: 2 }, wsBytes: 100, cu: 0 }));
    writeFileSync(join(dir, "z-c.json"), "{not json");
    const d = meterDay(h, "2026-10-04");
    expect(d.total).toBe(cuOf({ methods: { eth_sendRawTransaction: 2 }, wsBytes: 100 }));
    expect(d.total).toBe(84);
  });
});
