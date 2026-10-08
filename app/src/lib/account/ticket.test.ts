// Pro's resting limits for the real account: the ticket's numbers as a limit order, each limit order as the client's
// plan builder call (planPlaceLimit, planCancelLimit, planWithdrawMargin) and the batch handed through, and a resting
// order as the Open orders view lists it.
import { describe, expect, test } from "bun:test";
import type { AgateClient } from "@agate/client";
import { type LimitBuilders, limitPlanOf } from "./real";
import { limitTicketOrder, onCents, restingOpenOrder } from "./ticket";
import type { LimitOrder, RestingOrder } from "./types";

const ME = "0x00000000000000000000000000000000000000aa" as const;
const place = (o: LimitOrder) => o as Extract<LimitOrder, { kind: "placeLimit" }>;

describe("the ticket's limit as an order", () => {
  test("a bid and an ask: the price in cents, the size in 0.0001 GPU-hour steps, never more than asked", () => {
    expect(limitTicketOrder({ gpu: "H100", month: "2026-11", side: "long", price: 3.9, gpuHours: 10 })).toEqual({ kind: "placeLimit", gpu: "H100", month: "2026-11", side: "long", price: "3.90", gpuHours: "10.0000" });
    expect(limitTicketOrder({ gpu: "H100", month: "2026-11", side: "short", price: 4.1, gpuHours: 12.34567 })).toEqual({ kind: "placeLimit", gpu: "H100", month: "2026-11", side: "short", price: "4.10", gpuHours: "12.3456" });
    // float noise on a cent price still reads as that cent
    expect(place(limitTicketOrder({ gpu: "H100", month: "2026-11", side: "long", price: 0.1 + 0.2 + 3.6, gpuHours: 1 })).price).toBe("3.90");
  });

  test("a price on the cent goes as cents; one off it is caught before an order is built (onCents)", () => {
    expect(onCents(3.95)).toBe(true);
    expect(onCents(3.955)).toBe(false);
    expect(place(limitTicketOrder({ gpu: "H100", month: "2026-11", side: "long", price: 3.9500000001, gpuHours: 1 })).price).toBe("3.95");
  });
});

describe("a resting order as Open orders lists it", () => {
  const bid: RestingOrder = { id: "H100-2026-11-41", orderId: "41", gpu: "H100", month: "2026-11", side: "long", price: 3.9, q: 10, placedAt: "2026-11-02T01:00:00Z", filled: 2 };
  test("a bid holds its price, an ask the ceiling (the pairs it minted); never paid daily", () => {
    expect(restingOpenOrder(bid, 8)).toEqual({ id: "H100-2026-11-41", gpu: "H100", month: "2026-11", side: "long", price: 3.9, q: 10, hold: 39, daily: false, placedAt: "2026-11-02T01:00:00Z" });
    expect(restingOpenOrder({ ...bid, side: "short", price: 4.1 }, 8).hold).toBe(80);
    // the month not read yet: an ask holds nothing known, a bid still its price
    expect(restingOpenOrder({ ...bid, side: "short" }, 0).hold).toBe(0);
    expect(restingOpenOrder(bid, 0).hold).toBe(39);
  });
});

describe("limitPlanOf: each limit order as the client's builder call", () => {
  const agate = {} as AgateClient;
  function fake() {
    const calls: { fn: string; me: string; p: unknown }[] = [];
    const call = { to: "0x00000000000000000000000000000000000000bb" as const, value: 0n, data: "0x01" as const, label: "addBuyOrder", extra: "dropped" };
    const answer = (fn: string, summary: Record<string, unknown>) => async (_c: AgateClient, me: `0x${string}`, p: unknown) => {
      calls.push({ fn, me, p });
      return { account: me, calls: [call], summary };
    };
    const b = {
      planPlaceLimit: answer("planPlaceLimit", { action: "placeLimit", gpu: "H100", month: "2026-11", side: "long", price: 3.9, gpuHours: 10, postOnly: true, deposited: 39, minted: 0 }),
      planCancelLimit: answer("planCancelLimit", { action: "cancelLimit", gpu: "H100", month: "2026-11", cancelled: ["41"], skipped: [], withdrawn: { dollars: 39, gpuHours: 0 } }),
      planWithdrawMargin: answer("planWithdrawMargin", { action: "withdrawMargin", withdrawn: { dollars: 12.5, gpuHours: 0 } }),
    } as unknown as LimitBuilders;
    return { b, calls };
  }

  test("a bid rests post-only and deposits; an ask also mints the pairs it sells (a Short, never a held Long)", async () => {
    const { b, calls } = fake();
    const bid = await limitPlanOf(agate, ME, { kind: "placeLimit", gpu: "H100", month: "2026-11", side: "long", price: "3.90", gpuHours: "10.0000" }, b);
    await limitPlanOf(agate, ME, { kind: "placeLimit", gpu: "H100", month: "2026-11", side: "short", price: "4.10", gpuHours: "10.0000" }, b);
    expect(calls).toEqual([
      { fn: "planPlaceLimit", me: ME, p: { gpu: "H100", month: "2026-11", side: "long", price: "3.90", gpuHours: "10.0000", postOnly: true, mint: false } },
      { fn: "planPlaceLimit", me: ME, p: { gpu: "H100", month: "2026-11", side: "short", price: "4.10", gpuHours: "10.0000", postOnly: true, mint: true } },
    ]);
    // the client's batch handed through as is (only the call's own fields), with when it was planned
    expect(bid.account).toBe(ME);
    expect(bid.calls).toEqual([{ to: "0x00000000000000000000000000000000000000bb", value: 0n, data: "0x01", label: "addBuyOrder" }]);
    expect(bid.summary).toMatchObject({ action: "placeLimit", side: "long", price: 3.9, gpuHours: 10, deposited: 39 });
    expect(Math.abs(bid.plannedAt - Date.now())).toBeLessThan(5_000);
  });

  test("a cancel takes what it frees back in the same batch", async () => {
    const { b, calls } = fake();
    const p = await limitPlanOf(agate, ME, { kind: "cancelLimit", gpu: "H100", month: "2026-11", orderIds: ["41"] }, b);
    expect(calls).toEqual([{ fn: "planCancelLimit", me: ME, p: { gpu: "H100", month: "2026-11", orderIds: ["41"], withdraw: true } }]);
    expect(p.summary).toMatchObject({ action: "cancelLimit", cancelled: ["41"], withdrawn: { dollars: 39, gpuHours: 0 } });
  });

  test("withdrawMargin: the dollars, or one month's GPU-hours, all of it", async () => {
    const { b, calls } = fake();
    await limitPlanOf(agate, ME, { kind: "withdrawMargin", asset: "dollar" }, b);
    await limitPlanOf(agate, ME, { kind: "withdrawMargin", asset: { gpu: "H100", month: "2026-11" } }, b);
    expect(calls).toEqual([
      { fn: "planWithdrawMargin", me: ME, p: { asset: "dollar" } },
      { fn: "planWithdrawMargin", me: ME, p: { asset: { gpu: "H100", month: "2026-11" } } },
    ]);
  });

  test("a refusal from the builder comes through untouched (errors.ts limitRefusal words it)", async () => {
    const refusal = Object.assign(new Error("none of these orders is resting and yours"), { name: "WriteError", stage: "check" });
    const b = { planCancelLimit: async () => Promise.reject(refusal) } as unknown as LimitBuilders;
    await expect(limitPlanOf(agate, ME, { kind: "cancelLimit", gpu: "H100", month: "2026-11", orderIds: ["9"] }, b)).rejects.toBe(refusal);
  });
});
