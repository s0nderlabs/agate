// One MCP server per request, scoped to one AI connection (grant). The tool list IS the permission surface: an AI
// whose connection is not live sees only the read tools. Trades run from the AI's pocket, signed by the person's
// delegated Assistant wallet, checked by the server (typed refusals), by Dynamic Transaction Review, and by the
// pocket's onchain session key. A trade over the per-trade cap becomes an approval card in the person's app.
// Only transaction hashes returned by a tool are real: the instructions say so (an AI once invented hashes).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Address } from "viem";
import {
  type AgateClient,
  type Gpu,
  GPUS,
  band,
  planBuyLong,
  planCloseLongDaily,
  planCloseShort,
  planDrip,
  planOpenLongDaily,
  planOpenShort,
  planRollLong,
  planSellLong,
  simulateBuy,
  simulateSell,
  toNumber6,
  U,
  WriteError,
  type Plan,
  type TradeSummary,
} from "@agate/client";
import { isSponsorRefusal, SPONSOR_REFUSAL_TEXT } from "@agate/wallet";
import { describePocket } from "@agate/wallet/allowed";
import { grantView } from "../app.ts";
import { dailyLimitRefusal, limitsOf, pocketTrade } from "../grants.ts";
import { NotLandedYet } from "../dynamic/signer.ts";
import { serial } from "../serial.ts";
import { appBase } from "../oauth/routes.ts";
import type { GrantRow, Store } from "../store.ts";

export const SERVER_INFO = { name: "agate", version: "0.1.0" };

const INSTRUCTIONS = [
  "agate makes the price of GPU compute tradable: a daily index of GPU-hour rental prices (H100, H200, B200 and more) and monthly tokens that pay that month's average price. Long gains when GPU rent rises (a hedge for renters), Short gains when it falls. Everything is on Monad testnet with test dollars.",
  "This connection is one person's AI connection. Trades run from their AI pocket (a separate account holding only the budget they gave you), within a per-trade cap, a daily trade count and an end date; daily payouts always go to their main account (what is already sure at opening comes back into the pocket at once). `my_limits` shows what is left; check it before trading.",
  "Tools: `get_prices`, `quote`, `size_for`, `get_portfolio`, `activity`, `my_limits` read. `open_long` (optionally pay_me_daily), `open_short`, `close_long`, `close_long_daily`, `close_short`, `roll_long` (keep a hedge going into the next month), `get_test_dollars` trade. `keep_hedge_going` / `stop_keep_hedge_going` set agate's autopilot to roll a Long by itself before its month closes. A trade above the cap returns needs_approval with a link for the person; poll `approval_status`.",
  "Refusals name the rule (over_per_trade_cap, budget_left, daily_limit, grant_expired, price_moved, ...): read them before retrying. Report only transaction hashes a tool returned. Give every money tool an idempotency_key so a retry never trades twice.",
].join("\n\n");

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) }] });
const refusal = (rule: string, detail: string, extra: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: "text", text: JSON.stringify({ status: "refused", rule, detail, ...extra }, null, 2) }], isError: true });
/** A tool's number as the plain decimal the client parses (no exponent, no float noise past 6 decimals). */
const num = (x: number) => x.toFixed(6).replace(/\.?0+$/, "");
const failed = (message: string): ToolResult => ({ content: [{ type: "text", text: JSON.stringify({ status: "error", message }, null, 2) }], isError: true });

/** WriteError reasons from @agate/client, in the refusal words the AI reads. */
const RULES: Record<string, string> = {
  InsufficientBalance: "budget_left",
  InsufficientTokens: "not_enough_tokens",
  PriceMoved: "price_moved",
  ThinBook: "thin_book",
  AboveBand: "above_band",
  BelowBand: "below_band",
  Depth: "thin_book",
  DripTooSoon: "drip_too_soon",
  EmptyBook: "empty_book",
};

export type McpDeps = {
  store: Store;
  client: () => AgateClient;
  log?: (e: Record<string, unknown>) => void;
  /** test seam: the onchain step (defaults to pocketTrade) */
  trade?: typeof pocketTrade;
};

const gpuEnum = z.enum(GPUS as unknown as [Gpu, ...Gpu[]]);
const month = z.string().regex(/^\d{4}-\d{2}$/, "YYYY-MM");
const idem = z.string().min(8).max(100).optional().describe("any unique string; a retry with the same key returns the first result instead of trading twice");

// Registration through a type-erased helper: zod still validates every call at runtime, but TypeScript no longer
// instantiates the SDK's deep generic types once per tool (with a dozen tools that ran tsc out of memory).
type Shape = Record<string, z.ZodTypeAny>;
// biome-ignore lint/suspicious/noExplicitAny: see above
type Handler = (args: any) => Promise<ToolResult>;
function register(server: McpServer, name: string, config: { description: string; inputSchema: Shape }, handler: Handler): void {
  (server as unknown as { registerTool(n: string, c: unknown, h: unknown): void }).registerTool(name, config, handler);
}

export function buildMcpServer(deps: McpDeps, grant: GrantRow): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  const live = grant.status === "active" && grant.expiresAt > Date.now();
  const c = () => deps.client();
  const doTrade = deps.trade ?? pocketTrade;

  const run = async (fn: () => Promise<unknown>): Promise<ToolResult> => {
    try {
      const r = await fn();
      return r && typeof r === "object" && "content" in (r as object) ? (r as ToolResult) : ok(r);
    } catch (e) {
      if (e instanceof WriteError) return refusal(RULES[e.reason ?? ""] ?? (e.reason ? e.reason.toLowerCase() : "refused"), e.message, e.quote ? { quote: e.quote } : {});
      if ((e as Error)?.name === "WriteError") return refusal(String((e as WriteError).reason ?? "refused"), (e as Error).message);
      if ((e as Error)?.name === "AmountError") return refusal("bad_amount", (e as Error).message);
      if (isSponsorRefusal(e)) return refusal("sponsor_limit", SPONSOR_REFUSAL_TEXT);
      return failed((e as Error)?.message ?? String(e));
    }
  };

  // ------------------------------------------------------------------ reads

  register(
    server,
    "get_prices",
    { description: "Today's GPU-hour index prices and the tradable months with their best bid/ask and the band (the range a month token can pay).", inputSchema: { gpu: gpuEnum.optional() } },
    ({ gpu }) =>
      run(async () => {
        const markets = gpu ? [await c().getMarket(gpu)] : await c().getMarkets();
        return markets.map((m) => ({
          gpu: m.gpu,
          // no posted day yet reads as null, never as a $0 price
          price: m.priceDate ? m.price : null,
          priceDate: m.priceDate,
          change: m.priceDate ? Number((m.price - m.prevPrice).toFixed(4)) : null,
          clouds: `${m.liveCount} of ${m.panelSize}`,
          tradable: m.tradable,
          months: m.series.map((s) => ({ month: s.month, symbol: s.symbol, phase: s.phase, quote: s.quote, floor: s.floor, cap: s.cap, openInterest: s.openInterest, closesAt: s.closesAt })),
        }));
      }),
  );

  register(
    server,
    "quote",
    {
      description: "What a trade would do now, without trading: GPU-hours, average price, and the most it can win or lose by the month's end. Long takes dollars; short takes gpu_hours.",
      inputSchema: { gpu: gpuEnum, month, side: z.enum(["long", "short"]), dollars: z.number().positive().optional(), gpu_hours: z.number().positive().optional() },
    },
    ({ gpu, month: m, side, dollars, gpu_hours }) =>
      run(async () => {
        const s = await c().seriesAt(gpu, m);
        if (!s.market) return refusal("no_market", `${gpu} ${m} has no market yet`);
        const b = band(s);
        if (side === "long") {
          if (!dollars) return refusal("bad_input", "a long quote needs dollars");
          const d = BigInt(Math.round(dollars * 1e6));
          const tokens = await simulateBuy(c(), s.market, d);
          const h = toNumber6(tokens);
          return { side, gpu, month: m, dollars, gpuHours: h, avgPrice: h > 0 ? Number((dollars / h).toFixed(4)) : null, mostYouCanLose: Number((dollars - h * b.lo).toFixed(2)), mostYouCanWin: Number((h * b.hi - dollars).toFixed(2)), band: { lo: b.lo, hi: b.hi } };
        }
        if (!gpu_hours) return refusal("bad_input", "a short quote needs gpu_hours");
        const t = BigInt(Math.round(gpu_hours * 1e6));
        const proceeds = toNumber6(await simulateSell(c(), s.market, t));
        const collateral = toNumber6((t * s.terms.cap) / U);
        return { side, gpu, month: m, gpuHours: gpu_hours, saleProceeds: proceeds, collateral, netCost: Number((collateral - proceeds).toFixed(2)), mostYouCanLose: Number((gpu_hours * b.hi - proceeds).toFixed(2)), mostYouCanWin: Number((proceeds - gpu_hours * b.lo).toFixed(2)), band: { lo: b.lo, hi: b.hi } };
      }),
  );

  register(
    server,
    "size_for",
    { description: "GPU-hours for G GPUs over D days (24 GPU-hours per GPU per day): the size of a hedge for a rental.", inputSchema: { gpus: z.number().int().positive(), days: z.number().int().positive() } },
    ({ gpus, days }) => run(async () => ({ gpus, days, gpuHours: 24 * gpus * days })),
  );

  register(
    server,
    "get_portfolio",
    { description: "The person's main account and the AI pocket: test dollars and positions in each.", inputSchema: {} },
    () =>
      run(async () => {
        const [main, pocket] = await Promise.all([c().getWallet(grant.mainAccount), c().getWallet(grant.pocket)]);
        const slim = (w: typeof main) => ({ address: w.address, dollars: w.balance, positions: w.positions });
        return { main: slim(main), pocket: slim(pocket) };
      }),
  );

  register(
    server,
    "my_limits",
    { description: "This AI connection's limits and what is left: pocket balance (the total budget), per-trade cap, trades left today, end date, what the pocket may call.", inputSchema: {} },
    () =>
      run(async () => {
        const w = await c().getWallet(grant.pocket);
        const used = deps.store.tradesSince(grant.id, Date.now() - 86_400_000);
        return {
          ...grantView(grant),
          live,
          pocketDollars: w.balance,
          perTradeCapDollars: toNumber6(grant.perTradeCap),
          tradesLeftToday: Math.max(0, grant.tradesPerDay - used),
          autopilot: deps.store.standingOrdersOf({ grantId: grant.id, status: "active" }).map((o) => ({ order_id: o.id, gpu: o.gpu, lead_minutes: o.leadMinutes, last: o.lastResult })),
          allowed: describePocket(limitsOf(grant)),
        };
      }),
  );

  register(
    server,
    "activity",
    { description: "What this AI connection did, newest first: trades with their transaction hashes, refusals, approvals.", inputSchema: { limit: z.number().int().min(1).max(100).optional() } },
    ({ limit }) => run(async () => deps.store.events({ grantId: grant.id, limit: limit ?? 30 }).map((e) => ({ at: new Date(e.at).toISOString(), what: e.name, ...e.detail }))),
  );

  register(
    server,
    "approval_status",
    { description: "The state of a trade sent to the person for approval: pending, approved, denied, done (with its transaction hash), failed or expired.", inputSchema: { request_id: z.string().uuid() } },
    ({ request_id }) =>
      run(async () => {
        const a = deps.store.approval(request_id);
        if (!a || a.grantId !== grant.id) return refusal("not_found", "no such approval for this connection");
        return { request_id: a.id, status: a.status, summary: a.summary, result: a.result, expiresAt: new Date(a.expiresAt).toISOString() };
      }),
  );

  if (!live) return server;

  // ------------------------------------------------------------------ trades (live connection only)

  const approvalFor = (action: string, params: Record<string, unknown>, details: Record<string, unknown>, note: string | null) => {
    // a Short's positions belong to the pocket, so closing one runs from the pocket (its owner, the main wallet, signs)
    const runFrom = action === "close_short" ? "pocket" : "main";
    const summary = { ...details, runFrom };
    const a = deps.store.putApproval({ grantId: grant.id, userId: grant.userId, action, params, summary, note, expiresAt: Date.now() + 15 * 60_000 });
    deps.store.event({ source: "mcp", name: "approval.requested", userId: grant.userId, grantId: grant.id, detail: { requestId: a.id, action, summary, note } });
    return {
      status: "needs_approval",
      request_id: a.id,
      approve_url: `${appBase()}/approve?request=${a.id}`,
      summary,
      note: `Send the person this link. Once they approve it runs from ${runFrom === "pocket" ? "your pocket, signed by their main wallet" : "their main account"}; poll approval_status.`,
    };
  };

  /** The shared write path: idempotency, one trade at a time per connection, daily count, plan for the pocket, the
   *  allowed-call list, then the signed user operation. */
  type OverCap = () => Record<string, unknown> | null;
  /** over the cap only once the plan has priced it (a buy-back's cost) */
  type OverCapPlanned = (p: Plan<TradeSummary>) => Record<string, unknown> | null;
  const trade = async (action: string, key: string | undefined, args: Record<string, unknown>, plan: () => Promise<Plan<TradeSummary>>, overCap?: OverCap, overCapPlanned?: OverCapPlanned) => {
    const r = await tradeOnce(action, key, args, plan, overCap, overCapPlanned);
    // refusals land in the person's activity too, so the AI card shows what the AI tried and why it was stopped
    if (r.isError) {
      const body = JSON.parse(r.content[0]!.text) as { status?: string; rule?: string; detail?: string; message?: string };
      deps.store.event({ source: "mcp", name: body.status === "refused" ? "pocket.refused" : "pocket.error", userId: grant.userId, grantId: grant.id, detail: { action, rule: body.rule ?? null, message: (body.detail ?? body.message ?? "").slice(0, 300), args } });
    }
    return r;
  };
  const tradeOnce = (action: string, key: string | undefined, args: Record<string, unknown>, plan: () => Promise<Plan<TradeSummary>>, overCap?: OverCap, overCapPlanned?: OverCapPlanned) =>
    run(() =>
      serial(grant.id, async () => {
        // inside the lock, so a retry that arrives while the first call is still landing waits and replays it
        if (key) {
          const prior = deps.store.idem(grant.id, key);
          if (prior) return { ...prior, idempotent_replay: true };
        }
        const g = deps.store.grant(grant.id);
        if (!g || g.status !== "active") return refusal("grant_revoked", "the person disconnected this AI");
        if (g.expiresAt <= Date.now()) return refusal("grant_expired", `this connection ended at ${new Date(g.expiresAt).toISOString()}`);
        const big = overCap?.();
        if (big) {
          const r = approvalFor(action, args, big, null);
          if (key) deps.store.putIdem(grant.id, key, r);
          return r;
        }
        const daily = dailyLimitRefusal(deps.store, g);
        if (daily) return refusal(daily.refused, daily.detail);
        const p = await plan();
        const priced = overCapPlanned?.(p);
        if (priced) {
          const r = approvalFor(action, args, priced, null);
          if (key) deps.store.putIdem(grant.id, key, r);
          return r;
        }
        let r: Awaited<ReturnType<typeof doTrade>>;
        try {
          r = await doTrade(deps.store, g, p.calls.map(({ to, value, data }) => ({ to, value, data })), deps.log, undefined, { summary: { ...p.summary } });
        } catch (e) {
          if (!(e instanceof NotLandedYet)) throw e;
          // the bundler has it: never send it again under this key; the activity tool shows it once it lands
          const sent = { status: "sent", action, summary: p.summary, user_op_hash: e.userOpHash, detail: "sent, not seen landing yet; check activity before trying again" };
          if (key) deps.store.putIdem(grant.id, key, sent);
          return sent;
        }
        if ("refused" in r) return refusal(r.refused, r.detail);
        const out = {
          status: r.receipt.success ? "done" : "reverted",
          action,
          summary: p.summary,
          tx_hash: r.receipt.receipt.transactionHash,
          user_op_hash: r.userOpHash,
          explorer: `https://testnet.monadexplorer.com/tx/${r.receipt.receipt.transactionHash}`,
          seconds: Number(((r.ms.prepare + r.ms.sign + r.ms.land) / 1000).toFixed(1)),
        };
        if (key) deps.store.putIdem(grant.id, key, out);
        return out;
      }),
    );

  const cap = toNumber6(grant.perTradeCap);
  const shortCapHours = toNumber6(grant.shortTokensCap);
  const pocket = grant.pocket as Address;
  const payee = grant.mainAccount as Address;

  register(
    server,
    "open_long",
    {
      description: `Go Long: buy a month's GPU-hours for dollars from the pocket (gains if GPU rent rises). pay_me_daily turns it into daily payouts to the person's main account (what is already sure, the floor for the days left, comes back into the pocket at once). Above $${cap} it becomes an approval for the person.`,
      inputSchema: { gpu: gpuEnum, month, dollars: z.number().positive(), pay_me_daily: z.boolean().optional(), max_price: z.number().positive().optional().describe("dollars per GPU-hour on average at most"), idempotency_key: idem },
    },
    (a) =>
      trade(
        a.pay_me_daily ? "open_long_daily" : "open_long",
        a.idempotency_key,
        a,
        () => (a.pay_me_daily ? planOpenLongDaily(c(), pocket, { gpu: a.gpu, month: a.month, dollars: num(a.dollars), payee, ...(a.max_price ? { maxPrice: num(a.max_price) } : {}) }) : planBuyLong(c(), pocket, { gpu: a.gpu, month: a.month, dollars: num(a.dollars), ...(a.max_price ? { maxPrice: num(a.max_price) } : {}) })),
        () => (a.dollars > cap ? { action: "open_long", gpu: a.gpu, month: a.month, dollars: a.dollars, payMeDaily: Boolean(a.pay_me_daily), overCapBy: Number((a.dollars - cap).toFixed(2)) } : null),
      ),
  );

  register(
    server,
    "open_short",
    {
      description: `Go Short: sell a month's GPU-hours (gains if GPU rent falls). The pocket puts up collateral (GPU-hours x the band's top); most comes back to the pocket at once. The rest is paid daily to the main account unless pay_me_daily is false. Collateral above $${cap} or more than ${shortCapHours} GPU-hours in one short becomes an approval.`,
      inputSchema: { gpu: gpuEnum, month, gpu_hours: z.number().positive(), pay_me_daily: z.boolean().optional(), min_price: z.number().positive().optional(), idempotency_key: idem },
    },
    (a) =>
      run(async () => {
        const s = await c().seriesAt(a.gpu, a.month);
        const collateral = toNumber6((BigInt(Math.round(a.gpu_hours * 1e6)) * s.terms.cap) / U);
        return trade(
          "open_short",
          a.idempotency_key,
          a,
          () => planOpenShort(c(), pocket, { gpu: a.gpu, month: a.month, gpuHours: num(a.gpu_hours), daily: a.pay_me_daily ?? true, payee, ...(a.min_price ? { minPrice: num(a.min_price) } : {}) }),
          // two limits: the collateral against the per-trade cap, and the session key's own GPU-hours-per-short limit
          () =>
            collateral > cap || a.gpu_hours > shortCapHours
              ? { action: "open_short", gpu: a.gpu, month: a.month, gpuHours: a.gpu_hours, collateral, ...(collateral > cap ? { overCapBy: Number((collateral - cap).toFixed(2)) } : {}), ...(a.gpu_hours > shortCapHours ? { overShortLimitBy: Number((a.gpu_hours - shortCapHours).toFixed(4)) } : {}) }
              : null,
        );
      }),
  );

  register(
    server,
    "close_long",
    { description: "Sell GPU-hours of a month the pocket holds (ends a Long early).", inputSchema: { gpu: gpuEnum, month, gpu_hours: z.number().positive(), min_price: z.number().positive().optional(), idempotency_key: idem } },
    (a) => trade("close_long", a.idempotency_key, a, () => planSellLong(c(), pocket, { gpu: a.gpu, month: a.month, gpuHours: num(a.gpu_hours), ...(a.min_price ? { minPrice: num(a.min_price) } : {}) })),
  );

  register(
    server,
    "roll_long",
    {
      description: `Keep a Long going: sell GPU-hours the pocket holds in one month and buy the same GPU's later month with the sale's proceeds, in ONE transaction (both happen or neither). gpu_hours defaults to all held. min_price guards the sale, max_price the buy. Proceeds above $${cap} are refused (over_per_trade_cap): roll in parts.`,
      inputSchema: { gpu: gpuEnum, from_month: month, to_month: month, gpu_hours: z.number().positive().optional(), min_price: z.number().positive().optional(), max_price: z.number().positive().optional(), idempotency_key: idem },
    },
    (a) =>
      trade("roll_long", a.idempotency_key, a, () =>
        planRollLong(c(), pocket, { gpu: a.gpu, fromMonth: a.from_month, toMonth: a.to_month, ...(a.gpu_hours ? { gpuHours: num(a.gpu_hours) } : {}), ...(a.min_price ? { minPrice: num(a.min_price) } : {}), ...(a.max_price ? { maxPrice: num(a.max_price) } : {}) }),
      ),
  );

  register(
    server,
    "keep_hedge_going",
    {
      description: `Autopilot for a hedge: agate rolls the pocket's Long of this GPU into the next listed month by itself when the month it holds closes within lead_minutes (default 60), in parts under the $${cap} cap. Each roll is a trade (it counts against the daily trades) and shows in activity. One order per GPU; asking again returns the existing one.`,
      inputSchema: { gpu: gpuEnum, lead_minutes: z.number().int().min(10).max(10_080).optional() },
    },
    ({ gpu, lead_minutes }) =>
      run(async () => {
        const g = deps.store.grant(grant.id);
        if (!g || g.status !== "active" || g.expiresAt <= Date.now()) return refusal("grant_revoked", "the person disconnected this AI");
        const existing = deps.store.standingOrdersOf({ grantId: grant.id, status: "active" }).find((o) => o.gpu === gpu);
        const o = existing ?? deps.store.putStandingOrder({ grantId: grant.id, userId: grant.userId, kind: "roll_long", gpu, leadMinutes: lead_minutes ?? 60 });
        if (!existing) deps.store.event({ source: "mcp", name: "autopilot.started", userId: grant.userId, grantId: grant.id, detail: { orderId: o.id, gpu, leadMinutes: o.leadMinutes } });
        return { order_id: o.id, gpu: o.gpu, lead_minutes: o.leadMinutes, status: o.status, already_on: Boolean(existing) };
      }),
  );

  register(
    server,
    "stop_keep_hedge_going",
    { description: "Stops an autopilot order (order_id from keep_hedge_going or my_limits). Positions stay as they are.", inputSchema: { order_id: z.string().uuid() } },
    ({ order_id }) =>
      run(async () => {
        const o = deps.store.standingOrder(order_id);
        if (!o || o.grantId !== grant.id) return refusal("not_found", "no such autopilot order for this connection");
        deps.store.setStandingOrder(o.id, { status: "stopped" });
        deps.store.event({ source: "mcp", name: "autopilot.stopped", userId: grant.userId, grantId: grant.id, detail: { orderId: o.id, gpu: o.gpu, by: "ai" } });
        return { order_id: o.id, status: "stopped" };
      }),
  );

  register(
    server,
    "close_long_daily",
    { description: "End pay-me-daily Long positions early (ids from get_portfolio).", inputSchema: { gpu: gpuEnum, month, position_ids: z.array(z.string()).min(1).max(20), min_price: z.number().positive().optional(), idempotency_key: idem } },
    (a) => trade("close_long_daily", a.idempotency_key, a, () => planCloseLongDaily(c(), pocket, { gpu: a.gpu, month: a.month, positionIds: a.position_ids, ...(a.min_price ? { minPrice: num(a.min_price) } : {}) })),
  );

  register(
    server,
    "close_short",
    { description: `Close Short positions (ids from get_portfolio): buys the GPU-hours back. Spending over $${cap} becomes an approval.`, inputSchema: { gpu: gpuEnum, month, position_ids: z.array(z.string()).min(1).max(20), max_dollars: z.number().positive().optional(), idempotency_key: idem } },
    (a) =>
      trade(
        "close_short",
        a.idempotency_key,
        a,
        () => planCloseShort(c(), pocket, { gpu: a.gpu, month: a.month, positionIds: a.position_ids, ...(a.max_dollars ? { maxDollars: num(a.max_dollars) } : {}) }),
        () => (a.max_dollars && a.max_dollars > cap ? { action: "close_short", gpu: a.gpu, month: a.month, positionIds: a.position_ids, maxDollars: a.max_dollars } : null),
        // without max_dollars the cost is known only once the buy-back is quoted
        (p) => (p.summary.maxSpend > cap ? { action: "close_short", gpu: a.gpu, month: a.month, positionIds: a.position_ids, maxDollars: p.summary.maxSpend, overCapBy: Number((p.summary.maxSpend - cap).toFixed(2)) } : null),
      ),
  );

  register(
    server,
    "get_test_dollars",
    { description: "Take the pocket's daily test dollars from the faucet (testnet only).", inputSchema: { idempotency_key: idem } },
    (a) => trade("get_test_dollars", a.idempotency_key, a, () => planDrip(c(), pocket)),
  );

  register(
    server,
    "request_approval",
    { description: "Ask the person to approve a trade you may not make alone (for example above the cap); returns a link for them.", inputSchema: { action: z.enum(["open_long", "open_short", "close_short"]), args: z.record(z.unknown()), note: z.string().max(500).optional() } },
    (a) => run(async () => approvalFor(a.action, a.args as Record<string, unknown>, { action: a.action, ...(a.args as Record<string, unknown>) }, a.note ?? null)),
  );

  return server;
}
