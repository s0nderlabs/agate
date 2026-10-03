// Audit (phase 3, bot money and risk lens): the payer, the lister and the shared scanner, probed where the build's own
// tests stopped. The audit round asserted the behaviour it found; the fix round flipped each assertion to the fixed
// behaviour (fix-log.md, Oct 3). In-memory fakes and two local HTTP endpoints only: no chain, no key, no network.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, padHex, toHex } from "viem";
import { AlertSink, RpcPool } from "@agate/watcher";
import { CENT, type FactoryEntry, LimitTable, MarketScanner, type Plan, scanIdentity, type SendSpec } from "@agate/market";
import { Payer } from "../../src/payer.ts";
import { Positions } from "../../src/positions.ts";
import { StateStore } from "../../src/state.ts";
import { addr, FakeReads, FakeScanner, FakeSender, type FakeSeries, FakeWorld, gpu, U } from "../fake/world.ts";

const F = 1_800_000n;
const C = 7_200_000n;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function world(sender?: (w: FakeWorld) => FakeSender) {
  const w = new FakeWorld();
  const f = w.addFactory("demo");
  const s: FakeSeries = w.addSeries(f, gpu(0x100), 24_322, { n: 30, floor: F, cap: C, startTs: w.t, day: 600 });
  s.values = Array.from({ length: 30 }, () => 3_600_000n);
  const entry: FactoryEntry = { name: "demo", index: f.index, dollar: addr(0xd011a7), tag: "demo", factory: f.address, router: addr(0x7007), tPend: 210, startBlock: 0n };
  const dir = mkdtempSync(join(tmpdir(), "agate-payer-audit-"));
  dirs.push(dir);
  const alerts = new AlertSink(join(dir, "alerts.jsonl"), { now: () => Number(w.t), print: false });
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const snd = sender ? sender(w) : new FakeSender(w);
  const payer = new Payer({
    reads: new FakeReads(w),
    sender: snd,
    scanner: new FakeScanner(w),
    positions: new Positions([entry]),
    state: new StateStore(dir),
    limits: new LimitTable(),
    config: { claimThresholdU: CENT, maxIdsPerCall: 50, claimEveryDays: { demo: 1 } },
    alerts,
    log: (event, data) => logs.push({ event, data }),
  });
  return { w, s, entry, alerts, logs, payer };
}

describe("AUDIT P-H1 (fixed): the D1 hold covers every day the call would apply", () => {
  test("the wall closed day 1 of 3 overdue days; previewSync would force days 2 and 3: nothing is sent, PAYER_FORCE_HELD; once the wall closes them, paid", async () => {
    const x = world();
    const id = x.s.open({ owner: addr(1), payee: addr(0xa1), side: 0, q: 720n * U, daily: true });
    // three days ended long ago, all past their last resort; the wall (catching up after an outage) has closed day 1
    // only: head = startDay + 1. In the real series, sync would apply day 1 (final) and FORCE days 2 and 3 at lastX.
    x.s.finalDays = 3; // what previewSync answers: 3 days a sync would apply now (1 final + 2 forced)
    x.w.t = x.s.t.startTs + 3n * 600n + x.s.t.lastResort + 1n;
    const head = `${x.entry.index.toLowerCase()}:${x.s.t.gpuId}`;
    x.w.heads.set(head, x.s.t.startDay + 1);
    await x.payer.tick(x.w.t);
    // FIXED: held (was sync(3), then claimMany)
    expect(x.w.sends).toEqual([]);
    expect(x.alerts.open().map((a) => a.code as string)).toContain("PAYER_FORCE_HELD");
    // the wall closes days 2 and 3 (and, recheck R1-L1, the days whose last resort comes within the hour: 4 to 9,
    // skipped in this fake): nothing is forced any more
    x.w.heads.set(head, x.s.t.startDay + 9);
    await x.payer.tick(x.w.t + 1n);
    expect(x.w.sends.map((s) => s.fn)).toEqual(["sync", "claimMany"]);
    expect(x.s.claimableOf(id)).toBe(0n);
    expect(x.alerts.open().map((a) => a.code as string)).not.toContain("PAYER_FORCE_HELD");
  });

  test("checked again right before claimMany: a day that turns forced between the views and the send holds the claims", async () => {
    const x = world();
    x.s.open({ owner: addr(1), payee: addr(0xa1), side: 0, q: 720n * U, daily: true });
    x.s.finalDays = 1;
    x.w.t = x.s.t.startTs + 3n * 600n + x.s.t.lastResort + 1n; // days 1 to 3 at or past their last resort
    const head = `${x.entry.index.toLowerCase()}:${x.s.t.gpuId}`;
    x.w.heads.set(head, x.s.t.startDay + 1); // day 1 closed, 2 and 3 not
    // the views see kPrev 1 (day 1, closed); recheck R1-L1: the views already look past kPrev, at days 2 and 3 (and
    // every day within the hour of its last resort), so not even the sync goes out
    await x.payer.tick(x.w.t);
    expect(x.w.sends).toEqual([]);
    expect(x.alerts.open().map((a) => a.code as string)).toContain("PAYER_FORCE_HELD");
    // the second check: the views pass (every near day closed), then the index stops answering head (a MockIndex, a
    // node's revert) between the sync and the claimMany: the claimMany is held
    x.w.heads.set(head, x.s.t.startDay + 9);
    const sync = x.s.syncN.bind(x.s);
    x.s.syncN = (max: number) => {
      const n = sync(max);
      x.w.heads.set(head, null);
      return n;
    };
    x.s.finalDays = 3;
    await x.payer.tick(x.w.t + 1n);
    expect(x.w.sends.map((s) => s.fn)).toEqual(["sync"]); // the claimMany is held by the fresh check
    expect(x.alerts.open().map((a) => a.code as string)).toContain("PAYER_FORCE_HELD");
  });
});

class Capped extends FakeSender {
  constructor(
    w: FakeWorld,
    readonly capSync: number,
    readonly capClaim: number,
  ) {
    super(w);
  }
  override async plan(s: SendSpec): Promise<Plan> {
    if (s.functionName === "sync" && (s.c ?? 0) > this.capSync) return { ok: false, error: "GAS_CAP" };
    if (s.functionName === "claimMany" && (s.c ?? 0) > this.capClaim) return { ok: false, error: "GAS_CAP" };
    return super.plan(s);
  }
  override async send(s: SendSpec) {
    const p = await this.plan(s);
    if (!p.ok) return { ok: false, sent: false, error: p.error ?? "refused" };
    return super.send(s);
  }
}

describe("AUDIT P-M1 (fixed): a sync over its cap is chunked; when no chunk fits, claimMany carries it", () => {
  test("12 pending days, a sync over 5 days refused by the cap: sync in chunks that fit, then the claims", async () => {
    // a sender whose cap refuses a sync of more than 5 days (what Ethereum-priced LIMITs give on Monad for a long
    // backlog: about 18,000 more gas per cold round); everything else as the fake's real rule
    const x = world((w) => new Capped(w, 5, 5));
    const id = x.s.open({ owner: addr(1), payee: addr(0xa1), side: 0, q: 720n * U, daily: true });
    x.s.finalDays = 12;
    x.w.t = x.s.t.startTs + 12n * 600n + 400n;
    await x.payer.tick(x.w.t);
    // FIXED: 12 refused, 6 refused, 3 fits; the next chunks start at 3 (was: nothing ever sent)
    expect(x.w.sends.map((s) => `${s.fn}:${s.c}`)).toEqual(["sync:3", "sync:3", "sync:3", "sync:3", "claimMany:0"]);
    expect(x.s.claimableOf(id)).toBe(0n);
    expect(x.logs.filter((l) => l.event === "sync_chunked").length).toBe(4);
  });

  test("one pending day, sync(1) over its cap while claimMany (which syncs itself, larger LIMIT) fits: claimMany pays, PAYER_SYNC_CAPPED (action)", async () => {
    // sync(1)'s CAP is 1.5 x (135,249 + 21,000 + 204) = 234,680, so a Monad estimate above 195,566 is refused; the
    // stand-in measured on Monad (MS 4.6, n = 1 per shape) estimated 220,278 for one pending day
    const x = world((w) => new Capped(w, 0, 99));
    const id = x.s.open({ owner: addr(1), payee: addr(0xa1), side: 0, q: 720n * U, daily: true });
    x.s.finalDays = 1;
    x.w.t = x.s.t.startTs + 600n + 400n;
    await x.payer.tick(x.w.t);
    // FIXED: the claim went through with its own sync (was: nothing paid)
    expect(x.w.sends.map((s) => s.fn)).toEqual(["claimMany"]);
    expect(x.s.claimableOf(id)).toBe(0n);
    const a = x.alerts.open().find((y) => (y.code as string) === "PAYER_SYNC_CAPPED")!;
    expect(a.severity).toBe("action");
    expect(a.message).toContain("AGATE_MARKET_GAS_LIMITS");
  });

  test("a sync refused for another reason (not its cap) still waits: the claims would revert the same way", async () => {
    class Reverting extends FakeSender {
      override async plan(s: SendSpec): Promise<Plan> {
        if (s.functionName === "sync") return { ok: false, error: "SyncGasLow()" };
        return super.plan(s);
      }
      override async send(s: SendSpec) {
        const p = await this.plan(s);
        if (!p.ok) return { ok: false, sent: false, error: p.error ?? "refused" };
        return super.send(s);
      }
    }
    const x = world((w) => new Reverting(w));
    x.s.open({ owner: addr(1), payee: addr(0xa1), side: 0, q: 720n * U, daily: true });
    x.s.finalDays = 1;
    x.w.t = x.s.t.startTs + 600n + 400n;
    await x.payer.tick(x.w.t);
    expect(x.w.sends).toEqual([]);
    expect(x.alerts.open().map((a) => a.code as string)).not.toContain("PAYER_BAD_ID");
  });
});

// ------------------------------------------------------------------ the scanner and a rate-limited first URL

interface Srv {
  url: string;
  getLogs: number;
  stop(): void;
}

function block(n: bigint) {
  const z = (k: number) => `0x${"0".repeat(k)}`;
  return { number: `0x${n.toString(16)}`, hash: `0x${n.toString(16).padStart(64, "0")}`, parentHash: z(64), timestamp: `0x${(1_900_000_000n + n).toString(16)}`, baseFeePerGas: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: z(40), extraData: "0x", logsBloom: z(512), transactions: [], difficulty: "0x0", nonce: "0x0000000000000000", sha3Uncles: z(64), size: "0x0", stateRoot: z(64), receiptsRoot: z(64), transactionsRoot: z(64), uncles: [], mixHash: z(64), totalDifficulty: "0x0" };
}

/** A JSON-RPC endpoint; `throttle()` true answers eth_getLogs with Alchemy's HTTP 429 body. */
function serve(throttle: () => boolean): Srv {
  const st = { getLogs: 0 };
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const b = (await req.json()) as { id: number; method: string; params: unknown[] };
      const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: b.id, result });
      switch (b.method) {
        case "eth_chainId":
          return ok("0x279f");
        case "eth_blockNumber":
          return ok("0x3e8");
        case "eth_getBlockByNumber":
          return ok(block(b.params[0] === "finalized" ? 998n : 1_000n));
        case "eth_getLogs":
          st.getLogs++;
          if (throttle())
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, error: { code: 429, message: "Your app has exceeded its compute units per second capacity. If you have retries enabled, you can safely ignore this message. If not, check out https://docs.alchemy.com/reference/throughput" } }), { status: 429, headers: { "content-type": "application/json" } });
          return ok([]);
        default:
          return Response.json({ jsonrpc: "2.0", id: b.id, error: { code: -32601, message: "not supported" } });
      }
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    get getLogs() {
      return st.getLogs;
    },
    stop: () => server.stop(true),
  };
}

describe("AUDIT P-M3 (fixed): cursor.json carries the chain, the factory set and the start block", () => {
  test("a cursor left by another chain (a fork run, a testnet reset) far ahead of this chain's tip: rescanned from the start block", async () => {
    const node = serve(() => false);
    try {
      const pool = await RpcPool.create({ urls: [node.url, node.url.replace("127.0.0.1", "localhost")], expectChainId: 10143, timeoutMs: 5_000, staleS: 10 ** 9, role: "audit", now: () => 0 });
      const dir = mkdtempSync(join(tmpdir(), "agate-payer-audit-cursor-"));
      dirs.push(dir);
      await Bun.write(join(dir, "cursor.json"), JSON.stringify({ next: "67760000" })); // from an earlier run elsewhere
      const scanner = new MarketScanner({ pool, dir, fromBlock: 10n, factories: [padHex(toHex(0xfac), { size: 20 }) as Address], chunk: 100 });
      await scanner.sync();
      // FIXED: scanned from block 10 to the finalized tip 998 (was: caught up at once, zero eth_getLogs)
      expect(node.getLogs).toBe(10);
      expect(scanner.caughtUp).toBe(true);
      expect(scanner.next).toBe(999n);
      // and the cursor now names its chain, start block and factories, so another deployment's start rescans too
      const j = JSON.parse(readFileSync(join(dir, "cursor.json"), "utf8"));
      expect(j).toMatchObject({ chainId: 10143, fromBlock: "10" });
      const other = new MarketScanner({ pool, dir, fromBlock: 500n, factories: [padHex(toHex(0xfad), { size: 20 }) as Address], chunk: 100 });
      expect(other.next).toBe(500n);
    } finally {
      node.stop();
    }
  });

  test("state.json of another deployment is set aside: its lastClaimK and sweepDone never hide a series", () => {
    const dir = mkdtempSync(join(tmpdir(), "agate-payer-audit-state-"));
    dirs.push(dir);
    const fork = scanIdentity(10143, 67_760_000n, [padHex(toHex(0xfac), { size: 20 })]);
    const a = new StateStore(dir, fork);
    a.mark("0x00000000000000000000000000000000000005e1").sweepDone = true;
    a.save();
    const real = scanIdentity(10143, 67_900_000n, [padHex(toHex(0xfad), { size: 20 })]);
    const b = new StateStore(dir, real);
    expect(b.resetWhy).toContain("fromBlock, factories");
    expect(b.data.series).toEqual({});
    const c = new StateStore(dir, real); // the same deployment again: kept
    expect(c.resetWhy).toBe(null);
  });
});

describe("AUDIT P-M2 (fixed): the scanner reads an Alchemy 429 as a rate limit and fails over", () => {
  test("the healthy second URL takes over at once; the chunk stays 100", async () => {
    const throttled = true;
    const alchemy = serve(() => throttled);
    const pub = serve(() => false);
    try {
      const pool = await RpcPool.create({ urls: [alchemy.url, pub.url], expectChainId: 10143, timeoutMs: 5_000, staleS: 10 ** 9, role: "audit", now: () => 0 });
      const dir = mkdtempSync(join(tmpdir(), "agate-payer-audit-scan-"));
      dirs.push(dir);
      const scanner = new MarketScanner({ pool, dir, fromBlock: 10n, factories: [padHex(toHex(0xfac), { size: 20 }) as Address], chunk: 100 });
      await scanner.sync();
      // FIXED: one throttled call, then the public RPC for the rest (was: 5 throttled calls, a throw and chunk 10 for
      // good)
      expect(alchemy.getLogs).toBe(1);
      expect(pub.getLogs).toBe(10);
      expect(scanner.chunkSize).toBe(100);
      expect(scanner.caughtUp).toBe(true);
    } finally {
      alchemy.stop();
      pub.stop();
    }
  });
});
