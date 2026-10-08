// Fork rehearsal only: writes whole index days onto an AgateIndex on a local anvil fork, as its real writer and
// attester addresses (impersonated; no key exists here for them), moving the fork's clock forward day by day. It
// stands in for weeks of the real-calendar index so the lister's real path can list November (SEEDED from the first
// final record) and December (RULE: the five final days before Nov 1) on the fork's Kuru V1.
//
//   bun run ops/testnet/rehearse/days.ts --rpc http://127.0.0.1:<port> --index 0x... --to <last day id> [--slices all|N]
//
// Each day from the index's head: one report per slice at the slice's read second (every GPU of launch.json, the live
// slots at the GPU's price, reserve slots 0), then at the day's end plus CLOSE_GRACE closeDay for every GPU by the
// primary, and the attester's countersign of every record that needs one. Refuses a non-anvil or non-loopback RPC.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Address,
  createPublicClient,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  http,
  parseAbi,
} from "../../../wall/packages/report/node_modules/viem";

const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  const v = i >= 0 ? argv[i + 1] : d;
  if (v === undefined) throw new Error(`--${n} is required`);
  return v;
};
const rpc = arg("rpc");
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(rpc)) throw new Error("a loopback fork URL only");
const index = arg("index") as Address;
const toDay = Number(arg("to"));
const PRICE: Record<string, number> = { H100: 3_990_000, H200: 4_780_000, B200: 6_990_000, B300: 8_710_000, A100: 2_700_000, L40S: 1_560_000 };

// generous timeouts: on a loaded machine (other processes at load 15 to 30) the fork answers slowly while bots share it
const pub = createPublicClient({ transport: http(rpc, { timeout: 120_000 }) });
const call = (method: string, params: unknown[] = []) => pub.request({ method: method as never, params: params as never }) as Promise<unknown>;
await call("anvil_nodeInfo").catch(() => {
  throw new Error("not an anvil node");
});

const abi = parseAbi([
  "function writers() view returns (address[2])",
  "function attester() view returns (address)",
  "function head(bytes32) view returns (uint32)",
  "function dayStart(uint32) view returns (uint64)",
  "function postReport(bytes)",
  "function closeDay(bytes32)",
  "function attest(bytes32,uint32,address,bytes32)",
  "function record(bytes32,uint32) view returns (bool exists, bool isFinal, (uint32 value, uint8 status, uint8 fresh, uint8 quorum, uint8 held, uint32 freshMedian, bool late, bool incomplete, bool changed, bool needsSign, bool dropped, address source, uint64 postedAt, uint64 finalAt, uint64 attestedAt, address attestedBy, bytes32 digest) rec)",
  "function clocks() view returns ((uint32 day, uint32 slice, uint32 tPend, uint32 closeGrace, uint32 grace, uint32 holdMove, uint32 holdMin, uint32 step, uint32 reopenWait, uint32 timelock, uint8 slices, uint8 minReadings, uint8 qMin, bool demoLabel, bool signAll, uint64 epochTs, uint32 epochDay, uint64 chainSelector))",
]);
const read = async <T>(fn: string, args: unknown[] = []): Promise<T> => {
  const data = encodeFunctionData({ abi, functionName: fn as never, args: args as never });
  const out = (await call("eth_call", [{ to: index, data }, "latest"])) as Hex;
  return decodeFunctionResult({ abi, functionName: fn as never, data: out }) as T;
};
const panel = JSON.parse(readFileSync(join(import.meta.dir, "../../../wall/packages/sources/panels/launch.json"), "utf8")) as {
  deploy: { gpu: string; gpuId: Hex; family: number[]; liveAtStartMask: number }[];
};
const [primary] = await read<readonly [Address, Address]>("writers");
const attester = await read<Address>("attester");
const ck = await read<{ day: number; slice: number; slices: number; closeGrace: number; tPend: number; chainSelector: bigint }>("clocks");
for (const a of [primary, attester]) await call("anvil_impersonateAccount", [a]);

let sent = 0;
let gasUsed = 0n;
async function tx(from: Address, data: Hex, what: string): Promise<void> {
  const hash = (await call("eth_sendTransaction", [{ from, to: index, data, gas: "0x1c9c380" }])) as Hex;
  const rc = await pub.waitForTransactionReceipt({ hash, pollingInterval: 20, timeout: 600_000 });
  if (rc.status !== "success") throw new Error(`${what} reverted (${hash})`);
  sent++;
  gasUsed += rc.gasUsed;
}
async function now(): Promise<bigint> {
  return (await pub.getBlock({ blockTag: "latest" })).timestamp;
}
async function at(t: bigint): Promise<void> {
  if (t > (await now())) await call("evm_setNextBlockTimestamp", [Number(t)]);
}

/** the attester's countersign of a closed record that waits for one (a changed day is never final by itself) */
async function attestIfNeeded(g: { gpu: string; gpuId: Hex }, d: number): Promise<boolean> {
  const [exists, isFinal, rec] = await read<readonly [boolean, boolean, { needsSign: boolean; finalAt: bigint; source: Address; digest: Hex }]>("record", [g.gpuId, d]);
  if (!exists || isFinal || !rec.needsSign || rec.finalAt !== 0n) return false;
  await tx(attester, encodeFunctionData({ abi, functionName: "attest", args: [g.gpuId, d, rec.source, rec.digest] }), `attest ${g.gpu} ${d}`);
  return true;
}

const h0 = await read<number>("head", [panel.deploy[0]!.gpuId]);
console.log(JSON.stringify({ index, primary, attester, from: h0, to: toDay, day: ck.day, slices: ck.slices }));
// a fork of the live index mid-life: each GPU's day before its own head may be closed and still wait for the
// attester's countersign, and its next close is refused until it has it (the live writer closes the GPUs one
// transaction at a time, so a fork block can fall between them). Logged without a "day" key: the caller reads the
// last {"day" line as the last day this script finished.
const pending: string[] = [];
for (const g of panel.deploy) {
  const h = await read<number>("head", [g.gpuId]);
  if (await attestIfNeeded(g, h - 1)) pending.push(`${g.gpu} ${h - 1}`);
}
if (pending.length) console.log(JSON.stringify({ countersignedBeforeStart: pending }));
for (let d = h0; d <= toDay; d++) {
  const start = await read<bigint>("dayStart", [d]);
  for (let h = 0; h < ck.slices; h++) {
    const readAt = start + BigInt(h * ck.slice + 25);
    await at(readAt);
    const entries = panel.deploy.map((g) => ({
      gpuId: g.gpuId,
      dayId: d,
      slice: h,
      readAt,
      values: g.family.map((_, i) => ((g.liveAtStartMask >> i) & 1 ? PRICE[g.gpu]! : 0)),
    }));
    const report = encodeAbiParameters(
      [{ type: "uint8" }, { type: "uint64" }, { type: "address" }, { type: "tuple[]", components: [{ name: "gpuId", type: "bytes32" }, { name: "dayId", type: "uint32" }, { name: "slice", type: "uint8" }, { name: "readAt", type: "uint64" }, { name: "values", type: "uint32[]" }] }],
      [1, ck.chainSelector, index, entries],
    );
    await tx(primary, encodeFunctionData({ abi, functionName: "postReport", args: [report] }), `postReport ${d}/${h}`);
  }
  await at(start + BigInt(ck.day + ck.closeGrace));
  let attested = 0;
  for (const g of panel.deploy) {
    await tx(primary, encodeFunctionData({ abi, functionName: "closeDay", args: [g.gpuId] }), `closeDay ${g.gpu} ${d}`);
    if (await attestIfNeeded(g, d)) attested++;
  }
  console.log(JSON.stringify({ day: d, date: new Date(d * 86_400_000).toISOString().slice(0, 10), reports: ck.slices, closed: panel.deploy.length, attested }));
}
// past the last record's T_PEND, so every closed day is final
const lastStart = await read<bigint>("dayStart", [toDay]);
await at(lastStart + BigInt(ck.day + ck.closeGrace + ck.tPend + 60));
await call("evm_mine");
const [, fin] = await read<readonly [boolean, boolean, unknown]>("record", [panel.deploy[0]!.gpuId, toDay]);
console.log(JSON.stringify({ done: true, transactions: sent, gasUsed: gasUsed.toString(), lastDayFinal: fin, chainTime: new Date(Number(await now()) * 1000).toISOString() }));
