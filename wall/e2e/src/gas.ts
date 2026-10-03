// Gas of the wall's sends on a private anvil with the real AgateIndex (local chain only): one report with three entries
// against six, direct (postReport) and through the CRE path's mock forwarder (onReport), on a writer's first slice of
// a day (cold) and its second (warm), on the launch panel's slot counts and on the contract's worst case (15 slots
// in 15 families); then closeDay, attest (countersign) and carryDay (the keeper's case 2) per GPU. gasUsed is the
// receipt's (intrinsic and calldata included); estimate is eth_estimateGas just before the send (the senders' input).
import { agateIndexAbi } from "@agate/report/abi";
import type { Address, Entry, Hex } from "@agate/report/types";
import type { Panel } from "@agate/sources/types";
import { reportHex } from "@agate/writer-standby/core";
import { encodeFunctionData, keccak256, toBytes } from "viem";
import { ADDR, type Anvil, deployIndex, LAUNCH_PANELS_FILE, type Profile, PROFILES, read, ROLE, SELECTOR, send, startAnvil, walletFor } from "./chain.ts";

export type GasPath = "postReport" | "onReport" | "closeDay" | "attest" | "carryDay";

export interface GasRow {
  path: GasPath;
  /** entries in the report (1 for the per-GPU calls) */
  entries: number;
  /** slots per entry, in entry order */
  slots: number[];
  /** "launch": launch.json's slot counts; "worst": 15 slots in 15 families */
  shape: "launch" | "worst";
  /** a writer's first post of a day for these GPUs (fresh accumulators), or its second */
  cold?: boolean;
  gpu?: string;
  estimate?: number;
  used: number;
}

export interface GasReport {
  profile: Profile["name"];
  /** GPUs the launch panel registers: entries a report carries, and closes, countersigns and carries a day */
  gpus: number;
  rows: GasRow[];
}

const FORWARD_ABI = [
  { type: "function", name: "forward", stateMutability: "nonpayable", inputs: [{ name: "receiver", type: "address" }, { name: "metadata", type: "bytes" }, { name: "report", type: "bytes" }], outputs: [{ name: "ok", type: "bool" }] },
  { type: "event", name: "Forwarded", inputs: [{ name: "receiver", type: "address", indexed: true }, { name: "ok", type: "bool", indexed: false }, { name: "err", type: "bytes", indexed: false }] },
] as const;
const FORWARDED_TOPIC = keccak256(toBytes("Forwarded(address,bool,bytes)"));
const WORST_SLOTS = 15;

interface Gpu {
  name: string;
  gpuId: Hex;
  slots: number;
  shape: "launch" | "worst";
}

/** One transaction from an anvil account: its estimate (unless skipped) and its receipt's gasUsed. A forwarded
 *  report must also have landed (the forwarder swallows a revert). */
async function measure(a: Anvil, from: number, to: Address, data: Hex, o: { estimate?: boolean; forwarded?: boolean } = {}): Promise<{ estimate?: number; used: number }> {
  const estimate = o.estimate === false ? undefined : Number(await a.pub.estimateGas({ account: ADDR[from]!, to, data }));
  const w = walletFor(a, from);
  const hash = await w.sendTransaction({ to, data, gas: 15_000_000n, account: w.account, chain: w.chain });
  const rc = await a.pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`gas: a send to ${to} reverted`);
  if (o.forwarded) {
    const log = rc.logs.find((l) => l.topics[0] === FORWARDED_TOPIC);
    // data: ok (bool word) then the err bytes; ok must be 1
    if (!log || BigInt(log.data.slice(0, 66)) !== 1n) throw new Error("gas: the forwarded report reverted inside onReport");
  }
  return { ...(estimate !== undefined ? { estimate } : {}), used: Number(rc.gasUsed) };
}

/** Measures every row on a fresh anvil (anvil-safe) with the given clock profile. */
export async function measureGas(profile: Profile = PROFILES.PRODUCTION): Promise<GasReport> {
  const NOV1 = 20_758;
  const prod = profile.name === "PRODUCTION";
  // PRODUCTION counts days from the unix epoch; the demo profiles from an epoch on Nov 1 (30 s before the first block)
  const start = prod ? NOV1 * 86_400 + 30 : 1_793_491_230;
  const a = await startAnvil(start);
  try {
    const launch = (await Bun.file(LAUNCH_PANELS_FILE).json()) as { panels: Panel[] };
    const dep = await deployIndex(a, profile, { ...(prod ? { epochTs: 0, epochDay: 0 } : { epochTs: start - 30, epochDay: NOV1 }), gpus: launch.panels.map((p) => ({ gpu: p.gpu })), panelsFile: LAUNCH_PANELS_FILE });
    const L: Gpu[] = dep.panels.map((p) => ({ name: p.gpu, gpuId: p.gpuId as Hex, slots: p.slots.length, shape: "launch" }));
    const W: Gpu[] = [];
    for (let i = 1; i <= L.length; i++) {
      const gpuId = keccak256(toBytes(`gas-worst-${i}/15-slots`));
      const fam = Array.from({ length: WORST_SLOTS }, (_, k) => k);
      await send(a, ROLE.owner, "registerGpu", [gpuId, keccak256(gpuId), fam, fam.map(() => 1), dep.firstDay, 2 ** WORST_SLOTS - 1], dep.index);
      W.push({ name: `W${i}`, gpuId, slots: WORST_SLOTS, shape: "worst" });
    }
    const ck = await read<{ day: number; slice: number; closeGrace: number; slices: number; tPend: number }>(a, dep.index, "clocks", []);
    const D = dep.firstDay;
    const dayStart = (d: number) => dep.epochTs + (d - dep.epochDay) * ck.day;
    const at = (d: number, h: number, off: number) => dayStart(d) + h * ck.slice + off;
    const entries = (gs: Gpu[], d: number, h: number, readAt: number): Entry[] =>
      gs.map((g) => ({ gpuId: g.gpuId, dayId: d, slice: h, readAt: BigInt(readAt), values: Array.from({ length: g.slots }, (_, k) => 3_990_000 + k * 10_000) }));
    const report = (gs: Gpu[], d: number, h: number, readAt: number) => reportHex(SELECTOR, dep.index, entries(gs, d, h, readAt));
    const post = (gs: Gpu[], d: number, h: number, readAt: number) => encodeFunctionData({ abi: agateIndexAbi, functionName: "postReport", args: [report(gs, d, h, readAt)] });
    const forward = (gs: Gpu[], d: number, h: number, readAt: number) => encodeFunctionData({ abi: FORWARD_ABI, functionName: "forward", args: [dep.index, "0x", report(gs, d, h, readAt)] });
    const rows: GasRow[] = [];
    const row = (path: GasPath, gs: Gpu[], cold: boolean | undefined, m: { estimate?: number; used: number }) =>
      rows.push({ path, entries: gs.length, slots: gs.map((g) => g.slots), shape: gs[0]!.shape, ...(cold !== undefined ? { cold } : {}), ...(gs.length === 1 ? { gpu: gs[0]!.name } : {}), ...m });
    const all = [...L, ...W];
    const fill = async (d: number, h: number, readAt: number) => {
      // every GPU for both writers, so the day is complete; entries already posted this slice are skipped (E7)
      await measure(a, ROLE.primary, dep.index, post(all, d, h, readAt), { estimate: false });
      await measure(a, ROLE.standby, dep.index, post(all, d, h, readAt), { estimate: false });
    };

    // Day D: launch GPUs direct, worst GPUs through the forwarder (slice 0 cold, slice 1 warm)
    for (const h of [0, 1]) {
      const t = await a.warp(at(D, h, 30));
      const cold = h === 0;
      row("postReport", L.slice(0, 3), cold, await measure(a, ROLE.primary, dep.index, post(L.slice(0, 3), D, h, t - 5)));
      row("postReport", L, cold, await measure(a, ROLE.standby, dep.index, post(L, D, h, t - 5)));
      row("onReport", W.slice(0, 3), cold, await measure(a, ROLE.primary, dep.forwarder, forward(W.slice(0, 3), D, h, t - 5), { estimate: false, forwarded: true }));
      row("onReport", W, cold, await measure(a, ROLE.standby, dep.forwarder, forward(W, D, h, t - 5), { estimate: false, forwarded: true }));
      await fill(D, h, t - 5);
    }
    for (let h = 2; h < ck.slices; h++) {
      const t = await a.warp(at(D, h, 30));
      await fill(D, h, t - 5);
    }
    // Day D + 1: the other way round (worst direct, launch through the forwarder), before day D closes
    for (const h of [0, 1]) {
      const t = await a.warp(at(D + 1, h, Math.min(30, Math.floor(ck.slice / 5))));
      const cold = h === 0;
      row("postReport", W.slice(0, 3), cold, await measure(a, ROLE.primary, dep.index, post(W.slice(0, 3), D + 1, h, t - 5)));
      row("postReport", W, cold, await measure(a, ROLE.standby, dep.index, post(W, D + 1, h, t - 5)));
      row("onReport", L.slice(0, 3), cold, await measure(a, ROLE.primary, dep.forwarder, forward(L.slice(0, 3), D + 1, h, t - 5), { estimate: false, forwarded: true }));
      row("onReport", L, cold, await measure(a, ROLE.standby, dep.forwarder, forward(L, D + 1, h, t - 5), { estimate: false, forwarded: true }));
    }
    // Day D closes at C1 (the first writer quorate, at dayEnd + CLOSE_GRACE): one closeDay per GPU, then the
    // attester's countersign of each first record (a GPU's first record is "changed", so it needs a sign)
    await a.warp(dayStart(D + 1) + ck.closeGrace + 1);
    for (const g of all) {
      const data = encodeFunctionData({ abi: agateIndexAbi, functionName: "closeDay", args: [g.gpuId] });
      row("closeDay", [g], undefined, await measure(a, ROLE.primary, dep.index, data));
    }
    for (const g of all) {
      const [, , rec] = await read<[boolean, boolean, { needsSign: boolean; source: Address; digest: Hex }]>(a, dep.index, "record", [g.gpuId, D]);
      if (!rec.needsSign) continue;
      const data = encodeFunctionData({ abi: agateIndexAbi, functionName: "attest", args: [g.gpuId, D, rec.source, rec.digest] });
      row("attest", [g], undefined, await measure(a, ROLE.attester, dep.index, data));
    }
    // Day D + 1 holds two readings a writer (below quorum on PRODUCTION): the keeper carries it once it may
    if (prod) {
      await a.warp(dayStart(D + 2) + ck.day + 1);
      for (const g of all) {
        const data = encodeFunctionData({ abi: agateIndexAbi, functionName: "carryDay", args: [g.gpuId] });
        row("carryDay", [g], undefined, await measure(a, ROLE.keeper, dep.index, data));
      }
    }
    return { profile: profile.name, gpus: L.length, rows };
  } finally {
    a.stop();
  }
}

/** The largest gasUsed among the rows that match. */
export function worst(r: GasReport, path: GasPath, f: (x: GasRow) => boolean = () => true): number {
  return Math.max(0, ...r.rows.filter((x) => x.path === path && f(x)).map((x) => x.used));
}
