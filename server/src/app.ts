// The HTTP surfaces. Two listeners, so nothing private is ever reachable through the public tunnel or host:
//  - public (AGATE_SERVER_PORT, behind HTTPS): Dynamic's webhooks, Transaction Review, later MCP + OAuth + app API.
//  - internal (AGATE_INTERNAL_PORT, 127.0.0.1 only, never tunnelled): intents from local signers (the payer bot),
//    recent reviews and events for the operator.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import type { Hex } from "viem";
import { config, HOME, readHomeFile, secret, type Config } from "./config.ts";
import { type DynamicUser, jwtVerifier } from "./dynamic/jwt.ts";
import { createGrant, endGrant, type GrantRequest, limitsOf as grantLimits, MAX_GRANT_DAYS, MAX_TRADES_PER_DAY, pocketTrade } from "./grants.ts";
import { SHORT_SIZING_PRICE } from "@agate/wallet/allowed";
import { type AgateClient, createAgateClient, type Deployments, GPUS, TESTNET_DEPLOYMENTS } from "@agate/client";
import { existsSync, readFileSync } from "node:fs";
import { mcpRoutes } from "./mcp/routes.ts";
import { appendRedirectParams, oauthRoutes, publicBase, redirectUriAllowed } from "./oauth/routes.ts";
import { OAuthStore } from "./oauth/store.ts";
import { ed25519Signer } from "./dynamic/hmac.ts";
import { checkHmac } from "./dynamic/hmac.ts";
import { decide, type ReviewRequest } from "./dynamic/review.ts";
import { type SnapshotCache, snapshotCache } from "./snapshot.ts";
import { developerApi } from "./developer.ts";
import { handleWebhook } from "./dynamic/webhook.ts";
import type { PocketLimits } from "@agate/wallet/allowed";
import type { GrantRow, Store } from "./store.ts";

export function logger(file = join(HOME, "server.log")) {
  return (entry: Record<string, unknown>) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    console.log(line);
    try {
      appendFileSync(file, line + "\n", { mode: 0o600 });
    } catch {
      // stdout still has it
    }
  };
}

export type AppDeps = {
  store: Store;
  cfg?: Config;
  log?: (e: Record<string, unknown>) => void;
  /** overrides for tests */
  webhookSecret?: () => string | undefined;
  reviewSecret?: () => string | undefined;
  reviewSigningKeyPem?: () => string | undefined;
  rsaPrivateKeyPem?: () => string | undefined;
  serverWallets?: () => Set<string>;
  limitsOf?: (g: GrantRow) => PocketLimits;
  verifyUser?: (token: string) => Promise<DynamicUser>;
  agateClient?: () => AgateClient;
  /** the markets snapshot behind GET /api/markets (default: read through agateClient) */
  snapshots?: SnapshotCache;
};

/** The market reader the MCP tools use: the factory in AGATE_FACTORY ("real" by default), deployments from
 *  AGATE_DEPLOYMENTS_FILE when set (a demo session's factory lives only there), the indexer at AGATE_GRAPHQL_URL. */
let clientCache: AgateClient | undefined;
export function marketClient(cfg: Config = config): AgateClient {
  if (clientCache) return clientCache;
  const f = process.env.AGATE_DEPLOYMENTS_FILE;
  const deployments = f && existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Deployments) : TESTNET_DEPLOYMENTS;
  clientCache = createAgateClient({ deployments, factory: process.env.AGATE_FACTORY ?? "real", rpcUrl: cfg.rpcUrl, graphqlUrl: process.env.AGATE_GRAPHQL_URL ?? "http://localhost:8080/v1/graphql" });
  return clientCache;
}

/** A grant as the app and the AI see it (no permission blob, amounts as decimal strings of u). */
export function grantView(g: GrantRow) {
  return {
    id: g.id,
    label: g.label,
    status: g.expiresAt <= Date.now() && g.status === "active" ? "expired" : g.status,
    pocket: g.pocket,
    mainAccount: g.mainAccount,
    assistant: g.assistantAddress,
    budget: g.budget.toString(),
    perTradeCap: g.perTradeCap.toString(),
    pocketIndex: g.pocketIndex,
    tradesPerDay: g.tradesPerDay,
    expiresAt: new Date(g.expiresAt).toISOString(),
    createdAt: new Date(g.createdAt).toISOString(),
  };
}

export function publicApp(deps: AppDeps): Hono {
  const cfg = deps.cfg ?? config;
  const log = deps.log ?? logger();
  const app = new Hono();
  const webhookSecret = deps.webhookSecret ?? (() => secret("DYNAMIC_WEBHOOK_SECRET", "webhook.env"));
  const reviewSecret = deps.reviewSecret ?? (() => secret("DYNAMIC_REVIEW_SECRET", "review.env"));
  const rsaPem = deps.rsaPrivateKeyPem ?? (() => readHomeFile("delegation-rsa-private.pem"));
  const signPem = deps.reviewSigningKeyPem ?? (() => readHomeFile("review-ed25519.pem"));
  const serverWallets = deps.serverWallets ?? (() => new Set([...deps.store.serverWalletIds(), ...(secret("AGATE_SERVER_WALLET_IDS", "server-wallets.env") ?? "").split(",").filter(Boolean)]));
  const limitsOf = deps.limitsOf ?? grantLimits;
  const verifyUser = deps.verifyUser ?? jwtVerifier(cfg.environmentId);
  const oauth = new OAuthStore(deps.store.db);
  const agate = deps.agateClient ?? (() => marketClient(cfg));
  app.route("/", oauthRoutes({ store: deps.store }, oauth));
  app.route("/", mcpRoutes({ store: deps.store, client: agate, log }, oauth));
  const origins = (process.env.AGATE_APP_ORIGINS ?? "http://localhost:5174,http://127.0.0.1:5174,http://localhost:3317,http://127.0.0.1:3317").split(",").filter(Boolean);
  let signer: ((b: string) => string) | null | undefined;
  app.use("/api/*", cors({ origin: origins, allowHeaders: ["authorization", "content-type"], allowMethods: ["GET", "POST"], maxAge: 600 }));

  app.get("/health", (c) => c.json({ ok: true }));

  /** The markets snapshot (snapshot.ts): every market and listed book in one answer, so a visitor's browser does not
   *  read the chain itself; 503 when it cannot be read (the app then reads the chain). */
  const snapshots = deps.snapshots ?? snapshotCache(agate, { log });
  // the developer API (developer.ts): the same snapshot as stable, read-only JSON for anyone, under /v1
  app.route("/", developerApi({ snapshots, client: agate, log }));
  app.get("/api/markets", async (c) => {
    const s = await snapshots.get();
    if (!s) return c.json({ error: "the markets could not be read; read them from the chain" }, 503, { "cache-control": "no-store" });
    return c.json(s, 200, { "cache-control": "no-store" });
  });

  /** What the app needs to build a pocket permission the server will accept (routers in the exact signing order). */
  app.get("/api/config", (c) =>
    c.json({
      chainId: cfg.chainId,
      dollar: cfg.dollar,
      routers: cfg.routers,
      factory: process.env.AGATE_FACTORY ?? "real",
      shortSizingPrice: SHORT_SIZING_PRICE.toString(),
      maxGrantDays: MAX_GRANT_DAYS,
      maxTradesPerDay: MAX_TRADES_PER_DAY,
    }),
  );

  // Reachability probes from dashboards use GET; only POST carries events.
  app.get("/dynamic/webhook", (c) => c.json({ ok: true }));
  app.post("/dynamic/webhook", async (c) => {
    const raw = await c.req.text();
    const r = handleWebhook(raw, c.req.header("x-dynamic-signature-256") ?? null, { store: deps.store, secret: webhookSecret, rsaPrivateKeyPem: rsaPem, log });
    return c.json(r.body, r.status as 200);
  });

  app.post("/dynamic/review", async (c) => {
    const t0 = performance.now();
    const raw = await c.req.text();
    const sig = checkHmac(raw, c.req.header("x-dynamic-signature"), reviewSecret());
    let decision: { proceed: boolean; reason: string; intentId: string | null; contextKind: string | null };
    let req: ReviewRequest = {};
    if (sig !== "ok") {
      // no secret configured is a setup error, not an open door (as for the webhook)
      decision = { proceed: false, reason: sig === "no-secret" ? "review not configured on agate" : "request not signed by Dynamic", intentId: null, contextKind: null };
    } else {
      try {
        req = JSON.parse(raw) as ReviewRequest;
        decision = decide(req, { store: deps.store, environmentId: cfg.environmentId, chainId: cfg.chainId, limitsOf, serverWallets });
      } catch (e) {
        decision = { proceed: false, reason: "unreadable request", intentId: null, contextKind: null };
        log({ event: "review.error", error: (e as Error).message });
      }
    }
    const ms = Math.round(performance.now() - t0);
    deps.store.logReview({
      at: Date.now(),
      walletId: req.walletId ?? null,
      userId: req.userId ?? null,
      shareSetType: req.shareSetType ?? null,
      contextKind: decision.contextKind,
      proceed: decision.proceed,
      reason: decision.reason,
      intentId: decision.intentId,
      ms,
    });
    log({
      event: "review",
      sig,
      shareSetType: req.shareSetType,
      walletId: req.walletId,
      contextKind: decision.contextKind,
      message: typeof req.message === "string" ? `${req.message.slice(0, 12)}..(${req.message.length})` : typeof req.message,
      proceed: decision.proceed,
      reason: decision.reason,
      ms,
    });
    const body = JSON.stringify(decision.proceed ? { proceed: true } : { proceed: false, reason: decision.reason });
    if (signer === undefined) signer = ed25519Signer(signPem());
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (signer) headers["x-dynamic-response-signature"] = signer(body);
    return new Response(body, { status: 200, headers });
  });

  // ---------------------------------------------------------------- the app's API (Dynamic session JWT)

  const authed = async (c: Context): Promise<DynamicUser | Response> => {
    const m = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i);
    if (!m) return c.json({ error: "sign in first" }, 401);
    try {
      return await verifyUser(m[1]!);
    } catch (e) {
      log({ event: "api.auth.rejected", error: (e as Error).message.slice(0, 120) });
      return c.json({ error: "session not valid: sign in again" }, 401);
    }
  };

  app.get("/api/me", async (c) => {
    const u = await authed(c);
    if (u instanceof Response) return u;
    const delegations = deps.store.delegationsOf(u.userId).map((d) => ({ walletId: d.walletId, address: d.address, status: d.status }));
    const grants = deps.store.grantsOf(u.userId);
    // a pocket index is never reused: a revoked pocket's old permission stays installed onchain until its end date
    const nextPocketIndex = 1 + grants.reduce((m, g) => Math.max(m, g.pocketIndex), 0);
    return c.json({ userId: u.userId, email: u.email, wallets: [...u.wallets.keys()], delegations, grants: grants.map(grantView), nextPocketIndex });
  });

  app.post("/api/grants", async (c) => {
    const u = await authed(c);
    if (u instanceof Response) return u;
    const body = (await c.req.json().catch(() => null)) as GrantRequest | null;
    if (!body) return c.json({ error: "no grant" }, 400);
    try {
      const r = await createGrant(deps.store, u, body);
      if ("error" in r) return c.json({ error: r.error }, r.status as 400);
      log({ event: "grant.created", grantId: r.id, userId: u.userId, pocket: r.pocket });
      return c.json(grantView(r), 201);
    } catch (e) {
      log({ event: "grant.error", error: (e as Error).message.slice(0, 200) });
      return c.json({ error: "could not check the permission, try again" }, 502);
    }
  });

  app.get("/api/grants", async (c) => {
    const u = await authed(c);
    if (u instanceof Response) return u;
    return c.json(deps.store.grantsOf(u.userId).map(grantView));
  });

  /** "Disconnect" on agate's side (the app also revokes the Assistant's delegation with Dynamic). */
  app.post("/api/grants/:id/disconnect", async (c) => {
    const u = await authed(c);
    if (u instanceof Response) return u;
    const g = deps.store.grant(c.req.param("id"));
    if (!g || g.userId !== u.userId) return c.json({ error: "no such AI connection" }, 404);
    endGrant(deps.store, g.id);
    deps.store.event({ source: "agate", name: "grant.disconnected", userId: u.userId, grantId: g.id, walletId: g.assistantWalletId, detail: { label: g.label } });
    return c.json(grantView({ ...g, status: "revoked" }));
  });

  /** The connector URL for an AI app (shown once; asking again replaces it). */
  app.post("/api/grants/:id/connector", async (c) => {
    const u = await authed(c);
    if (u instanceof Response) return u;
    const g = deps.store.grant(c.req.param("id"));
    if (!g || g.userId !== u.userId || g.status !== "active") return c.json({ error: "no such live AI connection" }, 404);
    const url = `${publicBase()}/c/${deps.store.newConnectorSecret(g.id)}/mcp`;
    deps.store.event({ source: "agate", name: "grant.connector_issued", userId: u.userId, grantId: g.id, detail: {} });
    return c.json({ url, claudeCode: `claude mcp add --transport http agate ${url}`, note: "Treat this URL like a password: anyone with it can use this AI connection." });
  });

  // ---- the Allow page (OAuth consent): the app shows the request, the person picks or creates the connection
  app.get("/api/oauth/requests/:id", async (c) => {
    const u = await authed(c);
    if (u instanceof Response) return u;
    const r = oauth.getRequest(c.req.param("id"));
    if (!r || !oauth.bindRequestUser(r.request_id, u.userId)) return c.json({ error: "this request expired or belongs to someone else" }, 404);
    const client = oauth.getClient(r.client_id);
    let redirectHost = "";
    try {
      redirectHost = new URL(r.redirect_uri).host;
    } catch {
      redirectHost = r.redirect_uri.split(":")[0] ?? "";
    }
    return c.json({ requestId: r.request_id, clientName: client?.client_name ?? "an AI app", redirectHost, expiresAt: new Date(r.expires_at * 1000).toISOString() });
  });

  /** the app follows the redirect in Agate's origin: a request stored before a policy tightening is
   * re-checked here and dropped, never handed back as a redirect */
  const returnAllowed = (r: { request_id: string; redirect_uri: string }): boolean => {
    if (redirectUriAllowed(r.redirect_uri)) return true;
    oauth.deleteRequest(r.request_id);
    return false;
  };

  app.post("/api/oauth/requests/:id/approve", async (c) => {
    const u = await authed(c);
    if (u instanceof Response) return u;
    const r = oauth.getRequest(c.req.param("id"));
    if (!r || !oauth.bindRequestUser(r.request_id, u.userId)) return c.json({ error: "this request expired or belongs to someone else" }, 404);
    if (!returnAllowed(r)) return c.json({ error: "this AI app's return address is not allowed" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { grantId?: string };
    const g = body.grantId ? deps.store.grant(body.grantId) : null;
    if (!g || g.userId !== u.userId || g.status !== "active" || g.expiresAt <= Date.now()) return c.json({ error: "connect the AI first (no live connection with that id)" }, 409);
    const code = oauth.createCode({ client_id: r.client_id, redirect_uri: r.redirect_uri, code_challenge: r.code_challenge, card_id: g.id, user_id: u.userId, resource: r.resource, scope: r.scope }, 120);
    oauth.deleteRequest(r.request_id);
    deps.store.event({ source: "agate", name: "grant.oauth_approved", userId: u.userId, grantId: g.id, detail: { client: oauth.getClient(r.client_id)?.client_name ?? null } });
    return c.json({ redirect: appendRedirectParams(r.redirect_uri, { code, ...(r.state ? { state: r.state } : {}) }) });
  });

  app.post("/api/oauth/requests/:id/deny", async (c) => {
    const u = await authed(c);
    if (u instanceof Response) return u;
    const r = oauth.getRequest(c.req.param("id"));
    if (!r || !oauth.bindRequestUser(r.request_id, u.userId)) return c.json({ error: "this request expired or belongs to someone else" }, 404);
    if (!returnAllowed(r)) return c.json({ error: "this AI app's return address is not allowed" }, 400);
    oauth.deleteRequest(r.request_id);
    return c.json({ redirect: appendRedirectParams(r.redirect_uri, { error: "access_denied", ...(r.state ? { state: r.state } : {}) }) });
  });

  // ---- approvals: trades an AI asked for above its cap; the person runs them from the main account in the app
  /** a person who started the trade just before the approval ran out can still report how it went */
  const REPORT_GRACE_MS = 15 * 60_000;
  app.get("/api/approvals", async (c) => {
    const u = await authed(c);
    if (u instanceof Response) return u;
    return c.json(deps.store.approvalsOf(u.userId).map((a) => deps.store.approval(a.id)));
  });

  const settle = (status: "denied" | "done" | "failed") => async (c: Context) => {
    const u = await authed(c);
    if (u instanceof Response) return u;
    const a = deps.store.approval(c.req.param("id") ?? "");
    if (!a || a.userId !== u.userId) return c.json({ error: "no such approval" }, 404);
    const late = a.status === "expired" && status !== "denied" && Date.now() < a.expiresAt + REPORT_GRACE_MS;
    if (a.status !== "pending" && a.status !== "approved" && !late) return c.json({ error: `this approval is ${a.status}` }, 409);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const result = status === "done" ? { txHash: String(body.txHash ?? ""), userOpHash: String(body.userOpHash ?? "") } : status === "failed" ? { reason: String(body.reason ?? "").slice(0, 300) } : null;
    deps.store.setApproval(a.id, status, result);
    deps.store.event({ source: "agate", name: `approval.${status}`, userId: u.userId, grantId: a.grantId, detail: { requestId: a.id, ...(result ?? {}) } });
    return c.json(deps.store.approval(a.id));
  };
  app.post("/api/approvals/:id/deny", settle("denied"));
  app.post("/api/approvals/:id/done", settle("done"));
  app.post("/api/approvals/:id/failed", settle("failed"));

  app.get("/api/activity", async (c) => {
    const u = await authed(c);
    if (u instanceof Response) return u;
    const grantId = c.req.query("grantId");
    if (grantId) {
      const g = deps.store.grant(grantId);
      if (!g || g.userId !== u.userId) return c.json({ error: "no such AI connection" }, 404);
    }
    const n = Math.floor(Number(c.req.query("limit") ?? 100));
    return c.json(deps.store.events({ userId: u.userId, ...(grantId ? { grantId } : {}), limit: Number.isFinite(n) ? Math.max(1, Math.min(500, n)) : 100 }));
  });

  // ---- autopilot orders ("keep my hedge going"), for the AI card
  app.get("/api/standing-orders", async (c) => {
    const u = await authed(c);
    if (u instanceof Response) return u;
    const grantId = c.req.query("grantId");
    return c.json(deps.store.standingOrdersOf({ userId: u.userId, ...(grantId ? { grantId } : {}) }));
  });

  app.post("/api/standing-orders", async (c) => {
    const u = await authed(c);
    if (u instanceof Response) return u;
    const body = (await c.req.json().catch(() => ({}))) as { grantId?: string; gpu?: string; leadMinutes?: number };
    const g = body.grantId ? deps.store.grant(body.grantId) : null;
    if (!g || g.userId !== u.userId || g.status !== "active" || g.expiresAt <= Date.now()) return c.json({ error: "no such live AI connection" }, 404);
    if (!body.gpu || !(GPUS as readonly string[]).includes(body.gpu)) return c.json({ error: `gpu must be one of ${GPUS.join(", ")}` }, 400);
    const lead = body.leadMinutes ?? 60;
    if (!Number.isInteger(lead) || lead < 10 || lead > 10_080) return c.json({ error: "leadMinutes: a whole number from 10 to 10080" }, 400);
    const existing = deps.store.standingOrdersOf({ grantId: g.id, status: "active" }).find((o) => o.gpu === body.gpu);
    if (existing) return c.json(existing);
    const o = deps.store.putStandingOrder({ grantId: g.id, userId: u.userId, kind: "roll_long", gpu: body.gpu, leadMinutes: lead });
    deps.store.event({ source: "agate", name: "autopilot.started", userId: u.userId, grantId: g.id, detail: { orderId: o.id, gpu: o.gpu, leadMinutes: lead } });
    return c.json(o, 201);
  });

  app.post("/api/standing-orders/:id/stop", async (c) => {
    const u = await authed(c);
    if (u instanceof Response) return u;
    const o = deps.store.standingOrder(c.req.param("id"));
    if (!o || o.userId !== u.userId) return c.json({ error: "no such autopilot order" }, 404);
    deps.store.setStandingOrder(o.id, { status: "stopped" });
    deps.store.event({ source: "agate", name: "autopilot.stopped", userId: u.userId, grantId: o.grantId, detail: { orderId: o.id, gpu: o.gpu, by: "person" } });
    return c.json(deps.store.standingOrder(o.id));
  });

  // Live-test hook (AGATE_LAB=1 only): the owner of a grant asks the server to trade from its pocket, exactly the
  // path the MCP tools take. Off in every real deployment.
  if (process.env.AGATE_LAB === "1") {
    app.post("/api/grants/:id/lab-trade", async (c) => {
      const u = await authed(c);
      if (u instanceof Response) return u;
      const g = deps.store.grant(c.req.param("id"));
      if (!g || g.userId !== u.userId) return c.json({ error: "no such AI connection" }, 404);
      const body = (await c.req.json().catch(() => null)) as { calls?: { to: Hex; value?: string; data: Hex }[] } | null;
      const calls = (body?.calls ?? []).map((x) => ({ to: x.to, value: BigInt(x.value ?? "0"), data: x.data }));
      try {
        const r = await pocketTrade(deps.store, g, calls, log, undefined, { skipServerChecks: c.req.query("raw") === "1" });
        if ("refused" in r) return c.json(r, 422);
        return c.json({ userOpHash: r.userOpHash, txHash: r.receipt.receipt.transactionHash, success: r.receipt.success, ms: r.ms });
      } catch (e) {
        const m = (e as Error).message;
        log({ event: "lab.trade.error", error: m.slice(-900) });
        return c.json({ error: m.slice(0, 120), reason: (m.match(/"message":"([^"]{0,300})/)?.[1] ?? m.match(/(AA\d\d[^"\\]{0,200})/)?.[1] ?? m.slice(-300)) }, 502);
      }
    });
  }

  return app;
}

export function internalApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/reviews", (c) => c.json(deps.store.reviews(Number(c.req.query("limit") ?? 50))));
  app.get("/events", (c) => c.json(deps.store.events({ limit: Number(c.req.query("limit") ?? 100) })));

  // agate's own kill switch. Dynamic's server-side revoke answers 401 to every API token (Oct 4: both endpoints, both
  // hosts, 3 credentials), so the person's browser revoke stays the Dynamic-side switch; this one destroys OUR sealed
  // copy of the delegated share and ends the connections, so nothing can sign through agate any more.
  app.post("/kill/:walletId", (c) => {
    const walletId = c.req.param("walletId");
    const had = deps.store.revokeDelegation(walletId);
    const ended = deps.store.grantsOfAssistant(walletId).filter((g) => g.status === "active" || g.status === "pending");
    for (const g of ended) endGrant(deps.store, g.id);
    deps.store.event({ source: "ops", name: "delegation.killed", walletId, detail: { hadMaterials: had, grantsEnded: ended.map((g) => g.id) } });
    return c.json({ walletId, hadMaterials: had, grantsEnded: ended.length });
  });
  return app;
}
