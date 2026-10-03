// The market on a local chain for the payer's tests, deployed with viem from the Foundry artifacts: a MockIndex on the
// demo clock (600-second days, day 20,727 = 2026-10-01 at epochTs), the test dollar, a Kuru V1 router (the
// MockKuruRouter locally, Kuru's real Router on a fork), one factory ("demo") and its router; the deployments file
// the bots read; records put per day with their finality (closeGrace 150 s + tPend 210 s after the day ends).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Abi, type Address, type Hex, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agateDollarAbi, agateFactoryAbi, agateRouterAbi, agateSeriesAbi, firstDayOf } from "@agate/market";
import { artifact, type Chain, deploy, read, tx } from "./chain.ts";

export const DAY = 600n;
export const EPOCH_DAY = 20_727; // 2026-10-01
export const OCT = 24_321;
export const NOV = 24_322;
export const DEC = 24_323;
export const U = 1_000_000n;
export const H100 = keccak256(toBytes("H100-SXM/on-demand-list/neocloud/v1"));
export const H200 = keccak256(toBytes("H200-SXM/on-demand-list/neocloud/v1"));
export const NOPERMIT = { value: 0n, deadline: 0n, v: 0, r: `0x${"0".repeat(64)}` as Hex, s: `0x${"0".repeat(64)}` as Hex };
export const MAX = 2n ** 256n - 1n;

export interface MarketWorld {
  c: Chain;
  deployer: Hex;
  index: Address;
  indexAbi: Abi;
  dollar: Address;
  kuruRouter: Address;
  factory: Address;
  router: Address;
  epochTs: bigint;
  startBlock: bigint;
  depFile: string;
  bookAbi: Abi;
}

export function dayStart(w: { epochTs: bigint }, day: number): bigint {
  return w.epochTs + BigInt(day - EPOCH_DAY) * DAY;
}
/** When a day's record is final on the demo clock: its end + closeGrace 150 + tPend 210. */
export function finalAt(w: { epochTs: bigint }, day: number): bigint {
  return dayStart(w, day) + DAY + 360n;
}

export async function buildMarket(c: Chain, o: { deployer: Hex; epochTs: bigint; dir: string; kuruRouter?: Address; marginAccount?: Address }): Promise<MarketWorld> {
  const d = o.deployer;
  const me = privateKeyToAccount(d).address;
  const startBlock = await c.pub.getBlockNumber({ cacheTime: 0 });
  const mi = await artifact("MockIndex");
  const index = await deploy(c, d, mi, [Number(DAY), o.epochTs, EPOCH_DAY]);
  for (const g of [H100, H200]) await tx(c, d, index, mi.abi, "register", [g, keccak256(g)]);
  const dollar = await deploy(c, d, await artifact("AgateDollar"), [me, 10_000n * U, 86_400n]);
  const book = await artifact("MockKuruOrderBook");
  const kuruRouter = o.kuruRouter ?? (await deploy(c, d, await artifact("MockKuruRouter")));
  const factory = await deploy(c, d, await artifact("AgateFactory"), [index, dollar, kuruRouter, [H100, H200], ["H100", "H200"], me, "demo", 0n, 0n]);
  const router = await read<Address>(c, factory, agateFactoryAbi as Abi, "router");
  const depFile = join(o.dir, "deployments.json");
  writeFileSync(
    depFile,
    JSON.stringify({
      chainId: c.chainId,
      dollar,
      kuru: { router: kuruRouter, ...(o.marginAccount ? { marginAccount: o.marginAccount } : {}) },
      factories: { demo: { index, dollar, tag: "demo", factory, router, tPend: 210, startBlock: Number(startBlock) } },
    }),
  );
  return { c, deployer: d, index, indexAbi: mi.abi, dollar, kuruRouter, factory, router, epochTs: o.epochTs, startBlock, depFile, bookAbi: book.abi };
}

/** MockIndex.put: the record of `day` (status FULL, 5 fresh), final at the demo clock's finality. */
export async function putDay(w: MarketWorld, gpuId: Hex, day: number, value: bigint): Promise<void> {
  await tx(w.c, w.deployer, w.index, w.indexAbi, "put", [gpuId, day, Number(value), finalAt(w, day), 1, 5, false, false]);
}

export async function seriesOf(w: MarketWorld, gpuId: Hex, month: number): Promise<Address> {
  return read<Address>(w.c, w.factory, agateFactoryAbi as Abi, "seriesOf", [gpuId, month]);
}

export async function marketOf(w: MarketWorld, series: Address): Promise<{ market: Address; venue: number }> {
  const [market, venue] = await read<[Address, number]>(w.c, w.factory, agateFactoryAbi as Abi, "marketOf", [series]);
  return { market, venue: Number(venue) };
}

export async function balanceOf(w: MarketWorld, token: Address, who: Address): Promise<bigint> {
  return read<bigint>(w.c, token, agateDollarAbi as Abi, "balanceOf", [who]);
}

export async function mintDollars(w: MarketWorld, to: Address, amount: bigint): Promise<void> {
  await tx(w.c, w.deployer, w.dollar, agateDollarAbi as Abi, "mint", [to, amount]);
}

export async function fund(w: MarketWorld, who: Address, mon = 10_000n): Promise<void> {
  await w.c.call("anvil_setBalance", [who, `0x${(mon * 10n ** 18n).toString(16)}`]);
}

/** A holder opens a position directly: mint q pairs, then streamOut (MS 6.4). Returns the position id. */
export async function streamOut(w: MarketWorld, key: Hex, series: Address, side: 0 | 1, q: bigint, payee: Address, daily: boolean): Promise<bigint> {
  const me = privateKeyToAccount(key).address;
  const r = await tx(w.c, key, series, agateSeriesAbi as Abi, "streamOut", [side, q, me, payee, me, daily]);
  const st = await read<readonly unknown[]>(w.c, series, agateSeriesAbi as Abi, "state");
  void r;
  return (st[6] as bigint) - 1n;
}

export async function position(w: MarketWorld, series: Address, id: bigint): Promise<{ owner: Address; paid: bigint; q: bigint; daily: boolean; payee: Address }> {
  return read(w.c, series, agateSeriesAbi as Abi, "position", [id]);
}

export async function claimable(w: MarketWorld, series: Address, id: bigint): Promise<bigint | null> {
  try {
    return await read<bigint>(w.c, series, agateSeriesAbi as Abi, "claimable", [id]);
  } catch {
    return null;
  }
}

export { agateDollarAbi, agateFactoryAbi, agateRouterAbi, agateSeriesAbi, firstDayOf };
