// The Oct 3 upgrades on the watcher side (BUILD-SPEC 17.2): VETO_BY (6.6), day labels (9.6), the owner and reader
// events and their decoder (4.11, 4.15, 10), the reader-swap alerts (9.4), per-index files (13.7), the per-key send
// lock (13.7), health's new heartbeats (9.5) and the websocket wake (13.6). Synthetic data only; no network beyond
// 127.0.0.1.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Abi, encodeAbiParameters, encodeEventTopics, type Hex, keccak256, type Log, parseAbi, parseTransaction, type PublicClient, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { READER_SWAP_TAG as REPORT_TAG } from "@agate/report/types";
import { AlertCode, Status } from "@agate/report/types";
import { AlertSink } from "../src/alerts.ts";
import { Attester } from "../src/attester.ts";
import { keyLockPath, SendLock } from "../src/chain/keylock.ts";
import { ACTION_WINDOW_DAYS, actionIdOf, ownerEntries, READER_SWAP_TAG, readerHashOf, readerSwapIdOf } from "../src/chain/owner.ts";
import { RpcPool } from "../src/chain/rpc.ts";
import { TxSender } from "../src/chain/sender.ts";
import { decodeWallEvent, WATCHER_ABI } from "../src/chain/viem-index.ts";
import { Waker, WsWake } from "../src/chain/ws-wake.ts";
import { vetoBy, vetoDue } from "../src/clock.ts";
import { GuardianLog } from "../src/guardian-log.ts";
import { dayLabel } from "../src/labels.ts";
import { decisionsPath, guardianLogDir, oldGuardianLogWarning, roleBeats } from "../src/main.ts";
import { evaluate } from "../src/rule/decide.ts";
import { ATTESTER, Pages, World } from "../src/sim/world.ts";
import { A, D, scen, slotLog, steady, TEST, writer } from "./helpers.ts";

const BASE = [3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000];
const flat = () => BASE.map((v) => slotLog(TEST, D - 1, D + 1, () => v));
const OCT1 = 20_727;
const T = 2_400;

// ------------------------------------------------------------------ 6.6 VETO_BY

describe("6.6 step 3b: VETO_BY = graceStart + GRACE - REOPEN_WAIT", () => {
  test("R1_NO_CANDIDATE carries vetoBy = graceStart + GRACE - REOPEN_WAIT", () => {
    // a changed record nothing signs (the typed value of slot 2 is outside every range)
    const thief = BASE.map((v, i) => (i === 2 ? 4_500_000 : v));
    const sc = scen({ log: flat(), pre: steady(BASE), writers: [writer(TEST, A, 0, (_h, i) => thief[i]!)] });
    const ev = evaluate(sc);
    const a = ev.alerts.find((x) => x.code === "R1_NO_CANDIDATE")!;
    const dayEnd = (D + 1) * 2_400;
    expect((a.data as { vetoBy: number }).vetoBy).toBe(dayEnd + 2_400 - 600); // TEST: + 1,800 s
    expect(a.message).toContain(`may wait until ${dayEnd + 1_800}`);
    // a backfilled day: graceStart is the registration time
    const late = { ...sc, gpu: { ...sc.gpu, registeredAt: dayEnd + 5_000 } };
    expect((evaluate(late).alerts.find((x) => x.code === "R1_NO_CANDIDATE")!.data as { vetoBy: number }).vetoBy).toBe(dayEnd + 5_000 + 1_800);
  });

  test("the guardian view's step 3b deadline is the later of VETO_BY and the alert + GUARD_ACT", () => {
    const thief = BASE.map((v, i) => (i === 2 ? 4_500_000 : v));
    const sc = scen({ log: flat(), pre: steady(BASE), writers: [writer(TEST, A, 0, (_h, i) => thief[i]!)] });
    const vb = (D + 1) * 2_400 + 1_800;
    sc.alertRaisedAt = (D + 1) * 2_400 + 300; // + GUARD_ACT 600 = 900 < VETO_BY
    expect(evaluate(sc).guardian.stuck).toEqual({ vetoBy: vb, due: vb });
    sc.alertRaisedAt = vb; // a late alert: due at alert + GUARD_ACT
    expect(evaluate(sc).guardian.stuck).toEqual({ vetoBy: vb, due: vb + 600 });
    // a record R11 can sign is not stuck
    const ok = scen({ log: flat(), pre: steady(BASE), writers: [writer(TEST, A, 0, (_h, i) => BASE[i]!)], pendingNeedsSign: true });
    expect(evaluate(ok).guardian.stuck).toBeUndefined();
  });

  test("PRODUCTION, DEMO, FAST and TEST offsets (2.2's VETO_BY row)", () => {
    const at = (day: number) => vetoBy({ day, grace: day, reopenWait: day / 4, epochTs: 0, epochDay: 0 }, 0, 0) - day;
    expect([at(86_400), at(600), at(24), at(2_400)]).toEqual([64_800, 450, 18, 1_800]);
    expect(vetoDue(100, 50, 30)).toBe(100);
    expect(vetoDue(100, 90, 30)).toBe(120);
  });
});

// ------------------------------------------------------------------ 9.6 day labels

describe("9.6 dayLabel", () => {
  const rec = (status: number, dropped = false) => ({ status: status as never, dropped });
  test("every row of the table", () => {
    expect(dayLabel(null, false, 0, 10, 10)).toBe("open");
    expect(dayLabel(null, false, 0, 10, 12)).toBe("open");
    expect(dayLabel(null, false, 0, 10, 7)).toBe("skipped");
    expect(dayLabel(rec(Status.NONE), false, 0, 10, 7)).toBe("skipped");
    expect(dayLabel(rec(Status.FULL), false, 0, 10, 9)).toBe("pending");
    expect(dayLabel(rec(Status.DEMO), true, 0, 10, 8)).toBe("final");
    expect(dayLabel(rec(Status.CARRIED, true), true, 0, 10, 8)).toBe("carried, unverified"); // a dropped carry
    expect(dayLabel(rec(Status.CARRIED), true, 12_345, 10, 8)).toBe("carried, unverified"); // a carry after a veto
    expect(dayLabel(rec(Status.CARRIED), true, 0, 10, 8)).toBe("carried"); // no quorate data
  });

  test("on the fake index: a liveness-vetoed day reads carried, unverified; a no-data day carried", async () => {
    const pages = new Pages(BASE);
    const D0 = OCT1 + 2;
    const withhold = (d: number, _h: number, _t: number, v: number[]) => v.map((x, i) => (i === 4 && d >= D0 ? 0 : x));
    const w = new World({ firstDay: OCT1, pages: pages.fn, writers: [{ net: "w1", values: withhold, skip: (d) => d === OCT1 + 9 }], guardian: { delay: 200, looks: true } });
    await w.run((OCT1 + 12) * T);
    const label = async (d: number) => {
      const r = await w.chain.record(w.panel.gpuId, d);
      return dayLabel(r.exists ? r.rec : null, r.isFinal, await w.chain.reopenedAt(w.panel.gpuId, d), await w.chain.head(w.panel.gpuId), d);
    };
    expect(await label(OCT1)).toBe("final");
    expect(await label(D0 + 5)).toBe("carried, unverified"); // the exit day, vetoed by step 3b (J)
    expect(await label(OCT1 + 9)).toBe("carried"); // no posts at all
    expect(await label(OCT1 + 30)).toBe("open");
  });
});

// ------------------------------------------------------------------ owner actions and reader swaps

const OCT3 = parseAbi([
  "event ActionQueued(bytes32 indexed id, (uint8 kind, uint8 slot, address addr, bytes32 gpuId, uint32 day, uint8 mode) action, uint64 eta)",
  "event ActionExecuted(bytes32 indexed id, (uint8 kind, uint8 slot, address addr, bytes32 gpuId, uint32 day, uint8 mode) action)",
  "event ActionCancelled(bytes32 indexed id)",
  "event ReaderSwapQueued(bytes32 indexed id, bytes32 indexed gpuId, uint8 slot, string url, string parserVersion, string reason, uint64 eta)",
  "event ReaderSwapped(bytes32 indexed id, bytes32 indexed gpuId, uint8 slot, uint32 fromDay, bytes32 readerHash, string url, string parserVersion, string reason)",
  "event ReaderSwapCancelled(bytes32 indexed id, bytes32 indexed gpuId, uint8 slot)",
]);
const ID = `0x${"ab".repeat(32)}` as Hex;
const GPU = `0x${"12".repeat(32)}` as Hex;
const TX = `0x${"cd".repeat(32)}` as Hex;
const ACTION = { kind: 4, slot: 3, addr: "0x0000000000000000000000000000000000000000", gpuId: GPU, day: 20_788, mode: 0 } as const;

function logOf(eventName: string, args: Record<string, unknown>, data: { types: { type: string; components?: unknown }[]; values: unknown[] }): Log {
  const topics = encodeEventTopics({ abi: OCT3 as Abi, eventName, args } as never) as [Hex, ...Hex[]];
  return { address: "0x5FbDB2315678afecb367f032d93F642f64180aa3", blockNumber: 7n, logIndex: 2, transactionHash: TX, data: encodeAbiParameters(data.types as never, data.values as never), topics } as unknown as Log;
}
const ACTION_T = { type: "tuple", components: [{ name: "kind", type: "uint8" }, { name: "slot", type: "uint8" }, { name: "addr", type: "address" }, { name: "gpuId", type: "bytes32" }, { name: "day", type: "uint32" }, { name: "mode", type: "uint8" }] };

describe("the decoder: ActionExecuted, ActionCancelled and the three reader events (10)", () => {
  test("ActionQueued keeps every field; ActionExecuted and ActionCancelled decode with their id", () => {
    const q = decodeWallEvent(logOf("ActionQueued", { id: ID }, { types: [ACTION_T, { type: "uint64" }], values: [ACTION, 5_000n] }));
    expect(q).toMatchObject({ name: "ActionQueued", id: ID, eta: 5_000, kind: 4, slot: 3, actionGpuId: GPU, actionDay: 20_788, mode: 0, tx: TX, day: 0 });
    const x = decodeWallEvent(logOf("ActionExecuted", { id: ID }, { types: [ACTION_T], values: [ACTION] }));
    expect(x).toMatchObject({ name: "ActionExecuted", id: ID, kind: 4 });
    const c = decodeWallEvent(logOf("ActionCancelled", { id: ID }, { types: [], values: [] }));
    expect(c).toMatchObject({ name: "ActionCancelled", id: ID });
  });

  test("ReaderSwapQueued, ReaderSwapped and ReaderSwapCancelled decode with gpu, slot, url, parserVersion and reason", () => {
    const q = decodeWallEvent(logOf("ReaderSwapQueued", { id: ID, gpuId: GPU }, { types: [{ type: "uint8" }, { type: "string" }, { type: "string" }, { type: "string" }, { type: "uint64" }], values: [3, "https://lambda.ai/pricing", "lambda/2", "redesigned", 9_000n] }));
    expect(q).toMatchObject({ name: "ReaderSwapQueued", id: ID, gpuId: GPU, slot: 3, url: "https://lambda.ai/pricing", parserVersion: "lambda/2", reason: "redesigned", eta: 9_000 });
    const rh = readerHashOf("https://lambda.ai/pricing", "lambda/2");
    const s = decodeWallEvent(logOf("ReaderSwapped", { id: ID, gpuId: GPU }, { types: [{ type: "uint8" }, { type: "uint32" }, { type: "bytes32" }, { type: "string" }, { type: "string" }, { type: "string" }], values: [3, 20_800, rh, "https://lambda.ai/pricing", "lambda/2", "redesigned"] }));
    expect(s).toMatchObject({ name: "ReaderSwapped", gpuId: GPU, slot: 3, fromDay: 20_800, readerHash: rh, parserVersion: "lambda/2", reason: "redesigned" });
    const c = decodeWallEvent(logOf("ReaderSwapCancelled", { id: ID, gpuId: GPU }, { types: [{ type: "uint8" }], values: [3] }));
    expect(c).toMatchObject({ name: "ReaderSwapCancelled", id: ID, gpuId: GPU, slot: 3 });
  });

  test("ids: READER_SWAP_TAG, actionId and readerSwapId follow 4.11 and 4.15", () => {
    expect(READER_SWAP_TAG).toBe(keccak256(toHex("agate.ReaderSwap.v1")));
    expect(READER_SWAP_TAG).toBe(REPORT_TAG);
    expect(actionIdOf(ACTION)).toBe(keccak256(encodeAbiParameters([ACTION_T as never], [ACTION] as never)));
    expect(readerSwapIdOf(GPU, 3, "https://a.example/x", "a/2")).toBe(
      keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }, { type: "bytes32" }], [READER_SWAP_TAG, GPU, 3, keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }], ["https://a.example/x", "a/2"]))])),
    );
    // the merged ABI knows queuedEta and every Oct 3 event exactly once
    for (const n of ["queuedEta", "ActionExecuted", "ActionCancelled", "ReaderSwapQueued", "ReaderSwapped", "ReaderSwapCancelled"]) expect(WATCHER_ABI.filter((x) => "name" in x && x.name === n).length).toBe(1);
  });
});

describe("live owner entries (queuedEta != 0) on the fake index", () => {
  test("queued, executed, cancelled and expired entries", async () => {
    const w = new World({ firstDay: OCT1, pages: new Pages(BASE).fn, writers: [{ net: "w1" }], guardian: null });
    const now = w.now;
    const win = ACTION_WINDOW_DAYS * T;
    const a1 = { ...ACTION, gpuId: w.panel.gpuId, kind: 0, slot: 1, addr: "0x00000000000000000000000000000000000000a1" as const, day: 0 };
    const a2 = { ...a1, addr: "0x00000000000000000000000000000000000000a2" as const };
    const a3 = { ...a1, addr: "0x00000000000000000000000000000000000000a3" as const };
    w.m.queueAction(a1, now);
    w.m.queueAction(a2, now);
    w.m.queueAction(a3, now);
    w.m.queueReaderSwap(w.panel.gpuId, 2, "https://s2.example/v2", "s2/2", "page moved", now);
    w.m.executeAction(a2, now + 2 * T);
    w.m.cancelAction(a3, now + 10);
    const at = now + 2 * T + 100;
    const xs = await ownerEntries(w.chain.all(), async (id) => w.m.queuedEta(id, at), T, at);
    expect(xs.map((x) => [x.type, x.state, x.type === "action" ? x.action!.addr : x.reader!.url])).toEqual([
      ["action", "executable", a1.addr],
      ["reader", "executable", "https://s2.example/v2"],
    ]);
    expect(xs[0]!.windowEnd).toBe(now + 2 * T + win);
    const later = now + 2 * T + win + 1;
    const ys = await ownerEntries(w.chain.all(), async (id) => w.m.queuedEta(id, later), T, later);
    expect(ys.map((x) => x.state)).toEqual(["expired", "expired"]);
  });

  test("the attester raises an action alert per ReaderSwapQueued (deadline eta), READER_MISSING or READER_REFUSED, and an info once a window passes", async () => {
    const w = new World({ firstDay: OCT1, pages: new Pages(BASE).fn, writers: [{ net: "w1" }], attester: false, guardian: null });
    const alerts = new AlertSink(null, { now: () => w.now, print: false });
    const att = new Attester({ view: w.chain, events: w.chain, log: w.log, alerts, sender: w.chain.sender(ATTESTER), clock: w.c, panels: [w.panel], decisionsPath: null, tickS: 10, readerCheck: (_s, r) => (r.parserVersion.endsWith("/9") ? "missing" : r.url.includes("evil") ? "refused" : "ok") });
    await att.tick(w.now);
    const id = w.m.queueReaderSwap(w.panel.gpuId, 1, "https://s1.example/v2", "s1/9", "redesign", w.now);
    w.m.queueReaderSwap(w.panel.gpuId, 3, "https://evil.example/x", "s3/2", "?", w.now);
    await att.tick(w.now + 1);
    const swaps = alerts.open().filter((a) => a.code === AlertCode.ONCHAIN_EVENT && a.severity === "action");
    expect(swaps.map((a) => [a.slot, a.deadline])).toEqual([[1, w.now + w.c.timelock], [3, w.now + w.c.timelock]]);
    expect(swaps[0]!.message).toContain("check you queued this");
    expect(alerts.open().filter((a) => a.code === AlertCode.READER_MISSING).map((a) => a.slot)).toEqual([1]);
    expect(alerts.open().filter((a) => a.code === AlertCode.READER_REFUSED).map((a) => a.slot)).toEqual([3]);
    // executed: the action alert gives way to an info naming the fromDay
    w.m.executeReaderSwap(w.panel.gpuId, 1, "https://s1.example/v2", "s1/9", w.now + w.c.timelock);
    await att.tick(w.now + w.c.timelock + 1);
    expect(alerts.open().some((a) => a.code === AlertCode.ONCHAIN_EVENT && a.severity === "action" && (a.data as { id?: string }).id === id)).toBe(false);
    expect(alerts.open().some((a) => a.code === AlertCode.ONCHAIN_EVENT && a.message.startsWith("reader swap executed"))).toBe(true);
    // the other one passes its window unexecuted
    await att.tick(w.now + w.c.timelock + ACTION_WINDOW_DAYS * T + 5);
    expect(alerts.open().filter((a) => (a.data as { expired?: boolean } | undefined)?.expired).length).toBe(1);
  });
});

// ------------------------------------------------------------------ 13.7 two indexes side by side

describe("13.7: two indexes in one home", () => {
  const I1 = "0xAAAAAAAA00000000000000000000000000000001";
  const I2 = "0xBBBBBBBB00000000000000000000000000000002";
  test("decisions and guardian logs are per index; neither reads the other's", () => {
    const home = mkdtempSync(join(tmpdir(), "agate-two-"));
    expect(decisionsPath(home, I1)).toBe(join(home, "attester", "decisions-aaaaaaaa.jsonl"));
    expect(decisionsPath(home, I2)).toBe(join(home, "attester", "decisions-bbbbbbbb.jsonl"));
    const g1 = new GuardianLog(guardianLogDir(home, I1));
    const g2 = new GuardianLog(guardianLogDir(home, I2));
    g1.addLook({ gpu: "H100", gpuId: GPU, sourceId: "p_a", interval: 1, at: 1, state: "FAILED", valueU: 0, region: "writer", writerRegion: true });
    g1.addSignature({ gpuId: GPU, day: 20_730, writer: A, digest: ID, rule: "R11", at: 2 });
    expect(g1.looks(GPU).length).toBe(1);
    expect(g2.looks(GPU)).toEqual([]);
    expect(g2.handSigned(GPU, 20_730)).toBe(false);
    expect(readdirSync(join(home, "guardian"))).toEqual([I1.toLowerCase()]);
    expect(oldGuardianLogWarning(home)).toBeNull();
    new GuardianLog(join(home, "guardian")).addLook({ gpu: "H100", gpuId: GPU, sourceId: "p_a", interval: 1, at: 1, state: "VALID", valueU: 1, region: "x", writerRegion: false });
    expect(oldGuardianLogWarning(home)).toContain("ignoring the shared guardian log files looks.jsonl");
  });

  test("every watcher launchd template's Label and log paths carry __INDEX8__", () => {
    const dir = join(import.meta.dir, "..", "launchd");
    const tpls = readdirSync(dir).filter((f) => f.endsWith(".plist.template"));
    expect(tpls.length).toBeGreaterThan(0);
    for (const f of tpls) {
      const s = readFileSync(join(dir, f), "utf8");
      const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(s)![1]!;
      expect(label).toBe("xyz.s0nderlabs.agate-watcher-__ROLE__-__INDEX8__");
      expect(s).toContain("__ROLE__-__INDEX8__.stdout.log");
      expect(s).toContain("__ROLE__-__INDEX8__.stderr.log");
      expect(s).toContain("<key>AGATE_RPC_URLS_CMD</key>");
      expect(s).not.toContain("__RPC_URLS__<");
    }
  });

  test("two sender processes on one key (two indexes) never reuse a nonce: the send lock", async () => {
    const KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"; // anvil #5, never on a public chain
    process.env.AGATE_TEST_LOCK_KEY = KEY;
    const from = privateKeyToAccount(KEY).address;
    // a fake chain that counts nonces: a raw transaction with a used nonce is refused
    const chain = { mined: new Map<number, Hex>(), reused: 0 };
    const client = {
      getChainId: async () => 31_337,
      getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
      call: async () => ({ data: "0x" }),
      estimateGas: async () => 50_000n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }),
      getTransactionCount: async () => {
        await Bun.sleep(20); // both read before either sends, without the lock
        return chain.mined.size;
      },
      request: async ({ params }: { params: [Hex] }) => {
        const tx = parseTransaction(params[0]);
        await Bun.sleep(30);
        if (chain.mined.has(tx.nonce!)) {
          chain.reused++;
          throw new Error("nonce too low");
        }
        chain.mined.set(tx.nonce!, keccak256(params[0]));
        return keccak256(params[0]);
      },
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        if (![...chain.mined.values()].includes(hash)) throw Object.assign(new Error("could not be found"), { name: "TransactionReceiptNotFound" });
        return { status: "success" };
      },
    } as unknown as PublicClient;
    const home = mkdtempSync(join(tmpdir(), "agate-lock-"));
    const mk = async (role: string, lock: boolean) => {
      const pool = await RpcPool.create({ urls: [`http://${role}`, `http://${role}-b`], timeoutMs: 100, staleS: 60, role, now: () => Math.floor(Date.now() / 1000), clientFor: () => client });
      const ping: Abi = [{ type: "function", name: "ping", inputs: [], outputs: [], stateMutability: "nonpayable" }];
      return new TxSender({ pool, to: "0x00000000000000000000000000000000000000E0", keyEnv: "AGATE_TEST_LOCK_KEY", role, abi: ping, now: () => Math.floor(Date.now() / 1000), pollMs: 10, ...(lock ? { lock: new SendLock(keyLockPath(home, from), 5_000) } : {}) });
    };
    // with the lock (one SendLock per process, each its own open file description): no reuse, nonces 0..5
    const [a, b] = [await mk("index-a", true), await mk("index-b", true)];
    const res = await Promise.all([a.send("ping", []), b.send("ping", []), a.send("ping", []), b.send("ping", []), a.send("ping", []), b.send("ping", [])]);
    expect(res.every((r) => r.ok)).toBe(true);
    expect(chain.reused).toBe(0);
    expect([...chain.mined.keys()].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(readFileSync(keyLockPath(home, from), "utf8")).toContain('"use":"send"');
    // negative control: the same two senders without the lock collide on a nonce
    chain.mined.clear();
    const [c, e] = [await mk("index-c", false), await mk("index-e", false)];
    await Promise.all([c.send("ping", []), e.send("ping", [])]);
    expect(chain.reused).toBeGreaterThan(0);
    delete process.env.AGATE_TEST_LOCK_KEY;
  });

  test("the attester treats a busy key as transient: no R1_NO_CANDIDATE, the pick note kept, the next tick retries", async () => {
    const pages = new Pages(BASE, BASE.map((b, i) => ({ slot: i, at: (OCT1 + 2) * T, v: b + 600_000 })));
    const w = new World({ firstDay: OCT1, pages: pages.fn, writers: [{ net: "w1" }], attester: { down: (t) => t >= (OCT1 + 2) * T }, guardian: null });
    await w.run((OCT1 + 3) * T + 500);
    const g = w.m.g(w.panel.gpuId);
    const d = g.head - 1;
    expect(g.records.get(d)!.needsSign).toBe(true);
    const alerts = new AlertSink(null, { now: () => w.now, print: false });
    const real = w.chain.sender(ATTESTER);
    let busy = true;
    const sender = { from: real.from, simulate: real.simulate, send: async (fn: never, args: readonly unknown[]) => (busy ? { ok: false, sent: false, error: "key busy: another process holds the send lock" } : real.send(fn, args)) };
    const home = mkdtempSync(join(tmpdir(), "agate-busy-"));
    const pick = join(home, "pick.json");
    const att = new Attester({ view: w.chain, events: w.chain, log: w.log, alerts, sender, clock: w.c, panels: [w.panel], decisionsPath: null, pickPath: () => pick, tickS: 10 });
    await att.tick(w.now);
    expect(alerts.open().some((a) => a.code === AlertCode.R1_NO_CANDIDATE)).toBe(false);
    expect(readFileSync(pick, "utf8")).toContain(g.records.get(d)!.digest);
    expect(g.records.get(d)!.attestedAt).toBe(0);
    busy = false;
    await att.tick(w.now + 1); // same interval: retried at once
    expect(g.records.get(d)!.attestedBy).toBe(ATTESTER);
  });

  test("a lock held elsewhere past its wait gives up that send without sending", async () => {
    const home = mkdtempSync(join(tmpdir(), "agate-lock2-"));
    const p = keyLockPath(home, "0x00000000000000000000000000000000000000aa");
    const other = new SendLock(p, 10);
    expect(await other.acquire()).not.toBeNull();
    const mine = new SendLock(p, 150);
    const t0 = Date.now();
    expect(await mine.acquire()).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    other.release();
    expect(await mine.acquire()).toEqual({ otherHolder: true });
    mine.release();
    expect(await mine.acquire()).toEqual({ otherHolder: false }); // nobody else held it since
    mine.release();
  });
});

// ------------------------------------------------------------------ 9.5 health

describe("9.5: health watches the page check, the repair agent and the Akash reader", () => {
  test("their heartbeats and periods; AGATE_HEALTH_EXTRA can leave them out", () => {
    const w = { home: "/h", index: "0xAbCdEf0100000000000000000000000000000001", dir: "/h/watcher/x", logDir: "/h/watcher/x", clock: { slice: 150, keeperPeriod: 50 } } as never;
    const saved = process.env.AGATE_HEALTH_EXTRA;
    delete process.env.AGATE_HEALTH_EXTRA;
    const rb = roleBeats(w);
    expect(rb.filter((r) => ["pagecheck", "repair", "akash"].includes(r.role))).toEqual([
      { role: "pagecheck", path: "/h/pagecheck/heartbeat-abcdef01.json", periodS: 150 },
      { role: "repair", path: "/h/repair/heartbeat.json", periodS: 3_600 },
      { role: "akash", path: "/h/akash/heartbeat.json", periodS: 3_600 },
    ]);
    process.env.AGATE_HEALTH_EXTRA = "repair";
    expect(roleBeats(w).map((r) => r.role)).toEqual(["log", "attest", "keep", "primary", "standby", "repair"]);
    if (saved === undefined) delete process.env.AGATE_HEALTH_EXTRA;
    else process.env.AGATE_HEALTH_EXTRA = saved;
  });
});

// ------------------------------------------------------------------ 13.6 websocket wake (a local mock server)

interface MockWs {
  url: string;
  sockets: Set<{ send: (s: string) => void; close: () => void }>;
  subs: string[];
  refuseMonad: boolean;
  stop: () => void;
}
function mockWsServer(): MockWs {
  const m: MockWs = { url: "", sockets: new Set(), subs: [], refuseMonad: false, stop: () => {} };
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("ws only", { status: 400 });
    },
    websocket: {
      open(ws) {
        m.sockets.add(ws);
      },
      message(ws, msg) {
        const j = JSON.parse(String(msg)) as { id: number; method: string; params: unknown[] };
        if (j.method !== "eth_subscribe") return;
        const name = String(j.params[0]);
        if (m.refuseMonad && name.startsWith("monad")) {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: j.id, error: { code: -32601, message: "unsupported" } }));
          return;
        }
        m.subs.push(name);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: `0xsub${m.subs.length}` }));
      },
      close(ws) {
        m.sockets.delete(ws);
      },
    },
  });
  m.url = `ws://127.0.0.1:${server.port}/v2/FAKEWSKEY000111222333`;
  m.stop = () => server.stop(true);
  return m;
}
const notify = (m: MockWs) => {
  for (const s of m.sockets) s.send(JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription: "0xsub1", result: { address: "0x5FbDB2315678afecb367f032d93F642f64180aa3", topics: [], data: "0x", blockNumber: "0x10", commitState: "Proposed" } } }));
};
const until = async (f: () => boolean, ms = 3_000) => {
  const t = Date.now() + ms;
  while (!f() && Date.now() < t) await Bun.sleep(10);
  return f();
};

describe("13.6 websocket wake-ups (monadLogs) with polling as the fallback", () => {
  test("a notification makes the next tick run at once (debounced to one per second)", async () => {
    const m = mockWsServer();
    const waker = new Waker();
    let wakes = 0;
    const ws = new WsWake({ urls: [m.url], address: "0x5FbDB2315678afecb367f032d93F642f64180aa3", onWake: () => (wakes++, waker.wake()), role: "attest" });
    ws.start();
    expect(await until(() => ws.live)).toBe(true);
    expect(m.subs).toEqual(["monadLogs"]);
    const t0 = Date.now();
    const slept = waker.wait(30_000); // a 30 s poll period
    notify(m);
    await slept;
    expect(Date.now() - t0).toBeLessThan(2_000);
    notify(m);
    notify(m);
    await Bun.sleep(100);
    expect([wakes, ws.notifications]).toEqual([1, 3]);
    ws.stop();
    m.stop();
  });

  test("a speculative log that never reaches HTTP changes nothing: the tick reads the chain as without it", async () => {
    const pages = new Pages(BASE, BASE.map((b, i) => ({ slot: i, at: (OCT1 + 2) * T, v: b + 600_000 })));
    const w = new World({ firstDay: OCT1, pages: pages.fn, writers: [{ net: "w1" }], attester: false, guardian: null });
    await w.run((OCT1 + 1) * T + 500);
    const alerts = new AlertSink(null, { now: () => w.now, print: false });
    const att = new Attester({ view: w.chain, events: w.chain, log: w.log, alerts, sender: w.chain.sender(ATTESTER), clock: w.c, panels: [w.panel], decisionsPath: null, tickS: 10 });
    await att.tick(w.now);
    const before = { decisions: att.decisions.length, alerts: alerts.all().length, events: w.chain.all().length };
    const m = mockWsServer();
    let woke = 0;
    const ws = new WsWake({ urls: [m.url], address: w.m.address, onWake: () => woke++, role: "attest" });
    ws.start();
    await until(() => ws.live);
    notify(m); // a Proposed block's log the chain never finalizes
    await until(() => woke > 0);
    await att.tick(w.now + 1); // the woken tick
    expect({ decisions: att.decisions.length, alerts: alerts.all().length, events: w.chain.all().length }).toEqual(before);
    ws.stop();
    m.stop();
  });

  test("a dropped socket falls back to polling and reconnects with a doubling backoff; RPC_WS_DOWN after 3 ticks", async () => {
    const m = mockWsServer();
    const alerts = new AlertSink(null, { now: () => 0, print: false });
    const events: string[] = [];
    const ws = new WsWake({ urls: [m.url], address: "0x5FbDB2315678afecb367f032d93F642f64180aa3", onWake: () => {}, role: "keep", alerts, minBackoffMs: 50, maxBackoffMs: 400, log: (e, d) => events.push(`${e} ${JSON.stringify(d)}`) });
    ws.start();
    expect(await until(() => ws.live)).toBe(true);
    for (const s of m.sockets) s.close(); // the server drops the socket
    expect(await until(() => !ws.live)).toBe(true);
    for (let i = 0; i < 2; i++) ws.tick();
    expect(alerts.open().some((a) => a.code === AlertCode.RPC_WS_DOWN)).toBe(false);
    expect(await until(() => ws.live && ws.connects === 2)).toBe(true); // reconnected and subscribed again
    ws.tick();
    expect(alerts.open().some((a) => a.code === AlertCode.RPC_WS_DOWN)).toBe(false);
    m.stop(); // gone for good: retries back off, polling carries on
    expect(await until(() => !ws.live)).toBe(true);
    for (let i = 0; i < 3; i++) ws.tick();
    const down = alerts.open().filter((a) => a.code === AlertCode.RPC_WS_DOWN);
    expect(down.length).toBe(1);
    expect(down[0]!.severity).toBe("info");
    // URLs are secrets: neither the alert nor a log line carries the key
    expect(JSON.stringify(down)).not.toContain("FAKEWSKEY000111222333");
    expect(events.join("\n")).not.toContain("FAKEWSKEY000111222333");
    await Bun.sleep(450);
    // the first drop waits 50 ms; a live subscription resets the backoff; the dead server then doubles it to the cap
    const waits = events.filter((e) => e.startsWith("ws_down")).map((e) => (JSON.parse(e.slice(8)) as { retryMs: number }).retryMs);
    expect(waits.slice(0, 4)).toEqual([50, 50, 100, 200]);
    ws.stop();
  });

  test("a node that refuses monadLogs gets the finalized logs subscription", async () => {
    const m = mockWsServer();
    m.refuseMonad = true;
    const ws = new WsWake({ urls: [m.url], address: "0x5FbDB2315678afecb367f032d93F642f64180aa3", onWake: () => {}, role: "attest" });
    ws.start();
    expect(await until(() => ws.live)).toBe(true);
    expect(m.subs).toEqual(["logs"]);
    ws.stop();
    m.stop();
  });
});
