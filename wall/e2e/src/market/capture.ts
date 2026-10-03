// The fork run's replay fixture for the indexer (BOTS-SPEC 5.7 item 5, E15): every raw log the fork produced after
// the fork block, in order, with its block time and its transaction's sender, and the truth read by views at the
// last block: every series (state, supplies, every account's token and short balance, every position), every
// dollar balance, each series' market, every daily fix the index closed (record()), every Kuru order the books
// created (s_orders and the price-point heads, Kuru's own status rule) and each book's best bid and ask
// (getL2Book). The indexer's fork replay (indexer/test/fork) feeds the logs through Envio's simulate and requires
// every entity to equal this truth.
import { type Abi, type Address, decodeEventLog, type Hex } from "viem";
import { agateDollarAbi, agateFactoryAbi, agateIndexAbi, agateRouterAbi, agateSeriesAbi, agateTokenAbi, decodeL2Book, kuruOrderBookAbi, kuruStatus } from "../../../packages/market/src/index.ts";
import { type Fork, ZERO } from "./fork.ts";

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
  timestamp: number;
  from: string;
}

const DECODE_ABI = [...agateFactoryAbi, ...agateSeriesAbi, ...agateTokenAbi, ...agateDollarAbi, ...agateRouterAbi, ...kuruOrderBookAbi] as unknown as Abi;

/** Every log from `fromBlock` to the latest block, with block time and the transaction's sender. */
export async function exportLogs(f: Fork, fromBlock: bigint): Promise<RawLog[]> {
  const to = await f.block();
  const raw = (await f.call("eth_getLogs", [{ fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${to.toString(16)}` }])) as { address: string; topics: string[]; data: string; blockNumber: Hex; logIndex: Hex; transactionHash: Hex }[];
  const times = new Map<string, number>();
  const froms = new Map<string, string>();
  for (const l of raw) {
    if (!times.has(l.blockNumber)) {
      const b = (await f.call("eth_getBlockByNumber", [l.blockNumber, false])) as { timestamp: Hex };
      times.set(l.blockNumber, Number(BigInt(b.timestamp)));
    }
    if (!froms.has(l.transactionHash)) {
      const t = (await f.call("eth_getTransactionByHash", [l.transactionHash])) as { from: string };
      froms.set(l.transactionHash, t.from.toLowerCase());
    }
  }
  return raw.map((l) => ({
    address: l.address.toLowerCase(),
    topics: l.topics,
    data: l.data,
    blockNumber: Number(BigInt(l.blockNumber)),
    logIndex: Number(BigInt(l.logIndex)),
    transactionHash: l.transactionHash,
    timestamp: times.get(l.blockNumber)!,
    from: froms.get(l.transactionHash)!,
  }));
}

function dec(abi: Abi, l: RawLog): { eventName: string; args: Record<string, unknown> } | null {
  try {
    const d = decodeEventLog({ abi, data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] });
    return { eventName: d.eventName!, args: d.args as unknown as Record<string, unknown> };
  } catch {
    return null;
  }
}

export interface Truth {
  block: number;
  series: Record<string, unknown>;
  dollar: Record<string, string>;
  markets: Record<string, string>;
  fixes: Record<string, unknown>;
  orders: Record<string, unknown>;
  books: Record<string, { bestBid: string | null; bestAsk: string | null; bids: [string, string][]; asks: [string, string][] }>;
}

export async function readTruth(f: Fork, logs: RawLog[], w: { index: Address; dollar: Address; factory: Address }): Promise<Truth> {
  const s = (x: bigint | number) => x.toString();
  const block = Number(await f.block());
  const series: Address[] = [];
  const markets = new Map<string, string>(); // series -> market
  const accounts = new Set<string>();
  const fixDays = new Map<string, { gpuId: Hex; day: number }>();
  const orderIds = new Map<string, Set<bigint>>(); // market -> ids
  for (const l of logs) {
    const d = dec(DECODE_ABI, l) ?? dec(agateIndexAbi as unknown as Abi, l);
    if (!d) continue;
    for (const v of Object.values(d.args)) if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && v !== ZERO) accounts.add(v.toLowerCase());
    if (l.address === w.factory.toLowerCase() && d.eventName === "SeriesListed") series.push(d.args.series as Address);
    if (l.address === w.factory.toLowerCase() && d.eventName === "MarketRecorded" && Number(d.args.venue) === 1) markets.set((d.args.series as string).toLowerCase(), (d.args.market as string).toLowerCase());
    if (l.address === w.index.toLowerCase() && d.eventName === "DayClosed") fixDays.set(`${(d.args.gpuId as string).toLowerCase()}-${d.args.day}`, { gpuId: d.args.gpuId as Hex, day: Number(d.args.day) });
  }
  const bookSet = new Set(markets.values());
  for (const l of logs) {
    if (!bookSet.has(l.address)) continue;
    const d = dec(kuruOrderBookAbi as unknown as Abi, l);
    if (d?.eventName === "OrderCreated") {
      const set = orderIds.get(l.address) ?? new Set<bigint>();
      set.add(BigInt(d.args.orderId as number));
      orderIds.set(l.address, set);
    }
  }
  const out: Truth = { block, series: {}, dollar: {}, markets: Object.fromEntries(markets), fixes: {}, orders: {}, books: {} };
  for (const ser of series) {
    const st = await f.read<readonly [number, bigint, number, boolean, boolean, bigint, bigint, bigint]>(ser, agateSeriesAbi as unknown as Abi, "state");
    const token = await f.read<Address>(ser, agateSeriesAbi as unknown as Abi, "token");
    const supply = await f.read<bigint>(token, agateTokenAbi as unknown as Abi, "totalSupply");
    const shorts: Record<string, string> = {};
    const balances: Record<string, string> = {};
    for (const a of accounts) {
      const sh = await f.read<bigint>(ser, agateSeriesAbi as unknown as Abi, "shortOf", [a]);
      if (sh !== 0n) shorts[a] = s(sh);
      const b = await f.read<bigint>(token, agateTokenAbi as unknown as Abi, "balanceOf", [a]);
      if (b !== 0n) balances[a] = s(b);
    }
    const positions: Record<string, unknown> = {};
    for (let id = 1n; id < st[6]; id++) {
      const p = await f.read<{ owner: Address; payee: Address; operator: Address; side: number; q: bigint; paid: bigint; daily: boolean }>(ser, agateSeriesAbi as unknown as Abi, "position", [id]);
      positions[s(id)] = { open: p.owner !== ZERO, owner: p.owner.toLowerCase(), payee: p.payee.toLowerCase(), operator: p.operator.toLowerCase(), side: p.side, q: s(p.q), paid: s(p.paid), daily: p.daily };
    }
    out.series[ser.toLowerCase()] = { k: st[0], sum: s(st[1]), ledger: s(st[5]), nextId: s(st[6]), shortSupply: s(st[7]), token: token.toLowerCase(), tokenSupply: s(supply), shorts, balances, positions };
  }
  for (const a of accounts) {
    const b = await f.read<bigint>(w.dollar, agateDollarAbi as unknown as Abi, "balanceOf", [a]);
    if (b !== 0n) out.dollar[a] = s(b);
  }
  for (const [key, { gpuId, day }] of fixDays) {
    const [exists, isFinal, r] = await f.read<readonly [boolean, boolean, { value: number; status: number; finalAt: bigint; needsSign: boolean; dropped: boolean; postedAt: bigint; attestedAt: bigint }]>(w.index, agateIndexAbi as unknown as Abi, "record", [gpuId, day]);
    out.fixes[`${w.index.toLowerCase()}-${key}`] = { exists, isFinal, value: s(r.value), status: r.status, finalAt: s(r.finalAt), needsSign: r.needsSign, dropped: r.dropped, postedAt: s(r.postedAt), attestedAt: s(r.attestedAt) };
  }
  for (const [market, ids] of orderIds) {
    for (const id of ids) {
      const o = await f.read<readonly [Address, bigint, number, number, number, number, number, boolean]>(market as Address, kuruOrderBookAbi as unknown as Abi, "s_orders", [Number(id)]);
      let status: string;
      if (o[5] === 0) status = "CANCELED";
      else {
        const [head] = await f.read<readonly [number, number]>(market as Address, kuruOrderBookAbi as unknown as Abi, o[7] ? "s_buyPricePoints" : "s_sellPricePoints", [BigInt(o[5])]);
        status = kuruStatus(id, BigInt(o[5]), BigInt(head));
      }
      out.orders[`${market}-${id}`] = { owner: o[0].toLowerCase(), remaining: s(o[1]), price: s(o[5]), isBuy: o[7], status };
    }
    const b = decodeL2Book(await f.read<Hex>(market as Address, kuruOrderBookAbi as unknown as Abi, "getL2Book"));
    out.books[market] = { bestBid: b.bids[0] ? s(b.bids[0][0]) : null, bestAsk: b.asks[0] ? s(b.asks[0][0]) : null, bids: b.bids.map(([p, z]) => [s(p), s(z)]), asks: b.asks.map(([p, z]) => [s(p), s(z)]) };
  }
  return out;
}
