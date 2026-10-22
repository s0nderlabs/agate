// readResult for an early close of pay-me-daily Longs, both ways: the router's closeLongDaily (q x C up front) and
// upFront "paid" (the series' unstream takes back what was paid, then closeLong sells). Same net either way.
import { describe, expect, test } from "bun:test";
import { type Address, encodeAbiParameters, encodeEventTopics, type Log } from "viem";
import { agateRouterAbi, agateSeriesAbi } from "../src/abi.ts";
import type { AgateClient } from "../src/client.ts";
import { readResult } from "../src/plan.ts";

const ROUTER = "0x00000000000000000000000000000000000000a1" as Address;
const SERIES = "0x00000000000000000000000000000000000000b2" as Address;
const ME = "0x00000000000000000000000000000000000000c3" as Address;
const c = { router: ROUTER } as unknown as AgateClient;

const log = (address: Address, topics: readonly `0x${string}`[], data: `0x${string}`) => ({ address, topics, data }) as unknown as Log;
const closed = (kind: number, amount: bigint) =>
  log(
    SERIES,
    encodeEventTopics({ abi: agateSeriesAbi, eventName: "PositionClosed", args: { id: 12n, owner: ME } }) as `0x${string}`[],
    encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }, { type: "address" }, { type: "address" }], [kind, amount, ME, ME]),
  );
const routed = (flow: number, tokens: bigint, dollarsIn: bigint, dollarsOut: bigint) =>
  log(
    ROUTER,
    encodeEventTopics({ abi: agateRouterAbi, eventName: "Routed", args: { user: ME, series: SERIES, flow } }) as `0x${string}`[],
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256[]" }], [tokens, dollarsIn, dollarsOut, 0n, tokens, 0n, []]),
  );

describe("closeLongDaily results", () => {
  // the fork run of Oct 22 2026 on position 12 (24.4498 GPU-hours): both ways leave the account $57.946026 up
  test("upFront paid: cost is what unstream took back, received is the sale", () => {
    const r = readResult(c, "closeLongDaily", [closed(2, 47_677_110n), routed(1, 24_449_800n, 0n, 105_623_136n)]);
    expect(r).toEqual({ cost: 47.67711, received: 105.623136, paid: 0 });
    expect((r.received as number) + (r.paid as number) - (r.cost as number)).toBeCloseTo(57.946026, 6);
  });
  test("the router's closeLongDaily reads as before", () => {
    const r = readResult(c, "closeLongDaily", [closed(1, 147_921_290n), routed(5, 24_449_800n, 195_598_400n, 105_623_136n + 147_921_290n)]);
    expect(r).toEqual({ cost: 195.5984, received: 105.623136, paid: 147.92129 });
    expect((r.received as number) + (r.paid as number) - (r.cost as number)).toBeCloseTo(57.946026, 6);
  });
});
