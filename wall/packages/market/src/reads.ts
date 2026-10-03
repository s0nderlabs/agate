// BOTS-SPEC 2.5: MarketReads over viem and the wall's RpcPool. Views issued in the same turn of the event loop are
// batched into one Multicall3 aggregate3 (allowFailure) at `latest` when Multicall3 has code on the chain (checked
// once), else sent as plain eth_calls (a local anvil). A view that reverts returns null where the type allows it;
// a transport failure fails the pool over and, when every URL fails, rejects with RpcDown.
import {
  AbiDecodingZeroDataError,
  type Abi,
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  type Hex,
  hexToBigInt,
} from "viem";
import { isRevert, type RpcPool } from "@agate/watcher";
import { agateFactoryAbi, agateIndexAbi, agateSeriesAbi } from "./abi.ts";
import { MULTICALL3, ZERO_ADDRESS } from "./constants.ts";
import { kuruMarginAccountAbi, kuruOrderBookAbi } from "./kuru-abi.ts";
import { revertReason } from "./sender.ts";
import type { IndexRecordView, KuruOrder, L2Book, ListingCheck, MarketReads, PositionInfo, SeriesState, SeriesTerms, Side, VenueId } from "./types.ts";

const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

/** Reads the payer needs beyond MarketReads (the lister's LISTER_STUCK timing). */
export interface ExtraReads {
  indexFirstRecordDay(index: Address, gpuId: Hex): Promise<{ exists: boolean; day: number }>;
}

/** Reads the maker uses beyond MarketReads (audit M-H1): what closeDay would record for the index's head day right
 *  now (index.previewFix), null when it is not computable (below quorum, no readings, or a MockIndex); and (recheck
 *  R2-M1) the index's writers and what one writer's value for a day would be (index.previewRecord: the pending day
 *  head - 1, where the attester may select it, or the head day), null when it is not eligible or below quorum. */
export interface PreviewReads {
  indexPreviewFix(index: Address, gpuId: Hex): Promise<{ value: bigint } | null>;
  indexWriters(index: Address): Promise<Address[]>;
  indexPreviewRecord(index: Address, gpuId: Hex, day: number, writer: Address): Promise<{ value: bigint } | null>;
}

export class ViewReverted extends Error {}

interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}
type Res = { ok: true; value: unknown } | { ok: false; error: unknown };
interface Req extends Call {
  resolve: (r: Res) => void;
  reject: (e: unknown) => void;
}

/** A failure of the call itself (a revert, or no code at the address), never of the transport. */
export function callFailure(e: unknown): boolean {
  if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError || x instanceof ContractFunctionZeroDataError || x instanceof AbiDecodingZeroDataError)) return true;
  return isRevert(e);
}

export interface ViemReadsOptions {
  pool: RpcPool;
  /** calls per aggregate3 (default 300) */
  chunk?: number;
  /** force plain calls (tests) */
  noMulticall?: boolean;
}

export class ViemReads implements MarketReads, ExtraReads, PreviewReads {
  private pending: Req[] = [];
  private scheduled = false;
  private mc: boolean | null = null;
  private readonly cache = new Map<string, Promise<unknown>>();
  /** batches sent (tests) */
  batches = 0;

  constructor(readonly o: ViemReadsOptions) {
    if (o.noMulticall) this.mc = false;
  }

  // ------------------------------------------------------------------ batching

  private enqueue(c: Call): Promise<Res> {
    return new Promise<Res>((resolve, reject) => {
      this.pending.push({ ...c, resolve, reject });
      if (!this.scheduled) {
        this.scheduled = true;
        setTimeout(() => void this.flush(), 0);
      }
    });
  }

  private async flush(): Promise<void> {
    const batch = this.pending;
    this.pending = [];
    this.scheduled = false;
    if (batch.length === 0) return;
    try {
      const rs = await this.exec(batch);
      batch.forEach((r, i) => r.resolve(rs[i]!));
    } catch (e) {
      for (const r of batch) r.reject(e);
    }
  }

  private async multicallOn(): Promise<boolean> {
    if (this.mc === null) {
      const code = await this.o.pool.call((c) => c.getCode({ address: MULTICALL3 }));
      this.mc = !!code && code !== "0x";
    }
    return this.mc;
  }

  private async exec(batch: Call[]): Promise<Res[]> {
    this.batches++;
    if (!(await this.multicallOn())) {
      return Promise.all(
        batch.map(async (c) => {
          try {
            const value = await this.o.pool.call((cl) => cl.readContract({ address: c.address, abi: c.abi, functionName: c.functionName, args: c.args as unknown[], blockTag: "latest" }), callFailure);
            return { ok: true as const, value };
          } catch (e) {
            if (callFailure(e)) return { ok: false as const, error: e };
            throw e;
          }
        }),
      );
    }
    const size = this.o.chunk ?? 300;
    const out: Res[] = [];
    for (let i = 0; i < batch.length; i += size) {
      const part = batch.slice(i, i + size);
      const rs = await this.o.pool.call(async (cl) => {
        const r = await cl.multicall({
          contracts: part.map((c) => ({ address: c.address, abi: c.abi, functionName: c.functionName, args: c.args as unknown[] })),
          allowFailure: true,
          multicallAddress: MULTICALL3,
          blockTag: "latest",
          batchSize: 0,
        } as never);
        const arr = r as unknown as { status: "success" | "failure"; result?: unknown; error?: unknown }[];
        // a transport failure inside multicall arrives as a per-call failure: rethrow it so the pool fails over
        const transport = arr.find((x) => x.status === "failure" && !callFailure(x.error));
        if (transport) throw transport.error;
        return arr;
      });
      for (const x of rs) out.push(x.status === "success" ? { ok: true, value: x.result } : { ok: false, error: x.error });
    }
    return out;
  }

  private async view<T>(c: Call): Promise<T> {
    const r = await this.enqueue(c);
    if (!r.ok) throw new ViewReverted(`${c.functionName} at ${c.address}: ${revertReason(r.error, c.abi)}`);
    return r.value as T;
  }

  private async maybe<T>(c: Call): Promise<T | null> {
    const r = await this.enqueue(c);
    return r.ok ? (r.value as T) : null;
  }

  private cached<T>(key: string, f: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (!p) {
      p = f();
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key));
    }
    return p;
  }

  // ------------------------------------------------------------------ chain

  async blockTime(): Promise<bigint> {
    const b = await this.o.pool.call((c) => c.getBlock({ blockTag: "latest" }));
    return b.timestamp;
  }

  monBalance(who: Address): Promise<bigint> {
    return this.o.pool.call((c) => c.getBalance({ address: who, blockTag: "latest" }));
  }

  erc20Balance(token: Address, who: Address): Promise<bigint> {
    return this.view<bigint>({ address: token, abi: erc20Abi as Abi, functionName: "balanceOf", args: [who] });
  }

  allowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
    return this.view<bigint>({ address: token, abi: erc20Abi as Abi, functionName: "allowance", args: [owner, spender] });
  }

  // ------------------------------------------------------------------ factory

  private f(factory: Address, functionName: string, args: readonly unknown[] = []): Call {
    return { address: factory, abi: agateFactoryAbi as Abi, functionName, args };
  }

  async currentMonth(factory: Address): Promise<number> {
    return Number(await this.view<number>(this.f(factory, "currentMonth")));
  }

  gpuIds(factory: Address): Promise<Hex[]> {
    return this.cached(`gpuIds:${factory}`, async () => [...(await this.view<readonly Hex[]>(this.f(factory, "gpuIds")))]);
  }

  labelOf(factory: Address, gpuId: Hex): Promise<string> {
    return this.cached(`label:${factory}:${gpuId}`, () => this.view<string>(this.f(factory, "labelOf", [gpuId])));
  }

  kuruRouterOf(factory: Address): Promise<Address> {
    return this.cached(`kr:${factory}`, () => this.view<Address>(this.f(factory, "kuruRouter")));
  }

  seriesOf(factory: Address, gpuId: Hex, month: number): Promise<Address> {
    return this.view<Address>(this.f(factory, "seriesOf", [gpuId, month]));
  }

  async marketOf(factory: Address, series: Address): Promise<{ market: Address; venue: VenueId }> {
    const [market, venue] = await this.view<readonly [Address, number]>(this.f(factory, "marketOf", [series]));
    return { market, venue: Number(venue) as VenueId };
  }

  routerCanUse(factory: Address, series: Address): Promise<boolean> {
    return this.view<boolean>(this.f(factory, "routerCanUse", [series]));
  }

  async previewListing(factory: Address, gpuId: Hex, month: number): Promise<ListingCheck> {
    const c = this.f(factory, "previewListing", [gpuId, month]);
    const r = await this.enqueue(c);
    if (!r.ok) return { ok: false, error: revertReason(r.error, c.abi) };
    const l = r.value as { floor: number | bigint; cap: number | bigint };
    return { ok: true, floor: BigInt(l.floor), cap: BigInt(l.cap) };
  }

  // ------------------------------------------------------------------ series

  private s(series: Address, functionName: string, args: readonly unknown[] = []): Call {
    return { address: series, abi: agateSeriesAbi as Abi, functionName, args };
  }

  terms(series: Address): Promise<SeriesTerms> {
    return this.cached(`terms:${series}`, async () => {
      const t = await this.view<Record<string, unknown>>(this.s(series, "terms"));
      return {
        index: t.index as Address,
        dollar: t.dollar as Address,
        factory: t.factory as Address,
        router: t.router as Address,
        gpuId: t.gpuId as Hex,
        recipeHash: t.recipeHash as Hex,
        month: Number(t.month),
        startDay: Number(t.startDay),
        n: Number(t.n),
        startTs: BigInt(t.startTs as bigint),
        day: Number(t.day),
        lastResort: BigInt(t.lastResort as bigint),
        floor: BigInt(t.floor as number),
        cap: BigInt(t.cap as number),
        x0: BigInt(t.x0 as number),
        bandGrade: Number(t.bandGrade),
        anchorCarried: Number(t.anchorCarried),
        anchorMinFresh: Number(t.anchorMinFresh),
        anchorLate: Boolean(t.anchorLate),
      };
    });
  }

  token(series: Address): Promise<Address> {
    return this.cached(`token:${series}`, () => this.view<Address>(this.s(series, "token")));
  }

  async state(series: Address): Promise<SeriesState> {
    const r = await this.view<readonly [number, bigint, number, boolean, boolean, bigint, bigint, bigint]>(this.s(series, "state"));
    return { k: Number(r[0]), sum: BigInt(r[1]), lastX: BigInt(r[2]), walked: r[3], appliedReal: r[4], ledger: BigInt(r[5]), nextId: BigInt(r[6]), shortSupply: BigInt(r[7]) };
  }

  async previewSync(series: Address): Promise<{ k: number; sum: bigint }> {
    const [k, sum] = await this.view<readonly [number, bigint]>(this.s(series, "previewSync"));
    return { k: Number(k), sum: BigInt(sum) };
  }

  shortOf(series: Address, who: Address): Promise<bigint> {
    return this.view<bigint>(this.s(series, "shortOf", [who]));
  }

  async position(series: Address, id: bigint): Promise<PositionInfo | null> {
    const p = await this.view<{ owner: Address; side: number; daily: boolean; openedK: number; payee: Address; q: bigint; operator: Address; paid: bigint }>(this.s(series, "position", [id]));
    if (p.owner.toLowerCase() === ZERO_ADDRESS) return null;
    return { id, owner: p.owner, payee: p.payee, operator: p.operator, side: Number(p.side) as Side, q: BigInt(p.q), paid: BigInt(p.paid), daily: p.daily, openedK: Number(p.openedK), open: true };
  }

  claimable(series: Address, id: bigint): Promise<bigint | null> {
    return this.maybe<bigint>(this.s(series, "claimable", [id]));
  }

  // ------------------------------------------------------------------ index

  private i(index: Address, functionName: string, args: readonly unknown[] = []): Call {
    return { address: index, abi: agateIndexAbi as Abi, functionName, args };
  }

  async indexRecord(index: Address, gpuId: Hex, day: number): Promise<IndexRecordView> {
    const [exists, isFinal, rec] = await this.view<readonly [boolean, boolean, { value: number; status: number; source: Address; attestedAt: bigint }]>(this.i(index, "record", [gpuId, day]));
    return { exists, isFinal, value: BigInt(rec.value), status: Number(rec.status), source: rec.source, attestedAt: BigInt(rec.attestedAt) };
  }

  async indexWriters(index: Address): Promise<Address[]> {
    // read every time (an admin can rotate a writer); a zero slot is no writer; reverts (a MockIndex): none
    const ws = await this.maybe<readonly Address[]>(this.i(index, "writers"));
    return (ws ?? []).filter((w) => w.toLowerCase() !== ZERO_ADDRESS);
  }

  async indexPreviewRecord(index: Address, gpuId: Hex, day: number, writer: Address): Promise<{ value: bigint } | null> {
    const r = await this.maybe<readonly [boolean, { rec: { value: number } }]>(this.i(index, "previewRecord", [gpuId, day, writer]));
    if (r === null || !r[0]) return null;
    return { value: BigInt(r[1].rec.value) };
  }

  async indexHead(index: Address, gpuId: Hex): Promise<number | null> {
    const h = await this.maybe<number>(this.i(index, "head", [gpuId]));
    return h === null ? null : Number(h);
  }

  indexClocks(index: Address): Promise<{ day: number; closeGrace: number; tPend: number }> {
    return this.cached(`clocks:${index}`, async () => {
      const c = await this.view<{ day: number; closeGrace: number; tPend: number }>(this.i(index, "clocks"));
      return { day: Number(c.day), closeGrace: Number(c.closeGrace), tPend: Number(c.tPend) };
    });
  }

  async indexPreviewFix(index: Address, gpuId: Hex): Promise<{ value: bigint } | null> {
    const r = await this.maybe<readonly [boolean, { rec: { value: number } }]>(this.i(index, "previewFix", [gpuId]));
    if (r === null || !r[0]) return null;
    return { value: BigInt(r[1].rec.value) };
  }

  async indexDayStart(index: Address, day: number): Promise<bigint> {
    return BigInt(await this.view<bigint>(this.i(index, "dayStart", [day])));
  }

  async indexFirstRecordDay(index: Address, gpuId: Hex): Promise<{ exists: boolean; day: number }> {
    const [exists, day] = await this.view<readonly [boolean, number]>(this.i(index, "firstRecordDay", [gpuId]));
    return { exists, day: Number(day) };
  }

  // ------------------------------------------------------------------ Kuru V1

  private k(market: Address, functionName: string, args: readonly unknown[] = []): Call {
    return { address: market, abi: kuruOrderBookAbi as Abi, functionName, args };
  }

  async kuruMarketState(market: Address): Promise<number | null> {
    const s = await this.maybe<number>(this.k(market, "marketState"));
    return s === null ? null : Number(s);
  }

  async kuruBook(market: Address): Promise<L2Book> {
    return decodeL2Book(await this.view<Hex>(this.k(market, "getL2Book")));
  }

  async kuruOrders(market: Address, ids: readonly bigint[]): Promise<KuruOrder[]> {
    if (ids.length === 0) return [];
    const raw = await Promise.all(ids.map((id) => this.view<readonly [Address, bigint, number, number, number, number, number, boolean]>(this.k(market, "s_orders", [Number(id)]))));
    // one price-point read per (side, price), not per order: a ladder rests a few prices
    const keys = [...new Set(raw.filter((o) => Number(o[5]) !== 0).map((o) => `${o[7] ? "b" : "s"}:${Number(o[5])}`))];
    const heads = await Promise.all(keys.map((k) => this.view<readonly [number, number]>(this.k(market, k.startsWith("b") ? "s_buyPricePoints" : "s_sellPricePoints", [BigInt(k.slice(2))]))));
    const headOf = new Map<string, bigint>(keys.map((k, i) => [k, BigInt(heads[i]![0])]));
    return raw.map((o, i) => {
      const id = ids[i]!;
      const price = BigInt(o[5]);
      const status = kuruStatus(id, price, headOf.get(`${o[7] ? "b" : "s"}:${Number(o[5])}`) ?? 0n);
      return { id, owner: o[0], isBuy: o[7], price, remaining: status === "ACTIVE" ? BigInt(o[1]) : 0n, status };
    });
  }

  async kuruOrderIdCounter(market: Address): Promise<bigint> {
    return BigInt(await this.view<number>(this.k(market, "s_orderIdCounter")));
  }

  marginBalance(marginAccount: Address, who: Address, token: Address): Promise<bigint> {
    return this.view<bigint>({ address: marginAccount, abi: kuruMarginAccountAbi as Abi, functionName: "getBalance", args: [who, token] });
  }
}

/** Kuru's own status rule (BOTS-SPEC 3.6): price 0 cancelled (or never existed); head 0 or head > id filled; else
 *  active with its size as the remainder. */
export function kuruStatus(id: bigint, price: bigint, head: bigint): KuruOrder["status"] {
  if (price === 0n) return "CANCELED";
  if (head === 0n || head > id) return "FILLED";
  return "ACTIVE";
}

/** BOTS-SPEC 1: getL2Book's bytes are 32-byte words: the block number, (price, size) pairs of the bids best first, a
 *  zero word, then the asks best first (prices in pricePrecision units, sizes in size units summed per price). */
export function decodeL2Book(data: Hex): L2Book {
  const hex = data.slice(2);
  const words: bigint[] = [];
  for (let i = 0; i + 64 <= hex.length; i += 64) words.push(hexToBigInt(`0x${hex.slice(i, i + 64)}`));
  const book: L2Book = { block: words[0] ?? 0n, bids: [], asks: [] };
  let i = 1;
  let side: "bids" | "asks" = "bids";
  while (i < words.length) {
    const price = words[i]!;
    if (side === "bids" && price === 0n) {
      side = "asks";
      i += 1;
      continue;
    }
    if (i + 1 >= words.length) break;
    book[side].push([price, words[i + 1]!]);
    i += 2;
  }
  return book;
}
