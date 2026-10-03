// BOTS-SPEC 3.3, 3.6: the book seen by the maker (others' best bid and ask: the L2 book minus its own resting sizes),
// and what a landed batchUpdate did (OrderCreated ids of the maker, OrderCanceled / OrdersCanceled).
import { type Address, decodeEventLog, type Log } from "viem";
import { kuruOrderBookAbi, type L2Book } from "@agate/market";

export { decodeL2Book, kuruStatus } from "@agate/market";

export interface OwnOrder {
  id: bigint;
  isBuy: boolean;
  price: bigint;
  size: bigint; // size units at creation
  remaining: bigint; // size units resting now
}

/** Others' best bid and ask: each price level minus the maker's own remaining there; null when nothing is left. */
export function othersBest(book: L2Book, own: readonly OwnOrder[]): { bid: bigint | null; ask: bigint | null } {
  const mine = new Map<string, bigint>();
  for (const o of own) {
    const k = `${o.isBuy ? "b" : "a"}:${o.price}`;
    mine.set(k, (mine.get(k) ?? 0n) + o.remaining);
  }
  let bid: bigint | null = null;
  for (const [p, s] of book.bids) {
    if (s - (mine.get(`b:${p}`) ?? 0n) > 0n && (bid === null || p > bid)) bid = p;
  }
  let ask: bigint | null = null;
  for (const [p, s] of book.asks) {
    if (s - (mine.get(`a:${p}`) ?? 0n) > 0n && (ask === null || p < ask)) ask = p;
  }
  return { bid, ask };
}

export interface BatchEffects {
  created: OwnOrder[];
  canceled: bigint[];
}

/** The maker's new orders and every id cancelled, from the logs of a landed transaction on market. */
export function parseBatchLogs(logs: readonly Log[], market: Address, maker: Address): BatchEffects {
  const created: OwnOrder[] = [];
  const canceled: bigint[] = [];
  for (const l of logs) {
    if (l.address.toLowerCase() !== market.toLowerCase()) continue;
    let ev: { eventName: string; args: Record<string, unknown> };
    try {
      ev = decodeEventLog({ abi: kuruOrderBookAbi, data: l.data, topics: l.topics }) as unknown as typeof ev;
    } catch {
      continue;
    }
    if (ev.eventName === "OrderCreated") {
      if ((ev.args.owner as string).toLowerCase() !== maker.toLowerCase()) continue;
      const size = BigInt(ev.args.size as bigint);
      created.push({ id: BigInt(ev.args.orderId as number), isBuy: ev.args.isBuy as boolean, price: BigInt(ev.args.price as number), size, remaining: size });
    } else if (ev.eventName === "OrderCanceled") {
      if ((ev.args.owner as string).toLowerCase() === maker.toLowerCase()) canceled.push(BigInt(ev.args.orderId as number));
    }
  }
  return { created, canceled };
}
