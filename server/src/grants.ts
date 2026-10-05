// "Connect your AI": the grant a person gives one AI, and the pocket trades agate makes for it.
//
// The app (the person, signed in) has already: created the Assistant and delegated it to agate (the webhook stored
// the share), had the main wallet sign the pocket's session-key permission, and moved the budget into the pocket.
// It then posts the grant here. The server accepts it only when the caller's Dynamic session owns both wallets, the
// Assistant's delegation reached us for that same person, and the permission carries exactly the agreed limits.
// The session key's signer (the Assistant) is bound by the main wallet's enable signature and checked onchain by the
// first trade.
import { randomUUID } from "node:crypto";
import { type Address, createPublicClient, http, isAddress, type PublicClient } from "viem";
import { accountClient, type Call, checkApproval, checkPocketCalls, kernelAddress, monadTestnet, pocketSessionAccount, type PocketLimits, type PocketTerms, readApproval, shortTokensCapFor, zerodev } from "@agate/wallet";
import { config, requireSecret } from "./config.ts";
import { type DynamicUser, owns } from "./dynamic/jwt.ts";
import { delegatedAccount, NotLandedYet, sendWithIntent, type SignContext } from "./dynamic/signer.ts";
import { refreshWallets } from "./dynamic/users.ts";
import { OAuthStore } from "./oauth/store.ts";
import { AI_DISCONNECTED, AI_ENDED, type GrantRow, type Store } from "./store.ts";

export const MAX_GRANT_DAYS = 90;
export const MAX_TRADES_PER_DAY = 50;

let pcCache: PublicClient | undefined;
export const publicClient = () => (pcCache ??= createPublicClient({ chain: monadTestnet, transport: http(config.rpcUrl) }) as PublicClient);

export type GrantRequest = {
  label: string;
  mainOwner: Address;
  assistantAddress: Address;
  /** u, decimal strings */
  budget: string;
  perTradeCap: string;
  tradesPerDay: number;
  /** unix seconds */
  validUntil: number;
  /** the pocket's Kernel index (1 for the first AI) */
  pocketIndex?: number;
  approval: string;
};

export type GrantError = { status: number; error: string };

export function limitsOf(g: GrantRow): PocketLimits {
  return { routers: g.routers, dollar: config.dollar, mainAccount: g.mainAccount, perTradeCap: g.perTradeCap, shortTokensCap: g.shortTokensCap };
}

export function termsOf(g: Pick<GrantRow, "assistantAddress" | "routers" | "mainAccount" | "perTradeCap" | "shortTokensCap" | "expiresAt" | "tradesPerDay" | "pocketIndex">): PocketTerms {
  return {
    assistant: g.assistantAddress,
    limits: { routers: g.routers, dollar: config.dollar, mainAccount: g.mainAccount, perTradeCap: g.perTradeCap, shortTokensCap: g.shortTokensCap },
    validUntil: Math.floor(g.expiresAt / 1000),
    tradesPerDay: g.tradesPerDay,
    index: BigInt(g.pocketIndex),
  };
}

/** The terms the app must have signed for a request, derived the same way the app derives them. */
export async function expectedTerms(req: GrantRequest, pc: PublicClient = publicClient()): Promise<PocketTerms> {
  const perTradeCap = BigInt(req.perTradeCap);
  return {
    assistant: req.assistantAddress,
    limits: { routers: config.routers, dollar: config.dollar, mainAccount: await kernelAddress(pc, req.mainOwner, 0n), perTradeCap, shortTokensCap: shortTokensCapFor(perTradeCap) },
    validUntil: req.validUntil,
    tradesPerDay: req.tradesPerDay,
    index: BigInt(req.pocketIndex ?? 1),
  };
}

export async function createGrant(store: Store, user: DynamicUser, req: GrantRequest, pc: PublicClient = publicClient()): Promise<GrantRow | GrantError> {
  const bad = (error: string, status = 400): GrantError => ({ status, error });
  if (!req || typeof req !== "object") return bad("no grant");
  if (!isAddress(req.mainOwner) || !isAddress(req.assistantAddress)) return bad("wallet addresses are malformed");
  if (req.mainOwner.toLowerCase() === req.assistantAddress.toLowerCase()) return bad("the main wallet is never delegated: use the Assistant");
  if (!owns(user, req.mainOwner) || !owns(user, req.assistantAddress)) await refreshWallets(user);
  if (!owns(user, req.mainOwner) || !owns(user, req.assistantAddress)) return bad("these wallets are not yours", 403);
  const del = store.delegationByAddress(req.assistantAddress);
  if (!del || del.status !== "active") return bad("the Assistant is not delegated to agate yet (try again in a few seconds)", 409);
  if (del.userId && del.userId !== user.userId) return bad("this Assistant belongs to someone else", 403);
  let budget: bigint, perTradeCap: bigint;
  try {
    budget = BigInt(req.budget);
    perTradeCap = BigInt(req.perTradeCap);
  } catch {
    return bad("budget and per-trade cap are whole numbers of u (1e6 = $1)");
  }
  if (budget <= 0n || perTradeCap <= 0n || perTradeCap > budget) return bad("the per-trade cap must be above 0 and at most the budget");
  if (!Number.isInteger(req.tradesPerDay) || req.tradesPerDay < 1 || req.tradesPerDay > MAX_TRADES_PER_DAY) return bad(`trades per day: 1 to ${MAX_TRADES_PER_DAY}`);
  const nowS = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(req.validUntil) || req.validUntil <= nowS || req.validUntil > nowS + MAX_GRANT_DAYS * 86_400) return bad(`the end date must be within ${MAX_GRANT_DAYS} days`);
  if (req.pocketIndex !== undefined && (!Number.isInteger(req.pocketIndex) || req.pocketIndex < 1 || req.pocketIndex > 1_000)) return bad("pocket index: a whole number from 1 (0 is the main account)");
  const terms = await expectedTerms(req, pc);
  const problems = await checkApproval(pc, req.approval, req.mainOwner, terms);
  if (problems.length) return bad(`the signed permission does not match: ${problems.join("; ")}`);
  const pocket = readApproval(req.approval).accountAddress;
  // one live AI per pocket: two would share one balance and the person could not tell whose trades spent it
  const clash = store.grantsOf(user.userId).find((x) => x.status === "active" && x.expiresAt > Date.now() && x.pocket.toLowerCase() === pocket.toLowerCase());
  if (clash) return bad(`pocket_in_use: this pocket already serves "${clash.label}"; use the next pocket index or disconnect it first`, 409);
  const g: GrantRow = {
    id: randomUUID(),
    userId: user.userId,
    label: String(req.label ?? "AI").slice(0, 60),
    mainAccount: terms.limits.mainAccount,
    pocket,
    assistantWalletId: del.walletId,
    assistantAddress: req.assistantAddress,
    budget,
    perTradeCap,
    shortTokensCap: terms.limits.shortTokensCap,
    routers: [...terms.limits.routers],
    pocketIndex: Number(terms.index ?? 1n),
    tradesPerDay: req.tradesPerDay,
    expiresAt: req.validUntil * 1000,
    permission: req.approval,
    status: "active",
    createdAt: Date.now(),
  };
  store.putGrant(g);
  store.event({ source: "agate", name: "grant.created", userId: user.userId, walletId: del.walletId, grantId: g.id, detail: { label: g.label, pocket: g.pocket, budget: g.budget.toString(), perTradeCap: g.perTradeCap.toString(), tradesPerDay: g.tradesPerDay, expiresAt: new Date(g.expiresAt).toISOString() } });
  return g;
}

export type TradeRefusal = { refused: string; detail: string };

/** Ends an AI connection everywhere it could still act: its status, its pending approvals, its autopilot orders, its
 *  connector URL and its OAuth tokens. Disconnect, Dynamic's revoke webhook and agate's kill switch all end a connection this way. */
export function endGrant(store: Store, id: string): void {
  // its pending approvals end with it, with the true reason recorded now (an end date already passed reads as ended)
  const g = store.grant(id);
  const reason = g && g.expiresAt <= Date.now() ? AI_ENDED : AI_DISCONNECTED;
  for (const a of store.expireApprovalsOfGrant(id, reason)) store.event({ source: "agate", name: "approval.expired", userId: a.userId, grantId: id, detail: { requestId: a.id, reason } });
  store.setGrantStatus(id, "revoked");
  for (const o of store.standingOrdersOf({ grantId: id, status: "active" })) store.setStandingOrder(o.id, { status: "stopped" });
  store.newConnectorSecret(id); // the old connector URL stops working; the new one is never shown
  new OAuthStore(store.db).revokeTokensByCardId(id);
}

/** The connection's trades sent in the last 24 hours (landed or not) against its daily limit. */
export function dailyLimitRefusal(store: Store, g: GrantRow, now = Date.now()): TradeRefusal | null {
  const used = store.tradesSince(g.id, now - 86_400_000);
  return used >= g.tradesPerDay ? { refused: "daily_limit", detail: `${used} of ${g.tradesPerDay} trades used in the last 24 hours` } : null;
}

/** A pocket trade: the server's own checks first (typed refusals), then the Assistant signs under Transaction Review,
 *  then the onchain session key checks again. */
export async function pocketTrade(
  store: Store,
  g: GrantRow,
  calls: Call[],
  log?: (e: Record<string, unknown>) => void,
  pc: PublicClient = publicClient(),
  opts: {
    /** live tests only (AGATE_LAB): skip the server's own checks, to prove the onchain key refuses by itself */
    skipServerChecks?: boolean;
    /** what the trade is, in the plan's words (amounts, GPU, month); stored with the activity entry */
    summary?: Record<string, unknown>;
  } = {},
) {
  if (!opts.skipServerChecks) {
    if (g.status !== "active") return { refused: "grant_revoked", detail: "the AI's permission is no longer active" } satisfies TradeRefusal;
    if (g.expiresAt <= Date.now()) return { refused: "grant_expired", detail: "the AI's permission has expired" } satisfies TradeRefusal;
    const daily = dailyLimitRefusal(store, g);
    if (daily) return daily;
    const c = checkPocketCalls(calls, limitsOf(g));
    if (!c.ok) return { refused: c.rule, detail: c.detail } satisfies TradeRefusal;
  }
  const ctx: SignContext = {};
  const deadline = Date.now() + config.intentTtlMs - 5_000;
  const assistant = delegatedAccount(store, g.assistantWalletId, ctx, () => deadline, log);
  const account = await pocketSessionAccount(pc, g.permission!, assistant);
  const client = accountClient(account, pc, zerodev(requireSecret("ZERODEV_RPC", "zerodev.env")));
  const summary = opts.summary ? { summary: opts.summary } : {};
  let r: Awaited<ReturnType<typeof sendWithIntent>>;
  try {
    r = await sendWithIntent({ store, client, ctx, walletId: g.assistantWalletId, kind: "pocket-trade", calls, grantId: g.id });
  } catch (e) {
    // sent but not seen landing: it still counts against the day (the onchain rate limit counts it if it lands)
    if (e instanceof NotLandedYet) store.event({ source: "agate", name: "pocket.trade", userId: g.userId, walletId: g.assistantWalletId, grantId: g.id, detail: { ...summary, userOpHash: e.userOpHash, txHash: null, landed: false, calls: calls.length } });
    throw e;
  }
  store.event({ source: "agate", name: "pocket.trade", userId: g.userId, walletId: g.assistantWalletId, grantId: g.id, detail: { ...summary, userOpHash: r.userOpHash, txHash: r.receipt.receipt.transactionHash, success: r.receipt.success, calls: calls.length, ms: r.ms } });
  return r;
}
