// The Envio indexer's GraphQL (Hasura over Envio's tables, indexer/README.md): a small fetch-based reader and the
// queries the client runs. Addresses and gpuIds are lowercase in every filter; BigInt columns come back as strings.
// Every failure (unreachable, HTTP error, GraphQL errors) is an IndexerError, which the reads turn into their
// documented chain-only fallbacks.

export const DEFAULT_GRAPHQL_URL = "http://localhost:8080/v1/graphql";

export class IndexerError extends Error {
  override name = "IndexerError";
  /** retryable: another indexer may answer (true for everything but a malformed request); rest: the failure is about
   *  this indexer (unreachable, an HTTP error, not JSON, a rate limit or database error), so it steps back a minute */
  constructor(
    message: string,
    readonly retryable = false,
    readonly rest = false,
  ) {
    super(message);
  }
}

export interface GraphQL {
  readonly url: string;
  query<T>(q: string, variables?: Record<string, unknown>): Promise<T>;
}

// Hasura's codes for a query this schema cannot run: another indexer (a newer deployment) may, but this one is healthy
const SCHEMA_CODES = new Set(["validation-failed", "parse-failed"]);

/** A reader over one indexer URL, or several separated by commas (since Oct 6: Envio Cloud first, whose free plan
 *  allows 100 queries a minute, then agate's own indexer). Every query goes to the current indexer: the first URL that
 *  is not resting. A failure another indexer could answer moves the query to the next URL; a failure about the indexer
 *  itself (unreachable, an HTTP error, not JSON, a rate limit or database error in the body) also rests that URL for
 *  restMs (default 60 s, never cut short), so following queries start at the next one. Sticky on purpose: the client's
 *  paired reads (newest ids, then the rows) land on one indexer unless it fails between them, and then the next poll
 *  reads both again. A malformed request (HTTP 400, 413, 422, or variables that cannot be sent) is never retried. An
 *  attempt with a later URL to fall back on waits at most 5 s. A value with no URL in it reads the chain only, as an
 *  unset one does: every query throws an IndexerError. */
export function graphql(url: string, o: { fetch?: typeof fetch; timeoutMs?: number; restMs?: number; now?: () => number } = {}): GraphQL {
  const urls = url
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = o.timeoutMs ?? 10_000;
  const restMs = o.restMs ?? 60_000;
  const now = o.now ?? Date.now;
  const restingUntil = new Map<string, number>();

  async function once<T>(u: string, body: string, ms: number): Promise<T> {
    let r: Response;
    try {
      r = await f(u, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(ms) });
    } catch (e) {
      throw new IndexerError(`the indexer at ${u} is not reachable (${e instanceof Error ? e.message : String(e)})`, true, true);
    }
    if (!r.ok) {
      const malformed = r.status === 400 || r.status === 413 || r.status === 422;
      throw new IndexerError(`the indexer answered HTTP ${r.status}`, !malformed, !malformed);
    }
    // whatever answers at the URL must be GraphQL's JSON: a dev server's HTML page or a proxy's error page (even with
    // status 200) means no indexer there
    let j: { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
    try {
      j = (await r.json()) as typeof j;
    } catch (e) {
      throw new IndexerError(`the indexer at ${u} did not answer JSON (${e instanceof Error ? e.message : String(e)})`, true, true);
    }
    if (!j || typeof j !== "object") throw new IndexerError(`the indexer at ${u} did not answer a GraphQL object`, true, true);
    if (j.errors?.length) {
      const schema = j.errors.every((e) => SCHEMA_CODES.has(e.extensions?.code ?? ""));
      throw new IndexerError(`the indexer refused the query: ${j.errors.map((e) => e.message).join("; ")}`, true, !schema);
    }
    if (!j.data) throw new IndexerError("the indexer answered without data", true, true);
    return j.data;
  }

  return {
    url: urls[0] ?? "",
    async query<T>(q: string, variables: Record<string, unknown> = {}): Promise<T> {
      if (urls.length === 0) throw new IndexerError("no indexer URL is set");
      let body: string;
      try {
        body = JSON.stringify({ query: q, variables });
      } catch (e) {
        throw new IndexerError(`the query's variables cannot be sent (${e instanceof Error ? e.message : String(e)})`);
      }
      const t = now();
      const order = [...urls.filter((u) => (restingUntil.get(u) ?? 0) <= t), ...urls.filter((u) => (restingUntil.get(u) ?? 0) > t)];
      let last: unknown;
      for (const [i, u] of order.entries()) {
        try {
          return await once<T>(u, body, i < order.length - 1 ? Math.min(timeoutMs, 5_000) : timeoutMs);
        } catch (e) {
          last = e;
          if (!(e instanceof IndexerError) || !e.retryable) throw e;
          if (e.rest) restingUntil.set(u, Math.max(restingUntil.get(u) ?? 0, now() + restMs));
        }
      }
      throw last;
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
