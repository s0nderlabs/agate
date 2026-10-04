// Recheck r2 (Oct 4): the Alchemy meter's arithmetic and the ways it could undercount. A hand-priced day, a home the
// meter cannot write (the stop must still come from its own counts), the most a process can spend past the budget
// before it stops (one sum period), and two processes that share one role and scope (they write one file).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cuOf, METER_PERIOD_MS, meterDay, RpcMeter, utcDate } from "../../../src/meter.ts";

const homes: string[] = [];
const home = () => {
  const h = mkdtempSync(join(tmpdir(), "agate-recheck-r2-meter-"));
  homes.push(h);
  return h;
};
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

describe("the meter's arithmetic (recheck r2)", () => {
  test("a hand-priced day: every method at its price, an unknown one at 26, websocket bytes at 0.04, rounded up once", () => {
    const methods = { eth_sendRawTransaction: 3, eth_estimateGas: 2, eth_getTransactionReceipt: 5, eth_getTransactionCount: 4, eth_chainId: 7, eth_getTransactionByHash: 1, eth_subscribe: 2 };
    // 3x40 + 2x20 + 5x20 + 4x20 + 7x0 + 1x26 + 2x10 = 386, plus 1001 bytes x 0.04 = 40.04: 426.04, rounded up to 427
    expect(cuOf({ methods, wsBytes: 1001 })).toBe(427);
    expect(cuOf({ methods: {}, wsBytes: 25 })).toBe(1);
    expect(cuOf({ methods: { eth_chainId: 1000 }, wsBytes: 0 })).toBe(0);
  });

  test("the live fork's counts of recheck r1 in one sum: 12,440 for the calls plus 28,362.16 for the bytes, 40,803 (its 8 files, each rounded up, said 40,804)", () => {
    const methods = { eth_chainId: 10, eth_estimateGas: 110, eth_getTransactionCount: 65, eth_sendRawTransaction: 109, eth_getTransactionReceipt: 227, eth_subscribe: 4 };
    expect(cuOf({ methods, wsBytes: 709_054 })).toBe(40_803);
  });
});

describe("what the meter cannot lose (recheck r2)", () => {
  test("a home it cannot write: the counts stay in memory and the stop still comes at the budget", () => {
    const h = home();
    const blocked = join(h, "not-a-dir");
    writeFileSync(blocked, "a file where the meter wants a folder");
    const said: string[] = [];
    let now = Date.parse("2026-10-04T12:00:00Z");
    const m = new RpcMeter({ home: blocked, role: "attest", scope: "r2r2r2r2", dailyCu: 1_000, nowMs: () => now, say: (e) => void said.push(e) });
    for (let i = 0; i < 26; i++) m.count("eth_sendRawTransaction"); // 1,040 CU
    now += METER_PERIOD_MS;
    expect(m.allowed()).toBe(false);
    expect(said).toContain("rpc_meter_write_failed");
    expect(said).toContain("alchemy_budget_stop");
  });

  test("the most a process spends past the budget before it stops: what it sends within one sum period (60 s)", () => {
    const h = home();
    let now = Date.parse("2026-10-04T12:00:00Z");
    const m = new RpcMeter({ home: h, role: "marketmaker", scope: "market", dailyCu: 1_000, nowMs: () => now });
    m.count("eth_chainId"); // the first count sums at once (0 CU)
    let allowedCalls = 0;
    // a burst of 100 sends inside one period: each asks allowed() first, as the routes do
    for (let i = 0; i < 100; i++) {
      now += 100;
      if (!m.allowed()) break;
      allowedCalls++;
      m.count("eth_sendRawTransaction");
    }
    // nothing stops it inside the period: 100 x 40 = 4,000 CU against a budget of 1,000
    expect(allowedCalls).toBe(100);
    now += METER_PERIOD_MS;
    expect(m.allowed()).toBe(false);
    expect(m.ownCu()).toBe(4_000);
  });

  test("two processes of one role and scope at once write one file: the day's total holds only the last writer's counts", () => {
    // INFO (recheck r2): every long-running role holds a per-role lock (watcher role.lock, writer FileLock, market
    // role.lock), so only a tool without one (the guardian CLI, role "guardian") can run twice at once; its sends are few.
    const h = home();
    let now = Date.parse("2026-10-04T12:00:00Z");
    const a = new RpcMeter({ home: h, role: "guardian", scope: "r2r2r2r2", dailyCu: 1_000_000, nowMs: () => now });
    const b = new RpcMeter({ home: h, role: "guardian", scope: "r2r2r2r2", dailyCu: 1_000_000, nowMs: () => now });
    for (let i = 0; i < 10; i++) a.count("eth_sendRawTransaction");
    for (let i = 0; i < 3; i++) b.count("eth_sendRawTransaction");
    now += METER_PERIOD_MS;
    a.tick(true);
    b.tick(true);
    expect(a.ownCu() + b.ownCu()).toBe(520);
    expect(meterDay(h, utcDate(now)).total).toBe(120);
  });
});
