// A report carries one entry per registered GPU, so six since the price-only GPUs (wall spec 18.4). The gas rule's
// MEASURED for reports is the six-entry worst case (15 slots in 15 families per GPU, a writer's first slice of a day):
// such a report must pass the direct path's cap and land through the CRE path's forwarder at the runner's limit,
// where the three-entry limit of before ran out inside the forwarder's try/catch. Local anvil only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeReport, makeReport } from "@agate/report";
import { agateIndexAbi } from "@agate/report/abi";
import type { Entry, Hex, Readings } from "@agate/report/types";
import { encodeFunctionData, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ReadingLog } from "../src/pipeline/log.ts";
import { RpcPool } from "../src/pipeline/rpc.ts";
import { gasLimitFor, MEASURED, TxSender } from "../src/pipeline/sender.ts";
import { ADDR, type Anvil, type Deployed, deployIndex, haveAnvil, KEYS, MOCK_FORWARDER_ABI, SELECTOR, startAnvil, warp } from "./helpers/anvil.ts";

const D = 20_727;
const SLICE = 200; // TEST profile
const WORST = Array.from({ length: 6 }, (_, i) => keccak256(toBytes(`worst-${i}/15-slots-15-families`)));
const FORWARDED = keccak256(toBytes("Forwarded(address,bool,bytes)"));

let a: Anvil;
let dep: Deployed;

beforeAll(async () => {
  if (!haveAnvil) return;
  a = await startAnvil();
  dep = await deployIndex(a); // default.json: the six GPUs of the recipe
  const fam = Array.from({ length: 15 }, (_, k) => k);
  const w = a.wallet(0);
  for (const g of WORST) {
    const hash = await w.writeContract({ address: dep.index, abi: agateIndexAbi, functionName: "registerGpu", args: [g, keccak256(g), fam, fam.map(() => 1), D, 2 ** 15 - 1], account: w.account!, chain: w.chain });
    expect((await a.pub.waitForTransactionReceipt({ hash })).status).toBe("success");
  }
  await warp(a, dep.epochTs + 30); // slice 0 of day D: every writer's accumulators are new storage (cold)
}, 120_000);
afterAll(() => a?.stop());

function worstReport(h: number): Hex {
  const entries: Entry[] = WORST.map((gpuId) => ({ gpuId, dayId: D, slice: h, readAt: BigInt(dep.epochTs + h * SLICE + 1), values: Array.from({ length: 15 }, (_, k) => 3_990_000 + k * 10_000) }));
  return encodeReport(makeReport(SELECTOR, dep.index, entries));
}
const bits = (g: Hex, who: number) => a.pub.readContract({ address: dep.index, abi: agateIndexAbi, functionName: "readings", args: [g, D, ADDR[who]!] }) as Promise<Readings>;

describe.skipIf(!haveAnvil)("six-entry reports and the gas limits (18.4)", () => {
  test("direct: a 6 x 15 report on a cold slice is sent at ceil(1.5 x max(estimate, MEASURED)), under its cap, and lands", async () => {
    const pool = new RpcPool({ urls: [a.rpc], timeoutMs: 2_000, staleS: 10_000_000 });
    await pool.init();
    const log = new ReadingLog(mkdtempSync(join(tmpdir(), "agate-six-")), "standby");
    const s = new TxSender({ pool, account: privateKeyToAccount(KEYS[2]), index: dep.index, journal: log, timing: { pollMs: 20, rebroadcastMs: 2_000, replaceMs: 6_000, waitMs: 5_000, lockWaitMs: 1_000 }, alert: () => {} });
    const data = encodeFunctionData({ abi: agateIndexAbi, functionName: "postReport", args: [worstReport(0)] });
    const est = await a.pub.estimateGas({ account: ADDR[2]!, to: dep.index, data });
    const r = await s.send({ to: dep.index, data, shape: "postReport", meta: { action: "post", tags: ["six"] } });
    expect(r.ok).toBe(true);
    // anvil's estimate of this shape sits a little above its gasUsed, so the limit is 1.5 x the estimate, well under CAP
    const g = gasLimitFor(est, MEASURED.postReport);
    if (!g.ok) throw new Error("GAS_CAP");
    expect(g.limit).toBe((3n * (est > MEASURED.postReport ? est : MEASURED.postReport) + 1n) / 2n);
    expect(g.cap).toBe(1_988_552n);
    expect(g.limit < g.cap).toBe(true);
    expect((await a.pub.getTransaction({ hash: r.txHash! })).gas).toBe(g.limit);
    expect(r.gasUsed! <= MEASURED.postReport).toBe(true); // MEASURED is this shape's worst case
    for (const w of WORST) expect((await bits(w, 2)).sliceBits).toBe(1n);
  }, 60_000);

  test("CRE path: through the forwarder the old limit (777,371) runs out inside the try/catch; ceil(1.5 x MEASURED onReport) lands", async () => {
    const w = a.wallet(1); // the primary (tx.origin in TX_ORIGIN mode)
    const data = encodeFunctionData({ abi: MOCK_FORWARDER_ABI, functionName: "forward", args: [dep.index, "0x", worstReport(0)] });
    const send = async (gas: bigint) => {
      const hash = await w.sendTransaction({ to: dep.forwarder, data, gas, account: w.account!, chain: w.chain });
      const rc = await a.pub.waitForTransactionReceipt({ hash });
      const log = rc.logs.find((l) => l.topics[0] === FORWARDED);
      return { status: rc.status, ok: log ? BigInt(log.data.slice(0, 66)) === 1n : false, used: rc.gasUsed };
    };
    const old = await send(777_371n);
    expect(old).toMatchObject({ status: "success", ok: false }); // a "successful" transaction that wrote nothing
    expect((await bits(WORST[0]!, 1)).sliceBits).toBe(0n);
    const cre = gasLimitFor(MEASURED.onReport, MEASURED.onReport);
    expect(cre).toEqual({ ok: true, limit: 1_614_000n, cap: 2_152_000n });
    const now = await send(cre.ok ? cre.limit : 0n);
    expect(now).toMatchObject({ status: "success", ok: true });
    expect(now.used <= MEASURED.onReport).toBe(true);
    for (const g of WORST) expect((await bits(g, 1)).sliceBits).toBe(1n);
  }, 60_000);
});
