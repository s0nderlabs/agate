// An in-memory market for the payer's unit tests: factories (listing rules programmable per GPU and month), series
// with MS 4.5's exact owed and claimMany semantics (one sync, then each id; a payee whose transfer reverts reverts
// the batch; at k = N a claim deletes), the scanner's events, and a sender that applies sends to the world with the
// gas and budget rules of the real one (plan, guard, receipts with ABI-encoded logs).
import { type Abi, type AbiEvent, type Address, encodeAbiParameters, encodeEventTopics, type Hex, type Log, padHex, toHex } from "viem";
import { agateSeriesAbi, capFor, type ExtraReads, type IndexRecordView, type KuruOrder, type L2Book, LimitTable, type ListingCheck, type MarketReads, owed, type Plan, type PlanningSender, type PositionInfo, type ScanEvent, scanKey, type SendResult, type SendSpec, type SeriesState, type SeriesTerms, type Side, type SimResult, type SpendGuard, type VenueId } from "@agate/market";

export const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const U = 1_000_000n;
export const addr = (n: number | bigint): Address => padHex(toHex(BigInt(n)), { size: 20 }) as Address;
export const gpu = (n: number): Hex => padHex(toHex(n), { size: 32 });

export class Revert extends Error {}

export interface FakePos {
  owner: Address;
  payee: Address;
  side: Side;
  q: bigint;
  paid: bigint;
  daily: boolean;
  openedK: number;
}

export class FakeSeries {
  k = 0;
  S = 0n;
  /** the clamped value of each day, 1-based by position (index 0 = day 1) */
  values: bigint[] = [];
  /** how many days are final (previewSync applies these) */
  finalDays = 0;
  nextId = 1n;
  readonly pos = new Map<bigint, FakePos>();
  readonly revertPayees = new Set<string>();
  constructor(
    readonly w: FakeWorld,
    readonly address: Address,
    readonly t: SeriesTerms,
    readonly symbol: string,
  ) {}

  preview(): { k: number; S: bigint } {
    let k = this.k;
    let S = this.S;
    while (k < this.finalDays && k < this.t.n) {
      S += this.values[k]!;
      k++;
    }
    return { k, S };
  }
  syncN(max: number): number {
    const p = this.preview();
    let n = 0;
    while (this.k < p.k && n < max) {
      this.S += this.values[this.k]!;
      this.k++;
      this.w.emit(this.address, "FixApplied", { k: this.k, day: this.t.startDay + this.k - 1, x: Number(this.values[this.k - 1]!), c: Number(this.values[this.k - 1]!), status: 1, flags: 0, sumAfter: this.S });
      n++;
    }
    return n;
  }
  claimableOf(id: bigint): bigint | null {
    const p = this.pos.get(id);
    if (!p) return null;
    const pv = this.preview();
    return owed(p.side, p.q, pv.k, pv.S, this.t) - p.paid;
  }
  open(o: { owner: Address; payee: Address; side: Side; q: bigint; daily: boolean }): bigint {
    this.syncN(1_000);
    const id = this.nextId++;
    const paidNow = owed(o.side, o.q, this.k, this.S, this.t);
    this.pos.set(id, { ...o, paid: paidNow, openedK: this.k });
    this.w.pay(o.owner, paidNow);
    this.w.emit(this.address, "PositionOpened", { id, owner: o.owner, payee: o.payee, side: o.side, q: o.q, paidNow, operator: ZERO, daily: o.daily, k: this.k, to: o.owner });
    return id;
  }
  /** A stranger's claim (outside the payer): pays, emits. */
  claim(id: bigint): bigint {
    return this.claimMany([id]).total;
  }
  claimMany(ids: readonly bigint[], dry = false): { total: bigint; logs: Log[] } {
    const snap = { k: this.k, S: this.S, pos: new Map([...this.pos].map(([i, p]) => [i, { ...p }])), bal: new Map(this.w.balances), evs: this.w.events.length, logs: this.w.logBuf.length };
    try {
      this.syncN(1_000);
      let total = 0n;
      for (const id of ids) {
        const p = this.pos.get(id);
        if (!p) continue;
        const o = owed(p.side, p.q, this.k, this.S, this.t);
        const amount = o - p.paid;
        if (this.revertPayees.has(p.payee.toLowerCase())) throw new Revert("ERC20 transfer reverted");
        this.w.emit(this.address, "Claimed", { id, payee: p.payee, amount, paidTotal: o, k: this.k });
        if (this.k === this.t.n) {
          this.pos.delete(id);
          this.w.emit(this.address, "PositionClosed", { id, owner: p.owner, kind: 0, amount, to: p.payee, by: this.w.payer });
        } else p.paid = o;
        this.w.pay(p.payee, amount);
        total += amount;
      }
      const logs = this.w.logBuf.slice(snap.logs);
      if (dry) throw new DryDone(total, logs);
      return { total, logs };
    } catch (e) {
      this.k = snap.k;
      this.S = snap.S;
      this.pos.clear();
      for (const [i, p] of snap.pos) this.pos.set(i, p);
      this.w.balances.clear();
      for (const [a, b] of snap.bal) this.w.balances.set(a, b);
      this.w.events.length = snap.evs;
      this.w.logBuf.length = snap.logs;
      if (e instanceof DryDone) return { total: e.total, logs: e.logs };
      throw e;
    }
  }
}

class DryDone extends Error {
  constructor(
    readonly total: bigint,
    readonly logs: Log[],
  ) {
    super("dry");
  }
}

export interface FakeFactory {
  name: string;
  address: Address;
  index: Address;
  month: number;
  gpus: Hex[];
  labels: Record<string, string>;
  kuruRouter: Address;
  series: Map<string, Address>;
  markets: Map<string, { market: Address; venue: VenueId }>;
  /** what previewListing answers for (gpu, month); default NotReady() */
  listing: (gpuId: Hex, month: number) => ListingCheck;
  createMarketError?: string;
  /** firstRecordDay of the index per GPU */
  firstRecord: Map<string, number>;
}

export class FakeWorld {
  t = 2_000_000_000n;
  block = 100;
  readonly balances = new Map<string, bigint>();
  readonly series = new Map<string, FakeSeries>();
  readonly factories = new Map<string, FakeFactory>();
  readonly events: ScanEvent[] = [];
  readonly logBuf: Log[] = [];
  readonly sends: { fn: string; to: Address; args: readonly unknown[]; shape: string; c?: number; n?: number }[] = [];
  readonly heads = new Map<string, number | null>();
  monBalance = 1_000n * 10n ** 18n;
  maxFeePerGas = 100_000_000_000n; // 100 gwei
  payer: Address = addr(0xbeef);
  private nextAddr = 0x5000;
  private logIndex = 0;
  /** index DAY and dayStart for the lister */
  dayLen = 600;
  epochTs = 1_900_000_000n;
  epochDay = 20_727;

  newAddr(): Address {
    return addr(this.nextAddr++);
  }

  pay(to: Address, amt: bigint): void {
    this.balances.set(to.toLowerCase(), (this.balances.get(to.toLowerCase()) ?? 0n) + amt);
  }
  balance(a: Address): bigint {
    return this.balances.get(a.toLowerCase()) ?? 0n;
  }

  /** Records an event both as a scanner event and as an ABI-encoded log (for receipts). */
  emit(address: Address, name: string, args: Record<string, unknown>): void {
    const item = (agateSeriesAbi as Abi).find((x) => x.type === "event" && x.name === name) as AbiEvent | undefined;
    const block = this.block;
    const li = this.logIndex++;
    if (item) {
      const topics = encodeEventTopics({ abi: [item], eventName: name, args: Object.fromEntries(item.inputs.filter((i) => i.indexed).map((i) => [i.name!, args[i.name!]])) } as never) as Hex[];
      const data = encodeAbiParameters(item.inputs.filter((i) => !i.indexed), item.inputs.filter((i) => !i.indexed).map((i) => args[i.name!]) as never);
      this.logBuf.push({ address, topics: topics as [Hex, ...Hex[]], data, blockNumber: BigInt(block), logIndex: li, transactionHash: padHex(toHex(li), { size: 32 }), transactionIndex: 0, blockHash: padHex("0x1", { size: 32 }), removed: false } as Log);
    }
    const base = { key: scanKey(block, li), block, logIndex: li, address: address.toLowerCase() as Address, tx: null };
    const A = (x: unknown) => String(x).toLowerCase() as Address;
    switch (name) {
      case "PositionOpened":
        this.events.push({ ...base, name, id: args.id as bigint, owner: A(args.owner), payee: A(args.payee), side: Number(args.side), q: args.q as bigint, paidNow: args.paidNow as bigint, operator: A(args.operator), daily: Boolean(args.daily), k: Number(args.k), to: A(args.to) });
        break;
      case "Claimed":
        this.events.push({ ...base, name, id: args.id as bigint, payee: A(args.payee), amount: args.amount as bigint, paidTotal: args.paidTotal as bigint, k: Number(args.k) });
        break;
      case "PositionClosed":
        this.events.push({ ...base, name, id: args.id as bigint, owner: A(args.owner), kind: Number(args.kind), amount: args.amount as bigint, to: A(args.to), by: A(args.by) });
        break;
      case "PayoutChanged":
        this.events.push({ ...base, name, id: args.id as bigint, payee: A(args.payee), daily: Boolean(args.daily) });
        break;
      default:
        break;
    }
  }

  mine(): void {
    this.block++;
    this.logIndex = 0;
  }

  /** A listed series (with its SeriesListed event from the factory). */
  addSeries(f: FakeFactory, g: Hex, month: number, o: { n?: number; floor?: bigint; cap?: bigint; startTs?: bigint; day?: number; lastResort?: bigint } = {}): FakeSeries {
    const address = this.newAddr();
    const day = o.day ?? this.dayLen;
    const startDay = this.epochDay + (month - 24_321) * 31; // any consistent number
    const t: SeriesTerms = {
      index: f.index, dollar: addr(0xd011a7), factory: f.address, router: addr(0x7007), gpuId: g, recipeHash: gpu(1), month, startDay,
      n: o.n ?? 30, startTs: o.startTs ?? this.t, day, lastResort: o.lastResort ?? 259_200n, floor: o.floor ?? 1_800_000n, cap: o.cap ?? 7_200_000n,
      x0: 3_600_000n, bandGrade: 0, anchorCarried: 0, anchorMinFresh: 5, anchorLate: false,
    };
    const s = new FakeSeries(this, address, t, `d${f.labels[g] ?? "H100"}-${month}`);
    this.series.set(address.toLowerCase(), s);
    f.series.set(`${g}:${month}`, address);
    f.markets.set(address.toLowerCase(), { market: ZERO, venue: 0 });
    const li = this.logIndex++;
    this.events.push({ key: scanKey(this.block, li), block: this.block, logIndex: li, address: f.address.toLowerCase() as Address, tx: null, name: "SeriesListed", series: address.toLowerCase() as Address, gpuId: g, month, token: this.newAddr(), startDay, n: t.n, startTs: t.startTs, day, lastResort: t.lastResort, floor: t.floor, cap: t.cap, x0: t.x0, bandGrade: 0, symbol: s.symbol });
    return s;
  }

  addFactory(name: string, o: Partial<FakeFactory> = {}): FakeFactory {
    const f: FakeFactory = {
      name, address: this.newAddr(), index: this.newAddr(), month: 24_321, gpus: [gpu(0x100), gpu(0x200)], labels: {}, kuruRouter: addr(0x4b55), series: new Map(), markets: new Map(),
      listing: () => ({ ok: false, error: "NotReady()" }), firstRecord: new Map(), ...o,
    };
    if (!o.labels) f.labels = Object.fromEntries(f.gpus.map((g, i) => [g, ["H100", "H200", "B200"][i] ?? `G${i}`]));
    this.factories.set(f.address.toLowerCase(), f);
    return f;
  }

  dayStart(day: number): bigint {
    return day < this.epochDay ? this.epochTs : this.epochTs + BigInt(day - this.epochDay) * BigInt(this.dayLen);
  }
}

/** MarketReads over the fake world (only the views the payer and the lister read). */
export class FakeReads implements MarketReads, ExtraReads {
  calls = 0;
  failNext: Error | null = null;
  constructor(readonly w: FakeWorld) {}
  private hit(): void {
    this.calls++;
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
  }
  private fac(a: Address): FakeFactory {
    const f = this.w.factories.get(a.toLowerCase());
    if (!f) throw new Error("no factory");
    return f;
  }
  private ser(a: Address): FakeSeries {
    const s = this.w.series.get(a.toLowerCase());
    if (!s) throw new Error("no series");
    return s;
  }
  async blockTime() {
    this.hit();
    return this.w.t;
  }
  async monBalance() {
    return this.w.monBalance;
  }
  async erc20Balance(_t: Address, who: Address) {
    return this.w.balance(who);
  }
  async allowance() {
    return 0n;
  }
  async currentMonth(f: Address) {
    this.hit();
    return this.fac(f).month;
  }
  async gpuIds(f: Address) {
    return [...this.fac(f).gpus];
  }
  async labelOf(f: Address, g: Hex) {
    return this.fac(f).labels[g] ?? "?";
  }
  async kuruRouterOf(f: Address) {
    return this.fac(f).kuruRouter;
  }
  async seriesOf(f: Address, g: Hex, month: number) {
    return this.fac(f).series.get(`${g}:${month}`) ?? ZERO;
  }
  async marketOf(f: Address, s: Address) {
    return this.fac(f).markets.get(s.toLowerCase()) ?? { market: ZERO, venue: 0 as VenueId };
  }
  async routerCanUse(f: Address, s: Address) {
    return (await this.marketOf(f, s)).venue === 1;
  }
  async previewListing(f: Address, g: Hex, month: number): Promise<ListingCheck> {
    this.hit();
    const fac = this.fac(f);
    if (fac.series.has(`${g}:${month}`)) return { ok: false, error: `AlreadyListed(${fac.series.get(`${g}:${month}`)})` };
    if (month !== fac.month && month !== fac.month + 1) return { ok: false, error: `MonthNotOpen(${month}, ${fac.month})` };
    return fac.listing(g, month);
  }
  async terms(s: Address) {
    return this.ser(s).t;
  }
  async token() {
    return ZERO;
  }
  async state(s: Address): Promise<SeriesState> {
    this.hit();
    const x = this.ser(s);
    return { k: x.k, sum: x.S, lastX: 0n, walked: false, appliedReal: true, ledger: 0n, nextId: x.nextId, shortSupply: 0n };
  }
  async previewSync(s: Address) {
    this.hit();
    const p = this.ser(s).preview();
    return { k: p.k, sum: p.S };
  }
  async shortOf() {
    return 0n;
  }
  async position(s: Address, id: bigint): Promise<PositionInfo | null> {
    const p = this.ser(s).pos.get(id);
    return p ? { id, owner: p.owner, payee: p.payee, operator: ZERO, side: p.side, q: p.q, paid: p.paid, daily: p.daily, openedK: p.openedK, open: true } : null;
  }
  async claimable(s: Address, id: bigint) {
    return this.ser(s).claimableOf(id);
  }
  async indexRecord(): Promise<IndexRecordView> {
    return { exists: false, isFinal: false, value: 0n, status: 0 };
  }
  async indexHead(index: Address, g: Hex) {
    const h = this.w.heads.get(`${index.toLowerCase()}:${g}`);
    return h === undefined ? null : h;
  }
  async indexClocks() {
    return { day: this.w.dayLen, closeGrace: 150, tPend: 210 };
  }
  async indexDayStart(_i: Address, day: number) {
    return this.w.dayStart(day);
  }
  async indexFirstRecordDay(index: Address, g: Hex) {
    for (const f of this.w.factories.values()) if (f.index.toLowerCase() === index.toLowerCase()) {
      const d = f.firstRecord.get(g);
      return d === undefined ? { exists: false, day: 0 } : { exists: true, day: d };
    }
    return { exists: false, day: 0 };
  }
  async kuruMarketState() {
    return 0;
  }
  async kuruBook(): Promise<L2Book> {
    return { block: 0n, bids: [], asks: [] };
  }
  async kuruOrders(): Promise<KuruOrder[]> {
    return [];
  }
  async kuruOrderIdCounter() {
    return 0n;
  }
  async marginBalance() {
    return 0n;
  }
}

/** A PlanningSender over the fake world: gas from the LIMIT table (estimate = LIMIT + 21,000 + calldata), the real
 *  CAP rule, a spend guard, and receipts carrying the world's ABI-encoded logs. */
export class FakeSender implements PlanningSender {
  readonly from: Address;
  failSend: string | null = null;
  constructor(
    readonly w: FakeWorld,
    readonly o: { guard?: SpendGuard; limits?: LimitTable; dryRun?: boolean; capIdsAbove?: number } = {},
  ) {
    this.from = w.payer;
  }
  resetNonce(): void {}
  async fees() {
    return { maxFeePerGas: this.w.maxFeePerGas, maxPriorityFeePerGas: 1n };
  }
  private run(s: SendSpec, dry: boolean): { result: unknown; logs: Log[] } {
    const fn = s.functionName;
    const ser = this.w.series.get(s.to.toLowerCase());
    const fac = this.w.factories.get(s.to.toLowerCase());
    if (fn === "claimMany" && ser) {
      const r = ser.claimMany(s.args[0] as bigint[], dry);
      return { result: r.total, logs: r.logs };
    }
    if (fn === "sync" && ser) {
      if (dry) return { result: BigInt(Math.min(Number(s.args[0]), ser.preview().k - ser.k)), logs: [] };
      return { result: BigInt(ser.syncN(Number(s.args[0]))), logs: [] };
    }
    if (fn === "list" && fac) {
      const [g, month] = s.args as [Hex, number];
      const key = `${g}:${month}`;
      if (fac.series.has(key)) throw new Revert(`AlreadyListed(${fac.series.get(key)})`);
      if (month !== fac.month && month !== fac.month + 1) throw new Revert(`MonthNotOpen(${month}, ${fac.month})`);
      const chk = fac.listing(g, month);
      if (!chk.ok) throw new Revert(chk.error);
      if (!dry) this.w.addSeries(fac, g, month, { floor: chk.floor, cap: chk.cap });
      return { result: ZERO, logs: [] };
    }
    if (fn === "createMarket" && fac) {
      const series = (s.args[0] as Address).toLowerCase();
      const m = fac.markets.get(series);
      if (!m) throw new Revert(`NotSeries(${series})`);
      if (m.venue !== 0) throw new Revert(`MarketAlreadySet(${m.market})`);
      if (fac.kuruRouter === ZERO) throw new Revert("NoKuruRouter()");
      if (fac.createMarketError) throw new Revert(fac.createMarketError);
      if (!dry) fac.markets.set(series, { market: this.w.newAddr(), venue: 1 });
      return { result: ZERO, logs: [] };
    }
    throw new Revert(`unknown call ${fn}`);
  }
  async simulate(s: SendSpec): Promise<SimResult> {
    try {
      return { ok: true, result: this.run(s, true).result };
    } catch (e) {
      if (e instanceof Revert) return { ok: false, error: e.message };
      throw e;
    }
  }
  async plan(s: SendSpec): Promise<Plan> {
    const sim = await this.simulate(s);
    if (!sim.ok) return { ok: false, ...(sim.error ? { error: sim.error } : {}) };
    const limits = this.o.limits ?? new LimitTable();
    const data = "0x" as Hex;
    const limit = limits.limitFor(s.shape, s.c ?? 0, s.n ?? 1);
    const estimate = BigInt(limit + 21_000);
    const cap = capFor(limits, s.shape, data, { ...(s.c !== undefined ? { c: s.c } : {}), ...(s.n !== undefined ? { n: s.n } : {}) });
    const gasLimit = (estimate * 6n + 4n) / 5n;
    if (gasLimit > cap || (this.o.capIdsAbove !== undefined && (s.n ?? 1) > this.o.capIdsAbove)) return { ok: false, error: "GAS_CAP" };
    return { ok: true, result: sim.result, estimate, cap, gasLimit, maxFeePerGas: this.w.maxFeePerGas, maxPriorityFeePerGas: 1n, costMaxWei: gasLimit * this.w.maxFeePerGas };
  }
  async send(s: SendSpec): Promise<SendResult> {
    const p = await this.plan(s);
    if (!p.ok) return { ok: false, sent: false, error: p.error ?? "refused" };
    const g = this.o.guard?.canSpend(p.costMaxWei!, s.safety === true);
    if (g && !g.ok) return { ok: false, sent: false, gasLimit: p.gasLimit!, error: g.why };
    if (this.o.dryRun) return { ok: false, sent: false, gasLimit: p.gasLimit!, error: "DRY_RUN" };
    if (this.failSend) return { ok: false, sent: false, error: this.failSend };
    this.w.mine();
    const r = this.run(s, false);
    this.w.sends.push({ fn: s.functionName, to: s.to, args: s.args, shape: s.shape, ...(s.c !== undefined ? { c: s.c } : {}), ...(s.n !== undefined ? { n: s.n } : {}) });
    const costWei = p.gasLimit! * this.w.maxFeePerGas;
    this.o.guard?.record(costWei, s.safety === true);
    return { ok: true, sent: true, txHash: padHex(toHex(this.w.sends.length), { size: 32 }), gasLimit: p.gasLimit!, costWei, logs: r.logs };
  }
}

/** The scanner's surface over the world's event list. */
export class FakeScanner {
  caughtUp = true;
  syncs = 0;
  /** everything the world emitted is scanned: the tip is the world's block */
  get tip(): bigint | null {
    return BigInt(this.w.block);
  }
  constructor(readonly w: FakeWorld) {}
  async sync(): Promise<number> {
    this.syncs++;
    return 0;
  }
  all(): readonly ScanEvent[] {
    return this.w.events;
  }
}
