// The maker's tick over the fakes (BOTS-SPEC 3.12): a full lifecycle on one book, the decisions, limits, kill switch,
// wind-down, settlement, and restart safety.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEther } from "viem";
import { LOT, U } from "@agate/market";
import { C, DAY, F, H100, makerBook, REF, type Rig, rig, START_DAY } from "./helpers.ts";

let r: Rig;
afterEach(() => r?.cleanup());
const openCodes = (x: Rig): string[] => x.alerts.open().map((a) => a.code as string);

const T = 10_000n; // size units per token
const ladder36: { bids: [bigint, bigint][]; asks: [bigint, bigint][] } = {
  bids: [
    [3_560_000n, 1_000n * T],
    [3_550_000n, 2_000n * T],
    [3_540_000n, 4_000n * T],
  ],
  asks: [
    [3_640_000n, 1_000n * T],
    [3_650_000n, 2_000n * T],
    [3_660_000n, 4_000n * T],
  ],
};

describe("first quote and quiet ticks", () => {
  test("the worked example of 3.3: fair 3.60 gives 3.56/3.55/3.54 and 3.64/3.65/3.66 at 1,000/2,000/4,000 tokens", async () => {
    r = rig();
    const rep = await r.tick();
    expect(rep.decisions[0]!.d).toMatchObject({ act: "requote", cond: 6 });
    expect(makerBook(r)).toEqual(ladder36);
    // pairs minted for the asks (7,000 tokens), deposited; dollars deposited for the bids plus the buffer
    expect(r.s.shortOf(r.maker)).toBe(7_000n * U);
    expect(r.w.margin(r.maker, r.s.token)).toBe(0n);
    const bidLock = (3_560_000n * 1_000n + 3_550_000n * 2_000n + 3_540_000n * 4_000n) * T / 10_000n;
    expect(r.w.margin(r.maker, r.w.dollar)).toBe(100_000_000_000n); // the buffer is what is left after the locks
    expect(bidLock).toBe(24_820_000_000n);
    expect(r.sender.landed()).toEqual(["approve", "deposit", "approve", "mint", "approve", "deposit", "batchUpdate"]);
    // the state knows exactly the six orders
    expect(Object.values(r.mm.state.orders)[0]!.length).toBe(6);
  });

  test("an unchanged world sends nothing (the maker's nonce does not move)", async () => {
    r = rig();
    await r.tick();
    const n = r.sender.nonce;
    for (let i = 0; i < 5; i++) {
      r.w.t += 60n;
      await r.tick();
    }
    expect(r.sender.nonce).toBe(n);
  });

  test("a restart with the state file sends nothing and keeps the same orders", async () => {
    r = rig();
    await r.tick();
    const n = r.sender.nonce;
    const before = JSON.stringify(makerBook(r), (_k, v) => (typeof v === "bigint" ? `${v}` : v));
    r.restart();
    await r.tick();
    expect(r.sender.nonce).toBe(n);
    expect(JSON.stringify(makerBook(r), (_k, v) => (typeof v === "bigint" ? `${v}` : v))).toBe(before);
  });
});

describe("fills, refills and fair moves", () => {
  test("a small fill is left alone; a fill past half the top ask refills it", async () => {
    r = rig();
    await r.tick();
    r.w.tx(() => r.k.takerBuy(r.user, 100n * T)); // 100 tokens of the 1,000 at 3.64
    let n = r.sender.nonce;
    await r.tick();
    expect(r.sender.nonce).toBe(n);
    r.w.tx(() => r.k.takerBuy(r.user, 450n * T)); // now 450 left, under 50 %
    await r.tick();
    expect(r.mm.report.decisions[0]!.d).toMatchObject({ act: "requote", cond: 4 });
    expect(makerBook(r)).toEqual(ladder36);
    // the maker sold 550 tokens at 3.64: its dollars rose by exactly that in its margin account, nothing was minted
    n = r.sender.nonce;
    await r.tick();
    expect(r.sender.nonce).toBe(n);
  });

  test("a fill that empties the top ask (a filled id) is replaced without reverting the batch", async () => {
    r = rig();
    await r.tick();
    r.w.tx(() => r.k.takerBuy(r.user, 1_200n * T)); // all of 3.64 and 200 of 3.65
    await r.tick();
    expect(r.sender.log.at(-1)!.result.ok).toBe(true);
    expect(makerBook(r)).toEqual(ladder36);
  });

  test("a new final day 10 cents higher moves the whole ladder once; an unchanged day sends nothing", async () => {
    r = rig({ config: { staleS: 864_000 } });
    await r.tick();
    r.w.t += BigInt(DAY);
    r.ix.put(H100, r.today() - 1, 3_700_000n);
    await r.tick();
    expect(r.mm.report.decisions[0]!.d).toMatchObject({ act: "requote", cond: 2 }); // the 3.64 ask is under the new fair
    const b = makerBook(r);
    expect(b.bids.map((x) => x[0])).toEqual([3_660_000n, 3_650_000n, 3_640_000n]);
    expect(b.asks.map((x) => x[0])).toEqual([3_740_000n, 3_750_000n, 3_760_000n]);
    const n = r.sender.nonce;
    r.w.t += BigInt(DAY);
    r.ix.put(H100, r.today() - 1, 3_700_000n);
    await r.tick();
    expect(r.sender.nonce).toBe(n);
  });

  test("a move of exactly one tick does not requote; more than one tick does (condition 3)", async () => {
    r = rig({ config: { staleS: 864_000 } });
    await r.tick();
    r.w.t += BigInt(DAY);
    r.ix.put(H100, r.today() - 1, 3_610_000n);
    let n = r.sender.nonce;
    await r.tick();
    expect(r.sender.nonce).toBe(n);
    r.w.t += BigInt(DAY);
    r.ix.put(H100, r.today() - 1, 3_620_000n);
    n = r.sender.nonce;
    await r.tick();
    expect(r.mm.report.decisions[0]!.d).toMatchObject({ act: "requote", cond: 3 });
    expect(r.sender.nonce).toBeGreaterThan(n);
  });

  test("during the month fair is (S + (N - k) x xc) / N", async () => {
    r = rig({ daysBefore: -10 });
    r.s.setPreview(10, 10n * 3_600_000n);
    r.putDays(4_200_000n);
    await r.tick();
    const fair = (36_000_000n + 20n * 4_200_000n) / 30n; // 4.00
    expect(fair).toBe(4_000_000n);
    expect(makerBook(r).bids[0]![0]).toBe(3_960_000n);
    expect(makerBook(r).asks[0]![0]).toBe(4_040_000n);
  });

  test("x outside the band is clamped: an index at 9.00 quotes around C, never above it", async () => {
    r = rig();
    r.putDays(9_000_000n);
    await r.tick();
    const b = makerBook(r);
    expect(b.asks).toEqual([]); // fair = C: every ask would be above C
    expect(b.bids[0]![0]).toBe(7_120_000n); // 7.20 - 1 % = 7.128 -> 7.12
    for (const [p] of b.bids) expect(p).toBeLessThan(C);
  });
});

describe("the crossing guard", () => {
  test("a stranger's ask under the maker's next bid lowers the bid; the batch never reverts", async () => {
    r = rig();
    await r.tick();
    // the stranger rests an ask at 3.62 (above the maker's 3.56 bid, so it rests)
    const stranger = r.user;
    r.w.tx(() => {
      r.w.mintTo(r.s.token, stranger, 100n * U);
      r.w.approve(r.s.token, stranger, r.w.ma, 2n ** 256n - 1n);
      r.w.deposit(stranger, stranger, r.s.token, 100n * U);
      r.k.addSell(stranger, 3_620_000n, 100n * T, true);
    });
    r.w.t += BigInt(DAY);
    r.ix.put(H100, r.today() - 1, 3_700_000n);
    await r.tick();
    const last = r.sender.log.at(-1)!;
    expect(last.spec.functionName).toBe("batchUpdate");
    expect(last.result.ok).toBe(true);
    const b = makerBook(r);
    expect(b.bids.map((x) => x[0])).toEqual([3_610_000n]); // 3.66, 3.65, 3.64 all clamp to 3.61: one kept
    expect(b.asks.map((x) => x[0])).toEqual([3_740_000n, 3_750_000n, 3_760_000n]);
    expect(r.sender.log.filter((x) => x.result.sent && !x.result.ok)).toEqual([]);
  });
});

describe("inventory limits", () => {
  test("asks stop once the maker is net short maxNetTokens; bids stay; buying back reopens them", async () => {
    r = rig({ config: { maxNetTokens: 1_500, sizesTokens: [1000, 1000, 1000] } });
    await r.tick();
    r.w.tx(() => r.k.takerBuy(r.user, 1_000n * T));
    await r.tick(); // refill (E = -1,000 > -1,500)
    r.w.tx(() => r.k.takerBuy(r.user, 600n * T));
    await r.tick();
    // E = -1,600: no asks
    expect(makerBook(r).asks).toEqual([]);
    expect(makerBook(r).bids.length).toBe(3);
    expect(openCodes(r).includes("MM_INVENTORY_CAP")).toBe(true);
    // the user sells 600 back into the bids: E = -1,000, asks come back
    r.w.mintTo(r.s.token, r.user, 0n);
    r.w.tx(() => r.k.takerSell(r.user, 600n * T));
    await r.tick();
    expect(makerBook(r).asks.length).toBeGreaterThan(0);
  });

  test("the pairs cap limits what is minted and cuts the asks", async () => {
    r = rig({ config: { maxPairsTokens: 2_500 } });
    await r.tick();
    expect(r.s.shortOf(r.maker)).toBe(2_500n * U);
    const asks = makerBook(r).asks;
    expect(asks.reduce((s, a) => s + a[1], 0n)).toBe(2_500n * T);
    expect(asks[0]).toEqual([3_640_000n, 1_000n * T]);
  });
});

describe("kill switch and loss limit", () => {
  test("KILL cancels every order within one tick and places nothing; unkill requotes", async () => {
    r = rig();
    await r.tick();
    writeFileSync(r.mm.killPath(), "test");
    await r.tick();
    expect(makerBook(r)).toEqual({ bids: [], asks: [] });
    expect(openCodes(r).includes("MM_KILLED")).toBe(true);
    const n = r.sender.nonce;
    await r.tick();
    expect(r.sender.nonce).toBe(n);
    rmSync(r.mm.killPath());
    await r.tick();
    expect(makerBook(r)).toEqual(ladder36);
    expect(openCodes(r).includes("MM_KILLED")).toBe(false);
  });

  test("a jump after fills drives pnl under -maxLossU: the kill engages with MM_LOSS_LIMIT", async () => {
    r = rig({ config: { maxLossU: 100_000_000 } }); // $100
    await r.tick();
    r.w.tx(() => r.k.takerBuy(r.user, 1_000n * T)); // the maker sold 1,000 at 3.64
    await r.tick();
    r.w.t += BigInt(DAY);
    r.ix.put(H100, r.today() - 1, 4_000_000n); // the maker is short 1,000 tokens; fair +0.40 = -$400 mark
    await r.tick();
    expect(r.mm.report.killed).toBe("loss");
    expect(existsSync(r.mm.killPath())).toBe(true);
    expect(openCodes(r)).toContain("MM_LOSS_LIMIT");
    expect(makerBook(r)).toEqual({ bids: [], asks: [] });
    // unkill (a person decided): the limit re-arms maxLossU under the value at unkill, so it quotes again
    writeFileSync(join(r.dir, "UNKILL"), "");
    await r.tick();
    expect(r.mm.report.killed).toBe(null);
    await r.tick();
    expect(makerBook(r).bids.length).toBe(3);
  });
});

describe("wind-down and settlement", () => {
  test("past stopAt: cancel, withdraw the token, redeem pairs; at k == N settle the rest and drop the series", async () => {
    r = rig({ daysBefore: -29 }); // day 30 of 30 running
    r.s.setPreview(29, 29n * REF);
    await r.tick();
    expect(makerBook(r).asks.length).toBe(3);
    // the maker sells 100 tokens so it is net short after the redeem
    r.w.tx(() => r.k.takerBuy(r.user, 100n * T));
    const endTs = BigInt((START_DAY + 30) * DAY);
    r.w.t = endTs - 1_000n; // past stopAt = end - 3,600
    await r.tick();
    expect(makerBook(r)).toEqual({ bids: [], asks: [] });
    const fns = r.sender.log.slice(-3).map((x) => x.spec.functionName);
    expect(fns).toEqual(["batchUpdate", "withdraw", "redeem"]);
    expect(r.w.margin(r.maker, r.s.token)).toBe(0n);
    expect(r.w.balanceOf(r.s.token, r.maker)).toBe(0n);
    expect(r.s.shortOf(r.maker)).toBe(100n * U);
    // the month ends and every day is applied: settle the short and drop the series
    r.w.t = endTs + 30_000n;
    r.s.setPreview(30, 30n * REF);
    await r.tick();
    expect(r.sender.log.at(-1)!.spec.functionName).toBe("settle");
    expect(r.s.shortOf(r.maker)).toBe(0n);
    expect(Object.keys(r.mm.state.series)).toEqual([]);
    expect(r.alerts.all().map((a) => a.code as string).includes("MM_SETTLED")).toBe(true);
  });
});

describe("restart safety (3.10)", () => {
  test("no state file: the full id scan finds the maker's active orders among 1,000 ids", async () => {
    r = rig();
    const other = r.user;
    r.w.tx(() => {
      // margin credits backed by the MarginAccount's own wallet, as deposits would leave it
      r.w.mintTo(r.w.dollar, r.w.ma, 2_000_000n * U);
      r.w.mintTo(r.s.token, r.w.ma, 10_000n * U);
      r.w.creditMargin(other, r.w.dollar, 1_000_000n * U);
      r.w.creditMargin(r.maker, r.w.dollar, 1_000_000n * U);
      r.w.creditMargin(r.maker, r.s.token, 10_000n * U);
      for (let i = 0; i < 1_000; i++) {
        const who = i % 3 === 0 ? r.maker : other;
        const isBuy = i % 2 === 0;
        const price = isBuy ? 1_900_000n + BigInt(i % 50) * 10_000n : 7_000_000n - BigInt(i % 20) * 10_000n;
        if (isBuy) r.k.addBuy(who, price, 10_000n, true);
        else if (who === r.maker) r.k.addSell(who, price, 10_000n, true);
        else r.k.addBuy(who, 1_800_000n, 10_000n, true);
      }
    });
    // some of the maker's orders cancelled, some filled
    const mine = [...r.k.data.orders].filter(([, o]) => o.owner === r.maker).map(([id]) => id);
    r.w.tx(() => {
      for (const id of mine.slice(0, 20)) r.k.cancel(r.maker, id);
    });
    r.w.mintTo(r.s.token, r.user, 5n * U);
    r.w.tx(() => r.k.takerSell(r.user, 5n * 10_000n)); // the five best bids filled (some are the maker's)
    const truth = [...r.k.data.orders].filter(([id, o]) => o.owner === r.maker && r.k.status(id) === "ACTIVE").map(([id]) => id).sort((a, b) => (a < b ? -1 : 1));
    rmSync(join(r.dir, "state.json"), { force: true });
    r.restart();
    await r.mm.init();
    const got = (r.mm.state.orders[r.k.address.toLowerCase()] ?? []).map((o) => o.id).sort((a, b) => (a < b ? -1 : 1));
    expect(got).toEqual(truth);
    expect(got.length).toBeGreaterThan(250);
  });

  test("a crash after the batch landed: the restart finds the new orders and never cancels a cancelled id", async () => {
    r = rig();
    await r.tick();
    // a fair move; the batch lands and the process dies before it reads the receipt
    r.w.t += BigInt(DAY);
    r.ix.put(H100, r.today() - 1, 3_700_000n);
    r.sender.faults.push({ kind: "crashAfterLanding", match: (s) => s.functionName === "batchUpdate" });
    await expect(r.tick()).resolves.toBeDefined(); // the maker catches the throw as an unconfirmed send
    r.restart();
    const n0 = r.sender.nonce;
    await r.tick();
    expect(r.sender.nonce).toBe(n0); // the landed ladder is recognised: no second requote
    // the new ladder is there exactly once; no failed or reverted send afterwards
    const b = makerBook(r);
    expect(b.bids.map((x) => x[0])).toEqual([3_660_000n, 3_650_000n, 3_640_000n]);
    expect(b.asks.map((x) => x[0])).toEqual([3_740_000n, 3_750_000n, 3_760_000n]);
    const after = r.sender.log.slice(-3);
    expect(after.every((x) => x.result.ok || !x.result.sent)).toBe(true);
    expect(r.sender.log.filter((x) => x.result.error?.includes("OnlyOwnerAllowedError"))).toEqual([]);
    // and the next tick is quiet
    const n = r.sender.nonce;
    await r.tick();
    expect(r.sender.nonce).toBe(n);
  });

  test("a crash after the batch landed and the state file lost: the full scan recovers the same active set", async () => {
    r = rig();
    await r.tick();
    r.w.t += BigInt(DAY);
    r.ix.put(H100, r.today() - 1, 3_700_000n);
    r.sender.faults.push({ kind: "crashAfterLanding", match: (s) => s.functionName === "batchUpdate" });
    await r.tick();
    rmSync(join(r.dir, "state.json"));
    r.restart();
    await r.tick();
    const active = [...r.k.data.orders].filter(([id, o]) => o.owner === r.maker && r.k.status(id) === "ACTIVE");
    expect(active.length).toBe(6);
    expect(r.sender.log.filter((x) => x.result.sent && !x.result.ok)).toEqual([]);
  });
});

describe("sends and budgets", () => {
  test("three failed sends in a row on one book raise MM_SEND_FAILED", async () => {
    r = rig();
    for (let i = 0; i < 3; i++) {
      r.sender.faults.push({ kind: "simRevert", match: (s) => s.functionName === "batchUpdate" });
      await r.tick();
    }
    expect(openCodes(r)).toContain("MM_SEND_FAILED");
    await r.tick();
    expect(makerBook(r)).toEqual(ladder36);
    expect(openCodes(r)).not.toContain("MM_SEND_FAILED");
  });

  test("a budget of almost nothing: no requote, but the kill's cancels still go out (safety)", async () => {
    r = rig();
    await r.tick();
    // a new day with a tiny balance above keep: B is nearly zero
    r.w.t += BigInt(DAY);
    r.w.setMon(r.maker, parseEther("20.01"));
    r.ix.put(H100, r.today() - 1, 3_620_000n);
    await r.tick();
    expect(r.sender.log.at(-1)!.result.error).toBe("BUDGET");
    expect(openCodes(r)).toContain("MM_BUDGET_SPENT");
    r.w.setMon(r.maker, parseEther("30"));
    writeFileSync(r.mm.killPath(), "test");
    await r.tick();
    expect(makerBook(r)).toEqual({ bids: [], asks: [] });
  });

  test("the floor: no send at all when MON is under keep plus the cost", async () => {
    r = rig({ mon: parseEther("20") });
    await r.tick();
    expect(r.sender.nonce).toBe(0);
    expect(r.sender.log[0]!.result.error).toBe("FLOOR");
    expect(openCodes(r)).toContain("MM_KEY_LOW");
  });

  test("a hard-paused market keeps the order list and is cancelled once it is back", async () => {
    r = rig();
    await r.tick();
    r.k.data.state = 2;
    const n = r.sender.nonce;
    await r.tick();
    expect(r.sender.nonce).toBe(n);
    expect(openCodes(r)).toContain("MM_MARKET_PAUSED");
    r.k.data.state = 1; // soft pause: cancels only
    await r.tick();
    expect(makerBook(r)).toEqual({ bids: [], asks: [] });
    r.k.data.state = 0;
    await r.tick();
    expect(makerBook(r)).toEqual(ladder36);
  });

  test("no final index value in the walk: MM_NO_INDEX and nothing quoted", async () => {
    r = rig();
    for (const k of [...r.ix.data.recs.keys()]) r.ix.data.recs.delete(k);
    await r.tick();
    expect(r.sender.nonce).toBe(0);
    expect(openCodes(r)).toContain("MM_NO_INDEX");
  });

  test("a replaced market is wound down and the new one quoted", async () => {
    r = rig();
    await r.tick();
    const old = r.k;
    old.data.state = 1;
    const k2 = r.w.addMarket(r.f, r.s);
    await r.tick();
    expect([...old.data.orders].filter(([id, o]) => o.owner === r.maker && old.status(id) === "ACTIVE")).toEqual([]);
    const fresh = [...k2.data.orders].filter(([id, o]) => o.owner === r.maker && k2.status(id) === "ACTIVE");
    expect(fresh.length).toBe(6);
  });

  test("stop (SIGTERM): no new send starts", async () => {
    r = rig();
    r.mm.stop();
    const rep = await r.tick();
    expect(r.sender.nonce).toBe(0);
    expect(rep.sends.every((s) => s.error === "stopping")).toBe(true);
  });

  test("rebase sets the baseline to the value now and requotes every book once", async () => {
    r = rig();
    await r.tick();
    r.w.tx(() => r.k.takerBuy(r.user, 100n * T));
    r.w.mintTo(r.w.dollar, r.maker, 1_000_000n * U); // a float top-up
    writeFileSync(join(r.dir, "REBASE"), "");
    await r.tick();
    expect(r.mm.report.pnl).toBe(0n);
    expect(r.mm.report.decisions[0]!.d).toMatchObject({ act: "requote", cond: 6 });
    expect(makerBook(r)).toEqual(ladder36);
  });

  test("cancel-all cancels without killing; the next tick requotes", async () => {
    r = rig();
    await r.tick();
    writeFileSync(join(r.dir, "CANCEL_ALL"), "");
    await r.tick();
    expect(makerBook(r)).toEqual({ bids: [], asks: [] });
    await r.tick();
    expect(makerBook(r)).toEqual(ladder36);
  });

  test("withdraw-all needs the kill switch, then empties the margin account", async () => {
    r = rig();
    await r.tick();
    writeFileSync(join(r.dir, "WITHDRAW_ALL"), "");
    await r.tick();
    expect(r.w.margin(r.maker, r.w.dollar)).toBeGreaterThan(0n);
    writeFileSync(r.mm.killPath(), "test");
    writeFileSync(join(r.dir, "WITHDRAW_ALL"), "");
    await r.tick();
    expect(r.w.margin(r.maker, r.w.dollar)).toBe(0n);
    expect(r.w.margin(r.maker, r.s.token)).toBe(0n);
  });

  test("every quote of a long random run keeps the invariants on the real book", async () => {
    r = rig();
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let i = 0; i < 60; i++) {
      const roll = rnd();
      if (roll < 0.3) {
        r.w.t += BigInt(DAY);
        r.ix.put(H100, r.today() - 1, 2_000_000n + BigInt(Math.floor(rnd() * 400)) * 10_000n);
      } else if (roll < 0.55) {
        const units = BigInt(1 + Math.floor(rnd() * 2_000)) * T;
        r.w.tx(() => r.k.takerBuy(r.user, units));
      } else if (roll < 0.8) {
        const units = BigInt(1 + Math.floor(rnd() * 2_000)) * T;
        r.w.mintTo(r.s.token, r.user, units * LOT);
        r.w.tx(() => r.k.takerSell(r.user, units));
      }
      await r.tick();
      expect(r.sender.log.filter((x) => x.result.sent && !x.result.ok)).toEqual([]);
      const b = makerBook(r);
      const bestBid = b.bids[0]?.[0];
      const bestAsk = b.asks[0]?.[0];
      if (bestBid !== undefined && bestAsk !== undefined) expect(bestBid).toBeLessThan(bestAsk);
      for (const [p] of [...b.bids, ...b.asks]) {
        expect(p % 10_000n).toBe(0n);
        expect(p).toBeGreaterThanOrEqual(F);
        expect(p).toBeLessThanOrEqual(C);
      }
    }
  });
});
