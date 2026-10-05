// Agate's server as the app calls it (server/API.md, Oct 5): the shapes it answers with and one typed helper per
// endpoint, over a transport. Example data runs the helpers over the pretend server (fakeServer.ts); live swaps in
// a fetch to NEXT_PUBLIC_AGATE_SERVER with "Authorization: Bearer <session JWT>" read fresh on every call. A refusal
// is thrown as a ServerError carrying errors.ts's plain problem, so screens never parse the server's sentence.
import { serverProblemOf, type AutopilotResult, type ServerProblem, type ServerSubject } from "./errors";
import type { ApprovalView } from "./machine";

/** One request and its answer. status null: no answer at all (the server is unreachable). */
export type Transport = (method: "GET" | "POST", path: string, body?: unknown) => Promise<{ status: number | null; body: unknown }>;

export class ServerError extends Error {
  status: number | null;
  body: unknown;
  problem: ServerProblem;
  constructor(status: number | null, body: unknown, problem: ServerProblem) {
    super(problem.message);
    this.name = "ServerError";
    this.status = status;
    this.body = body;
    this.problem = problem;
  }
}

/** GET /api/config (no sign-in): the routers to sign the pocket's permission with, in this order. */
export interface ServerConfig {
  chainId: number;
  dollar: string;
  routers: string[];
  factory: string;
  shortSizingPrice: string;
  maxGrantDays: number;
  maxTradesPerDay: number;
}

export type GrantStatus = "active" | "revoked" | "expired";

/** An AI connection (server grantView): amounts are u strings (1e6 = $1), times ISO. */
export interface Grant {
  id: string;
  label: string;
  status: GrantStatus;
  pocket: string;
  mainAccount: string;
  assistant: string;
  budget: string;
  perTradeCap: string;
  pocketIndex: number;
  tradesPerDay: number;
  expiresAt: string;
  createdAt: string;
}

export interface Me {
  userId: string;
  email: string | null;
  wallets: string[];
  delegations: { walletId: string; address: string; status: string }[];
  grants: Grant[];
  /** each AI gets its own pocket, and an index is never reused */
  nextPocketIndex: number;
}

/** POST /api/grants */
export interface GrantRequest {
  label: string;
  mainOwner: string;
  assistantAddress: string;
  budget: string;
  perTradeCap: string;
  tradesPerDay: number;
  validUntil: number;
  pocketIndex: number;
  approval: string;
}

/** POST /api/grants/:id/connector: shown once; asking again replaces it. */
export interface Connector {
  url: string;
  claudeCode: string;
  note: string;
}

/** GET /api/oauth/requests/:id */
export interface OAuthRequest {
  requestId: string;
  clientName: string;
  redirectHost: string;
  expiresAt: string;
}

/** GET /api/activity, newest first. at in ms. */
export interface ActivityEvent {
  at: number;
  source: string;
  name: string;
  walletId: string | null;
  grantId: string | null;
  detail: Record<string, unknown>;
}

/** GET /api/standing-orders: "Keep my hedge going" for one GPU of one AI. Times in ms. */
export interface StandingOrder {
  id: string;
  grantId: string;
  gpu: string;
  kind: "roll_long";
  leadMinutes: number;
  status: "active" | "stopped";
  createdAt: number;
  lastRunAt: number | null;
  lastResult: AutopilotResult | null;
}

export type { ApprovalView };

/** The typed endpoints over one transport. Each throws a ServerError on a refusal or no answer. */
export function serverApi(t: Transport) {
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown, subject: ServerSubject = "other"): Promise<T> {
    let r: { status: number | null; body: unknown };
    try {
      r = await t(method, path, body);
    } catch {
      r = { status: null, body: null };
    }
    if (r.status !== null && r.status >= 200 && r.status < 300) return r.body as T;
    throw new ServerError(r.status, r.body, serverProblemOf(r.status, r.body, { hasToken: true, subject }));
  }
  const id = (s: string) => encodeURIComponent(s);
  return {
    // is the server up: /api/config needs no sign-in and answers the app's origin (the bare /health sends no CORS
    // headers, so a browser can't read it)
    health: async () => {
      await call<ServerConfig>("GET", "/api/config");
      return { ok: true };
    },
    config: () => call<ServerConfig>("GET", "/api/config"),
    me: () => call<Me>("GET", "/api/me"),
    grants: () => call<Grant[]>("GET", "/api/grants"),
    createGrant: (b: GrantRequest) => call<Grant>("POST", "/api/grants", b),
    disconnect: (grantId: string) => call<Grant>("POST", `/api/grants/${id(grantId)}/disconnect`, {}, "grant"),
    connector: (grantId: string) => call<Connector>("POST", `/api/grants/${id(grantId)}/connector`, {}, "grant"),
    oauthRequest: (requestId: string) => call<OAuthRequest>("GET", `/api/oauth/requests/${id(requestId)}`, undefined, "request"),
    oauthApprove: (requestId: string, grantId: string) => call<{ redirect: string }>("POST", `/api/oauth/requests/${id(requestId)}/approve`, { grantId }, "request"),
    oauthDeny: (requestId: string) => call<{ redirect: string }>("POST", `/api/oauth/requests/${id(requestId)}/deny`, {}, "request"),
    approvals: () => call<ApprovalView[]>("GET", "/api/approvals"),
    approvalDone: (approvalId: string, b: { txHash: string; userOpHash: string }) => call<ApprovalView>("POST", `/api/approvals/${id(approvalId)}/done`, b, "approval"),
    approvalFailed: (approvalId: string, reason: string) => call<ApprovalView>("POST", `/api/approvals/${id(approvalId)}/failed`, { reason }, "approval"),
    approvalDeny: (approvalId: string) => call<ApprovalView>("POST", `/api/approvals/${id(approvalId)}/deny`, {}, "approval"),
    activity: (q: { limit?: number; grantId?: string } = {}) =>
      call<ActivityEvent[]>("GET", `/api/activity?limit=${q.limit ?? 100}${q.grantId ? `&grantId=${id(q.grantId)}` : ""}`, undefined, "grant"),
    standingOrders: (grantId?: string) => call<StandingOrder[]>("GET", `/api/standing-orders${grantId ? `?grantId=${id(grantId)}` : ""}`, undefined, "order"),
    startStandingOrder: (b: { grantId: string; gpu: string; leadMinutes?: number }) => call<StandingOrder>("POST", "/api/standing-orders", b, "order"),
    stopStandingOrder: (orderId: string) => call<StandingOrder>("POST", `/api/standing-orders/${id(orderId)}/stop`, {}, "order"),
    /** the AI apps' link: the resource of the protected-resource metadata */
    mcpUrl: async () => (await call<{ resource: string }>("GET", "/.well-known/oauth-protected-resource")).resource,
  };
}

export type ServerApi = ReturnType<typeof serverApi>;

/** u string (1e6 = $1) to dollars. */
export const fromU = (u: string | number | bigint | null | undefined) => {
  if (u === null || u === undefined) return 0;
  const n = typeof u === "bigint" ? Number(u) : Number(u);
  return Number.isFinite(n) ? n / 1e6 : 0;
};

/** A trade summary's dollars: a number is dollars, a whole-number string is u, a decimal string is dollars. */
export function summaryDollars(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    if (/^\d+$/.test(v)) return Number(v) / 1e6;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
