// BOTS-SPEC 3.6 and section 1: the getL2Book layout, own-order subtraction, receipt parsing with real encodings, and
// FakeKuru checked against Kuru's rules (post-only revert, a cancelled id reverts, a filled id does not).
import { describe, expect, test } from "bun:test";
import { type Address, encodeAbiParameters, encodeEventTopics, type Hex, type Log, toFunctionSelector, toEventSelector } from "viem";
import { decodeL2Book, kuruStatus, othersBest, parseBatchLogs } from "../src/book.ts";
import { kuruMarginAccountAbi, kuruOrderBookAbi, U } from "@agate/market";
import { fakeAddress, FakeRevert, FakeWorld } from "../src/fake/index.ts";

const word = (x: bigint) => x.toString(16).padStart(64, "0");

describe("getL2Book bytes", () => {
  test("block, bids best first, a zero word, asks best first", () => {
    const hex = `0x${[123n, 3_560_000n, 5n, 3_550_000n, 7n, 0n, 3_640_000n, 9n].map(word).join("")}` as Hex;
    expect(decodeL2Book(hex)).toEqual({ block: 123n, bids: [[3_560_000n, 5n], [3_550_000n, 7n]], asks: [[3_640_000n, 9n]] });
    expect(decodeL2Book(`0x${[9n, 0n].map(word).join("")}` as Hex)).toEqual({ block: 9n, bids: [], asks: [] });
    expect(decodeL2Book(`0x${[9n, 0n, 7n, 1n].map(word).join("")}` as Hex)).toEqual({ block: 9n, bids: [], asks: [[7n, 1n]] });
  });
  test("the others' best bid and ask: the book minus the maker's own remaining", () => {
    const book = { block: 1n, bids: [[3_560_000n, 10n], [3_550_000n, 4n]] as [bigint, bigint][], asks: [[3_640_000n, 10n], [3_700_000n, 1n]] as [bigint, bigint][] };
    const own = [
      { id: 1n, isBuy: true, price: 3_560_000n, size: 10n, remaining: 10n },
      { id: 2n, isBuy: false, price: 3_640_000n, size: 20n, remaining: 6n },
    ];
    expect(othersBest(book, own)).toEqual({ bid: 3_550_000n, ask: 3_640_000n });
    expect(othersBest({ block: 1n, bids: [], asks: [] }, own)).toEqual({ bid: null, ask: null });
  });
  test("Kuru's status rule", () => {
    expect(kuruStatus(5n, 0n, 9n)).toBe("CANCELED");
    expect(kuruStatus(5n, 1n, 0n)).toBe("FILLED");
    expect(kuruStatus(5n, 1n, 6n)).toBe("FILLED");
    expect(kuruStatus(5n, 1n, 5n)).toBe("ACTIVE");
    expect(kuruStatus(5n, 1n, 3n)).toBe("ACTIVE");
  });
});

describe("receipt parsing", () => {
  const M = "0x00000000000000000000000000000000000000aa" as Address;
  const me = "0x00000000000000000000000000000000000000bb" as Address;
  const other = "0x00000000000000000000000000000000000000cc" as Address;
  function log(address: Address, name: "OrderCreated" | "OrderCanceled" | "OrdersCanceled", values: unknown[]): Log {
    const ev = kuruOrderBookAbi.find((x) => x.type === "event" && x.name === name) as { inputs: readonly { name: string; type: string }[] };
    return { address, topics: encodeEventTopics({ abi: kuruOrderBookAbi, eventName: name }) as [Hex], data: encodeAbiParameters(ev.inputs, values) } as unknown as Log;
  }
  test("the maker's OrderCreated ids and every id it cancelled, on this market only", () => {
    const logs = [
      log(M, "OrderCanceled", [7, me, 3_560_000, 10_000_000n, true]),
      log(M, "OrdersCanceled", [[7, 0], me]),
      log(M, "OrderCreated", [9, me, 10_000_000n, 3_560_000, true]),
      log(M, "OrderCreated", [10, other, 10_000n, 3_000_000, true]),
      log("0x00000000000000000000000000000000000000dd", "OrderCreated", [11, me, 10_000n, 3_000_000, true]),
      log(M, "OrderCreated", [12, me, 40_000_000n, 3_660_000, false]),
    ];
    expect(parseBatchLogs(logs, M, me)).toEqual({
      created: [
        { id: 9n, isBuy: true, price: 3_560_000n, size: 10_000_000n, remaining: 10_000_000n },
        { id: 12n, isBuy: false, price: 3_660_000n, size: 40_000_000n, remaining: 40_000_000n },
      ],
      canceled: [7n],
    });
  });
});

describe("Appendix C against Appendix D", () => {
  test("every selector and topic the spec checked on the deployed implementations", () => {
    const fn = (sig: string) => toFunctionSelector(sig);
    expect(fn("addBuyOrder(uint32,uint96,bool)")).toBe("0xa09e9040");
    expect(fn("addSellOrder(uint32,uint96,bool)")).toBe("0x40e79b1b");
    expect(fn("batchUpdate(uint32[],uint96[],uint32[],uint96[],uint40[],bool)")).toBe("0x5339c59f");
    expect(fn("s_orders(uint40)")).toBe("0x1c0d9c22");
    expect(fn("s_orderIdCounter()")).toBe("0x2bf1360e");
    expect(fn("getL2Book()")).toBe("0x46fdfbb1");
    expect(fn("marketState()")).toBe("0x08fb1b77");
    expect(fn("s_buyPricePoints(uint256)")).toBe("0xe6d29b51");
    expect(fn("s_sellPricePoints(uint256)")).toBe("0x0e2e2ffe");
    expect(fn("deposit(address,address,uint256)")).toBe("0x8340f549");
    expect(fn("withdraw(uint256,address)")).toBe("0x00f714ce");
    expect(fn("getBalance(address,address)")).toBe("0xd4fac45d");
    const topic = (name: string) => toEventSelector((kuruOrderBookAbi.find((x) => x.type === "event" && x.name === name) as never));
    expect(topic("Trade")).toBe("0xf16924fba1c18c108912fcacaac7450c98eb3f2d8c0a3cdf3df7066c08f21581");
    expect(topic("OrderCreated").startsWith("0xb81bbaf1")).toBe(true);
    expect(topic("OrdersCanceled").startsWith("0x386974f4")).toBe(true);
    expect(topic("OrderCanceled").startsWith("0xd9c08981")).toBe(true);
    expect(kuruMarginAccountAbi.length).toBe(8);
  });
});

describe("FakeKuru follows Kuru's rules (3.6)", () => {
  function setup() {
    const w = new FakeWorld();
    const token = fakeAddress(20);
    const ix = w.addIndex();
    const f = w.addFactory(ix);
    const { kuru: k } = w.list(f, "0x01", 1, { startDay: 1, startTs: 86_400n, n: 30, floor: 1_800_000n, cap: 7_200_000n });
    const maker = fakeAddress(21);
    const taker = fakeAddress(22);
    w.mintTo(w.dollar, w.ma, 10n ** 15n);
    w.mintTo(k.base, w.ma, 10n ** 15n);
    w.creditMargin(maker, w.dollar, 1_000_000n * U);
    w.creditMargin(maker, k.base, 1_000_000n * U);
    w.mintTo(w.dollar, taker, 1_000_000n * U);
    void token;
    return { w, k, maker, taker };
  }
  test("a post-only add that would match reverts the whole batch", () => {
    const { w, k, maker } = setup();
    w.tx(() => k.addSell(maker, 3_640_000n, 10_000n, true));
    expect(() => w.tx(() => k.batchUpdate(maker, [3_640_000n], [10_000n], [], [], [], true))).toThrow(FakeRevert);
    expect(k.data.counter).toBe(1n);
  });
  test("cancel of a cancelled id reverts OnlyOwnerAllowedError; of a filled id it does not (and deletes the slot)", () => {
    const { w, k, maker, taker } = setup();
    w.tx(() => {
      k.addSell(maker, 3_640_000n, 10_000n, true);
      k.addSell(maker, 3_650_000n, 10_000n, true);
    });
    w.tx(() => k.batchUpdate(maker, [], [], [], [], [1n], true));
    expect(k.status(1n)).toBe("CANCELED");
    expect(() => w.tx(() => k.batchUpdate(maker, [], [], [], [], [1n], true))).toThrow("OnlyOwnerAllowedError");
    w.tx(() => k.takerBuy(taker, 15_000n)); // fills id 2 fully (more incoming than it had: its slot keeps its size)
    expect(k.status(2n)).toBe("FILLED");
    expect(k.sOrder(2n).size).toBe(10_000n);
    const before = w.margin(maker, k.base);
    w.tx(() => k.batchUpdate(maker, [], [], [], [], [2n], true));
    expect(w.margin(maker, k.base)).toBe(before); // nothing credited for a filled id
    expect(k.sOrder(2n).owner).toBe("0x0000000000000000000000000000000000000000");
    expect(() => w.tx(() => k.batchUpdate(maker, [], [], [], [], [2n], true))).toThrow("OnlyOwnerAllowedError");
  });
  test("a partial fill keeps the order active with its remainder; the L2 book sums per price", () => {
    const { w, k, maker, taker } = setup();
    w.tx(() => {
      k.addSell(maker, 3_640_000n, 10_000n, true);
      k.addSell(maker, 3_640_000n, 20_000n, true);
      k.addBuy(maker, 3_560_000n, 30_000n, true);
    });
    w.tx(() => k.takerBuy(taker, 4_000n));
    expect(k.status(1n)).toBe("ACTIVE");
    expect(k.sOrder(1n).size).toBe(6_000n);
    expect(decodeL2Book(k.l2Bytes())).toEqual({ block: w.block, bids: [[3_560_000n, 30_000n]], asks: [[3_640_000n, 26_000n]] });
    // the maker was paid exactly 4,000 units at 3.64 into its margin account
    expect(w.margin(maker, w.dollar)).toBe(1_000_000n * U - 3_560_000n * 3n + 3_640_000n * 4_000n / 10_000n);
  });
  test("a bid locks price x size / 10^4 dollars, an ask size x 100 tokens; a cancel gives both back", () => {
    const { w, k, maker } = setup();
    const d0 = w.margin(maker, w.dollar);
    const t0 = w.margin(maker, k.base);
    w.tx(() => k.batchUpdate(maker, [3_560_000n], [10_000_000n], [3_640_000n], [10_000_000n], [], true));
    expect(d0 - w.margin(maker, w.dollar)).toBe(3_560_000_000n);
    expect(t0 - w.margin(maker, k.base)).toBe(1_000n * U);
    w.tx(() => k.batchUpdate(maker, [], [], [], [], [1n, 2n], true));
    expect(w.margin(maker, w.dollar)).toBe(d0);
    expect(w.margin(maker, k.base)).toBe(t0);
  });
});
