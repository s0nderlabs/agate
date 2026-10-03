// BOTS-SPEC 3.12: a small in-memory chain for the maker's unit tests. FakeKuru follows Kuru V1's OrderBook.sol rules
// that the maker depends on (3.6): post-only adds revert on any match; batchUpdate cancels first (a filled id is
// skipped and its slot deleted, an already cancelled id reverts OnlyOwnerAllowedError), then buys, then sells; a fill
// that consumes more than an order keeps the order's old size in its slot and moves the head past it; status by the
// price point's head. FakeSeries mints, redeems and settles with MS 4.5's integers; FakeIndex serves records.
import { type Address, encodeAbiParameters, encodeEventTopics, type Hex, type Log, padHex, toHex } from "viem";
import { type IndexRecordView, KURU_MAX_SIZE, KURU_MIN_SIZE, kuruOrderBookAbi, type L2Book, LOT, type SeriesTerms, TICK, U, ZERO_ADDRESS as ZERO } from "@agate/market";

export class FakeRevert extends Error {
  constructor(readonly errorName: string) {
    super(errorName);
  }
}

let addrSeq = 0x100;
export function fakeAddress(tag = 0): Address {
  addrSeq += 1;
  return padHex(toHex((BigInt(tag) << 32n) | BigInt(addrSeq)), { size: 20 }) as Address;
}

const lc = (a: string) => a.toLowerCase();

// ------------------------------------------------------------------ Kuru V1 order book

export interface KOrder {
  owner: Address;
  size: bigint;
  price: bigint;
  isBuy: boolean;
}

interface KuruData {
  counter: bigint;
  orders: Map<bigint, KOrder>; // slots that exist (active, or filled and not yet deleted)
  points: Map<string, bigint[]>; // "b:<price>" / "s:<price>" -> FIFO of unfilled ids, head first
  state: number; // 0 ACTIVE, 1 SOFT_PAUSED, 2 HARD_PAUSED
}

export class FakeKuru {
  data: KuruData = { counter: 0n, orders: new Map(), points: new Map(), state: 0 };
  constructor(
    readonly w: FakeWorld,
    readonly address: Address,
    readonly base: Address,
    readonly quote: Address,
  ) {}

  private key(isBuy: boolean, price: bigint) {
    return `${isBuy ? "b" : "s"}:${price}`;
  }
  head(isBuy: boolean, price: bigint): bigint {
    return this.data.points.get(this.key(isBuy, price))?.[0] ?? 0n;
  }
  status(id: bigint): "ACTIVE" | "FILLED" | "CANCELED" {
    const o = this.data.orders.get(id);
    if (!o || o.price === 0n) return "CANCELED";
    const h = this.head(o.isBuy, o.price);
    if (h === 0n || h > id) return "FILLED";
    return "ACTIVE";
  }
  sOrder(id: bigint): KOrder {
    return this.data.orders.get(id) ?? { owner: ZERO, size: 0n, price: 0n, isBuy: false };
  }

  private emit(eventName: string, args: Record<string, unknown>): void {
    const ev = kuruOrderBookAbi.find((x) => x.type === "event" && x.name === eventName) as { inputs: readonly { name: string; type: string }[] };
    const topics = encodeEventTopics({ abi: kuruOrderBookAbi, eventName: eventName as "OrderCreated" }) as [Hex];
    const data = encodeAbiParameters(ev.inputs, ev.inputs.map((i) => args[i.name]));
    this.w.emit(this.address, topics, data);
  }

  private bestAsk(): bigint | null {
    let best: bigint | null = null;
    for (const [k, ids] of this.data.points) if (k.startsWith("s:") && ids.length > 0) {
      const p = BigInt(k.slice(2));
      if (best === null || p < best) best = p;
    }
    return best;
  }
  private bestBid(): bigint | null {
    let best: bigint | null = null;
    for (const [k, ids] of this.data.points) if (k.startsWith("b:") && ids.length > 0) {
      const p = BigInt(k.slice(2));
      if (best === null || p > best) best = p;
    }
    return best;
  }

  private checkAdd(price: bigint, size: bigint): void {
    if (this.data.state !== 0) throw new FakeRevert("MarketStateError");
    if (price <= 0n || price >= 2n ** 32n - 1n) throw new FakeRevert("PriceError");
    if (size < KURU_MIN_SIZE || size > KURU_MAX_SIZE) throw new FakeRevert("SizeError");
    if (price % TICK !== 0n) throw new FakeRevert("TickSizeError");
  }

  private place(owner: Address, price: bigint, size: bigint, isBuy: boolean): bigint {
    const id = this.data.counter + 1n;
    this.data.counter = id;
    this.data.orders.set(id, { owner, size, price, isBuy });
    const k = this.key(isBuy, price);
    this.data.points.set(k, [...(this.data.points.get(k) ?? []), id]);
    this.emit("OrderCreated", { orderId: Number(id), owner, size, price: Number(price), isBuy });
    return id;
  }

  /** Post-only only (the maker and the tests never take with a limit order). */
  addBuy(sender: Address, price: bigint, size: bigint, postOnly: boolean): bigint {
    this.checkAdd(price, size);
    const ask = this.bestAsk();
    if (ask !== null && ask <= price) {
      if (postOnly) throw new FakeRevert("PostOnlyError");
      throw new Error("FakeKuru: a crossing limit order is not modelled");
    }
    this.w.debitMargin(sender, this.quote, (price * size + 9_999n) / 10_000n);
    return this.place(sender, price, size, true);
  }

  addSell(sender: Address, price: bigint, size: bigint, postOnly: boolean): bigint {
    this.checkAdd(price, size);
    this.w.debitMargin(sender, this.base, size * LOT);
    const bid = this.bestBid();
    if (bid !== null && bid >= price) {
      if (postOnly) throw new FakeRevert("PostOnlyError");
      throw new Error("FakeKuru: a crossing limit order is not modelled");
    }
    return this.place(sender, price, size, false);
  }

  /** _cancelOrder(id, false): owner check first (a deleted slot has owner 0), a filled id deleted and skipped. */
  cancel(sender: Address, id: bigint): boolean {
    const o = this.data.orders.get(id);
    if (!o || lc(o.owner) !== lc(sender)) throw new FakeRevert("OnlyOwnerAllowedError");
    if (this.status(id) === "FILLED") {
      this.data.orders.delete(id);
      return false;
    }
    const k = this.key(o.isBuy, o.price);
    this.data.points.set(k, (this.data.points.get(k) ?? []).filter((x) => x !== id));
    if (o.isBuy) this.w.creditMargin(o.owner, this.quote, (o.size * o.price) / 10_000n);
    else this.w.creditMargin(o.owner, this.base, o.size * LOT);
    this.data.orders.delete(id);
    this.emit("OrderCanceled", { orderId: Number(id), owner: o.owner, price: Number(o.price), size: o.size, isBuy: o.isBuy });
    return true;
  }

  batchUpdate(sender: Address, bp: readonly bigint[], bs: readonly bigint[], sp: readonly bigint[], ss: readonly bigint[], ids: readonly bigint[], postOnly: boolean): void {
    if (this.data.state === 2) throw new FakeRevert("MarketStateError");
    if (bp.length !== bs.length || sp.length !== ss.length) throw new FakeRevert("LengthMismatch");
    const done = ids.map((id) => (this.cancel(sender, id) ? id : 0n));
    bp.forEach((p, i) => this.addBuy(sender, p, bs[i]!, postOnly));
    sp.forEach((p, i) => this.addSell(sender, p, ss[i]!, postOnly));
    if (ids.length > 0) this.emit("OrdersCanceled", { orderId: done.map(Number), owner: sender });
  }

  private fill(taker: Address, isBuy: boolean, units: bigint): bigint {
    let left = units;
    while (left > 0n) {
      const p = isBuy ? this.bestAsk() : this.bestBid();
      if (p === null) break;
      const k = this.key(!isBuy, p);
      const fifo = this.data.points.get(k)!;
      const id = fifo[0]!;
      const o = this.data.orders.get(id)!;
      const filled = left < o.size ? left : o.size;
      let updated: bigint;
      if (left > o.size) {
        updated = 0n; // Kuru keeps the old size in the slot; the head moves on
        fifo.shift();
      } else {
        updated = o.size - left;
        o.size = updated;
        if (updated === 0n) fifo.shift();
      }
      // the taker's side moves through the MarginAccount's wallet; the maker is credited in the margin account
      if (isBuy) {
        this.w.creditMargin(o.owner, this.quote, (p * filled) / 10_000n);
        this.w.transfer(this.quote, taker, this.w.ma, (p * filled) / 10_000n);
        this.w.transfer(this.base, this.w.ma, taker, filled * LOT);
      } else {
        this.w.creditMargin(o.owner, this.base, filled * LOT);
        this.w.transfer(this.base, taker, this.w.ma, filled * LOT);
        this.w.transfer(this.quote, this.w.ma, taker, (p * filled) / 10_000n);
      }
      this.emit("Trade", { orderId: Number(id), makerAddress: o.owner, isBuy, price: p * 10n ** 12n, updatedSize: updated, takerAddress: taker, txOrigin: taker, filledSize: filled });
      left -= filled;
    }
    return units - left;
  }

  /** A taker buying `units` size units from the asks (the router's market buy, as far as the book goes). */
  takerBuy(taker: Address, units: bigint): bigint {
    return this.fill(taker, true, units);
  }
  takerSell(taker: Address, units: bigint): bigint {
    return this.fill(taker, false, units);
  }

  l2(): L2Book {
    const side = (b: boolean) =>
      [...this.data.points]
        .filter(([k, ids]) => k.startsWith(b ? "b:" : "s:") && ids.length > 0)
        .map(([k, ids]) => [BigInt(k.slice(2)), ids.reduce((s, id) => s + this.data.orders.get(id)!.size, 0n)] as [bigint, bigint])
        .sort((x, y) => (b ? (x[0] > y[0] ? -1 : 1) : x[0] < y[0] ? -1 : 1));
    return { block: this.w.block, bids: side(true), asks: side(false) };
  }

  /** getL2Book()'s bytes, laid out as Kuru's assembly writes them. */
  l2Bytes(): Hex {
    const b = this.l2();
    const words = [b.block, ...b.bids.flat(), 0n, ...b.asks.flat()];
    return `0x${words.map((w) => w.toString(16).padStart(64, "0")).join("")}` as Hex;
  }
}

// ------------------------------------------------------------------ a series (MS 4.5 integers)

interface SeriesData {
  k: number; // what previewSync answers
  sum: bigint;
  stateK: number;
  short: Map<string, bigint>;
}

export class FakeSeries {
  data: SeriesData = { k: 0, sum: 0n, stateK: 0, short: new Map() };
  constructor(
    readonly w: FakeWorld,
    readonly address: Address,
    readonly token: Address,
    readonly terms: SeriesTerms,
  ) {}

  shortOf(a: Address): bigint {
    return this.data.short.get(lc(a)) ?? 0n;
  }
  setPreview(k: number, sum: bigint): void {
    this.data.k = k;
    this.data.sum = sum;
  }
  mint(sender: Address, q: bigint, to: Address): bigint {
    if (q <= 0n || q % LOT !== 0n) throw new FakeRevert("BadAmount");
    const cost = (q * this.terms.cap + U - 1n) / U;
    this.w.transferFrom(this.terms.dollar, this.address, sender, this.address, cost);
    this.w.mintTo(this.token, to, q);
    this.data.short.set(lc(sender), this.shortOf(sender) + q);
    return cost;
  }
  redeem(sender: Address, q: bigint, to: Address): bigint {
    if (q <= 0n || q % LOT !== 0n) throw new FakeRevert("BadAmount");
    if (this.w.balanceOf(this.token, sender) < q) throw new FakeRevert("TokenBalance");
    if (this.shortOf(sender) < q) throw new FakeRevert("ShortBalance");
    this.w.burn(this.token, sender, q);
    this.data.short.set(lc(sender), this.shortOf(sender) - q);
    const paid = (q * this.terms.cap) / U;
    this.w.transfer(this.terms.dollar, this.address, to, paid);
    return paid;
  }
  /** sync(maxDays): applies up to maxDays of the days previewSync counts. */
  sync(maxDays: bigint): bigint {
    const n = BigInt(this.data.k - this.data.stateK) < maxDays ? this.data.k - this.data.stateK : Number(maxDays);
    this.data.stateK += n;
    return BigInt(n);
  }
  settle(sender: Address, side: number, q: bigint, to: Address): bigint {
    const n = BigInt(this.terms.n);
    if (this.data.k < this.terms.n) throw new FakeRevert("MonthNotFinal");
    this.data.stateK = this.data.k;
    if (q <= 0n) throw new FakeRevert("BadAmount");
    let paid: bigint;
    if (side === 0) {
      if (this.w.balanceOf(this.token, sender) < q) throw new FakeRevert("TokenBalance");
      paid = (q * this.data.sum) / (n * U);
      this.w.burn(this.token, sender, q);
    } else {
      if (this.shortOf(sender) < q) throw new FakeRevert("ShortBalance");
      paid = (q * (n * this.terms.cap - this.data.sum)) / (n * U);
      this.data.short.set(lc(sender), this.shortOf(sender) - q);
    }
    this.w.transfer(this.terms.dollar, this.address, to, paid);
    return paid;
  }
}

// ------------------------------------------------------------------ an index

interface IndexData {
  recs: Map<string, IndexRecordView>;
  head: number | null; // null: head() reverts (MockIndex)
  preview: Map<string, bigint>; // previewFix of the head day per GPU (absent: not computable)
  writers: Address[]; // writers()
  select: Map<string, bigint>; // previewRecord(gpuId, day, writer): "<gpu>:<day>:<writer>" (absent: not computable)
}

export class FakeIndex {
  data: IndexData = { recs: new Map(), head: null, preview: new Map(), writers: [], select: new Map() };
  /** What previewRecord(gpuId, day, writer) answers (null: not computable): another writer's value for a day. */
  setPreviewRecord(gpuId: Hex, day: number, writer: Address, value: bigint | null): void {
    const k = `${lc(gpuId)}:${day}:${lc(writer)}`;
    if (value === null) this.data.select.delete(k);
    else this.data.select.set(k, value);
  }
  constructor(readonly address: Address, readonly clocks = { day: 86_400, closeGrace: 3_600, tPend: 21_600 }) {}
  put(gpuId: Hex, day: number, value: bigint, isFinal = true): void {
    this.data.recs.set(`${lc(gpuId)}:${day}`, { exists: true, isFinal, value, status: 1 });
  }
  record(gpuId: Hex, day: number): IndexRecordView {
    return this.data.recs.get(`${lc(gpuId)}:${day}`) ?? { exists: false, isFinal: false, value: 0n, status: 0 };
  }
  /** What previewFix answers for the head day of gpuId (null: not computable). */
  setPreview(gpuId: Hex, value: bigint | null): void {
    if (value === null) this.data.preview.delete(lc(gpuId));
    else this.data.preview.set(lc(gpuId), value);
  }
}

// ------------------------------------------------------------------ a factory's record

interface FactoryData {
  month: number;
  gpus: Hex[];
  labels: Map<string, string>;
  series: Map<string, Address>; // "<gpu>:<month>" -> series
  markets: Map<string, { market: Address; venue: 0 | 1 | 2 }>;
}

export class FakeFactory {
  data: FactoryData = { month: 0, gpus: [], labels: new Map(), series: new Map(), markets: new Map() };
  constructor(readonly w: FakeWorld, readonly address: Address, readonly index: Address, readonly dollar: Address, readonly router: Address) {}
  routerCanUse(series: Address): boolean {
    const m = this.data.markets.get(lc(series));
    if (!m || m.venue !== 1) return false;
    return this.w.kuru.get(lc(m.market))?.data.state === 0;
  }
}

// ------------------------------------------------------------------ the world

interface Balances {
  erc20: Map<string, bigint>; // "<token>:<owner>"
  allow: Map<string, bigint>; // "<token>:<owner>:<spender>"
  margin: Map<string, bigint>; // "<user>:<token>"
  mon: Map<string, bigint>;
}

export class FakeWorld {
  t = 1_790_000_000n;
  block = 1_000n;
  bal: Balances = { erc20: new Map(), allow: new Map(), margin: new Map(), mon: new Map() };
  readonly dollar = fakeAddress(1);
  readonly ma = fakeAddress(2);
  readonly kuruRouter = fakeAddress(3);
  readonly factories = new Map<string, FakeFactory>();
  readonly series = new Map<string, FakeSeries>();
  readonly kuru = new Map<string, FakeKuru>();
  readonly indexes = new Map<string, FakeIndex>();
  logs: Log[] = [];

  emit(address: Address, topics: [Hex, ...Hex[]], data: Hex): void {
    this.logs.push({ address, topics, data, blockNumber: this.block, logIndex: this.logs.length, transactionHash: padHex(toHex(this.block), { size: 32 }), transactionIndex: 0, blockHash: padHex(toHex(this.block), { size: 32 }), removed: false } as Log);
  }

  balanceOf(token: Address, who: Address): bigint {
    return this.bal.erc20.get(`${lc(token)}:${lc(who)}`) ?? 0n;
  }
  private setBal(token: Address, who: Address, v: bigint): void {
    this.bal.erc20.set(`${lc(token)}:${lc(who)}`, v);
  }
  mintTo(token: Address, to: Address, v: bigint): void {
    this.setBal(token, to, this.balanceOf(token, to) + v);
  }
  burn(token: Address, from: Address, v: bigint): void {
    const b = this.balanceOf(token, from);
    if (b < v) throw new FakeRevert("ERC20InsufficientBalance");
    this.setBal(token, from, b - v);
  }
  transfer(token: Address, from: Address, to: Address, v: bigint): void {
    this.burn(token, from, v);
    this.mintTo(token, to, v);
  }
  allowance(token: Address, owner: Address, spender: Address): bigint {
    return this.bal.allow.get(`${lc(token)}:${lc(owner)}:${lc(spender)}`) ?? 0n;
  }
  approve(token: Address, owner: Address, spender: Address, v: bigint): void {
    this.bal.allow.set(`${lc(token)}:${lc(owner)}:${lc(spender)}`, v);
  }
  transferFrom(token: Address, spender: Address, from: Address, to: Address, v: bigint): void {
    const a = this.allowance(token, from, spender);
    if (a < v) throw new FakeRevert("ERC20InsufficientAllowance");
    if (a < 2n ** 255n) this.approve(token, from, spender, a - v);
    this.transfer(token, from, to, v);
  }
  margin(user: Address, token: Address): bigint {
    return this.bal.margin.get(`${lc(user)}:${lc(token)}`) ?? 0n;
  }
  creditMargin(user: Address, token: Address, v: bigint): void {
    this.bal.margin.set(`${lc(user)}:${lc(token)}`, this.margin(user, token) + v);
  }
  debitMargin(user: Address, token: Address, v: bigint): void {
    const b = this.margin(user, token);
    if (b < v) throw new FakeRevert("InsufficientBalance");
    this.bal.margin.set(`${lc(user)}:${lc(token)}`, b - v);
  }
  deposit(sender: Address, user: Address, token: Address, v: bigint): void {
    this.transferFrom(token, this.ma, sender, this.ma, v);
    this.creditMargin(user, token, v);
  }
  withdraw(sender: Address, v: bigint, token: Address): void {
    this.debitMargin(sender, token, v);
    this.transfer(token, this.ma, sender, v);
  }
  mon(who: Address): bigint {
    return this.bal.mon.get(lc(who)) ?? 0n;
  }
  setMon(who: Address, v: bigint): void {
    this.bal.mon.set(lc(who), v);
  }

  /** Everything a transaction can change, for a revert or a simulation. */
  snapshot(): unknown {
    return structuredClone({
      bal: this.bal,
      kuru: [...this.kuru].map(([k, x]) => [k, x.data]),
      series: [...this.series].map(([k, x]) => [k, x.data]),
      factories: [...this.factories].map(([k, x]) => [k, x.data]),
      indexes: [...this.indexes].map(([k, x]) => [k, x.data]),
    });
  }
  restore(snap: unknown): void {
    const s = structuredClone(snap) as { bal: Balances; kuru: [string, KuruData][]; series: [string, SeriesData][]; factories: [string, FactoryData][]; indexes: [string, IndexData][] };
    this.bal = s.bal;
    for (const [k, d] of s.kuru) this.kuru.get(k)!.data = d;
    for (const [k, d] of s.series) this.series.get(k)!.data = d;
    for (const [k, d] of s.factories) this.factories.get(k)!.data = d;
    for (const [k, d] of s.indexes) this.indexes.get(k)!.data = d;
  }

  /** Runs fn as one transaction: all or nothing; returns its logs. */
  tx<T>(fn: () => T): { result: T; logs: Log[] } {
    const snap = this.snapshot();
    this.logs = [];
    try {
      const result = fn();
      this.block += 1n;
      return { result, logs: this.logs };
    } catch (e) {
      this.restore(snap);
      this.logs = [];
      throw e;
    }
  }

  // ------------------------------------------------------------------ building a world

  addIndex(): FakeIndex {
    const ix = new FakeIndex(fakeAddress(4));
    this.indexes.set(lc(ix.address), ix);
    return ix;
  }
  addFactory(index: FakeIndex): FakeFactory {
    const f = new FakeFactory(this, fakeAddress(5), index.address, this.dollar, fakeAddress(6));
    this.factories.set(lc(f.address), f);
    return f;
  }
  /** Lists a series of month on f (with its terms) and records a fresh KURU_V1 market. */
  list(f: FakeFactory, gpuId: Hex, month: number, t: Partial<SeriesTerms> & Pick<SeriesTerms, "startDay" | "startTs" | "n" | "floor" | "cap">): { series: FakeSeries; kuru: FakeKuru } {
    const addr = fakeAddress(7);
    const token = fakeAddress(8);
    const terms: SeriesTerms = {
      index: f.index,
      dollar: f.dollar,
      factory: f.address,
      router: f.router,
      gpuId,
      recipeHash: padHex("0x01", { size: 32 }),
      month,
      day: 86_400,
      lastResort: 5_184_000n,
      x0: t.floor * 2n,
      bandGrade: 0,
      anchorCarried: 0,
      anchorMinFresh: 5,
      anchorLate: false,
      ...t,
    };
    const s = new FakeSeries(this, addr, token, terms);
    this.series.set(lc(addr), s);
    f.data.series.set(`${lc(gpuId)}:${month}`, addr);
    if (!f.data.gpus.map(lc).includes(lc(gpuId))) f.data.gpus.push(gpuId);
    const k = this.addMarket(f, s);
    return { series: s, kuru: k };
  }
  addMarket(f: FakeFactory, s: FakeSeries): FakeKuru {
    const k = new FakeKuru(this, fakeAddress(9), s.token, this.dollar);
    this.kuru.set(lc(k.address), k);
    f.data.markets.set(lc(s.address), { market: k.address, venue: 1 });
    return k;
  }
}
