// What the harness reads from the fork to judge the bots: series terms and previews, the maker's fair value
// recomputed independently (BOTS-SPEC 3.2), its expected ladder (3.3), Kuru books and order status by Kuru's own
// rule, the transactions a bot sent in a block range (decoded into gas shapes), and the positions the harness opened.
import { type Abi, type Address, decodeEventLog, decodeFunctionData, type Hex } from "viem";
import { agateDollarAbi, agateFactoryAbi, agateIndexAbi, agateSeriesAbi, decodeL2Book, kuruMarginAccountAbi, kuruOrderBookAbi, kuruStatus, type L2Book } from "../../../packages/market/src/index.ts";
import { type Fork, MARGIN, ZERO } from "./fork.ts";

export const TICK = 10_000n;
export const UNITS = 10_000n; // Kuru size units per token
export const CENT = 10_000n;

export interface Terms {
  series: Address;
  token: Address;
  gpuId: Hex;
  month: number;
  startDay: number;
  n: number;
  startTs: bigint;
  day: bigint;
  floor: bigint;
  cap: bigint;
}

export async function terms(f: Fork, series: Address): Promise<Terms> {
  const t = await f.read<{ gpuId: Hex; month: number; startDay: number; n: number; startTs: bigint; day: number; floor: number; cap: number }>(series, agateSeriesAbi as Abi, "terms");
  const token = await f.read<Address>(series, agateSeriesAbi as Abi, "token");
  return { series, token, gpuId: t.gpuId, month: t.month, startDay: t.startDay, n: t.n, startTs: t.startTs, day: BigInt(t.day), floor: BigInt(t.floor), cap: BigInt(t.cap) };
}

export async function preview(f: Fork, series: Address): Promise<{ k: number; S: bigint }> {
  const [k, S] = await f.read<readonly [number, bigint]>(series, agateSeriesAbi as Abi, "previewSync");
  return { k, S };
}

/** BOTS-SPEC 3.2, recomputed by the harness from the index and previewSync. */
export async function fairOf(f: Fork, index: Address, t: Terms): Promise<bigint | null> {
  const now = await f.time();
  const today = t.startDay + Math.floor(Number(now - t.startTs) / Number(t.day));
  let top = today - 1;
  try {
    const head = await f.read<number>(index, agateIndexAbi as Abi, "head", [t.gpuId]);
    top = Math.min(top, head - 1);
  } catch {
    // MockIndex: no head
  }
  let x: bigint | null = null;
  for (let d = top; d >= top - 31; d--) {
    const [exists, isFinal, r] = await f.read<readonly [boolean, boolean, { value: number }]>(index, agateIndexAbi as Abi, "record", [t.gpuId, d]);
    if (exists && isFinal) {
      x = BigInt(r.value);
      break;
    }
  }
  if (x === null) return null;
  const xc = x < t.floor ? t.floor : x > t.cap ? t.cap : x;
  const { k, S } = await preview(f, t.series);
  return (S + BigInt(t.n - k) * xc) / BigInt(t.n);
}

/** BOTS-SPEC 3.3 on an empty book: the default ladder (1 % half-spread, 3 levels one tick apart, 1,000 / 2,000 / 4,000). */
export function expectedLadder(fair: bigint, F: bigint, C: bigint, o: { spreadBps?: bigint; levels?: number; sizes?: bigint[] } = {}): { bids: [bigint, bigint][]; asks: [bigint, bigint][] } {
  const bps = o.spreadBps ?? 100n;
  const levels = o.levels ?? 3;
  const sizes = o.sizes ?? [1_000n, 2_000n, 4_000n];
  let h = (fair * bps + 9_999n) / 10_000n;
  if (h < TICK) h = TICK;
  const bids: [bigint, bigint][] = [];
  const asks: [bigint, bigint][] = [];
  if (fair - h >= TICK) {
    const bid0 = ((fair - h) / TICK) * TICK;
    for (let i = 0; i < levels; i++) {
      const p = bid0 - BigInt(i) * TICK;
      if (p >= F) bids.push([p, sizes[i]! * UNITS]);
    }
  }
  const ask0 = ((fair + h + TICK - 1n) / TICK) * TICK;
  for (let i = 0; i < levels; i++) {
    const p = ask0 + BigInt(i) * TICK;
    if (p <= C) asks.push([p, sizes[i]! * UNITS]);
  }
  return { bids, asks };
}

export async function book(f: Fork, market: Address): Promise<L2Book> {
  return decodeL2Book(await f.read<Hex>(market, kuruOrderBookAbi as Abi, "getL2Book"));
}

export interface ChainOrder {
  id: bigint;
  owner: Address;
  remaining: bigint;
  price: bigint;
  isBuy: boolean;
  status: "ACTIVE" | "FILLED" | "CANCELED";
}

/** Every order id 1..s_orderIdCounter of a market with Kuru's own status rule (multicall). */
export async function allOrders(f: Fork, market: Address): Promise<ChainOrder[]> {
  const top = BigInt(await f.read<number>(market, kuruOrderBookAbi as Abi, "s_orderIdCounter"));
  const out: ChainOrder[] = [];
  const ids: bigint[] = [];
  for (let id = 1n; id <= top; id++) ids.push(id);
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const rs = (await f.pub.multicall({ allowFailure: false, multicallAddress: "0xcA11bde05977b3631167028862bE2a173976CA11", contracts: chunk.map((id) => ({ address: market, abi: kuruOrderBookAbi as Abi, functionName: "s_orders", args: [Number(id)] })) })) as unknown as (readonly [Address, bigint, number, number, number, number, number, boolean])[];
    const heads = (await f.pub.multicall({
      allowFailure: false,
      multicallAddress: "0xcA11bde05977b3631167028862bE2a173976CA11",
      contracts: rs.map((o) => ({ address: market, abi: kuruOrderBookAbi as Abi, functionName: o[7] ? "s_buyPricePoints" : "s_sellPricePoints", args: [BigInt(o[5])] })),
    })) as unknown as (readonly [number, number])[];
    chunk.forEach((id, j) => {
      const o = rs[j]!;
      out.push({ id, owner: o[0], remaining: o[1], price: BigInt(o[5]), isBuy: o[7], status: kuruStatus(id, BigInt(o[5]), BigInt(heads[j]![0])) });
    });
  }
  return out;
}

export function activeOf(orders: ChainOrder[], owner: Address): ChainOrder[] {
  return orders.filter((o) => o.status === "ACTIVE" && o.owner.toLowerCase() === owner.toLowerCase());
}

export async function marginOf(f: Fork, who: Address, token: Address): Promise<bigint> {
  return f.read<bigint>(MARGIN, kuruMarginAccountAbi as Abi, "getBalance", [who, token]);
}

export interface SentTx {
  hash: Hex;
  block: bigint;
  to: Address;
  input: Hex;
  gas: bigint;
  gasUsed: bigint;
  ok: boolean;
  fn: string;
  args: readonly unknown[];
}

const SHAPE_ABIS = [agateSeriesAbi, agateFactoryAbi, agateDollarAbi, kuruOrderBookAbi, kuruMarginAccountAbi] as unknown as Abi[];

/** Every transaction `from` sent in blocks [a, b], decoded (function and arguments) with the market ABIs. */
export async function txsFrom(f: Fork, from: Address, a: bigint, b?: bigint): Promise<SentTx[]> {
  const end = b ?? (await f.block());
  const out: SentTx[] = [];
  for (let n = a; n <= end; n++) {
    const blk = (await f.call("eth_getBlockByNumber", [`0x${n.toString(16)}`, true])) as { transactions: { hash: Hex; from: string; to: Address; input: Hex; gas: Hex }[] } | null;
    if (!blk) continue;
    for (const t of blk.transactions) {
      if (t.from.toLowerCase() !== from.toLowerCase()) continue;
      const rc = (await f.call("eth_getTransactionReceipt", [t.hash])) as { status: Hex; gasUsed: Hex };
      let fn = t.input.slice(0, 10);
      let args: readonly unknown[] = [];
      for (const abi of SHAPE_ABIS) {
        try {
          const d = decodeFunctionData({ abi, data: t.input });
          fn = d.functionName;
          args = (d.args ?? []) as readonly unknown[];
          break;
        } catch {
          // another ABI
        }
      }
      out.push({ hash: t.hash, block: n, to: t.to, input: t.input, gas: BigInt(t.gas), gasUsed: BigInt(rc.gasUsed), ok: rc.status === "0x1", fn, args });
    }
  }
  return out;
}

/** A gas shape name and its c / n / adds / cancels detail for a decoded bot transaction. */
export function shapeOf(t: SentTx, k: { dollar: Address; margin: Address }): { shape: string; detail: string } {
  switch (t.fn) {
    case "batchUpdate": {
      const [bp, , sp, , cancels] = t.args as [unknown[], unknown[], unknown[], unknown[], unknown[]];
      return { shape: "kuru.batchUpdate", detail: `adds ${bp.length + sp.length}, cancels ${cancels.length}` };
    }
    case "deposit":
      return { shape: "kuru.deposit", detail: (t.args[1] as string).toLowerCase() === k.dollar.toLowerCase() ? "dollar" : "token" };
    case "withdraw":
      return { shape: "kuru.withdraw", detail: (t.args[1] as string).toLowerCase() === k.dollar.toLowerCase() ? "dollar" : "token" };
    case "approve":
      return { shape: "erc20.approve", detail: (t.args[0] as string).toLowerCase() === k.margin.toLowerCase() ? (t.to.toLowerCase() === k.dollar.toLowerCase() ? "dollar to MarginAccount" : "token to MarginAccount") : "dollar to series" };
    case "claimMany":
      return { shape: "series.claimMany", detail: `n ${(t.args[0] as unknown[]).length}` };
    case "sync":
      return { shape: "series.sync", detail: `c ${t.args[0]}` };
    case "list":
      return { shape: "factory.list", detail: "" };
    case "createMarket":
      return { shape: "factory.createMarket", detail: "" };
    case "mint":
    case "redeem":
    case "settle":
      return { shape: `series.${t.fn}`, detail: t.fn === "settle" ? (t.args[0] === 0 ? "LONG" : "SHORT") : `${t.args[0]} base units` };
    default:
      return { shape: t.fn, detail: "" };
  }
}

export interface Pos {
  series: Address;
  id: bigint;
  owner: Address;
  payee: Address;
  side: number;
  q: bigint;
  daily: boolean;
  label: string;
}

/** The PositionOpened events of a receipt. */
export function opened(logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[], label: string): Pos[] {
  const out: Pos[] = [];
  for (const l of logs) {
    try {
      const d = decodeEventLog({ abi: agateSeriesAbi as Abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (d.eventName !== "PositionOpened") continue;
      const a = d.args as unknown as { id: bigint; owner: Address; payee: Address; side: number; q: bigint; daily: boolean };
      out.push({ series: l.address, id: a.id, owner: a.owner, payee: a.payee, side: Number(a.side), q: a.q, daily: a.daily, label });
    } catch {
      // not a series event
    }
  }
  return out;
}

export async function position(f: Fork, p: Pos): Promise<{ owner: Address; paid: bigint; payee: Address; daily: boolean }> {
  return f.read<{ owner: Address; paid: bigint; payee: Address; daily: boolean }>(p.series, agateSeriesAbi as Abi, "position", [p.id]);
}
export async function claimableOf(f: Fork, p: Pos): Promise<bigint | null> {
  try {
    return await f.read<bigint>(p.series, agateSeriesAbi as Abi, "claimable", [p.id]);
  } catch {
    return null; // NoPosition: closed
  }
}
export const isOpen = async (f: Fork, p: Pos) => (await position(f, p)).owner !== ZERO;
