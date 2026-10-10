// The Kuru Spot V2 desk (v2.ts): units, the book's own-quantity removal, fitting a side to a budget, the decision rules,
// the kuruV2 config, and a full cycle on a fake V2 chain (first quote with a mint and two deposits, adoption, a fill,
// the kill's cancel-all, a final series' tokens withdrawn).
import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { type L2Book, type SendResult, type SendSpec, U, type V2Params } from "@agate/market";
import { parseConfig } from "../src/config.ts";
import { emptyState, type MmState } from "../src/state.ts";
import { baseAtoms, bidReserve, decideV2, fitSide, fromV2Price, notional, othersBestV2, toV2Price, toV2Qty, type V2Cfg, V2Desk, type V2Host, type V2Order, v2Orders, type V2Series } from "../src/v2.ts";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const MARKET = A(0xb00c);
const SERIES = A(0x5e71e5);
const TOKEN = A(0x70c3);
const USDC = A(0x05dc);
const DOLLAR = A(0xd011a);
const AC = A(0xacc0);
const MAKER = A(0x3a3e);

/** The pilot book as suggested to Kuru: $0.01 tick, 0.0001 GPU-hour lots, $10 minimum, 0.4% maker fee. */
const P: V2Params = { pricePrecision: 1_000_000n, sizePrecision: 10_000n, tickSize: 10_000n, minQuoteNotional: 10_000_000n, maxQuoteNotional: 5_000_000_000_000n, makerFeePps: 4_000n, base: TOKEN, quote: USDC, quoteDecimals: 6 };
/** Kuru's live MON/USDC shape (raw tick 1, 1e6 size precision). */
const P2: V2Params = { ...P, sizePrecision: 1_000_000n, tickSize: 1n };

describe("units", () => {
  test("prices: bids round down, asks up, on V2's tick", () => {
    expect(toV2Price(4_005_000n, P, "bid")).toBe(4_000_000n);
    expect(toV2Price(4_005_000n, P, "ask")).toBe(4_010_000n);
    expect(toV2Price(4_005_000n, P2, "ask")).toBe(4_005_000n);
    expect(toV2Price(4_000_000n, { ...P, pricePrecision: 100n, tickSize: 1n }, "bid")).toBe(400n);
    expect(fromV2Price(400n, { ...P, pricePrecision: 100n }, "down")).toBe(4_000_000n);
  });
  test("sizes, atoms, notional, a bid's reserve with the maker fee", () => {
    expect(toV2Qty(10n * 10_000n, P)).toBe(100_000n); // 10 tokens
    expect(toV2Qty(10n * 10_000n, P2)).toBe(10_000_000n);
    expect(baseAtoms(100_000n, P)).toBe(10n * U);
    const o: V2Order = { side: 0, price: 4_000_000n, qty: 100_000n };
    expect(notional(o, P)).toBe(40_000_000n); // $40
    expect(bidReserve(o, P)).toBe(40_160_000n); // + 0.4%
  });
  test("a ladder as V2 orders: under the minimum notional is dropped", () => {
    const os = v2Orders({ bids: [{ price: 3_960_000n, size: 20_000n }, { price: 3_950_000n, size: 100_000n }], asks: [{ price: 4_040_000n, size: 100_000n }] }, P);
    expect(os).toEqual([
      { side: 0, price: 3_950_000n, qty: 100_000n },
      { side: 1, price: 4_040_000n, qty: 100_000n },
    ]);
  });
  test("others' best leaves the maker's own quantity out", () => {
    const book: L2Book = { block: 0n, bids: [[3_960_000n, 100_000n], [3_950_000n, 5n]], asks: [[4_040_000n, 100_000n], [4_100_000n, 70n]] };
    expect(othersBestV2(book, { bids: [[3_960_000n, 100_000n]], asks: [[4_040_000n, 100_000n]] })).toEqual({ bid: 3_950_000n, ask: 4_100_000n });
    expect(othersBestV2(book, { bids: [], asks: [] })).toEqual({ bid: 3_960_000n, ask: 4_040_000n });
  });
  test("a side fitted to a budget, from the best level out, in whole steps", () => {
    const asks: V2Order[] = [
      { side: 1, price: 4_040_000n, qty: 100_000n },
      { side: 1, price: 4_050_000n, qty: 200_000n },
    ];
    expect(fitSide(asks, 15n * U, (o) => baseAtoms(o.qty, P), P, 1n)).toEqual([asks[0]!, { ...asks[1]!, qty: 50_000n }]);
    expect(fitSide(asks, 2n * U, (o) => baseAtoms(o.qty, P), P, 1n)).toEqual([]); // 2 tokens at $4.04 is under $10
  });
});

describe("decideV2", () => {
  const bc = { requoteMoveU: 10_000n, replenishBelowPct: 50, staleS: 21_600, minRequoteS: 10 };
  const rec = { fair: 4_000_000n, lo: 4_000_000n, hi: 4_000_000n, at: 1_000, ids: [7n, 8n], base: 20n * U, quote: 40_000_000n, bids: [], asks: [] };
  const base = { t: 1_100, nowMs: 1_100_000, cancelOnly: null, own: 2, slots: [7n, 8n], locked: { base: 20n * U, quote: 40_000_000n }, fair: 4_000_000n, lo: null, hi: null, rec, lastSendMs: null, bc };
  test("the rules", () => {
    expect(decideV2({ ...base, rec: null })).toEqual({ act: "requote", why: "first quote" });
    expect(decideV2(base)).toEqual({ act: "none" });
    expect(decideV2({ ...base, slots: [7n, 0n] }).act).toBe("requote");
    expect(decideV2({ ...base, locked: { base: 9n * U, quote: 40_000_000n } })).toEqual({ act: "requote", why: "asks filled" });
    expect(decideV2({ ...base, locked: { base: 20n * U, quote: 1n } })).toEqual({ act: "requote", why: "bids filled" });
    // V1's condition 3: strictly over requoteMoveU, the largest of the fair and band moves (a 1 u wobble is nothing)
    expect(decideV2({ ...base, fair: 4_000_001n })).toEqual({ act: "none" });
    expect(decideV2({ ...base, fair: 4_010_000n })).toEqual({ act: "none" });
    expect(decideV2({ ...base, fair: 4_010_001n })).toEqual({ act: "requote", why: "fair moved" });
    expect(decideV2({ ...base, hi: 4_100_000n })).toEqual({ act: "requote", why: "fair or its band moved" });
    expect(decideV2({ ...base, hi: 3_000_000n, lo: 5_000_000n })).toEqual({ act: "none" }); // edges on the wrong side of fair are fair
    expect(decideV2({ ...base, t: 1_000 + 21_600 })).toEqual({ act: "requote", why: "stale" });
    expect(decideV2({ ...base, rec: null, lastSendMs: 1_095_000 })).toEqual({ act: "none", why: "min requote interval" });
    expect(decideV2({ ...base, rec: { ...rec, ids: null } })).toEqual({ act: "none", why: "adopting" });
    expect(decideV2({ ...base, cancelOnly: "wind-down" })).toEqual({ act: "cancel", why: "wind-down" });
    expect(decideV2({ ...base, cancelOnly: "wind-down", own: 0 })).toEqual({ act: "none", why: "wind-down" });
    expect(decideV2({ ...base, fair: null })).toEqual({ act: "none", why: "no fair" });
  });
});

describe("config kuruV2", () => {
  test("defaults and refusals", () => {
    const c = parseConfig(JSON.stringify({ kuruV2: { books: [{ market: MARKET, series: SERIES }] } }));
    expect(c.kuruV2!.levels).toBe(2);
    expect(c.kuruV2!.sizesTokens).toEqual([10, 20]);
    expect(c.kuruV2!.maxBaseTokens).toBe(100);
    expect(c.kuruV2!.spreadBps).toBe(c.spreadBps);
    expect(c.kuruV2!.accountCore).toBe("0xdbaaDe7B42c95399bb1E9614D51B5B9e2cf78038");
    expect(parseConfig(JSON.stringify({ kuruV2: { books: [{ market: MARKET, series: SERIES }], spreadBps: 200, maxBaseTokens: 50 } })).kuruV2!.spreadBps).toBe(200);
    expect(() => parseConfig(JSON.stringify({ kuruV2: { books: [] } }))).toThrow("kuruV2.books");
    expect(() => parseConfig(JSON.stringify({ kuruV2: { books: [{ market: "0x1", series: SERIES }] } }))).toThrow("books[0]");
    expect(() => parseConfig(JSON.stringify({ kuruV2: { books: [{ market: MARKET, series: SERIES }], keepMon: 1 } }))).toThrow("unknown field kuruV2.keepMon");
    // fields the V2 desk does not read are refused, not silently ignored
    for (const f of ["maxNetTokens", "maxPairsTokens", "stopBeforeEndS"]) expect(() => parseConfig(JSON.stringify({ kuruV2: { books: [{ market: MARKET, series: SERIES }], [f]: 1 } }))).toThrow(`unknown field kuruV2.${f}`);
    expect(() => parseConfig(JSON.stringify({ kuruV2: { books: [{ market: MARKET, series: SERIES }, { market: MARKET, series: SERIES }] } }))).toThrow("twice");
  });
});

// ------------------------------------------------------------------ a fake V2 chain and host

class World {
  id = 0;
  free = new Map<string, bigint>(); // token -> free in the account
  slots: bigint[] = Array(8).fill(0n);
  locked = { base: 0n, quote: 0n };
  wallet = new Map<string, bigint>([[USDC, 1_000_000_000n], [TOKEN, 0n]]); // $1,000 of USDC
  nextOrder = 100n;
  state = 0;
  sends: SendSpec[] = [];
  book: L2Book = { block: 0n, bids: [], asks: [] };
  st: MmState = emptyState();
  now = 0;
  holds: Address[] = [];
  alerts: string[] = [];
  broken = new Set<string>(); // markets whose reads revert

  reads() {
    return {
      v2Params: async (m: Address) => {
        if (this.broken.has(m)) throw new Error("getMarketParams reverted");
        return P;
      },
      v2MarketState: async () => this.state,
      v2RootId: async () => this.id,
      v2Balance: async (_ac: Address, _id: number, token: Address) => this.free.get(token) ?? 0n,
      v2Slots: async (_m: Address, _id: number, n: number) => this.slots.slice(0, n),
      v2Locked: async () => ({ ...this.locked }),
      v2Book: async () => this.book,
      erc20Balance: async (token: Address) => this.wallet.get(token) ?? 0n,
    };
  }

  send = async (s: SendSpec): Promise<SendResult> => {
    this.sends.push(s);
    const args = s.args as unknown[];
    if (s.functionName === "deposit") {
      const [, token, amt] = args as [Address, Address, bigint];
      if (!this.id) this.id = 42;
      this.free.set(token, (this.free.get(token) ?? 0n) + amt);
      this.wallet.set(token, (this.wallet.get(token) ?? 0n) - amt);
    } else if (s.functionName === "mint") {
      const [q] = args as [bigint];
      this.wallet.set(TOKEN, (this.wallet.get(TOKEN) ?? 0n) + q);
    } else if (s.functionName === "batch") {
      const [, orders, cancels] = args as [number, { side: number; quantity: bigint; price: number }[], number[]];
      for (const slot of cancels) this.slots[slot] = 0n;
      this.free.set(TOKEN, (this.free.get(TOKEN) ?? 0n) + this.locked.base);
      this.free.set(USDC, (this.free.get(USDC) ?? 0n) + this.locked.quote);
      this.locked = { base: 0n, quote: 0n };
      for (const o of orders) {
        const slot = this.slots.indexOf(0n);
        this.slots[slot] = this.nextOrder++;
        const v: V2Order = { side: o.side as 0 | 1, price: BigInt(o.price), qty: o.quantity };
        if (o.side === 1) {
          this.locked.base += baseAtoms(o.quantity, P);
          this.free.set(TOKEN, (this.free.get(TOKEN) ?? 0n) - baseAtoms(o.quantity, P));
        } else {
          this.locked.quote += bidReserve(v, P);
          this.free.set(USDC, (this.free.get(USDC) ?? 0n) - bidReserve(v, P));
        }
      }
    } else if (s.functionName === "cancelAllOrders") {
      this.slots = this.slots.map(() => 0n);
      this.free.set(TOKEN, (this.free.get(TOKEN) ?? 0n) + this.locked.base);
      this.free.set(USDC, (this.free.get(USDC) ?? 0n) + this.locked.quote);
      this.locked = { base: 0n, quote: 0n };
    } else if (s.functionName === "withdraw") {
      const [, token, amt] = args as [number, Address, bigint];
      this.free.set(token, (this.free.get(token) ?? 0n) - amt);
      this.wallet.set(token, (this.wallet.get(token) ?? 0n) + amt);
    }
    return { ok: true, sent: true, txHash: "0xabc" };
  };

  host(dir: string): V2Host {
    return {
      maker: MAKER,
      reads: this.reads() as unknown as V2Host["reads"],
      dollar: DOLLAR,
      dir,
      send: this.send,
      approve: async () => true,
      hold: (series) => void this.holds.push(series),
      raise: (x) => void this.alerts.push(x.code),
      say: () => {},
      state: () => this.st,
      save: () => {},
      nowMs: () => this.now,
      budgetOut: () => false,
    };
  }
}

const CFG: V2Cfg = { ...parseConfig(null), accountCore: AC, books: [{ market: MARKET, series: SERIES }], maxBaseTokens: 100, levels: 2, sizesTokens: [10, 20] };
const series = (over: Partial<V2Series> = {}): V2Series => ({ series: SERIES, token: TOKEN, terms: { floor: 1_950_000n, cap: 8_000_000n, n: 30 }, quotable: true, k: 5, Tw: 5n * U, Sh: 0n, fair: 4_000_000n, lo: null, hi: null, stopAt: 10_000_000, ...over });
const ctx = { t: 1_000, killed: null, cancelAll: false, withdrawAll: false, oneShot: false, walletD: 1_000_000_000n };

describe("V2Desk on a fake chain", () => {
  test("first quote: mint the shortfall, deposit tokens and USDC, one batch; then adopt; a fill requotes with cancels", async () => {
    const w = new World();
    const dir = `${process.env.TMPDIR ?? "/tmp"}/v2desk-${process.pid}`;
    const desk = new V2Desk(CFG, w.host(dir));
    const s = series();
    let snaps = await desk.snapshot([s]);
    expect(snaps[0]!.id).toBe(0);
    await desk.run(snaps, ctx);
    const fns = w.sends.map((x) => x.functionName);
    // asks need 30 tokens: 5 from the wallet, 25 minted at the $8 cap ($200), then deposited; bids need USDC
    expect(fns).toEqual(["mint", "deposit", "deposit", "batch"]);
    expect(w.sends[0]!.args).toEqual([25n * U, MAKER]);
    expect(w.holds).toEqual([SERIES, SERIES]); // held after the mint and after the deposit
    expect(w.sends[1]!.args).toEqual([MAKER, TOKEN, 30n * U]);
    const batch = w.sends[3]!;
    const [id, orders, cancels] = batch.args as [number, { side: number; quantity: bigint; price: number; executionInstruction: number }[], number[]];
    expect(id).toBe(42);
    expect(cancels).toEqual([]);
    expect(orders.map((o) => [o.side, o.price, o.quantity])).toEqual([
      [0, 3_960_000, 100_000n],
      [0, 3_950_000, 200_000n],
      [1, 4_040_000, 100_000n],
      [1, 4_050_000, 200_000n],
    ]);
    expect(orders.every((o) => o.executionInstruction === 1)).toBe(true);
    expect(w.st.v2![MARKET.toLowerCase()]!.ids).toBeNull();

    // next tick: adopted, nothing sent
    w.sends = [];
    w.now += 60_000;
    snaps = await desk.snapshot([s]);
    await desk.run(snaps, { ...ctx, t: 1_060 });
    expect(w.sends).toEqual([]);
    expect(w.st.v2![MARKET.toLowerCase()]!.ids).toEqual([100n, 101n, 102n, 103n]);

    // a taker lifts the best ask whole: its id leaves slot 2, the batch cancels the other three slots and requotes
    w.slots[2] = 0n;
    w.locked.base -= 10n * U;
    w.now += 60_000;
    snaps = await desk.snapshot([s]);
    await desk.run(snaps, { ...ctx, t: 1_120 });
    const b2 = w.sends.find((x) => x.functionName === "batch")!;
    expect((b2.args as unknown[])[2]).toEqual([0, 1, 3]);
  });

  test("kill: cancel all; a final series' tokens are withdrawn to the wallet", async () => {
    const w = new World();
    const desk = new V2Desk(CFG, w.host(`${process.env.TMPDIR ?? "/tmp"}/v2desk-k-${process.pid}`));
    await desk.run(await desk.snapshot([series()]), ctx);
    w.sends = [];
    w.now += 60_000;
    await desk.run(await desk.snapshot([series()]), { ...ctx, killed: "loss" });
    expect(w.sends.map((x) => x.functionName)).toEqual(["cancelAllOrders"]);
    expect(w.st.v2![MARKET.toLowerCase()]).toBeUndefined();

    w.sends = [];
    const s = series({ k: 30, quotable: false });
    await desk.run(await desk.snapshot([s]), ctx);
    expect(w.sends.map((x) => x.functionName)).toEqual(["withdraw"]);
    expect(w.sends[0]!.args).toEqual([42, TOKEN, 30n * U, MAKER]);
    expect(s.Tw).toBe(35n * U); // its 5 wallet tokens plus the 30 withdrawn
  });

  test("at the token cap the bids close; a one-shot tick places nothing", async () => {
    const w = new World();
    w.id = 42;
    w.free.set(TOKEN, 100n * U);
    const desk = new V2Desk(CFG, w.host(`${process.env.TMPDIR ?? "/tmp"}/v2desk-c-${process.pid}`));
    await desk.run(await desk.snapshot([series()]), { ...ctx, oneShot: true });
    expect(w.sends).toEqual([]);
    await desk.run(await desk.snapshot([series()]), ctx);
    const b = w.sends.find((x) => x.functionName === "batch")!;
    const orders = (b.args as unknown[])[1] as { side: number }[];
    expect(orders.every((o) => o.side === 1)).toBe(true);
    expect(w.sends.some((x) => x.functionName === "deposit")).toBe(false);
  });

  test("V2 mints stay inside maxPairsTokens", async () => {
    const w = new World();
    const desk = new V2Desk({ ...CFG, maxPairsTokens: 30_000 }, w.host(`${process.env.TMPDIR ?? "/tmp"}/v2desk-p-${process.pid}`));
    const s = series({ Sh: 29_990n * U, Tw: 0n });
    await desk.run(await desk.snapshot([s]), ctx);
    const mint = w.sends.find((x) => x.functionName === "mint")!;
    expect(mint.args).toEqual([10n * U, MAKER]);
    const b = w.sends.find((x) => x.functionName === "batch")!;
    const asks = ((b.args as unknown[])[1] as { side: number; quantity: bigint }[]).filter((o) => o.side === 1);
    expect(asks.reduce((a, o) => a + o.quantity, 0n)).toBe(100_000n); // 10 tokens: the first level only
  });

  test("an unreadable book: alert, nothing sent, the mark keeps its last holdings", async () => {
    const w = new World();
    const desk = new V2Desk(CFG, w.host(`${process.env.TMPDIR ?? "/tmp"}/v2desk-u-${process.pid}`));
    await desk.run(await desk.snapshot([series()]), ctx);
    const before = desk.holdings(await desk.snapshot([series()]));
    expect(before.tokens.get(SERIES.toLowerCase())).toBe(30n * U);
    w.broken.add(MARKET);
    w.sends = [];
    const snaps = await desk.snapshot([series()]);
    expect(snaps).toEqual([]);
    expect(w.alerts).toContain("MM_V2_UNREADABLE");
    const after = desk.holdings(snaps);
    expect(after.tokens.get(SERIES.toLowerCase())).toBe(30n * U);
    expect(after.dollars).toBe(before.dollars);
    await desk.run(snaps, ctx);
    expect(w.sends).toEqual([]);
  });
});
