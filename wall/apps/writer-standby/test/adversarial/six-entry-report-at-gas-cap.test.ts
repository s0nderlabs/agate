// A six-entry report at the edge of the gas rule (wall spec 18.4 and 18.6, rule 13.4: limit min(CAP, ceil(1.5 x
// max(estimate, MEASURED))), CAP = 2 x MEASURED, refused with GAS_CAP above it). On a private anvil with the real
// AgateIndex and the launch panel's six GPUs plus two sets of six GPUs of 15 slots (the contract's worst case):
// - MEASURED postReport (994,276, a receipt on the PRODUCTION clock) is the worst cold six-entry shape only to within
//   calldata and clock: either writer, the TEST clock, prices of four nonzero bytes ($16.78 and up) cost a little more,
//   and every such shape is still sent and lands (1.5 x MEASURED and the CAP hold them with room);
// - a cold 6 x 15 report sent at exactly its CAP lands with every GPU's bit, and one MEASURED step lower is refused
//   before anything is signed (the boundary is need > CAP, not >=);
// - the operator's launch-panel overrides of 18.6 (AGATE_GAS_POST 619,063, AGATE_GAS_ONREPORT 672,000) carry the
//   launch report, while a report with more slots is refused loudly on the direct path (GAS_CAP, no nonce used) and
//   lands nothing through the CRE path's forwarder (its try/catch eats the out-of-gas), which a repost at the
//   published MEASURED then repairs; and those overrides, being anvil figures, leave an RPC's estimate only a third
//   of headroom before GAS_CAP. Local anvil only (anvil-safe); skips without anvil or a forge build.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeReport, makeReport } from "@agate/report";
import { agateIndexAbi } from "@agate/report/abi";
import type { Entry, Hex, Readings } from "@agate/report/types";
import { encodeFunctionData, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AlertFn } from "../../src/pipeline/rpc.ts";
import { ReadingLog } from "../../src/pipeline/log.ts";
import { RpcPool } from "../../src/pipeline/rpc.ts";
import { gasLimitFor, MEASURED, TxSender } from "../../src/pipeline/sender.ts";
import { ADDR, type Anvil, type Deployed, deployIndex, haveAnvil, KEYS, LAUNCH_PANELS_FILE, MOCK_FORWARDER_ABI, SELECTOR, startAnvil, warp } from "../helpers/anvil.ts";

const D = 20_727;
const SLICE = 200; // TEST profile: 12 slices of 200 s
const FORWARDED = keccak256(toBytes("Forwarded(address,bool,bytes)"));
/** 18.6's launch-panel overrides, as the operator would set them. */
const LAUNCH_POST = 619_063n;
const LAUNCH_ONREPORT = 672_000n;
const set = (tag: string) => Array.from({ length: 6 }, (_, i) => keccak256(toBytes(`${tag}-${i}/15-slots-15-families`)));
const WORST_A = set("cap-a");
const WORST_B = set("cap-b");
const WORST_C = set("cap-c");
const WORST_D = set("cap-d");

let a: Anvil;
let dep: Deployed;
let home: string;
let launch: { gpuId: Hex; n: number }[] = [];

beforeAll(async () => {
  if (!haveAnvil) return;
  a = await startAnvil();
  dep = await deployIndex(a, { panelsFile: LAUNCH_PANELS_FILE }); // the launch panel's six GPUs, a MockForwarder
  launch = dep.panels.map((p) => ({ gpuId: p.gpuId as Hex, n: p.slots.length }));
  const fam = Array.from({ length: 15 }, (_, k) => k);
  const w = a.wallet(0);
  for (const g of [...WORST_A, ...WORST_B, ...WORST_C, ...WORST_D]) {
    const hash = await w.writeContract({ address: dep.index, abi: agateIndexAbi, functionName: "registerGpu", args: [g, keccak256(g), fam, fam.map(() => 1), D, 2 ** 15 - 1], account: w.account!, chain: w.chain });
    expect((await a.pub.waitForTransactionReceipt({ hash })).status).toBe("success");
  }
  await warp(a, dep.epochTs + 30); // slice 0 of day D: every writer's accumulators are new storage (cold)
  home = mkdtempSync(join(tmpdir(), "agate-gas-cap-"));
}, 180_000);
afterAll(() => {
  a?.stop();
  if (home) rmSync(home, { recursive: true, force: true }); // this test's own temp dir only
});

/** Values on the cent grid: $3.99 and up by default (three nonzero bytes each), or from `base`. */
function report(gpus: readonly { gpuId: Hex; n: number }[], h: number, base = 3_990_000): Hex {
  const entries: Entry[] = gpus.map(({ gpuId, n }) => ({ gpuId, dayId: D, slice: h, readAt: BigInt(dep.epochTs + h * SLICE + 1), values: Array.from({ length: n }, (_, k) => base + k * 10_000) }));
  return encodeReport(makeReport(SELECTOR, dep.index, entries));
}
const worst = (ids: readonly Hex[]) => ids.map((gpuId) => ({ gpuId, n: 15 }));
const post = (rep: Hex) => encodeFunctionData({ abi: agateIndexAbi, functionName: "postReport", args: [rep] });
const bits = async (g: Hex, who: number) => ((await a.pub.readContract({ address: dep.index, abi: agateIndexAbi, functionName: "readings", args: [g, D, ADDR[who]!] })) as Readings).sliceBits;
/** The day's last slice (11): a test that runs alone still finds the chain there. */
const toLastSlice = () => warp(a, dep.epochTs + 11 * SLICE + 30);
const nonceOf = (who: number) => a.pub.getTransactionCount({ address: ADDR[who]!, blockTag: "pending" });

async function sender(who: 1 | 2, measured: Partial<Record<"postReport" | "closeDay" | "onReport", bigint>> = {}) {
  const pool = new RpcPool({ urls: [a.rpc], timeoutMs: 2_000, staleS: 10_000_000 });
  await pool.init();
  const alerts: Parameters<AlertFn>[0][] = [];
  const log = new ReadingLog(mkdtempSync(join(home, `w${who}-`)), who === 1 ? "primary" : "standby");
  const s = new TxSender({ pool, account: privateKeyToAccount(KEYS[who]), index: dep.index, journal: log, timing: { pollMs: 20, rebroadcastMs: 2_000, replaceMs: 6_000, waitMs: 5_000, lockWaitMs: 1_000 }, alert: (x) => alerts.push(x), measured });
  return { s, alerts };
}

describe.skipIf(!haveAnvil)("a six-entry report at the gas cap", () => {
  test("MEASURED postReport is the worst cold shape to within calldata and clock; every cold six-entry shape is sent and lands", async () => {
    const shapes: { name: string; used: bigint; est: bigint }[] = [];
    const send = async (name: string, who: 1 | 2, ids: readonly Hex[], h: number, base?: number) => {
      const w = a.wallet(who);
      const data = post(report(worst(ids), h, base));
      const est = await a.pub.estimateGas({ account: ADDR[who]!, to: dep.index, data });
      const g = gasLimitFor(est, MEASURED.postReport);
      expect(g.ok).toBe(true); // the sender sends it: 1.5 x the estimate is under the CAP
      const hash = await w.sendTransaction({ to: dep.index, data, gas: g.ok ? g.limit : 0n, account: w.account!, chain: w.chain });
      const rc = await a.pub.waitForTransactionReceipt({ hash });
      expect(rc.status).toBe("success");
      shapes.push({ name, used: rc.gasUsed, est });
    };
    await send("standby cold, $3.99 and up", 2, WORST_C, 0);
    await send("primary cold, $3.99 and up", 1, WORST_C, 0);
    await send("standby cold, $999.99 and down (four nonzero bytes a value)", 2, WORST_D, 0, 999_990_000 - 14 * 10_000);
    await toLastSlice(); // the same day's last slice: warm accumulators, a new bit
    await send("standby warm", 2, WORST_C, 11);
    console.log(`6 x 15 postReport on the TEST clock: ${shapes.map((x) => `${x.name}: used ${x.used}, estimate ${x.est}`).join("; ")}; MEASURED ${MEASURED.postReport}`);
    for (const x of shapes) {
      expect(x.used <= (3n * MEASURED.postReport) / 2n).toBe(true); // a limit taken from MEASURED alone still lands it
      expect(x.used - MEASURED.postReport < 2_000n).toBe(true); // any overshoot is calldata and clock, not storage
    }
    for (const g of WORST_C) expect(await bits(g, 2)).toBe(1n + 2n ** 11n);
    for (const g of WORST_D) expect(await bits(g, 2)).toBe(1n);
  }, 120_000);

  test("a cold 6 x 15 report sent at exactly its CAP lands every entry; one gas of MEASURED less and it is refused unsigned", async () => {
    await toLastSlice();
    const data = post(report(worst(WORST_A), 11));
    const est = await a.pub.estimateGas({ account: ADDR[2]!, to: dep.index, data });
    const need = (3n * est + 1n) / 2n;
    // the smallest MEASURED whose CAP (2 x MEASURED) still holds 1.5 x this estimate: the send goes out at the CAP
    const atCap = (need + 1n) / 2n;
    expect(gasLimitFor(est, atCap)).toEqual({ ok: true, limit: need, cap: 2n * atCap });
    expect(gasLimitFor(est, atCap - 1n).ok).toBe(false);

    const below = await sender(2, { postReport: atCap - 1n });
    const n0 = await nonceOf(2);
    const r0 = await below.s.send({ to: dep.index, data, shape: "postReport", meta: { action: "post", tags: ["cap-1"] } });
    expect(r0).toMatchObject({ ok: false, sent: false });
    expect(r0.error).toMatch(/^GAS_CAP/);
    expect(below.alerts.map((x) => x.code)).toEqual(["GAS_CAP"]);
    expect(await nonceOf(2)).toBe(n0); // nothing signed, no nonce used
    for (const g of WORST_A) expect(await bits(g, 2)).toBe(0n);

    const at = await sender(2, { postReport: atCap });
    const r1 = await at.s.send({ to: dep.index, data, shape: "postReport", meta: { action: "post", tags: ["cap"] } });
    expect(r1.ok).toBe(true);
    expect(r1.gasLimit).toBe(need); // 1.5 x the estimate, which is the CAP here (to one gas)
    expect(2n * atCap - need <= 1n).toBe(true);
    expect((await a.pub.getTransaction({ hash: r1.txHash! })).gas).toBe(need);
    for (const g of WORST_A) expect(await bits(g, 2)).toBe(2n ** 11n);
    expect(at.alerts).toEqual([]);
  }, 120_000);

  test("18.6's launch overrides: the launch report lands; a report with more slots is GAS_CAP on the direct path, never sent", async () => {
    await toLastSlice();
    const { s, alerts } = await sender(2, { postReport: LAUNCH_POST });
    const n0 = await nonceOf(2);
    const big = await s.send({ to: dep.index, data: post(report(worst(WORST_B), 11)), shape: "postReport", meta: { action: "post", tags: ["big"] } });
    expect(big).toMatchObject({ ok: false, sent: false });
    expect(alerts.map((x) => x.code)).toEqual(["GAS_CAP"]);
    expect(await nonceOf(2)).toBe(n0);
    for (const g of WORST_B) expect(await bits(g, 2)).toBe(0n);

    const ok = await s.send({ to: dep.index, data: post(report(launch, 11)), shape: "postReport", meta: { action: "post", tags: ["launch"] } });
    expect(ok.ok).toBe(true);
    const g = gasLimitFor(LAUNCH_POST, LAUNCH_POST);
    expect(ok.gasLimit! >= (g.ok ? g.limit : 0n)).toBe(true); // at least 1.5 x the override (928,595)
    expect(ok.gasLimit! <= 2n * LAUNCH_POST).toBe(true);
    console.log(`launch report, standby, cold: limit ${ok.gasLimit}, used ${ok.gasUsed} (override ${LAUNCH_POST})`);
    for (const { gpuId } of launch) expect(await bits(gpuId, 2)).toBe(2n ** 11n);
    // The override is an anvil figure and the CAP refuses any estimate above 4/3 of it: an RPC that estimates this same
    // report a third higher (13.4: anvil has run 15 to 45 percent under Monad) is refused. Measure it where it is used.
    const est = await a.pub.estimateGas({ account: ADDR[2]!, to: dep.index, data: post(report(launch, 11)) }); // warm now; the cold one was about the override
    expect(gasLimitFor((LAUNCH_POST * 134n) / 100n, LAUNCH_POST).ok).toBe(false);
    expect(gasLimitFor((LAUNCH_POST * 133n) / 100n, LAUNCH_POST).ok).toBe(true);
    expect(est < LAUNCH_POST).toBe(true);
  }, 120_000);

  test("18.6's launch overrides on the CRE path: the launch report lands; 6 x 15 at 1,008,000 lands nothing, the published repost repairs it", async () => {
    await toLastSlice();
    const w = a.wallet(1); // the primary, tx.origin in TX_ORIGIN mode
    const cre = gasLimitFor(LAUNCH_ONREPORT, LAUNCH_ONREPORT);
    expect(cre).toEqual({ ok: true, limit: 1_008_000n, cap: 1_344_000n });
    const forward = async (rep: Hex) => {
      const hash = await w.sendTransaction({ to: dep.forwarder, data: encodeFunctionData({ abi: MOCK_FORWARDER_ABI, functionName: "forward", args: [dep.index, "0x", rep] }), gas: cre.ok ? cre.limit : 0n, account: w.account!, chain: w.chain });
      const rc = await a.pub.waitForTransactionReceipt({ hash });
      const log = rc.logs.find((l) => l.topics[0] === FORWARDED);
      return { status: rc.status, landed: log ? BigInt(log.data.slice(0, 66)) === 1n : false };
    };
    expect(await forward(report(launch, 11))).toEqual({ status: "success", landed: true });
    for (const { gpuId } of launch) expect(await bits(gpuId, 1)).toBe(2n ** 11n);

    expect(await forward(report(worst(WORST_B), 11))).toEqual({ status: "success", landed: false }); // a "successful" transaction that wrote nothing
    for (const g of WORST_B) expect(await bits(g, 1)).toBe(0n);
    // the runner reads the bits back and reposts through postReport at the published MEASURED: every entry lands
    const { s } = await sender(1);
    const rep = await s.send({ to: dep.index, data: post(report(worst(WORST_B), 11)), shape: "postReport", meta: { action: "repost", tags: ["repost"] } });
    expect(rep.ok).toBe(true);
    for (const g of WORST_B) expect(await bits(g, 1)).toBe(2n ** 11n);
  }, 120_000);
});
