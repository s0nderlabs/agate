// MCP endpoints (ported from remit's production routes), two auth lanes:
//   Lane A (any client, incl. claude.ai web): the connector secret in the URL PATH, /c/<secret>/mcp (never a query
//          string). The app shows it once at Connect time; reissuing it kills the old one.
//   Lane B (OAuth 2.1): /mcp + Authorization: Bearer agt_at_<...>, minted by the self-hosted AS (oauth/routes.ts)
//          after the person approves on agate's Allow page.
// Only the bare /mcp 401 advertises OAuth (RFC 9728 WWW-Authenticate); the secret-path lane stays header-free.
// Stateless transport: a fresh McpServer + transport per request, no session map.
import { StreamableHTTPTransport } from "@hono/mcp";
import { type Context, Hono } from "hono";
import { resourceMetadataUrl, acceptedResources, envInt } from "../oauth/routes.ts";
import { ACCESS_TOKEN_PREFIX, type OAuthStore } from "../oauth/store.ts";
import { clientIp, RateLimiter } from "../ratelimit.ts";
import type { GrantRow } from "../store.ts";
import { buildMcpServer, type McpDeps } from "./server.ts";

const MAX_BODY_BYTES = 1 << 20;
/** What a disconnected connection answers, on either lane */
export const DISCONNECTED = "this AI connection was disconnected: connect it again from Agate";

export function mcpRoutes(deps: McpDeps, oauth: OAuthStore): Hono {
  const app = new Hono();
  const badSecret = new RateLimiter(envInt("AGATE_MCP_BAD_SECRET_LIMIT", 30), 60_000);
  const perGrant = new RateLimiter(envInt("AGATE_MCP_RATE_LIMIT", 240), 60_000);

  // Drain a small unread body before an early response, so a keep-alive socket never desyncs.
  const drain = (c: Context) => c.req.text().catch(() => {});

  const unauthorized = (c: Context, error: string, advertise: boolean) => {
    if (advertise) c.header("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl()}", error="invalid_token", error_description="${error}"`);
    return c.json({ error }, 401);
  };

  const serve = async (c: Context, credential: string | undefined, oauthLane: boolean) => {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_BODY_BYTES) return c.json({ error: "payload too large" }, 413, { Connection: "close" });
    if (!credential) {
      await drain(c);
      return unauthorized(c, "missing credential", oauthLane);
    }
    let grant: GrantRow | null = null;
    let miss = "unknown connection";
    let ended = false;
    if (oauthLane && credential.startsWith(ACCESS_TOKEN_PREFIX)) {
      const row = oauth.getByAccessToken(credential);
      grant = row && (!row.resource || acceptedResources().includes(row.resource)) ? deps.store.grant(row.card_id) : null;
      miss = "invalid or expired access token";
    } else {
      grant = deps.store.grantByConnector(credential);
      // a URL a disconnect ended answers why, so the AI app can say "you were disconnected", not a connection error
      ended = !grant && deps.store.isEndedConnector(credential);
      if (ended) miss = DISCONNECTED;
    }
    if (!grant) {
      await drain(c);
      // a retried ended URL is not a guess: it keeps its answer instead of counting toward the bad-secret limit
      if (!ended && !badSecret.allow(clientIp(c), Date.now())) return c.json({ error: "too many requests" }, 429);
      return unauthorized(c, miss, oauthLane);
    }
    if (grant.status === "revoked") {
      await drain(c);
      return unauthorized(c, DISCONNECTED, oauthLane);
    }
    if (c.req.method === "GET") return c.json({ error: "method not allowed" }, 405, { Allow: "POST, DELETE" });
    if (c.req.method === "POST" && !perGrant.allow(grant.id, Date.now())) {
      await drain(c);
      return c.json({ error: "rate limit exceeded for this connection" }, 429);
    }
    if (c.req.method === "POST") await drain(c); // buffer now (memoized), see remit's note on 431s
    // an expired connection still answers (reads); its trade tools are simply absent
    const server = buildMcpServer(deps, grant);
    const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    return transport.handleRequest(c);
  };

  app.all("/c/:secret/mcp", (c) => serve(c, c.req.param("secret"), false));
  app.all("/mcp", (c) => {
    const m = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i);
    return serve(c, m?.[1], true);
  });
  return app;
}
