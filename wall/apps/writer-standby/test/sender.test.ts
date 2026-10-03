// One key's transactions on a real anvil (13.4): eth_call first, the gas rule and GAS_CAP, the journal before the
// broadcast, a dropped transaction rebroadcast with the same bytes, replacement after the timeout, a cancel once the
// content's window has closed, NONCE_STUCK, "nonce too low", a foreign transaction at our nonce, the restart
// reconcile, the CRE CLI's transaction adopted, and the key held around another program's sends.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeReport, makeReport } from "@agate/report";
import { agateIndexAbi } from "@agate/report/abi";
import type { Address, Entry, Hex } from "@agate/report/types";
import { encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ReadingLog } from "../src/pipeline/log.ts";
import { KeyLock } from "../src/pipeline/lock.ts";
import { type AlertInput, RpcPool } from "../src/pipeline/rpc.ts";
import { gasLimitFor, MEASURED, type SenderTiming, type TxLine, TxSender } from "../src/pipeline/sender.ts";
import { ADDR, type Anvil, type Deployed, deployIndex, haveAnvil, KEYS, SELECTOR, startAnvil, warp } from "./helpers/anvil.ts";

describe("gas rule (13.4)", () => {
  test("min(CAP, ceil(1.5 x max(estimate, MEASURED))), CAP = 2 x MEASURED, refused when 1.5 x estimate > CAP", () => {
    expect(gasLimitFor(100_000n, 512_718n)).toEqual({ ok: true, limit: 769_077n, cap: 1_025_436n });
    expect(gasLimitFor(600_000n, 512_718n)).toEqual({ ok: true, limit: 900_000n, cap: 1_025_436n });
    expect(gasLimitFor(683_624n, 512_718n)).toEqual({ ok: true, limit: 1_025_436n, cap: 1_025_436n });
    expect(gasLimitFor(683_625n, 512_718n)).toEqual({ ok: false, need: 1_025_438n, cap: 1_025_436n });
    // reports at six entries of 15 slots (18.4, measured on anvil; onReport through the CRE simulation forwarder),
    // closeDay per GPU (forge, unchanged)
    expect(MEASURED).toEqual({ postReport: 994_276n, closeDay: 630_218n, onReport: 1_076_000n });
    expect(gasLimitFor(100_000n, MEASURED.postReport)).toEqual({ ok: true, limit: 1_491_414n, cap: 1_988_552n });
  });
});

let a: Anvil;
let dep: Deployed;

beforeAll(async () => {
  if (!haveAnvil) return;
  a = await startAnvil();
  dep = await deployIndex(a);
  await warp(a, dep.epochTs + 200 * 3 + 50); // slice 3 of day 20,727
});
afterAll(() => a?.stop());

const FAST: SenderTiming = { pollMs: 20, rebroadcastMs: 300, replaceMs: 1_000, waitMs: 2_000, lockWaitMs: 300 };

function clock() {
  let ms = 1_000_000;
  return { now: () => ms, sleep: async (d: number) => void ((ms += d), await Bun.sleep(2)), advance: (d: number) => void (ms += d) };
}

/** A JSON-RPC proxy in front of anvil that can lose the reply to a broadcast or refuse the "pending" tag. */
function proxy(o: { loseSendReply?: { n: number }; refusePending?: boolean }) {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { id: number; method: string; params?: unknown[] };
      if (o.refusePending && (body.params ?? []).includes("pending")) {
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "invalid block tag: pending is not supported" } });
      }
      const res = await fetch(a.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (body.method === "eth_sendRawTransaction" && o.loseSendReply && o.loseSendReply.n > 0) {
        o.loseSendReply.n -= 1;
        await res.text();
        return new Response("bad gateway", { status: 502 }); // the node took it; the answer was lost on the way
      }
      return new Response(await res.text(), { headers: { "content-type": "application/json" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

async function mkSender(key: Hex, o: { home?: string; urls?: string[]; measured?: Partial<Record<"postReport" | "closeDay" | "onReport", bigint>>; nowS?: () => number; maxFeeWei?: bigint; keyLock?: boolean } = {}) {
  const pool = new RpcPool({ urls: o.urls ?? [a.rpc], timeoutMs: 2_000, staleS: 10_000_000 });
  await pool.init();
  const home = o.home ?? mkdtempSync(join(tmpdir(), "agate-sender-"));
  const log = new ReadingLog(home, "standby");
  const alerts: AlertInput[] = [];
  const events: { e: string; d?: Record<string, unknown> }[] = [];
  const ck = clock();
  const account = privateKeyToAccount(key);
  const s = new TxSender({
    pool,
    account,
    index: dep.index,
    journal: log,
    timing: FAST,
    alert: (x) => void alerts.push(x),
    nowMs: ck.now,
    sleep: ck.sleep,
    say: (e, d) => void events.push({ e, ...(d ? { d } : {}) }),
    ...(o.measured ? { measured: o.measured } : {}),
    ...(o.nowS ? { nowS: o.nowS } : {}),
    ...(o.maxFeeWei !== undefined ? { maxFeeWei: o.maxFeeWei } : {}),
    ...(o.keyLock ? { keyLock: new KeyLock(join(home, "keys", `${account.address.toLowerCase()}.lock`), 100) } : {}),
  });
  return { s, log, home, alerts, events, ck };
}

let sliceNo = 0;
async function report(): Promise<Hex> {
  const t = Number((await a.pub.getBlock()).timestamp);
  const h = Math.floor((t - dep.epochTs) / 200);
  const entries: Entry[] = dep.panels.map((p) => ({ gpuId: p.gpuId, dayId: 20_727, slice: h, readAt: BigInt(dep.epochTs + h * 200 + 1), values: p.slots.map((_, i) => 3_000_000 + 10_000 * (i + sliceNo)) }));
  sliceNo += 1;
  return encodeReport(makeReport(SELECTOR, dep.index, entries));
}

const post = async (r: Hex) => encodeFunctionData({ abi: agateIndexAbi, functionName: "postReport", args: [r] });
const meta = (tags: string[] = ["t"], deadline?: number) => ({ action: "post" as const, tags, ...(deadline !== undefined ? { deadline } : {}) });
const journal = (log: ReadingLog, from: Address) => log.recent(from) as TxLine[];

async function txsOf(from: Address): Promise<number> {
  return a.pub.getTransactionCount({ address: from });
}

async function withAutomineOff<T>(fn: () => Promise<T>): Promise<T> {
  await a.test.setAutomine(false);
  try {
    return await fn();
  } finally {
    await a.test.setAutomine(true);
  }
}

describe.skipIf(!haveAnvil)("TxSender on anvil", () => {
  test("eth_call first: a key with no role sends nothing (no nonce used, nothing journaled)", async () => {
    const { s, log } = await mkSender(KEYS[5]);
    const n0 = await txsOf(ADDR[5]!);
    const r = await s.send({ to: dep.index, data: await post(await report()), shape: "postReport", meta: meta() });
    expect(r).toMatchObject({ ok: false, sent: false });
    expect(r.error).toMatch(/^A2_NotActiveWriter\(0x/i);
    expect(await txsOf(ADDR[5]!)).toBe(n0);
    expect(journal(log, ADDR[5]!).length).toBe(0);
  });

  test("a send: gas limit = ceil(1.5 x MEASURED), journaled before the broadcast, done on its receipt", async () => {
    const { s, log } = await mkSender(KEYS[2]);
    const r = await s.send({ to: dep.index, data: await post(await report()), shape: "postReport", meta: meta(["x:1"]) });
    expect(r.ok).toBe(true);
    const tx = await a.pub.getTransaction({ hash: r.txHash! });
    expect(tx.gas).toBe(1_491_414n); // ceil(1.5 x 994,276)
    expect(r.gasUsed! < tx.gas).toBe(true);
    const j = journal(log, ADDR[2]!);
    expect(j.at(-1)).toMatchObject({ kind: "tx", hash: r.txHash, nonce: tx.nonce, action: "post", tags: ["x:1"] });
    expect(s.inFlight().size).toBe(0);
  });

  test("GAS_CAP: 1.5 x estimate above 2 x MEASURED is refused and alerted, nothing sent", async () => {
    const { s, alerts } = await mkSender(KEYS[2], { measured: { postReport: 30_000n } });
    const n0 = await txsOf(ADDR[2]!);
    const r = await s.send({ to: dep.index, data: await post(await report()), shape: "postReport", meta: meta() });
    expect(r).toMatchObject({ ok: false, sent: false });
    expect(r.error).toMatch(/^GAS_CAP/);
    expect(alerts.map((x) => x.code)).toEqual(["GAS_CAP"]);
    expect(await txsOf(ADDR[2]!)).toBe(n0);
  });

  test("a dropped transaction is rebroadcast unchanged (same nonce, same hash) and mined", async () => {
    await withAutomineOff(async () => {
      const { s, ck, events } = await mkSender(KEYS[2]);
      const r = await s.send({ to: dep.index, data: await post(await report()), shape: "postReport", meta: meta(["d:1"]), waitUntilMs: ck.now() + 100 });
      expect(r).toMatchObject({ ok: false, sent: true, pending: true });
      expect(s.inFlight().has("d:1")).toBe(true);
      await a.test.dropTransaction({ hash: r.txHash! });
      expect(await a.pub.getTransaction({ hash: r.txHash! }).catch(() => null)).toBeNull();
      expect((await s.settle(ck.now() + 600)).kind).toBe("pending");
      expect(events.some((x) => x.e === "tx_rebroadcast")).toBe(true);
      await a.test.mine({ blocks: 1 });
      const done = await s.settle(ck.now() + 600);
      expect(done).toMatchObject({ kind: "mined", hash: r.txHash, status: "success" });
      expect((await a.pub.getTransaction({ hash: r.txHash! })).nonce).toBe(r.nonce!);
      expect(s.inFlight().size).toBe(0);
    });
  });

  test("an unmined transaction is replaced after the timeout: same nonce, fees + 25 %; only the replacement lands", async () => {
    await withAutomineOff(async () => {
      const { s, ck, log } = await mkSender(KEYS[2]);
      const r = await s.send({ to: dep.index, data: await post(await report()), shape: "postReport", meta: meta(["r:1"]), waitUntilMs: ck.now() + 50 });
      const first = await a.pub.getTransaction({ hash: r.txHash! });
      ck.advance(FAST.replaceMs);
      expect((await s.settle(ck.now() + 50)).kind).toBe("pending");
      const lines = journal(log, ADDR[2]!);
      expect(lines.length).toBe(2);
      expect(lines[1]).toMatchObject({ nonce: r.nonce, replaces: r.txHash, action: "post" });
      const second = await a.pub.getTransaction({ hash: lines[1]!.hash });
      expect(second.nonce).toBe(first.nonce);
      expect(second.maxFeePerGas! >= (first.maxFeePerGas! * 125n) / 100n).toBe(true);
      expect(second.input).toBe(first.input);
      await a.test.mine({ blocks: 1 });
      const done = await s.settle(ck.now() + 500);
      expect(done).toMatchObject({ kind: "mined", hash: lines[1]!.hash });
      expect(await a.pub.getTransactionReceipt({ hash: r.txHash! }).catch(() => null)).toBeNull();
    });
  });

  test("past its content's F1 deadline a stuck post is replaced by a cancel, never resent", async () => {
    let writerNow = 0;
    await withAutomineOff(async () => {
      const { s, ck, log } = await mkSender(KEYS[2], { nowS: () => writerNow });
      const r = await s.send({ to: dep.index, data: await post(await report()), shape: "postReport", meta: meta(["c:1"], 100), waitUntilMs: ck.now() + 50 });
      writerNow = 101;
      ck.advance(FAST.replaceMs);
      await s.settle(ck.now() + 50);
      const l = journal(log, ADDR[2]!).at(-1)!;
      expect(l).toMatchObject({ action: "cancel", replaces: r.txHash, nonce: r.nonce });
      const cancel = await a.pub.getTransaction({ hash: l.hash });
      expect(cancel.to?.toLowerCase()).toBe(ADDR[2]!.toLowerCase());
      expect(cancel.input).toBe("0x");
      await a.test.mine({ blocks: 1 });
      expect(await s.settle(ck.now() + 500)).toMatchObject({ kind: "mined", hash: l.hash, cancel: true });
    });
  });

  test("a stuck post whose day has closed (useful() false, Oct 3) is replaced by a cancel before its REPOST_END", async () => {
    let open = true;
    await withAutomineOff(async () => {
      const { s, ck, log } = await mkSender(KEYS[2], { nowS: () => 50 });
      const m = { ...meta(["u:1"], 100), useful: async () => open };
      const r = await s.send({ to: dep.index, data: await post(await report()), shape: "postReport", meta: m, waitUntilMs: ck.now() + 50 });
      ck.advance(FAST.replaceMs);
      await s.settle(ck.now() + 50);
      expect(journal(log, ADDR[2]!).at(-1)).toMatchObject({ action: "post", replaces: r.txHash }); // still useful: same content
      open = false; // the day was closed meanwhile: the entries would be skipped (E3)
      ck.advance(FAST.replaceMs);
      await s.settle(ck.now() + 50);
      const l = journal(log, ADDR[2]!).at(-1)!;
      expect(l).toMatchObject({ action: "cancel", nonce: r.nonce });
      await a.test.mine({ blocks: 1 });
      expect(await s.settle(ck.now() + 500)).toMatchObject({ kind: "mined", hash: l.hash, cancel: true });
    });
  });

  test("NONCE_STUCK after three replacements still unmined", async () => {
    await withAutomineOff(async () => {
      const { s, ck, alerts } = await mkSender(KEYS[2]);
      await s.send({ to: dep.index, data: await post(await report()), shape: "postReport", meta: meta(["n:1"]), waitUntilMs: ck.now() + 50 });
      for (let i = 0; i < 3; i++) {
        ck.advance(FAST.replaceMs);
        await s.settle(ck.now() + 10);
      }
      expect(alerts.filter((x) => x.code === "NONCE_STUCK").length).toBe(0);
      ck.advance(FAST.replaceMs);
      await s.settle(ck.now() + 10);
      expect(alerts.filter((x) => x.code === "NONCE_STUCK").length).toBe(1);
      await a.test.mine({ blocks: 1 });
      expect((await s.settle(ck.now() + 500)).kind).toBe("mined");
    });
  });

  test('"nonce too low": another sender used our nonce; we re-read it and send once more', async () => {
    const one = await mkSender(KEYS[2]);
    const two = await mkSender(KEYS[2]);
    await two.s.resync(); // two's counter is now stale-to-be
    expect((await one.s.send({ to: dep.index, data: await post(await report()), shape: "postReport", meta: meta() })).ok).toBe(true);
    const n = await txsOf(ADDR[2]!);
    const r = await two.s.send({ to: dep.index, data: await post(await report()), shape: "postReport", meta: meta() });
    expect(r.ok).toBe(true);
    expect(r.nonce).toBe(n);
    expect(journal(two.log, ADDR[2]!).length).toBe(2); // the refused signature and the re-signed one, both journaled
  });

  test('"nonce too low" from the failover URL after the first took our transaction: ours is found mined, never re-signed', async () => {
    const p = proxy({ loseSendReply: { n: 1 } });
    try {
      const { s, log } = await mkSender(KEYS[2], { urls: [p.url, a.rpc] });
      const n0 = await txsOf(ADDR[2]!);
      const r = await s.send({ to: dep.index, data: await post(await report()), shape: "postReport", meta: meta(["l:1"]) });
      expect(r).toMatchObject({ ok: true, sent: true, nonce: n0 });
      expect(await txsOf(ADDR[2]!)).toBe(n0 + 1);
      const j = journal(log, ADDR[2]!);
      expect(j.map((l) => l.hash)).toEqual([r.txHash!]);
    } finally {
      p.stop();
    }
  });

  test("a foreign transaction mined at our nonce: our flight is superseded, never counted as landed", async () => {
    await withAutomineOff(async () => {
      const { s, ck } = await mkSender(KEYS[2]);
      const r = await s.send({ to: dep.index, data: await post(await report()), shape: "postReport", meta: meta(["f:1"]), waitUntilMs: ck.now() + 50 });
      const w = a.wallet(2);
      const first = await a.pub.getTransaction({ hash: r.txHash! });
      await w.sendTransaction({ account: w.account!, chain: w.chain, to: ADDR[2]!, value: 0n, nonce: r.nonce!, maxFeePerGas: first.maxFeePerGas! * 2n, maxPriorityFeePerGas: first.maxPriorityFeePerGas! * 2n });
      await a.test.mine({ blocks: 1 });
      expect(await s.settle(ck.now() + 200)).toEqual({ kind: "superseded" });
      expect(s.inFlight().size).toBe(0);
    });
  });

  test("restart: a journaled transaction still in the mempool is adopted (no second send) and finished", async () => {
    await withAutomineOff(async () => {
      const home = mkdtempSync(join(tmpdir(), "agate-sender-"));
      const one = await mkSender(KEYS[2], { home });
      const r = await one.s.send({ to: dep.index, data: await post(await report()), shape: "postReport", meta: meta(["k:1"], 9_999_999_999), waitUntilMs: one.ck.now() + 50 });
      expect(r.pending).toBe(true);
      // the process dies here; a new one starts on the same log
      const two = await mkSender(KEYS[2], { home });
      expect(await two.s.reconcile()).toEqual({ adopted: r.nonce!, dropped: [] });
      expect(two.s.inFlight().has("k:1")).toBe(true);
      const blocked = await two.s.send({ to: dep.index, data: await post(await report()), shape: "postReport", meta: meta(), waitUntilMs: two.ck.now() + 50 });
      expect(blocked).toMatchObject({ ok: false, sent: false });
      expect(blocked.error).toMatch(/in flight/);
      await a.test.mine({ blocks: 1 });
      expect(await two.s.settle(two.ck.now() + 500)).toMatchObject({ kind: "mined", hash: r.txHash });
      expect((await a.pub.getBlock({ includeTransactions: true })).transactions.length).toBe(1);
    });
  });

  test("restart: a journaled transaction gone from the mempool is rebroadcast as the same bytes while its window is open", async () => {
    await withAutomineOff(async () => {
      const home = mkdtempSync(join(tmpdir(), "agate-sender-"));
      const one = await mkSender(KEYS[2], { home });
      const r = await one.s.send({ to: dep.index, data: await post(await report()), shape: "postReport", meta: meta(["g:1"], 9_999_999_999), waitUntilMs: one.ck.now() + 50 });
      await a.test.dropTransaction({ hash: r.txHash! });
      const two = await mkSender(KEYS[2], { home });
      expect((await two.s.reconcile()).adopted).toBe(r.nonce!);
      expect((await a.pub.getTransaction({ hash: r.txHash! })).hash).toBe(r.txHash!);
      await a.test.mine({ blocks: 1 });
      expect(await two.s.settle(two.ck.now() + 500)).toMatchObject({ kind: "mined", hash: r.txHash });
    });
  });

  test("restart: a journaled transaction gone from the mempool past its window is forgotten and its nonce reused", async () => {
    await withAutomineOff(async () => {
      const home = mkdtempSync(join(tmpdir(), "agate-sender-"));
      const one = await mkSender(KEYS[2], { home });
      const r = await one.s.send({ to: dep.index, data: await post(await report()), shape: "postReport", meta: meta(["s:1"], 5), waitUntilMs: one.ck.now() + 50 });
      await a.test.dropTransaction({ hash: r.txHash! });
      const two = await mkSender(KEYS[2], { home, nowS: () => 6 });
      expect(await two.s.reconcile()).toEqual({ dropped: [r.txHash!] });
      expect(two.s.inFlight().size).toBe(0);
      const next = await two.s.send({ to: dep.index, data: await post(await report()), shape: "postReport", meta: meta(), waitUntilMs: two.ck.now() + 50 });
      expect(next.nonce).toBe(r.nonce!);
      await a.test.mine({ blocks: 1 });
      expect((await two.s.settle(two.ck.now() + 500)).kind).toBe("mined");
    });
  });

  test("a broadcast whose answer is lost is kept in flight (never resent as a new transaction) and found mined", async () => {
    const p = proxy({ loseSendReply: { n: 1 } });
    try {
      const { s, ck } = await mkSender(KEYS[2], { urls: [p.url] });
      const n0 = await txsOf(ADDR[2]!);
      const r = await s.send({ to: dep.index, data: await post(await report()), shape: "postReport", meta: meta(["u:1"]) });
      expect(r).toMatchObject({ ok: false, sent: true, pending: true });
      expect(r.error).toMatch(/outcome unknown/);
      expect(s.inFlight().has("u:1")).toBe(true);
      expect(await s.settle(ck.now() + 500)).toMatchObject({ kind: "mined", hash: r.txHash });
      expect(await txsOf(ADDR[2]!)).toBe(n0 + 1);
    } finally {
      p.stop();
    }
  });

  test('an RPC that refuses the "pending" tag is asked at "latest" from then on', async () => {
    const p = proxy({ refusePending: true });
    try {
      const { s, events } = await mkSender(KEYS[2], { urls: [p.url] });
      const r = await s.send({ to: dep.index, data: await post(await report()), shape: "postReport", meta: meta() });
      expect(r.ok).toBe(true);
      expect(events.filter((x) => x.e === "rpc_pending_unsupported").length).toBe(1);
    } finally {
      p.stop();
    }
  });

  test("a transaction another program sent with this key (the CRE CLI) is adopted and finished", async () => {
    await withAutomineOff(async () => {
      const { s, ck } = await mkSender(KEYS[1]);
      const w = a.wallet(1);
      const hash = await w.sendTransaction({ account: w.account!, chain: w.chain, to: dep.index, data: await post(await report()), gas: 800_000n });
      expect(await s.adopt(hash, meta(["cli:1"]))).toBe(true);
      expect(s.inFlight().has("cli:1")).toBe(true);
      await a.test.mine({ blocks: 1 });
      expect(await s.settle(ck.now() + 500)).toMatchObject({ kind: "mined", hash });
      expect(await s.adopt(hash, meta())).toBe(false); // mined: nothing to adopt
    });
  });

  test("exclusive(): the key is held while another program sends; a second sender with this key waits, then proceeds", async () => {
    const home = mkdtempSync(join(tmpdir(), "agate-sender-"));
    const one = await mkSender(KEYS[2], { home, keyLock: true });
    const two = await mkSender(KEYS[2], { home, keyLock: true });
    let inside: Awaited<ReturnType<TxSender["send"]>> | undefined;
    const out = await one.s.exclusive(async () => {
      inside = await two.s.send({ to: dep.index, data: await post(await report()), shape: "postReport", meta: meta() });
      return 42;
    }, one.ck.now() + 100);
    expect(out).toBe(42);
    expect(inside).toMatchObject({ ok: false, sent: false });
    expect(inside!.error).toMatch(/key busy/);
    expect((await two.s.send({ to: dep.index, data: await post(await report()), shape: "postReport", meta: meta() })).ok).toBe(true);
  });
});
