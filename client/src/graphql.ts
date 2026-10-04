// The Envio indexer's GraphQL (Hasura over Envio's tables, indexer/README.md): a small fetch-based reader and the
// queries the client runs. Addresses and gpuIds are lowercase in every filter; BigInt columns come back as strings.
// Every failure (unreachable, HTTP error, GraphQL errors) is an IndexerError, which the reads turn into their
// documented chain-only fallbacks.

export const DEFAULT_GRAPHQL_URL = "http://localhost:8080/v1/graphql";

export class IndexerError extends Error {
  override name = "IndexerError";
}

export interface GraphQL {
  readonly url: string;
  query<T>(q: string, variables?: Record<string, unknown>): Promise<T>;
}

export function graphql(url: string, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): GraphQL {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = o.timeoutMs ?? 10_000;
  return {
    url,
    async query<T>(q: string, variables: Record<string, unknown> = {}): Promise<T> {
      let r: Response;
      try {
        r = await f(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: q, variables }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new IndexerError(`the indexer at ${url} is not reachable (${e instanceof Error ? e.message : String(e)})`);
      }
      if (!r.ok) throw new IndexerError(`the indexer answered HTTP ${r.status}`);
      // whatever answers at the URL must be GraphQL's JSON: a dev server's HTML page or a proxy's error page (even with
      // status 200) means no indexer there
      let j: { data?: T; errors?: { message: string }[] };
      try {
        j = (await r.json()) as { data?: T; errors?: { message: string }[] };
      } catch (e) {
        throw new IndexerError(`the indexer at ${url} did not answer JSON (${e instanceof Error ? e.message : String(e)})`);
      }
      if (!j || typeof j !== "object") throw new IndexerError(`the indexer at ${url} did not answer a GraphQL object`);
      if (j.errors?.length) throw new IndexerError(`the indexer refused the query: ${j.errors.map((e) => e.message).join("; ")}`);
      if (!j.data) throw new IndexerError("the indexer answered without data");
      return j.data;
    },
  };
}

// ------------------------------------------------------------------ rows

export interface FixRow {
  day: number;
  date: string;
  value: string;
  status: string;
  state: string;
  finalAt: string | null;
}
export interface SeriesRow {
  id: string;
  listedAt: string;
  qInPositionsLong: string;
  qInPositionsShort: string;
  tokenSupply: string;
}
export interface TradeRow {
  id: string;
  block: string;
  timestamp: string;
  priceU: string;
  tokens: string;
  takerIsBuy: boolean;
  maker: string;
  taker: string;
  txOrigin: string;
  txHash: string | null;
  series_id?: string;
  orderId?: string;
}
export interface PositionRow {
  id: string;
  positionId: string;
  openedAt: string;
  series_id: string;
  side: string;
  q: string;
  status: string;
}
export interface FlowRow {
  id?: string;
  flow: string;
  series_id: string;
  tokens: string;
  dollarsIn: string;
  dollarsOut: string;
  refund: string;
  positionIds: string[];
  txHash: string | null;
  timestamp: string;
}
export interface OrderRow {
  id: string;
  orderId: string;
  market_id: string;
  series_id: string;
  isBuy: boolean;
  price: string;
  size: string;
  remaining: string;
  createdAt: string;
}

export const Q = {
  history: `query History($index: String!, $gpus: [String!]!) {
  DailyFix(where: {index_id: {_eq: $index}, gpuId: {_in: $gpus}}, order_by: {day: asc}, limit: 5000) { gpuId day date value status state finalAt }
}`,
  series: `query Series($ids: [String!]!) {
  Series(where: {id: {_in: $ids}}) { id listedAt qInPositionsLong qInPositionsShort tokenSupply }
}`,
  lastTrades: `query LastTrades($series: [String!]!) {
  PricePoint(where: {id: {_in: $series}}) { id lastTradePriceU lastTradeAt }
}`,
  // Every paged query orders by a unique key last (the row id), so rows of one block keep one order from page to page
  // and an offset never repeats or skips a row. That id is text ("<block>-<logIndex>", so "B-9" sorts after "B-12"):
  // the client re-sorts by log index, and a page that ends inside a block is completed with tradesInBlock first.
  trades: `query Trades($series: String!, $limit: Int!, $offset: Int!, $desc: order_by!) {
  Trade(where: {series_id: {_eq: $series}}, order_by: [{block: $desc}, {id: $desc}], limit: $limit, offset: $offset) { id block timestamp priceU tokens takerIsBuy maker taker txOrigin txHash }
}`,
  tradesSince: `query TradesSince($series: String!, $since: numeric!, $limit: Int!, $offset: Int!) {
  Trade(where: {series_id: {_eq: $series}, timestamp: {_gte: $since}}, order_by: [{block: asc}, {id: asc}], limit: $limit, offset: $offset) { id block timestamp priceU tokens takerIsBuy maker taker txOrigin txHash }
}`,
  // the newest block's trades before a time (the caller takes the last by log index): a price "24 h earlier"
  tradesBefore: `query TradesBefore($series: String!, $before: numeric!, $limit: Int!) {
  Trade(where: {series_id: {_eq: $series}, timestamp: {_lt: $before}}, order_by: [{block: desc}, {id: desc}], limit: $limit) { id block timestamp priceU tokens takerIsBuy maker taker txOrigin txHash }
}`,
  // every trade of one block (a page of the queries above that ended inside it)
  tradesInBlock: `query TradesInBlock($series: String!, $block: numeric!, $limit: Int!, $offset: Int!) {
  Trade(where: {series_id: {_eq: $series}, block: {_eq: $block}}, order_by: [{id: asc}], limit: $limit, offset: $offset) { id block timestamp priceU tokens takerIsBuy maker taker txOrigin txHash }
}`,
  // a wallet's rows, oldest first, the first page of each; the More* queries page on (the client reads every page)
  wallet: `query Wallet($a: String!, $limit: Int!) {
  Position(where: {owner_id: {_eq: $a}, status: {_eq: "OPEN"}}, order_by: [{id: asc}], limit: $limit) { id positionId openedAt series_id side q status }
  RouterFlow(where: {user_id: {_eq: $a}}, order_by: [{block: asc}, {id: asc}], limit: $limit) { id flow series_id tokens dollarsIn dollarsOut refund positionIds txHash timestamp }
  Trade(where: {_or: [{txOrigin: {_eq: $a}}, {maker: {_eq: $a}}]}, order_by: [{block: asc}, {id: asc}], limit: $limit) { id block timestamp priceU tokens takerIsBuy maker taker txOrigin txHash series_id }
}`,
  morePositions: `query MorePositions($a: String!, $limit: Int!, $offset: Int!) {
  Position(where: {owner_id: {_eq: $a}, status: {_eq: "OPEN"}}, order_by: [{id: asc}], limit: $limit, offset: $offset) { id positionId openedAt series_id side q status }
}`,
  moreFlows: `query MoreFlows($a: String!, $limit: Int!, $offset: Int!) {
  RouterFlow(where: {user_id: {_eq: $a}}, order_by: [{block: asc}, {id: asc}], limit: $limit, offset: $offset) { id flow series_id tokens dollarsIn dollarsOut refund positionIds txHash timestamp }
}`,
  moreTrades: `query MoreTrades($a: String!, $limit: Int!, $offset: Int!) {
  Trade(where: {_or: [{txOrigin: {_eq: $a}}, {maker: {_eq: $a}}]}, order_by: [{block: asc}, {id: asc}], limit: $limit, offset: $offset) { id block timestamp priceU tokens takerIsBuy maker taker txOrigin txHash series_id }
}`,
  // the router's sales in a wallet's OPEN_SHORT transactions (a short's entry): a smart account's router sale has a
  // bundler as txOrigin and the bidder as maker, so the wallet queries above never return it
  tradesByTx: `query TradesByTx($h: [String!]!, $router: String!, $limit: Int!) {
  Trade(where: {txHash: {_in: $h}, taker: {_eq: $router}, takerIsBuy: {_eq: false}}, order_by: [{block: asc}, {id: asc}], limit: $limit) { id block timestamp priceU tokens takerIsBuy maker taker txOrigin txHash series_id }
}`,
  // a wallet's resting orders, a page after the id $after (keyset: an order that stops resting between two pages never
  // shifts the next page, as it would an offset); the client reads every page
  openOrders: `query OpenOrders($a: String!, $after: String!, $limit: Int!) {
  BookOrder(where: {owner: {_eq: $a}, status: {_eq: "ACTIVE"}, id: {_gt: $after}}, order_by: {id: asc}, limit: $limit) { id orderId market_id series_id isBuy price size remaining createdAt }
}`,
} as const;
