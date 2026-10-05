import { describe, expect, test } from "bun:test";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Address } from "viem";
import { publicApp } from "../src/app.ts";
import { config } from "../src/config.ts";
import type { DynamicUser } from "../src/dynamic/jwt.ts";
import { NotLandedYet } from "../src/dynamic/signer.ts";
import { handleWebhook } from "../src/dynamic/webhook.ts";
import { buildMcpServer } from "../src/mcp/server.ts";
import { redirectUriAllowed } from "../src/oauth/routes.ts";
import { OAuthStore } from "../src/oauth/store.ts";
import { type GrantRow, Store } from "../src/store.ts";

const MAIN = "0x1111111111111111111111111111111111111111" as Address;
const POCKET = "0x2222222222222222222222222222222222222222" as Address;
const ASSISTANT = "0x4444444444444444444444444444444444444444" as Address;

function grantRow(over: Partial<GrantRow> = {}): GrantRow {
  return {
    id: "g-1",
    userId: "u-1",
    label: "Claude",
    mainAccount: MAIN,
    pocket: POCKET,
    assistantWalletId: "w-a",
    assistantAddress: ASSISTANT,
    budget: 100_000_000n,
    perTradeCap: 20_000_000n,
    shortTokensCap: 1_000_000n,
    routers: [config.router],
    pocketIndex: 1,
    tradesPerDay: 3,
    expiresAt: Date.now() + 86_400_000,
    permission: "x",
    status: "active",
    createdAt: Date.now(),
    ...over,
  };
}

async function connect(store: Store, g: GrantRow, market: unknown = {}, trade?: unknown) {
  const server = buildMcpServer({ store, client: () => market as never, log: () => {}, ...(trade ? { trade: trade as never } : {}) }, g);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const json = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

describe("the tool list is the permission surface", () => {
  test("a live connection sees the trade tools; a revoked or expired one only the reads", async () => {
    const store = new Store(":memory:");
    const live = await connect(store, grantRow());
    const names = (await live.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_prices", "quote", "my_limits", "open_long", "open_short", "close_short", "roll_long", "get_test_dollars", "approval_status"]));
    for (const g of [grantRow({ status: "revoked" }), grantRow({ expiresAt: Date.now() - 1 })]) {
      const names2 = (await (await connect(store, g)).listTools()).tools.map((t) => t.name);
      expect(names2).toContain("get_prices");
      expect(names2).not.toContain("open_long");
    }
  });
});

describe("trades", () => {
  test("over the cap becomes an approval card; the same idempotency key returns the same card", async () => {
    const store = new Store(":memory:");
    const g = grantRow();
    store.putGrant(g);
    const c = await connect(store, g);
    const args = { gpu: "H100", month: "2026-11", dollars: 50, idempotency_key: "key-abcdefgh" };
    const r1 = json(await c.callTool({ name: "open_long", arguments: args }));
    expect(r1.status).toBe("needs_approval");
    expect(r1.approve_url).toContain(`/approve?request=${r1.request_id}`);
    expect(store.approval(r1.request_id)?.status).toBe("pending");
    const r2 = json(await c.callTool({ name: "open_long", arguments: args }));
    expect(r2.request_id).toBe(r1.request_id);
    expect(r2.idempotent_replay).toBe(true);
    const st = json(await c.callTool({ name: "approval_status", arguments: { request_id: r1.request_id } }));
    expect(st.status).toBe("pending");
  });

  test("a short over the key's GPU-hour limit becomes an approval card even when its collateral fits the cap", async () => {
    const store = new Store(":memory:");
    const g = grantRow(); // $20 cap, 1 GPU-hour a short
    store.putGrant(g);
    const c = await connect(store, g, { seriesAt: async () => ({ terms: { cap: 9_500_000n } }) });
    const r = json(await c.callTool({ name: "open_short", arguments: { gpu: "H200", month: "2026-11", gpu_hours: 2 } }));
    expect(r.status).toBe("needs_approval");
    expect(r.summary).toMatchObject({ collateral: 19, overShortLimitBy: 1 });
    expect(r.summary.overCapBy).toBeUndefined();
  });

  test("the daily count refuses by name before anything is planned", async () => {
    const store = new Store(":memory:");
    const g = grantRow({ tradesPerDay: 2 });
    store.putGrant(g);
    for (let i = 0; i < 2; i++) store.event({ source: "agate", name: "pocket.trade", grantId: g.id, detail: {} });
    const c = await connect(store, g);
    const r = await c.callTool({ name: "open_long", arguments: { gpu: "H100", month: "2026-11", dollars: 5 } });
    expect(r.isError).toBe(true);
    expect(json(r)).toMatchObject({ status: "refused", rule: "daily_limit" });
    // the refusal shows in the person's activity and does not use up a trade
    const ev = store.events({ grantId: g.id }).find((e) => e.name === "pocket.refused");
    expect(ev?.detail).toMatchObject({ action: "open_long", rule: "daily_limit" });
    expect(store.tradesSince(g.id, 0)).toBe(2);
  });

  test("a connection disconnected after the server was built refuses at call time", async () => {
    const store = new Store(":memory:");
    const g = grantRow();
    store.putGrant(g);
    const c = await connect(store, g);
    store.setGrantStatus(g.id, "revoked");
    expect(json(await c.callTool({ name: "open_long", arguments: { gpu: "H100", month: "2026-11", dollars: 5 } }))).toMatchObject({ rule: "grant_revoked" });
  });

  // a faucet plan needs only these reads; the onchain step is the test's stub
  const dripMarket = { dollar: "0x5555555555555555555555555555555555555555", pub: { readContract: async () => 0n }, chainTime: async () => 1n };
  const landed = { intentId: "i", userOpHash: "0xop", receipt: { success: true, receipt: { transactionHash: "0xtx" } }, ms: { prepare: 1, sign: 1, land: 1 } };

  test("a retry with the same key while the first trade is still landing waits and replays it", async () => {
    const store = new Store(":memory:");
    const g = grantRow();
    store.putGrant(g);
    let sent = 0;
    const c = await connect(store, g, dripMarket, async () => {
      sent++;
      await Bun.sleep(50);
      return landed;
    });
    const call = { name: "get_test_dollars", arguments: { idempotency_key: "key-retry-0001" } };
    const [r1, r2] = await Promise.all([c.callTool(call), c.callTool(call)]);
    expect(sent).toBe(1);
    expect(json(r1)).toMatchObject({ status: "done", tx_hash: "0xtx" });
    expect(json(r2)).toMatchObject({ status: "done", tx_hash: "0xtx", idempotent_replay: true });
  });

  test("a trade the bundler took but that did not land in time is reported as sent, never sent again under its key", async () => {
    const store = new Store(":memory:");
    const g = grantRow();
    store.putGrant(g);
    let sent = 0;
    const c = await connect(store, g, dripMarket, async () => {
      sent++;
      throw new NotLandedYet("0xop", new Error("timed out"));
    });
    const call = { name: "get_test_dollars", arguments: { idempotency_key: "key-slow-0001" } };
    const r1 = await c.callTool(call);
    expect(r1.isError).toBeFalsy();
    expect(json(r1)).toMatchObject({ status: "sent", user_op_hash: "0xop" });
    expect(json(await c.callTool(call))).toMatchObject({ status: "sent", idempotent_replay: true });
    expect(sent).toBe(1);
  });

  test("a paymaster refusal comes back as sponsor_limit, never as a raw RPC error", async () => {
    const store = new Store(":memory:");
    const g = grantRow();
    store.putGrant(g);
    const c = await connect(store, g, dripMarket, async () => {
      throw new Error("UserOperation reverted: pm_sponsorUserOperation: gas policy request limit exceeded");
    });
    expect(json(await c.callTool({ name: "get_test_dollars", arguments: {} }))).toMatchObject({ status: "refused", rule: "sponsor_limit" });
  });

  test("bad input is rejected by the schema", async () => {
    const store = new Store(":memory:");
    const c = await connect(store, grantRow());
    const r = await c.callTool({ name: "open_long", arguments: { gpu: "H999", month: "Nov", dollars: -1 } });
    expect(r.isError).toBe(true);
  });
});

describe("HTTP lanes and OAuth", () => {
  const user: DynamicUser = { userId: "u-1", email: null, wallets: new Map(), scopes: [] };
  const mk = () => {
    const store = new Store(":memory:");
    const app = publicApp({ store, log: () => {}, verifyUser: async (t) => (t === "good" ? { ...user, wallets: new Map() } : Promise.reject(new Error("bad"))), agateClient: () => ({}) as never });
    return { store, app };
  };
  const rpc = (app: ReturnType<typeof mk>["app"], path: string, auth?: string) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
  const tools = async (r: Response) => {
    const t = await r.text();
    const line = t.split("\n").find((l) => l.startsWith("data:"));
    return (JSON.parse(line ? line.slice(5) : t).result.tools as { name: string }[]).map((x) => x.name);
  };

  test("config, next pocket index and per-connection activity for the app", async () => {
    const { store, app } = mk();
    const cfg = await (await app.request("/api/config")).json();
    expect(cfg).toMatchObject({ chainId: 10143, routers: config.routers, shortSizingPrice: "20000000", maxGrantDays: 90 });
    store.putGrant(grantRow());
    store.putGrant(grantRow({ id: "g-other", userId: "u-2", pocketIndex: 4 }));
    const me = await (await app.request("/api/me", { headers: { authorization: "Bearer good" } })).json();
    expect(me.nextPocketIndex).toBe(2);
    expect(me.grants[0].pocketIndex).toBe(1);
    store.event({ source: "mcp", name: "pocket.refused", userId: "u-1", grantId: "g-1", detail: { rule: "daily_limit" } });
    const act = await (await app.request("/api/activity?grantId=g-1", { headers: { authorization: "Bearer good" } })).json();
    expect(act.map((e: { name: string }) => e.name)).toContain("pocket.refused");
    expect((await app.request("/api/activity?grantId=g-other", { headers: { authorization: "Bearer good" } })).status).toBe(404);
  });

  test("an approval that ran out while the person was sending it can still be reported, for a while", async () => {
    const { store, app } = mk();
    store.putGrant(grantRow());
    const put = (ago: number) => store.putApproval({ grantId: "g-1", userId: "u-1", action: "open_long", params: {}, summary: {}, note: null, expiresAt: Date.now() - ago });
    const post = (id: string, what: string) => app.request(`/api/approvals/${id}/${what}`, { method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" }, body: JSON.stringify({ txHash: "0xtx" }) });
    const late = put(60_000);
    expect((await post(late.id, "done")).status).toBe(200);
    expect(store.approval(late.id)?.status).toBe("done");
    expect((await post(put(60_000).id, "deny")).status).toBe(409);
    expect((await post(put(20 * 60_000).id, "done")).status).toBe(409);
  });

  test("a pending approval runs out with its AI: disconnected, or past the AI's end date; a settled one stays", async () => {
    const { store, app } = mk();
    store.putGrant(grantRow());
    store.putGrant(grantRow({ id: "g-2", pocket: "0x3333333333333333333333333333333333333333" as Address }));
    const put = (grantId: string) => store.putApproval({ grantId, userId: "u-1", action: "open_long", params: {}, summary: {}, note: null, expiresAt: Date.now() + 3_600_000 });
    const pending = put("g-1");
    const denied = put("g-1");
    store.setApproval(denied.id, "denied", null);
    const other = put("g-2");
    expect((await app.request("/api/grants/g-1/disconnect", { method: "POST", headers: { authorization: "Bearer good" } })).status).toBe(200);
    // expired at the disconnect itself, with an activity entry, before anyone reads it
    const row = store.db.query("SELECT status, result FROM approvals WHERE id = ?").get(pending.id) as { status: string; result: string };
    expect([row.status, JSON.parse(row.result).reason]).toEqual(["expired", "the AI was disconnected"]);
    const act = (await (await app.request("/api/activity?grantId=g-1", { headers: { authorization: "Bearer good" } })).json()) as { name: string }[];
    expect(act.map((e) => e.name)).toContain("approval.expired");
    const list = (await (await app.request("/api/approvals", { headers: { authorization: "Bearer good" } })).json()) as { id: string; status: string; result: { reason?: string } | null }[];
    const by = (id: string) => list.find((a) => a.id === id)!;
    expect([by(pending.id).status, by(pending.id).result?.reason]).toEqual(["expired", "the AI was disconnected"]);
    expect([by(denied.id).status, by(other.id).status]).toEqual(["denied", "pending"]);
    // the person was already sending it: the result can still be reported
    const post = (id: string) => app.request(`/api/approvals/${id}/done`, { method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" }, body: JSON.stringify({ txHash: "0xtx" }) });
    expect((await post(pending.id)).status).toBe(200);
    // the other AI's end date passes: its pending approval runs out at the next read
    store.putGrant(grantRow({ id: "g-2", pocket: "0x3333333333333333333333333333333333333333" as Address, expiresAt: Date.now() - 1 }));
    expect([store.approval(other.id)?.status, store.approval(other.id)?.result]).toEqual(["expired", { reason: "the AI's permission ended" }]);
    // past its end date, then disconnected before anyone read the approval: it ended, it was not cut short
    store.putGrant(grantRow({ id: "g-3", pocket: "0x5555555555555555555555555555555555555555" as Address, expiresAt: Date.now() - 1 }));
    const third = put("g-3");
    expect((await app.request("/api/grants/g-3/disconnect", { method: "POST", headers: { authorization: "Bearer good" } })).status).toBe(200);
    expect(store.approval(third.id)?.result).toEqual({ reason: "the AI's permission ended" });
  });

  test("the API answers the app cross-origin, /api/config included, and a bad activity limit is clamped", async () => {
    const { store, app } = mk();
    store.putGrant(grantRow());
    const cfg = await app.request("/api/config", { headers: { origin: "http://localhost:3317" } });
    expect(cfg.headers.get("access-control-allow-origin")).toBe("http://localhost:3317");
    for (const q of ["abc", "-1", "9999"]) expect((await app.request(`/api/activity?limit=${q}`, { headers: { authorization: "Bearer good" } })).status).toBe(200);
  });

  test("a revoke from Dynamic's side ends the connection like Disconnect: autopilot stopped, connector URL dead", () => {
    const store = new Store(":memory:");
    store.putGrant(grantRow());
    const secret = store.newConnectorSecret("g-1");
    store.putStandingOrder({ grantId: "g-1", userId: "u-1", kind: "roll_long", gpu: "H100", leadMinutes: 60 });
    const raw = JSON.stringify({ messageId: "m-r", eventName: "wallet.delegation.revoked", data: { walletId: "w-a" } });
    const r = handleWebhook(raw, createHmac("sha256", "whsec").update(raw).digest("hex"), { store, secret: () => "whsec", rsaPrivateKeyPem: () => undefined, log: () => {} });
    expect(r.status).toBe(200);
    expect(store.grant("g-1")?.status).toBe("revoked");
    expect(store.standingOrdersOf({ grantId: "g-1", status: "active" })).toHaveLength(0);
    expect(store.grantByConnector(secret)).toBeNull();
  });

  test("connector URL lane: a good secret lists tools, a bad one is 401, a disconnected one is 401", async () => {
    const { store, app } = mk();
    store.putGrant(grantRow());
    const secret = store.newConnectorSecret("g-1");
    expect(await tools(await rpc(app, `/c/${secret}/mcp`))).toContain("open_long");
    expect((await rpc(app, "/c/agt_c_nope/mcp")).status).toBe(401);
    const r = await app.request("/api/grants/g-1/disconnect", { method: "POST", headers: { authorization: "Bearer good" } });
    expect(r.status).toBe(200);
    expect((await rpc(app, `/c/${secret}/mcp`)).status).toBe(401);
  });

  test("bare /mcp advertises OAuth; register -> authorize -> Allow page approve -> token -> tools", async () => {
    const { store, app } = mk();
    store.putGrant(grantRow());
    const r401 = await rpc(app, "/mcp");
    expect(r401.status).toBe(401);
    expect(r401.headers.get("www-authenticate")).toContain("resource_metadata=");
    const reg = (await (await app.request("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://localhost:7777/cb"], client_name: "Claude" }) })).json()) as { client_id: string };
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const auth = await app.request(`/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent("http://localhost:7777/cb")}&code_challenge=${challenge}&code_challenge_method=S256&state=s1`);
    expect(auth.status).toBe(302);
    const requestId = new URL(auth.headers.get("location")!).searchParams.get("request")!;
    const info = (await (await app.request(`/api/oauth/requests/${requestId}`, { headers: { authorization: "Bearer good" } })).json()) as { clientName: string };
    expect(info.clientName).toBe("Claude");
    const ap = (await (await app.request(`/api/oauth/requests/${requestId}/approve`, { method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" }, body: JSON.stringify({ grantId: "g-1" }) })).json()) as { redirect: string };
    const cb = new URL(ap.redirect);
    expect(cb.searchParams.get("state")).toBe("s1");
    const tok = (await (await app.request("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: cb.searchParams.get("code")!, code_verifier: verifier, client_id: reg.client_id, redirect_uri: "http://localhost:7777/cb" }) })).json()) as { access_token: string; refresh_token: string };
    expect(tok.access_token.startsWith("agt_at_")).toBe(true);
    expect(await tools(await rpc(app, "/mcp", tok.access_token))).toContain("my_limits");
    // the person disconnects: the token dies with the connection
    await app.request("/api/grants/g-1/disconnect", { method: "POST", headers: { authorization: "Bearer good" } });
    expect((await rpc(app, "/mcp", tok.access_token)).status).toBe(401);
  });

  test("redirect policy: custom schemes are an allowlist, so script, local-file and OS-handler schemes never pass", () => {
    for (const bad of [
      "javascript:alert(1)",
      "javascript://%0aalert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://agate.example/1",
      "about:blank",
      "filesystem:https://agate.example/temporary/x",
      "view-source:https://agate.example",
      "ms-msdt:/id PCWDiagnostic",
      "search-ms:query=x",
      "myapp://cb",
      "http://agate.example/cb",
      "https://agate.example/cb#frag",
    ]) expect(redirectUriAllowed(bad)).toBe(false);
    for (const ok of [
      "cursor://anysphere.cursor-retrieval/oauth/callback",
      "vscode://vscode.github-authentication/did-authenticate",
      "com.example.app:/cb",
      "https://claude.ai/api/mcp/auth_callback",
      "http://127.0.0.1:5555/cb",
    ]) expect(redirectUriAllowed(ok)).toBe(true);
    process.env.AGATE_OAUTH_REDIRECT_SCHEMES = " MyApp: ,other";
    try {
      expect(redirectUriAllowed("myapp://cb")).toBe(true);
      expect(redirectUriAllowed("javascript:alert(1)")).toBe(false);
    } finally {
      delete process.env.AGATE_OAUTH_REDIRECT_SCHEMES;
    }
  });

  test("/register applies the policy (400 invalid_redirect_uri), an app scheme still registers", async () => {
    const { app } = mk();
    const register = (uri: string) => app.request("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [uri], client_name: "x" }) });
    const r = await register("javascript:alert(1)");
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("invalid_redirect_uri");
    expect((await register("cursor://anysphere.cursor-retrieval/oauth/callback")).status).toBe(201);
  });

  test("a client or request stored before the policy is re-checked at /authorize, Allow and Decline, never redirected to", async () => {
    const { store, app } = mk();
    store.putGrant(grantRow());
    const oauth = new OAuthStore(store.db);
    const bad = "javascript:alert(1)";
    const client = oauth.createClient({ redirectUris: [bad], clientName: "old" });
    const auth = await app.request(`/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(bad)}&code_challenge=x&code_challenge_method=S256`);
    expect(auth.status).toBe(400);
    expect(auth.headers.get("location")).toBeNull();
    for (const [action, body] of [["approve", { grantId: "g-1" }], ["deny", {}]] as const) {
      const id = oauth.createRequest({ client_id: client.client_id, redirect_uri: bad, code_challenge: "x", resource: null, scope: null, state: "s" }, 900);
      const r = await app.request(`/api/oauth/requests/${id}/${action}`, { method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(r.status).toBe(400);
      expect(JSON.stringify(await r.json())).not.toContain("javascript");
      expect(oauth.getRequest(id)).toBeNull();
    }
  });
});
