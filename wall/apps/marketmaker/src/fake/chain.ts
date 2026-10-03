// FakeReads (MarketReads over a FakeWorld) and FakeSender (records sends, applies them to the world as all-or-nothing
// transactions, charges MON at a fixed gas price, can fail or crash on demand). BOTS-SPEC 3.12.
import { type Address, type Hex, type Log, padHex, toHex } from "viem";
import { decodeL2Book, type IndexRecordView, type KuruOrder, type L2Book, type ListingCheck, type MarketReads, type PositionInfo, type PreviewReads, type Sender, type SendResult, type SendSpec, type SeriesState, type SeriesTerms, type SimResult, type SpendGuard, type VenueId } from "@agate/market";
import { FakeRevert, type FakeWorld } from "./world.ts";

const lc = (a: string) => a.toLowerCase();

export class FakeReads implements MarketReads, PreviewReads {
  calls = 0;
  constructor(readonly w: FakeWorld) {}
  private c(): void {
    this.calls++;
  }
  private fac(f: Address) {
    const x = this.w.factories.get(lc(f));
    if (!x) throw new FakeRevert("no factory");
    return x;
  }
  private ser(s: Address) {
    const x = this.w.series.get(lc(s));
    if (!x) throw new FakeRevert("no series");
    return x;
  }
  private book(m: Address) {
    const x = this.w.kuru.get(lc(m));
    if (!x) throw new FakeRevert("no market");
    return x;
  }
  async blockTime(): Promise<bigint> {
    this.c();
    return this.w.t;
  }
  async monBalance(who: Address): Promise<bigint> {
    this.c();
    return this.w.mon(who);
  }
  async erc20Balance(token: Address, who: Address): Promise<bigint> {
    this.c();
    return this.w.balanceOf(token, who);
  }
  async allowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
    this.c();
    return this.w.allowance(token, owner, spender);
  }
  async currentMonth(factory: Address): Promise<number> {
    this.c();
    return this.fac(factory).data.month;
  }
  async gpuIds(factory: Address): Promise<Hex[]> {
    this.c();
    return [...this.fac(factory).data.gpus];
  }
  async labelOf(factory: Address, gpuId: Hex): Promise<string> {
    this.c();
    return this.fac(factory).data.labels.get(lc(gpuId)) ?? "";
  }
  async kuruRouterOf(): Promise<Address> {
    this.c();
    return this.w.kuruRouter;
  }
  async seriesOf(factory: Address, gpuId: Hex, month: number): Promise<Address> {
    this.c();
    return this.fac(factory).data.series.get(`${lc(gpuId)}:${month}`) ?? "0x0000000000000000000000000000000000000000";
  }
  async marketOf(factory: Address, series: Address): Promise<{ market: Address; venue: VenueId }> {
    this.c();
    return this.fac(factory).data.markets.get(lc(series)) ?? { market: "0x0000000000000000000000000000000000000000", venue: 0 };
  }
  async routerCanUse(factory: Address, series: Address): Promise<boolean> {
    this.c();
    return this.fac(factory).routerCanUse(series);
  }
  async previewListing(): Promise<ListingCheck> {
    return { ok: false, error: "not modelled" };
  }
  async terms(series: Address): Promise<SeriesTerms> {
    this.c();
    return { ...this.ser(series).terms };
  }
  async token(series: Address): Promise<Address> {
    this.c();
    return this.ser(series).token;
  }
  async state(series: Address): Promise<SeriesState> {
    this.c();
    const s = this.ser(series);
    return { k: s.data.stateK, sum: 0n, lastX: 0n, walked: false, appliedReal: true, ledger: 0n, nextId: 1n, shortSupply: 0n };
  }
  async previewSync(series: Address): Promise<{ k: number; sum: bigint }> {
    this.c();
    const s = this.ser(series);
    return { k: s.data.k, sum: s.data.sum };
  }
  async shortOf(series: Address, who: Address): Promise<bigint> {
    this.c();
    return this.ser(series).shortOf(who);
  }
  async position(): Promise<PositionInfo | null> {
    return null;
  }
  async claimable(): Promise<bigint | null> {
    return null;
  }
  async indexRecord(index: Address, gpuId: Hex, day: number): Promise<IndexRecordView> {
    this.c();
    return this.w.indexes.get(lc(index))!.record(gpuId, day);
  }
  async indexHead(index: Address): Promise<number | null> {
    this.c();
    return this.w.indexes.get(lc(index))!.data.head;
  }
  async indexPreviewFix(index: Address, gpuId: Hex): Promise<{ value: bigint } | null> {
    this.c();
    const v = this.w.indexes.get(lc(index))!.data.preview.get(lc(gpuId));
    return v === undefined ? null : { value: v };
  }
  async indexWriters(index: Address): Promise<Address[]> {
    this.c();
    return [...this.w.indexes.get(lc(index))!.data.writers];
  }
  async indexPreviewRecord(index: Address, gpuId: Hex, day: number, writer: Address): Promise<{ value: bigint } | null> {
    this.c();
    const v = this.w.indexes.get(lc(index))!.data.select.get(`${lc(gpuId)}:${day}:${lc(writer)}`);
    return v === undefined ? null : { value: v };
  }
  async indexClocks(index: Address): Promise<{ day: number; closeGrace: number; tPend: number }> {
    this.c();
    return this.w.indexes.get(lc(index))!.clocks;
  }
  async indexDayStart(_index: Address, day: number): Promise<bigint> {
    return BigInt(day) * 86_400n;
  }
  async kuruMarketState(market: Address): Promise<number | null> {
    this.c();
    return this.book(market).data.state;
  }
  async kuruBook(market: Address): Promise<L2Book> {
    this.c();
    return decodeL2Book(this.book(market).l2Bytes());
  }
  async kuruOrders(market: Address, ids: readonly bigint[]): Promise<KuruOrder[]> {
    this.c();
    const k = this.book(market);
    return ids.map((id) => {
      const o = k.sOrder(id);
      const status = k.status(id);
      return { id, owner: o.owner, isBuy: o.isBuy, price: o.price, remaining: status === "ACTIVE" ? o.size : 0n, status };
    });
  }
  async kuruOrderIdCounter(market: Address): Promise<bigint> {
    this.c();
    return this.book(market).data.counter;
  }
  async marginBalance(_ma: Address, who: Address, token: Address): Promise<bigint> {
    this.c();
    return this.w.margin(who, token);
  }
}

export type FaultKind = "simRevert" | "revertOnchain" | "crashAfterLanding" | "throwBeforeSend";
export interface Fault {
  kind: FaultKind;
  match?: (s: SendSpec) => boolean;
}

export interface FakeSenderOptions {
  gasPerSend?: bigint;
  gasPrice?: bigint;
  /** the shared sender's spend guard (BOTS-SPEC 2.6): asked with gasLimit x price, told each landed cost */
  guard?: SpendGuard;
}

export class FakeSender implements Sender {
  readonly log: { spec: SendSpec; result: SendResult }[] = [];
  faults: Fault[] = [];
  nonce = 0;
  o: FakeSenderOptions;

  constructor(
    readonly w: FakeWorld,
    readonly from: Address,
    o: FakeSenderOptions = {},
  ) {
    this.o = o;
  }

  resetNonce(): void {}

  /** Applies one call to the world (inside a transaction). */
  apply(s: SendSpec): unknown {
    const a = s.args as unknown[];
    const me = this.from;
    if (lc(s.to) === lc(this.w.ma)) {
      if (s.functionName === "deposit") return this.w.deposit(me, a[0] as Address, a[1] as Address, a[2] as bigint);
      if (s.functionName === "withdraw") return this.w.withdraw(me, a[0] as bigint, a[1] as Address);
    }
    const k = this.w.kuru.get(lc(s.to));
    if (k) {
      if (s.functionName === "batchUpdate") {
        const n = (xs: unknown) => (xs as (number | bigint)[]).map((x) => BigInt(x));
        return k.batchUpdate(me, n(a[0]), n(a[1]), n(a[2]), n(a[3]), n(a[4]), a[5] as boolean);
      }
      if (s.functionName === "addSellOrder") return k.addSell(me, BigInt(a[0] as number), a[1] as bigint, a[2] as boolean);
      if (s.functionName === "addBuyOrder") return k.addBuy(me, BigInt(a[0] as number), a[1] as bigint, a[2] as boolean);
    }
    const se = this.w.series.get(lc(s.to));
    if (se) {
      if (s.functionName === "mint") return se.mint(me, a[0] as bigint, a[1] as Address);
      if (s.functionName === "redeem") return se.redeem(me, a[0] as bigint, a[1] as Address);
      if (s.functionName === "settle") return se.settle(me, Number(a[0]), a[1] as bigint, a[2] as Address);
      if (s.functionName === "sync") return se.sync(a[0] as bigint);
    }
    if (s.functionName === "approve") return this.w.approve(s.to, me, a[0] as Address, a[1] as bigint);
    throw new Error(`FakeSender: no model for ${s.functionName} on ${s.to}`);
  }

  async simulate(s: SendSpec): Promise<SimResult> {
    const snap = this.w.snapshot();
    try {
      const result = this.w.tx(() => this.apply(s)).result;
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e instanceof FakeRevert ? `${e.errorName}()` : String(e) };
    } finally {
      this.w.restore(snap);
    }
  }

  private take(s: SendSpec): Fault | undefined {
    const i = this.faults.findIndex((f) => !f.match || f.match(s));
    if (i < 0) return undefined;
    return this.faults.splice(i, 1)[0];
  }

  async send(s: SendSpec): Promise<SendResult> {
    const r = await this.sendNow(s);
    this.log.push({ spec: s, result: r });
    return r;
  }

  private async sendNow(s: SendSpec): Promise<SendResult> {
    const fault = this.take(s);
    if (fault?.kind === "throwBeforeSend") throw new Error("injected: crash before send");
    if (fault?.kind === "simRevert") return { ok: false, sent: false, error: "Injected()" };
    const sim = await this.simulate(s);
    if (!sim.ok) return { ok: false, sent: false, error: sim.error ?? "reverts" };
    const gasLimit = this.o.gasPerSend ?? 300_000n;
    const price = this.o.gasPrice ?? 1_000_000_000n;
    const g = this.o.guard?.canSpend(gasLimit * price, s.safety === true);
    if (g && !g.ok) return { ok: false, sent: false, gasLimit, error: g.why };
    const costWei = gasLimit * price;
    this.w.setMon(this.from, this.w.mon(this.from) - costWei);
    this.o.guard?.record(costWei, s.safety === true);
    this.nonce++;
    const txHash = padHex(toHex(this.nonce + 1_000_000), { size: 32 }) as Hex;
    if (fault?.kind === "revertOnchain") return { ok: false, sent: true, txHash, gasLimit, costWei, logs: [], error: "reverted onchain" };
    const { logs } = this.w.tx(() => this.apply(s));
    if (fault?.kind === "crashAfterLanding") throw new Error("injected: crash after the transaction landed");
    return { ok: true, sent: true, txHash, gasLimit, costWei, logs: logs as Log[] };
  }

  /** The functionNames sent and landed, in order (tests). */
  landed(): string[] {
    return this.log.filter((x) => x.result.ok).map((x) => x.spec.functionName);
  }
}
