// The CRE path's gas limit (wall spec 18.4: ceil(1.5 x MEASURED onReport)). The primary's demo path goes through the
// CRE simulation forwarder, whose report() parses the Keystone metadata, records the transmission and asks the
// receiver for ERC165 before it calls onReport inside its own try/catch, keeping back a 64th of the gas around it. So
// MEASURED onReport is the least gas limit at which a cold six-entry report of 15 slots per GPU still lands through
// this forwarder (rounded up to 1,000), not a receipt's gasUsed through the bare test MockForwarder. This runs the
// forwarder's own bytecode (the one deployed on Monad testnet, from foundry's RPC cache or AGATE_CRE_FORWARDER_CODE) on
// a private anvil and sends six-entry reports through it at the runner's limit: the six launch GPUs and the contract's
// worst case (six GPUs of 15 slots), each on a writer's cold first slice of a day. It prints the forwarder's overhead
// and the least gas limit at which the report still lands. Local anvil only; skips with a printed line without the code.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeReport, makeReport } from "@agate/report";
import { agateIndexAbi } from "@agate/report/abi";
import type { Address, Entry, Hex, Readings } from "@agate/report/types";
import { concat, encodeFunctionData, keccak256, pad, toBytes, toEventSelector, toHex } from "viem";
import { gasLimitFor, MEASURED } from "../../src/pipeline/sender.ts";
import { ADDR, type Anvil, type Deployed, deployIndex, haveAnvil, LAUNCH_PANELS_FILE, startAnvil, warp } from "../helpers/anvil.ts";

const SIM_FORWARDER: Address = "0xB9F79d863261869B234c481D1f9A7af84AeAd192"; // writer-cre's CRE_SIM_FORWARDER
const REPORT_ABI = [{ type: "function", name: "report", stateMutability: "nonpayable", inputs: [{ name: "receiver", type: "address" }, { name: "rawReport", type: "bytes" }, { name: "reportContext", type: "bytes" }, { name: "signatures", type: "bytes[]" }], outputs: [] }] as const;
const PROCESSED = toEventSelector("ReportProcessed(address,bytes32,bytes2,bool)");
const D = 20_727;
const SLICE = 200; // TEST profile

function simForwarderCode(): Hex | undefined {
  if (process.env.AGATE_CRE_FORWARDER_CODE) return readFileSync(process.env.AGATE_CRE_FORWARDER_CODE, "utf8").trim() as Hex;
  const dir = join(homedir(), ".foundry/cache/rpc/monad-testnet");
  if (!existsSync(dir)) return undefined;
  for (const b of readdirSync(dir).reverse()) {
    const f = join(dir, b, "storage.json");
    if (!existsSync(f)) continue;
    const accounts = (JSON.parse(readFileSync(f, "utf8")) as { accounts?: Record<string, { code?: { LegacyAnalyzed?: { bytecode?: string } } }> }).accounts ?? {};
    const code = Object.entries(accounts).find(([k]) => k.toLowerCase() === SIM_FORWARDER.toLowerCase())?.[1].code?.LegacyAnalyzed?.bytecode;
    if (code && code.length > 2) return code as Hex;
  }
  return undefined;
}

const code = haveAnvil ? simForwarderCode() : undefined;
if (haveAnvil && !code) console.log("the CRE simulation forwarder's code is not cached: skipping (set AGATE_CRE_FORWARDER_CODE to its bytecode file)");

let a: Anvil;
let dep: Deployed;
const WORST = Array.from({ length: 6 }, (_, i) => keccak256(toBytes(`sim-worst-${i}/15-slots`)));
let launch: { gpuId: Hex; n: number }[] = [];
let execution = 0;

beforeAll(async () => {
  if (!code) return;
  a = await startAnvil();
  await a.test.setCode({ address: SIM_FORWARDER, bytecode: code });
  // the launch panel's six GPUs, the primary as tx.origin (TX_ORIGIN mode)
  dep = await deployIndex(a, { forwarder: SIM_FORWARDER, panelsFile: LAUNCH_PANELS_FILE });
  launch = dep.panels.map((p) => ({ gpuId: p.gpuId as Hex, n: p.slots.length }));
  const fam = Array.from({ length: 15 }, (_, k) => k);
  const w = a.wallet(0);
  for (const g of WORST) {
    const hash = await w.writeContract({ address: dep.index, abi: agateIndexAbi, functionName: "registerGpu", args: [g, keccak256(g), fam, fam.map(() => 1), D, 2 ** 15 - 1], account: w.account!, chain: w.chain });
    expect((await a.pub.waitForTransactionReceipt({ hash })).status).toBe("success");
  }
  await warp(a, dep.epochTs + 30); // slice 0 of day D: every accumulator is new storage (cold)
}, 120_000);
afterAll(() => a?.stop());

/** Keystone's raw report: 109 bytes of metadata (version, execution id, timestamp, DON id and config version,
 *  workflow cid, name, owner, report id), then the report itself. A fresh execution id per send. */
function rawReport(gpus: { gpuId: Hex; n: number }[], slice: number): Hex {
  const entries: Entry[] = gpus.map((g) => ({ gpuId: g.gpuId, dayId: D, slice, readAt: BigInt(dep.epochTs + slice * SLICE + 1), values: Array.from({ length: g.n }, (_, k) => 3_990_000 + k * 10_000) }));
  const meta = concat(["0x01", keccak256(toBytes(`execution-${++execution}`)), pad(toHex(dep.epochTs), { size: 4 }), pad("0x01", { size: 4 }), pad("0x01", { size: 4 }), keccak256(toBytes("workflow")), pad("0x6167617465", { size: 10, dir: "right" }), ADDR[1]!, "0x0001"]);
  expect((meta.length - 2) / 2).toBe(109);
  return concat([meta, encodeReport(makeReport(2183018362218727504n, dep.index, entries)) as Hex]);
}

/** One send of report() by the primary at `gas`; whether onReport ran to the end inside the forwarder. */
async function send(raw: Hex, gas: bigint): Promise<{ landed: boolean; used: bigint }> {
  const w = a.wallet(1);
  const data = encodeFunctionData({ abi: REPORT_ABI, functionName: "report", args: [dep.index, raw, "0x", []] });
  const hash = await w.sendTransaction({ to: SIM_FORWARDER, data, gas, account: w.account!, chain: w.chain });
  const rc = await a.pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") return { landed: false, used: rc.gasUsed };
  const log = rc.logs.find((l) => l.topics[0] === PROCESSED);
  return { landed: log ? BigInt(log.data.slice(0, 66)) === 1n : false, used: rc.gasUsed };
}

/** The least gas limit (to 10 gas) at which the cold report lands, each try on a snapshot of the same state. */
async function least(gpus: { gpuId: Hex; n: number }[], hi: bigint): Promise<bigint> {
  let lo = 100_000n;
  while (hi - lo > 10n) {
    const mid = (lo + hi) / 2n;
    const snap = await a.test.snapshot();
    const r = await send(rawReport(gpus, 0), mid);
    await a.test.revert({ id: snap });
    if (r.landed) hi = mid;
    else lo = mid;
  }
  return hi;
}

const bits = (g: Hex) => a.pub.readContract({ address: dep.index, abi: agateIndexAbi, functionName: "readings", args: [g, D, ADDR[1]!] }) as Promise<Readings>;

describe.skipIf(!code)("six-entry reports through the CRE simulation forwarder's own code (18.4)", () => {
  const cre = gasLimitFor(MEASURED.onReport, MEASURED.onReport);
  const limit = cre.ok ? cre.limit : 0n;

  test("the launch panel's six GPUs on a cold slice land at the runner's limit, with room to spare", async () => {
    expect(launch.length).toBe(6);
    const need = await least(launch, limit);
    const r = await send(rawReport(launch, 0), limit);
    console.log(`sim forwarder, launch panel (${launch.map((g) => g.n).join("+")} slots) cold: used ${r.used}, lands from a limit of ${need}, runner's limit ${limit} (${(Number(limit) / Number(need)).toFixed(2)}x)`);
    expect(r.landed).toBe(true);
    for (const g of launch) expect((await bits(g.gpuId)).sliceBits).toBe(1n);
    expect(Number(limit) / Number(need)).toBeGreaterThan(1.45); // anvil has run up to 45% under Monad (13.4)
  }, 120_000);

  test("the worst case, six GPUs of 15 slots on a cold slice, lands at the runner's limit", async () => {
    const need = await least(WORST.map((g) => ({ gpuId: g, n: 15 })), limit);
    const r = await send(rawReport(WORST.map((g) => ({ gpuId: g, n: 15 })), 0), limit);
    console.log(`sim forwarder, 6 x 15 slots cold: used ${r.used}, lands from a limit of ${need} (MEASURED onReport ${MEASURED.onReport}), runner's limit ${limit} (${(Number(limit) / Number(need)).toFixed(2)}x)`);
    expect(r.landed).toBe(true);
    for (const g of WORST) expect((await bits(g)).sliceBits).toBe(1n);
    // MEASURED is this least landing limit rounded up, so the runner keeps the full 1.5x over it (13.4)
    expect(need <= MEASURED.onReport).toBe(true);
    expect(MEASURED.onReport - need < 2_000n).toBe(true);
    expect(Number(limit) / Number(need)).toBeGreaterThanOrEqual(1.5);
  }, 120_000);
});
