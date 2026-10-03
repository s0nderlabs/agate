// BOTS-SPEC 4.1: positions rebuilt from the scanned events (opened, claimed: paid only grows, payout changed, closed),
// each a real ABI encoding of the contract's own event decoded by the scanner's decodeScanLog.
import { describe, expect, test } from "bun:test";
import { type Abi, type AbiEvent, type Address, encodeAbiParameters, encodeEventTopics, type Hex, padHex, toHex } from "viem";
import { agateFactoryAbi, agateSeriesAbi, decodeScanLog, type FactoryEntry, type ScanEvent } from "@agate/market";
import { Positions } from "../src/positions.ts";

const A = (n: number): Address => padHex(toHex(n), { size: 20 }) as Address;
const FACTORY = A(0xfac);
const S1 = A(0x5e1);
const U = 1_000_000n;

function ev(address: Address, abi: Abi, name: string, args: Record<string, unknown>, block: number, logIndex: number): ScanEvent {
  const item = abi.find((x) => x.type === "event" && x.name === name) as AbiEvent;
  const topics = encodeEventTopics({ abi: [item], eventName: name, args: Object.fromEntries(item.inputs.filter((i) => i.indexed).map((i) => [i.name!, args[i.name!]])) } as never) as Hex[];
  const nonIdx = item.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIdx, nonIdx.map((i) => args[i.name!]) as never);
  const e = decodeScanLog({ address, topics, data, blockNumber: BigInt(block), logIndex, transactionHash: padHex(toHex(block * 1000 + logIndex), { size: 32 }) });
  if (!e) throw new Error(`${name} did not decode`);
  return e;
}

describe("positions from the scanned events", () => {
  test("opened, claimed (paid only grows), payout changed, closed", () => {
    const events = [
      ev(FACTORY, agateFactoryAbi as Abi, "SeriesListed", { series: S1, gpuId: padHex("0x01", { size: 32 }), month: 24_322, token: A(0x70c), startDay: 20_758, n: 30, startTs: 1_900_000_000n, day: 600, lastResort: 259_200n, floor: 1_800_000, cap: 7_200_000, x0: 3_600_000, bandGrade: 0, anchorCarried: 0, anchorMinFresh: 5, anchorLate: false, name: "agate H100 Nov 2026", symbol: "dH100-NOV26" }, 20, 0),
      ev(S1, agateSeriesAbi as Abi, "PositionOpened", { id: 1n, owner: A(0xa), payee: A(0xb), side: 0, q: 720n * U, paidNow: 1_296n * U, operator: A(0), daily: true, k: 0, to: A(0xa) }, 21, 0),
      ev(S1, agateSeriesAbi as Abi, "PositionOpened", { id: 2n, owner: A(0xa), payee: A(0xb), side: 0, q: 100n * U, paidNow: 1_296n * U, operator: A(0), daily: true, k: 0, to: A(0xa) }, 21, 1),
      ev(S1, agateSeriesAbi as Abi, "Claimed", { id: 1n, payee: A(0xb), amount: 104n * U, paidTotal: 1_400n * U, k: 1 }, 22, 0),
      ev(S1, agateSeriesAbi as Abi, "PayoutChanged", { id: 2n, payee: A(0xc), daily: false }, 23, 0),
      ev(S1, agateSeriesAbi as Abi, "PositionClosed", { id: 1n, owner: A(0xa), kind: 2, amount: 1_400n * U, to: A(0xa), by: A(0xa) }, 24, 0),
    ];
    const entry: FactoryEntry = { name: "demo", index: A(0x1d), dollar: A(0xd), tag: "demo", factory: FACTORY, router: A(0x7), tPend: 210, startBlock: 10n };
    const p = new Positions([entry]);
    p.apply(events);
    expect(p.series.get(S1.toLowerCase())!.symbol).toBe("dH100-NOV26");
    expect(p.series.get(S1.toLowerCase())!.factoryName).toBe("demo");
    expect(p.get(S1, 1n)!.paid).toBe(1_400n * U);
    expect(p.get(S1, 1n)!.open).toBe(false);
    expect(p.get(S1, 2n)!.payee).toBe(A(0xc).toLowerCase() as Address);
    expect(p.get(S1, 2n)!.daily).toBe(false);
    expect(p.open(S1).map((x) => x.id)).toEqual([2n]);
    p.setPaid(S1, 2n, 1n); // a stale event never lowers paid
    expect(p.get(S1, 2n)!.paid).toBe(1_296n * U);
  });
});
