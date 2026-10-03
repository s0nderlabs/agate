// AgateSeries handlers: one test per event, the ledger identity over a whole month, I29's shape, a claim of 0 and
// the FINAL close not double-counting.
import { createTestIndexer } from "envio";
import { describe, expect, it } from "vitest";
import { owed } from "../src/lib/math.ts";
import { SEP20, demoTs, listed } from "./build.ts";
import { ev } from "./ev.ts";
import { U, ZERO, series, token, user } from "./world.ts";

type TI = ReturnType<typeof createTestIndexer>;
const run = (indexer: TI, simulate: unknown[]) => indexer.process({ chains: { 10143: { simulate: simulate as never } } });
const S = series(1);
const T = token(1);
const t0 = demoTs(SEP20) + 50;
let blk = 200;
const at = () => ({ src: S, block: blk++, ts: t0 + blk });
const s = (name: string, args: Record<string, unknown>, m: Partial<ReturnType<typeof at>> & { from?: string } = {}) => ev("AgateSeries", name, args, { ...at(), ...m });
const opened = (id: number, side: 0 | 1, q: bigint, paidNow: bigint, o: { owner?: string; payee?: string; operator?: string; daily?: boolean; k?: number } = {}) =>
  s("PositionOpened", { id, owner: o.owner ?? user(1), payee: o.payee ?? user(1), side, q, paidNow, operator: o.operator ?? ZERO, daily: o.daily ?? true, k: o.k ?? 0, to: o.owner ?? user(1) });

async function fresh(): Promise<TI> {
  const indexer = createTestIndexer();
  blk = 200;
  await run(indexer, [listed({ series: S, token: T, block: 100 })]);
  return indexer;
}

describe("series events", () => {
  it("Minted and Redeemed: rows and the ledger", async () => {
    const i = await fresh();
    await run(i, [s("Minted", { payer: user(1), to: user(2), q: 10n * U, cost: 40n * U }, { from: user(1) }), s("Redeemed", { holder: user(2), to: user(3), q: 4n * U, paid: 16n * U })]);
    expect((await i.Series.getOrThrow(S)).ledger).toBe(24n * U);
    const [m] = await i.Mint.getAll();
    expect(m).toMatchObject({ series_id: S, payer_id: user(1), to: user(2), q: 10n * U, cost: 40n * U });
    const [r] = await i.Redeem.getAll();
    expect(r).toMatchObject({ holder_id: user(2), to: user(3), q: 4n * U, paid: 16n * U });
    for (const a of [user(1), user(2), user(3)]) expect(await i.Account.get(a)).toBeDefined();
  });

  it("ShortCredited and ShortDebited carry the new balance; shortSupply follows q (I29: no other event moves a short)", async () => {
    const i = await fresh();
    await run(i, [
      s("ShortCredited", { account: user(1), q: 10n * U, balance: 10n * U }),
      s("ShortCredited", { account: user(2), q: 3n * U, balance: 3n * U }),
      ev("AgateToken", "Transfer", { from: ZERO, to: user(1), value: 10n * U }, { src: T, block: blk++, ts: t0 + blk }),
      ev("AgateToken", "Transfer", { from: user(1), to: user(2), value: 5n * U }, { src: T, block: blk++, ts: t0 + blk }),
      s("ShortDebited", { account: user(1), q: 4n * U, balance: 6n * U }),
    ]);
    expect((await i.ShortBalance.getOrThrow(`${S}-${user(1)}`)).balance).toBe(6n * U);
    expect((await i.ShortBalance.getOrThrow(`${S}-${user(2)}`)).balance).toBe(3n * U);
    expect((await i.Series.getOrThrow(S)).shortSupply).toBe(9n * U);
    expect((await i.ShortBalance.getAll()).length).toBe(2); // the token transfer touched no short balance
  });

  it("PositionOpened: the position, the counters and the floor paid at once", async () => {
    const i = await fresh();
    await run(i, [
      s("Minted", { payer: user(1), to: user(1), q: 100n * U, cost: 400n * U }),
      opened(1, 0, 30n * U, 30n * U, { payee: user(2) }),
      opened(2, 1, 20n * U, 0n, { operator: user(9), daily: false }),
    ]);
    const p1 = await i.Position.getOrThrow(`${S}-1`);
    expect(p1).toMatchObject({ positionId: 1n, owner_id: user(1), payee_id: user(2), operator_id: undefined, side: "LONG", q: 30n * U, paid: 30n * U, daily: true, openedK: 0, status: "OPEN", openTo: user(1) });
    expect(await i.Position.getOrThrow(`${S}-2`)).toMatchObject({ side: "SHORT", operator_id: user(9), daily: false, paid: 0n });
    expect(await i.Series.getOrThrow(S)).toMatchObject({ ledger: 370n * U, openPositions: 2, qInPositionsLong: 30n * U, qInPositionsShort: 20n * U });
  });

  it("Claimed: a Claim row with the sender, paid = paidTotal; a claim of 0 is still a row", async () => {
    const i = await fresh();
    await run(i, [
      s("Minted", { payer: user(1), to: user(1), q: 100n * U, cost: 400n * U }),
      opened(1, 0, 30n * U, 30n * U, { payee: user(2) }),
      s("Claimed", { id: 1, payee: user(2), amount: 2n * U, paidTotal: 32n * U, k: 3 }, { from: user(7) }),
      s("Claimed", { id: 1, payee: user(2), amount: 0n, paidTotal: 32n * U, k: 3 }, { from: user(8) }),
    ]);
    const claims = (await i.Claim.getAll()).sort((a, b) => Number(a.block - b.block));
    expect(claims.map((c) => [c.amount, c.paidTotal, c.k, c.by, c.payee_id, c.position_id])).toEqual([
      [2n * U, 32n * U, 3, user(7), user(2), `${S}-1`],
      [0n, 32n * U, 3, user(8), user(2), `${S}-1`],
    ]);
    expect(await i.Position.getOrThrow(`${S}-1`)).toMatchObject({ paid: 32n * U, status: "OPEN" });
    expect((await i.Series.getOrThrow(S)).ledger).toBe(400n * U - 30n * U - 2n * U);
  });

  it("PositionClosed: FINAL does not double-count its claim, WITH_TOKEN pays out, UNSTREAMED takes back", async () => {
    const i = await fresh();
    await run(i, [
      s("Minted", { payer: user(1), to: user(1), q: 100n * U, cost: 400n * U }),
      opened(1, 0, 10n * U, 10n * U),
      opened(2, 1, 10n * U, 0n),
      opened(3, 0, 10n * U, 10n * U),
      // a final claim: Claimed then PositionClosed FINAL with the same amount, in one transaction
      s("Claimed", { id: 1, payee: user(1), amount: 15n * U, paidTotal: 25n * U, k: 30 }),
      s("PositionClosed", { id: 1, owner: user(1), kind: 0, amount: 15n * U, to: user(1), by: user(6) }),
      s("PositionClosed", { id: 2, owner: user(1), kind: 1, amount: 40n * U, to: user(4), by: user(1) }),
      s("PositionClosed", { id: 3, owner: user(1), kind: 2, amount: 10n * U, to: user(1), by: user(1) }),
    ]);
    expect(await i.Position.getOrThrow(`${S}-1`)).toMatchObject({ status: "CLOSED_FINAL", closedAmount: 15n * U, closedTo: user(1), closedBy: user(6), paid: 25n * U });
    expect(await i.Position.getOrThrow(`${S}-2`)).toMatchObject({ status: "CLOSED_WITH_TOKEN", closedAmount: 40n * U, closedTo: user(4) });
    expect((await i.Position.getOrThrow(`${S}-3`)).status).toBe("UNSTREAMED");
    // 400 in; 20 paid at open; 15 by the final claim; 40 by the close with token; 10 back in by the unstream
    expect(await i.Series.getOrThrow(S)).toMatchObject({ ledger: 335n * U, openPositions: 0, qInPositionsLong: 0n, qInPositionsShort: 0n });
  });

  it("PayoutChanged and OperatorSet (a revoke clears the operator)", async () => {
    const i = await fresh();
    await run(i, [
      opened(1, 0, 10n * U, 0n),
      s("PayoutChanged", { id: 1, payee: user(5), daily: false }),
      s("OperatorSet", { id: 1, operator: user(6) }),
    ]);
    expect(await i.Position.getOrThrow(`${S}-1`)).toMatchObject({ payee_id: user(5), daily: false, operator_id: user(6) });
    await run(i, [s("OperatorSet", { id: 1, operator: ZERO })]);
    expect((await i.Position.getOrThrow(`${S}-1`)).operator_id).toBeUndefined();
  });

  it("Settled: a row and the ledger", async () => {
    const i = await fresh();
    await run(i, [s("Minted", { payer: user(1), to: user(1), q: 10n * U, cost: 40n * U }), s("Settled", { holder: user(1), side: 1, q: 10n * U, paid: 12n * U, to: user(3) })]);
    expect((await i.Settle.getAll())[0]).toMatchObject({ holder_id: user(1), side: "SHORT", q: 10n * U, paid: 12n * U, to: user(3) });
    expect((await i.Series.getOrThrow(S)).ledger).toBe(28n * U);
  });

  it("FixApplied: the day with its flags split, then FINAL at k = n", async () => {
    const i = await fresh();
    const n = (await i.Series.getOrThrow(S)).n;
    const sd = (await i.Series.getOrThrow(S)).startDay;
    await run(i, [s("FixApplied", { k: 1, day: sd, x: 900_000, c: 1_000_000, status: 4, flags: 1 | 8 | 32, sumAfter: 1_000_000n })]);
    expect(await i.SeriesDay.getOrThrow(`${S}-1`)).toMatchObject({
      k: 1,
      day: sd,
      x: 900_000n,
      c: 1_000_000n,
      status: "CARRIED",
      flags: 41,
      late: true,
      incomplete: false,
      forced: false,
      belowFloor: true,
      aboveCap: false,
      carried: true,
      sumAfter: 1_000_000n,
    });
    expect(await i.Series.getOrThrow(S)).toMatchObject({ k: 1, sum: 1_000_000n, lastFixDay: sd, state: "ACCRUING" });
    const rest = [];
    for (let k = 2; k <= n; k++) rest.push(s("FixApplied", { k, day: sd + k - 1, x: 2_000_000, c: 2_000_000, status: 1, flags: k === n ? 4 : 0, sumAfter: 1_000_000n + BigInt(k - 1) * 2_000_000n }));
    await run(i, rest);
    expect(await i.Series.getOrThrow(S)).toMatchObject({ k: n, state: "FINAL", sum: 1_000_000n + BigInt(n - 1) * 2_000_000n });
    expect((await i.SeriesDay.getOrThrow(`${S}-${n}`)).forced).toBe(true);
  });
});

describe("the ledger identity over a whole month", () => {
  it("equals mints in, minus payouts, by MS 4.5's own integers", async () => {
    const i = await fresh();
    const se = await i.Series.getOrThrow(S);
    const { n, floor: F, cap: C, startDay } = se;
    const q = [30n * U, 20n * U, 7n * U + 300n]; // positions: LONG, SHORT, LONG (odd q)
    const side = ["LONG", "SHORT", "LONG"] as const;
    const evs: unknown[] = [s("Minted", { payer: user(1), to: user(1), q: 100n * U, cost: 100n * C }), s("Minted", { payer: user(2), to: user(2), q: 50n * U, cost: 50n * C })];
    let ledger = 150n * C;
    const paid = q.map((x, j) => owed(side[j]!, x, 0, 0n, n, F, C));
    q.forEach((x, j) => {
      evs.push(opened(j + 1, side[j] === "LONG" ? 0 : 1, x, paid[j]!, { owner: user(j + 1) }));
      ledger -= paid[j]!;
    });
    let sum = 0n;
    for (let k = 1; k <= n; k++) {
      const x = 1_500_000n + BigInt((k * 7919) % 3_000_000);
      const c = x < F ? F : x > C ? C : x;
      sum += c;
      evs.push(s("FixApplied", { k, day: startDay + k - 1, x, c, status: 1, flags: 0, sumAfter: sum }));
      for (let j = 0; j < q.length; j++) {
        if (k % (j + 2) !== 0 && k !== n) continue; // each position claims on its own rhythm, all at the end
        const o = owed(side[j]!, q[j]!, k, sum, n, F, C);
        const amt = o - paid[j]!;
        paid[j] = o;
        ledger -= amt;
        evs.push(s("Claimed", { id: j + 1, payee: user(j + 1), amount: amt, paidTotal: o, k }));
        if (k === n) evs.push(s("PositionClosed", { id: j + 1, owner: user(j + 1), kind: 0, amount: amt, to: user(j + 1), by: user(9) }));
      }
    }
    // settles: holders' tokens pay S / N each, shorts (k C - S) / N
    const longPay = (70n * U * sum) / (BigInt(n) * U);
    const shortPay = (60n * U * (BigInt(n) * C - sum)) / (BigInt(n) * U);
    evs.push(s("Settled", { holder: user(1), side: 0, q: 70n * U, paid: longPay, to: user(1) }));
    evs.push(s("Settled", { holder: user(2), side: 1, q: 60n * U, paid: shortPay, to: user(2) }));
    ledger -= longPay + shortPay;
    await run(i, evs);
    const out = await i.Series.getOrThrow(S);
    expect(out).toMatchObject({ ledger, k: n, sum, state: "FINAL", openPositions: 0 });
    expect(ledger).toBeGreaterThanOrEqual(0n);
    for (let j = 0; j < q.length; j++) expect((await i.Position.getOrThrow(`${S}-${j + 1}`)).paid).toBe(owed(side[j]!, q[j]!, n, sum, n, F, C));
  });
});
