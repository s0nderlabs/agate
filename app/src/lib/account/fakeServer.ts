// The pretend Agate server, pocket chain and AI-key wallet, for example data. The server half answers exactly like
// server/API.md (same paths, bodies, statuses and error sentences), as a Transport for api.ts, so going live is
// swapping this transport for fetch. The chain half stands in for getWallet(pocket) and the pocket transfers, and the
// wallet half for @agate/wallet's trading-key calls (ensureAssistantWallet, delegateAssistant, the step-up code,
// createPocketPermission, revokeAssistant). Everything lives in one module-level world, seeded from the example-only
// Mock rows "Connected AIs" (none, one, two, ended), "Connect outcome" and "Disconnect outcome", so a state is a URL and
// survives moving between pages; a reload seeds it again, and the dollars moved in and out of its pockets since then go
// back to the example wallet (pocketNet), so a reload never loses or makes money. Never imports the SDK or @agate/wallet.
import { NOVEMBER } from "@/lib/mock/data";
import { isCheckTab, type AisScenario, type ConnectOutcome, type DisconnectOutcome } from "@/lib/mock/config";
import type { Gpu, MarketGpu, Position } from "@/lib/mock/types";
import type { ActivityEvent, Grant, GrantRequest, OAuthRequest, ServerConfig, StandingOrder, Transport } from "./api";
import { APPROVAL_ENDED_BY, type ApprovalView } from "./machine";

const H = 3_600_000;
const MIN = 60_000;
const DAY = 24 * H;

/** Pretend latencies (ms): long enough to see each step, far shorter than the real 6 to 10 s. */
export const FAKE_MS = { read: 350, write: 600, assistant: 1300, delegate: 1100, permission: 800, funding: 1300, takeBack: 1100, revoke: 500, code: 700 } as const;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A made-up 20-byte address, the same for the same seed (never on Monad). */
export function fakeAddress(seed: string) {
  let out = "";
  let h = 0x811c9dc5;
  for (let round = 0; out.length < 40; round++) {
    for (const ch of `${seed}:${round}`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
  }
  return `0x${out.slice(0, 40)}`;
}
const fakeHash = (seed: string) => `0x${fakeAddress(`${seed}#a`).slice(2)}${fakeAddress(`${seed}#b`).slice(2, 26)}`;

const ROUTER = "0x5c1e7a0d93b4f2e8a6c0d1b7e3f9a2c4d6e8b0a1";
const DOLLAR = "0x3A05c7d1e9b2f4a6c8e0d2b4f6a8c0e2d4f6bF38";
const u = (dollars: number) => (BigInt(Math.round(dollars * 100)) * 10_000n).toString();

interface Pocket {
  balance: number;
  positions: Position[];
}

interface GrantRow extends Grant {
  /** when it was disconnected (ms), for "Disconnected Oct 6, 10:15 UTC" (the server logs grant.disconnected) */
  revokedAt: number | null;
}

interface RequestRow {
  req: OAuthRequest;
  redirectUri: string;
}

interface World {
  key: string;
  /** the data source it belongs to (example or live), for its pocketNet */
  source: string;
  userId: string;
  email: string;
  main: string;
  /** the trading key for every AI (the Assistant), once made */
  assistant: string | null;
  /** the key's delegation reached Agate */
  delegated: boolean;
  /** it was delegated at some point: /api/me lists only keys Dynamic's webhook recorded (a never-delegated one is
   *  not there at all, a switched-off one shows as revoked) */
  wasDelegated: boolean;
  /** the sign-in code's step-up scope is still held (about an hour after sign-in) */
  canDelegate: boolean;
  grants: GrantRow[];
  events: ActivityEvent[];
  approvals: ApprovalView[];
  orders: StandingOrder[];
  pockets: Record<string, Pocket>;
  requests: Record<string, RequestRow>;
  connect: ConnectOutcome;
  disc: DisconnectOutcome;
  /** each failing outcome fails once, so Try again shows the way out */
  failed: Set<string>;
  /** "Key not there yet": how many more POST /api/grants answer 409 before the key reaches Agate */
  notYetLeft: number;
}

/** "Key not there yet" answers 409 this many times: enough for the app's 30 s patience to run out (it asks every 2 s,
 *  each answer counted as 8 s in example data), after which Try again goes through, like every other failing outcome. */
export const NOT_YET_ANSWERS = 5;

const position = (p: Pick<Position, "gpu" | "month" | "side" | "q" | "entry" | "daily"> & Partial<Position>, i: number, openedAt: number): Position => ({
  id: `pocket-${p.gpu}-${p.side}-${i}`,
  paid: 0,
  openedAt: new Date(openedAt).toISOString(),
  kind: p.daily || p.side === "short" ? "position" : "tokens",
  series: "",
  positionId: p.daily || p.side === "short" ? String(100 + i) : null,
  claimable: 0,
  payee: null,
  inMargin: 0,
  ...p,
});

function grantRow(w: World, g: { id: string; label: string; index: number; budget: number; cap: number; perDay: number; createdAt: number; expiresAt: number; status?: Grant["status"]; revokedAt?: number }): GrantRow {
  return {
    id: g.id,
    label: g.label,
    status: g.status ?? "active",
    pocket: pocketAddressOf(w.main, g.index),
    mainAccount: w.main,
    assistant: w.assistant ?? fakeAddress(`${w.main}:assistant`),
    budget: u(g.budget),
    perTradeCap: u(g.cap),
    pocketIndex: g.index,
    tradesPerDay: g.perDay,
    expiresAt: new Date(g.expiresAt).toISOString(),
    createdAt: new Date(g.createdAt).toISOString(),
    revokedAt: g.revokedAt ?? null,
  };
}

/** The pocket of an account at a Kernel index (the real one is pocketAddress(pc, owner, index)). */
export const pocketAddressOf = (main: string, index: number) => fakeAddress(`${main.toLowerCase()}:pocket:${index}`);

const ev = (at: number, name: string, grantId: string | null, detail: Record<string, unknown>, source = "agate"): ActivityEvent => ({ at, source, name, walletId: null, grantId, detail });

/** A pocket trade as the server logs it (grants.ts pocketTrade): the plan's TradeSummary under detail.summary, an
 *  autopilot roll's with summary.autopilot set to its order. */
const trade = (at: number, grantId: string, s: { action: string; gpu: Gpu; month: string; maxSpend: number; gpuHours: number; autopilot?: string }, success = true, txHash = fakeHash(`${grantId}:${at}:tx`)): ActivityEvent =>
  ev(at, "pocket.trade", grantId, { summary: { ...s, bound: null }, userOpHash: fakeHash(`${grantId}:${at}:op`), txHash, success, calls: 2, ms: { prepare: 900, sign: 2600, land: 2600 } });

/** The approval.requested entry the server logs with an over-cap request (mcp/server.ts approvalFor). */
const asked = (at: number, a: ApprovalView): ActivityEvent => ev(at, "approval.requested", a.grantId, { requestId: a.id, action: a.action, summary: a.summary, note: a.note }, "mcp");

const hoursFor = (gpu: MarketGpu, dollars: number) => Math.floor((dollars / NOVEMBER[gpu].quote.ask) * 1e4) / 1e4;

function seed(scenario: AisScenario, main: string, email: string, connect: ConnectOutcome, disc: DisconnectOutcome): World {
  const now = Date.now();
  const w: World = {
    key: "",
    userId: `user-${main.slice(2, 10)}`,
    email,
    main,
    assistant: scenario === "none" ? null : fakeAddress(`${main}:assistant`),
    delegated: scenario === "one" || scenario === "two",
    wasDelegated: scenario !== "none",
    canDelegate: connect !== "stepup",
    grants: [],
    events: [],
    approvals: [],
    orders: [],
    pockets: {},
    requests: {},
    connect,
    disc,
    failed: new Set(),
    notYetLeft: NOT_YET_ANSWERS,
    source: "",
  };
  if (scenario === "none") return w;

  if (scenario === "ended") {
    const claude = grantRow(w, { id: "g-claude", label: "Claude", index: 1, budget: 1000, cap: 250, perDay: 5, createdAt: now - 8 * DAY, expiresAt: now - DAY - 3 * H, status: "expired" });
    const gpt = grantRow(w, { id: "g-chatgpt", label: "ChatGPT", index: 2, budget: 500, cap: 100, perDay: 3, createdAt: now - 5 * DAY, expiresAt: now + 25 * DAY, status: "revoked", revokedAt: now - 2 * DAY + 4 * H });
    w.grants = [gpt, claude];
    w.pockets[claude.pocket] = { balance: 120, positions: [position({ gpu: "H100", month: "2026-11", side: "long", q: hoursFor("H100", 880), entry: NOVEMBER.H100.quote.ask, daily: false }, 1, now - 6 * DAY)] };
    w.pockets[gpt.pocket] = { balance: 0, positions: [position({ gpu: "H100", month: "2026-11", side: "short", q: 25, entry: 4.2, daily: true, paid: 0 }, 2, now - 4 * DAY)] };
    w.events = [
      ev(now - 8 * DAY, "grant.created", claude.id, { label: "Claude", budget: claude.budget, perTradeCap: claude.perTradeCap, tradesPerDay: 5, expiresAt: claude.expiresAt }),
      ev(now - 8 * DAY + 4_000, "grant.oauth_approved", claude.id, { client: "Claude" }),
      trade(now - 6 * DAY, claude.id, { action: "openLong", gpu: "H100", month: "2026-11", maxSpend: 880, gpuHours: hoursFor("H100", 880) }),
      ev(now - 5 * DAY, "grant.created", gpt.id, { label: "ChatGPT", budget: gpt.budget, perTradeCap: gpt.perTradeCap, tradesPerDay: 3, expiresAt: gpt.expiresAt }),
      trade(now - 4 * DAY, gpt.id, { action: "openShort", gpu: "H100", month: "2026-11", maxSpend: 95, gpuHours: 25 }),
      ev(now - 3 * DAY, "pocket.refused", gpt.id, { action: "open_short", rule: "daily_limit", message: "3 of 3 trades used in the last 24 hours", args: {} }, "mcp"),
      ev(now - 2 * DAY + 4 * H, "grant.disconnected", gpt.id, { label: "ChatGPT" }),
      ev(now - 2 * DAY + 4 * H + 600, "wallet.delegation.revoked", gpt.id, {}, "dynamic"),
    ];
    w.approvals = [approval("a-old", claude.id, 250, "open_long", { gpu: "H100", month: "2026-11", dollars: 400 }, now - 2 * DAY - 15 * MIN, "expired")];
    return w;
  }

  // one and two: Claude, connected yesterday, two trades, one refusal, an over-cap request waiting
  const claude = grantRow(w, { id: "g-claude", label: "Claude", index: 1, budget: 1000, cap: 250, perDay: 5, createdAt: now - 22 * H, expiresAt: now - 22 * H + 7 * DAY });
  const h100 = hoursFor("H100", 150);
  const h200 = hoursFor("H200", 108);
  w.pockets[claude.pocket] = {
    balance: 742,
    positions: [
      position({ gpu: "H100", month: "2026-11", side: "long", q: h100, entry: NOVEMBER.H100.quote.ask, daily: false }, 1, now - 20 * H),
      position({ gpu: "H200", month: "2026-11", side: "long", q: h200, entry: NOVEMBER.H200.quote.ask, daily: false }, 2, now - 3 * H),
    ],
  };
  w.grants = [claude];
  const along = approval("a-long", claude.id, 250, "open_long", { gpu: "H100", month: "2026-11", dollars: 600 }, now + 11 * MIN, "pending", "Your plan said to hedge about 150 GPU-hours of November.");
  w.events = [
    ev(now - 22 * H, "grant.created", claude.id, { label: "Claude", budget: claude.budget, perTradeCap: claude.perTradeCap, tradesPerDay: 5, expiresAt: claude.expiresAt }),
    ev(now - 22 * H + 4_000, "grant.oauth_approved", claude.id, { client: "Claude" }),
    ev(now - 21 * H, "autopilot.started", claude.id, { orderId: "o-claude-h100", gpu: "H100", leadMinutes: 60 }, "mcp"),
    trade(now - 20 * H, claude.id, { action: "openLong", gpu: "H100", month: "2026-11", maxSpend: 150, gpuHours: h100 }),
    ev(now - 18 * H, "pocket.refused", claude.id, { action: "open_long", rule: "over_per_trade_cap", message: "$400 is over the $250 limit for one trade", args: { gpu: "H100", month: "2026-11", dollars: 400 } }, "mcp"),
    trade(now - 3 * H, claude.id, { action: "openLong", gpu: "H200", month: "2026-11", maxSpend: 108, gpuHours: h200 }),
    asked(now - 4 * MIN, along),
  ];
  w.orders = [{ id: "o-claude-h100", grantId: claude.id, gpu: "H100", kind: "roll_long", leadMinutes: 60, status: "active", createdAt: now - 21 * H, lastRunAt: now - 6 * MIN, lastResult: { skip: "nothing due" } }];
  w.approvals = [along, approval("a-old", claude.id, 250, "open_long", { gpu: "H100", month: "2026-11", dollars: 400 }, now - 2 * H, "expired")];

  if (scenario === "two") {
    const gpt = grantRow(w, { id: "g-chatgpt", label: "ChatGPT", index: 2, budget: 500, cap: 100, perDay: 3, createdAt: now - 2 * H, expiresAt: now - 2 * H + 30 * DAY });
    w.grants = [gpt, claude];
    w.pockets[gpt.pocket] = { balance: 500, positions: [] };
    const ashort = approval("a-short", gpt.id, 100, "open_short", { gpu: "H100", month: "2026-11", gpu_hours: 100, pay_me_daily: true }, now + 6 * MIN, "pending");
    const aclose = approval("a-close", claude.id, 250, "close_short", { gpu: "H100", month: "2026-11", position_ids: ["7"], max_dollars: 310 }, now + 13 * MIN, "pending");
    // an autopilot roll is a pocket trade too (it counts against the day), then its own autopilot.rolled entry
    const roll = fakeHash("roll");
    w.events.push(
      ev(now - 2 * H, "grant.created", gpt.id, { label: "ChatGPT", budget: gpt.budget, perTradeCap: gpt.perTradeCap, tradesPerDay: 3, expiresAt: gpt.expiresAt }),
      ev(now - 2 * H + 1_000, "grant.connector_issued", gpt.id, {}),
      trade(now - 50 * MIN, claude.id, { action: "rollLong", gpu: "H100", month: "2026-11", maxSpend: Math.floor(12 * NOVEMBER.H100.quote.bid * 100) / 100, gpuHours: 12, autopilot: "o-claude-h100" }, true, roll),
      ev(now - 50 * MIN, "autopilot.rolled", claude.id, { orderId: "o-claude-h100", gpu: "H100", rolled: { from: "2026-10", to: "2026-11", gpuHours: 12, held: 12 }, txHash: roll, success: true }, "autopilot"),
      asked(now - 9 * MIN, ashort),
      asked(now - 2 * MIN, aclose),
    );
    w.approvals.unshift(ashort, aclose);
  }
  return w;
}

/** An over-cap request with the summary the server keeps (mcp/server.ts approvalFor): the tool's over-cap details plus
 *  runFrom. open_long { dollars, payMeDaily, overCapBy }, open_short { gpuHours, collateral, overCapBy? },
 *  close_short { positionIds, maxDollars } (runs from the pocket). cap: the AI's per-trade limit in dollars. */
function approval(id: string, grantId: string, cap: number, action: string, params: Record<string, unknown>, expiresAt: number, status: ApprovalView["status"], note: string | null = null): ApprovalView {
  const gpu = params.gpu as MarketGpu;
  const month = params.month;
  const over = (v: number) => (v > cap ? { overCapBy: Math.round((v - cap) * 100) / 100 } : {});
  let details: Record<string, unknown>;
  if (action === "open_short") {
    const gpuHours = Number(params.gpu_hours);
    const collateral = Math.round(gpuHours * NOVEMBER[gpu].cap * 100) / 100;
    details = { action, gpu, month, gpuHours, collateral, ...over(collateral) };
  } else if (action === "close_short") {
    const maxDollars = Number(params.max_dollars);
    details = { action, gpu, month, positionIds: params.position_ids, maxDollars, ...over(maxDollars) };
  } else {
    const dollars = Number(params.dollars);
    details = { action: "open_long", gpu, month, dollars, payMeDaily: params.pay_me_daily === true, overCapBy: Math.round((dollars - cap) * 100) / 100 };
  }
  return { id, grantId, action, params, summary: { ...details, runFrom: action === "close_short" ? "pocket" : "main" }, note, status, expiresAt };
}

// ===== the world =====

/** One world per data source: example and live never share AIs, pockets or the dollars moved into them. */
const worlds: Partial<Record<string, World>> = {};

// ===== pocketNet: the dollars this world's pockets took from the example wallet (moved in, less taken back) =====
// The wallet lives in localStorage and outlasts a reload; the world does not. So the net is kept beside the wallet.
// When the world is seeded again (a reload, or another Mock row) the net moves to pocketOwed, still in localStorage,
// and stays there until AiProvider pays it into that source's loaded, signed-in wallet (takeOwed): a reseed while
// signed out, a page change or another reload before then never loses it. A render-check tab keeps its own of both.

const keyFor = (name: string) => (source: string) => `agate.${name}.${source}${isCheckTab() ? ".check" : ""}`;
const netKey = keyFor("pocketNet");
const owedKey = keyFor("pocketOwed");
const cents = (v: number) => Math.round(v * 100) / 100;

function readNum(key: string) {
  try {
    if (typeof localStorage === "undefined") return 0;
    const v = Number(localStorage.getItem(key) ?? 0);
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

function writeNum(key: string, v: number) {
  try {
    if (typeof localStorage === "undefined") return;
    if (v) localStorage.setItem(key, String(v));
    else localStorage.removeItem(key);
  } catch {}
}

const noteNet = (w: World, dollars: number) => w.source && writeNum(netKey(w.source), cents(readNum(netKey(w.source)) + dollars));

/** The dollars owed back to this source's wallet from pockets seeded away, cleared as they are handed over. */
export function takeOwed(source: string) {
  const v = readNum(owedKey(source));
  if (v) writeNum(owedKey(source), 0);
  return v;
}

/** Mock Reset: this source's world, its pockets and the dollars they hold or owe are gone with the wallet. */
export function forgetWorld(source: string) {
  delete worlds[source];
  writeNum(netKey(source), 0);
  writeNum(owedKey(source), 0);
}

/** The world for this source, person and these Mock rows; seeded again when any of them changes (or after a
 *  reload). The other source's world is kept as it was. onReseed hears that dollars are owed back (takeOwed). */
export function fakeWorld(o: { source?: string; scenario: AisScenario; main: string; email: string; connect: ConnectOutcome; disc: DisconnectOutcome; onReseed?: () => void }) {
  const source = o.source ?? "example";
  const key = `${source}|${o.scenario}|${o.main.toLowerCase()}`;
  let world = worlds[source];
  if (!world || world.key !== key) {
    // the pockets about to be seeded again took this much from the wallet (or gave it, when negative): it is owed back
    const back = readNum(netKey(source));
    if (back) {
      writeNum(owedKey(source), cents(readNum(owedKey(source)) + back));
      writeNum(netKey(source), 0);
    }
    world = seed(o.scenario, o.main, o.email, o.connect, o.disc);
    world.key = key;
    world.source = source;
    worlds[source] = world;
    if (back) o.onReseed?.();
  }
  // the outcome rows apply from the next action on, without wiping what was done
  if (world.connect !== o.connect) {
    world.connect = o.connect;
    world.failed.clear();
    world.notYetLeft = NOT_YET_ANSWERS;
    if (o.connect === "stepup") world.canDelegate = false;
  }
  if (world.disc !== o.disc) {
    world.disc = o.disc;
    world.failed.clear();
  }
  return world;
}

/** Fail once per outcome and target, so "Try again" then works. */
function failOnce(w: World, what: string, outcome: boolean) {
  if (!outcome || w.failed.has(what)) return false;
  w.failed.add(what);
  return true;
}

const viewOf = (g: GrantRow, now = Date.now()): Grant => {
  const { revokedAt: _drop, ...view } = g;
  void _drop;
  return { ...view, status: g.status === "active" && Date.parse(g.expiresAt) <= now ? "expired" : g.status };
};

/** A request still waiting ends with its time, and with its AI: a disconnect or the permission's end date. */
function approvalNow(w: World, a: ApprovalView, now = Date.now()): ApprovalView {
  if (a.status !== "pending") return a;
  const g = w.grants.find((x) => x.id === a.grantId);
  // like the server: an end date that already passed reads as ended, even if a disconnect came later
  if (g && Date.parse(g.expiresAt) <= now) return { ...a, status: "expired", result: { reason: APPROVAL_ENDED_BY.ended } };
  if (g && g.status !== "active") return { ...a, status: "expired", result: { reason: APPROVAL_ENDED_BY.disconnected } };
  return a.expiresAt <= now ? { ...a, status: "expired" } : a;
}

const json = (status: number, body: unknown) => ({ status, body });
const err = (status: number, error: string) => json(status, { error });

/** The pretend server's routes (server/src/app.ts), behind the same paths and answers. */
export function fakeTransport(getWorld: () => World): Transport {
  return async (method, path, body) => {
    const w = getWorld();
    await wait(method === "GET" ? FAKE_MS.read : FAKE_MS.write);
    const url = new URL(path, "https://agate.example");
    const p = url.pathname;
    const b = (body ?? {}) as Record<string, unknown>;
    const now = Date.now();
    const offline = w.connect === "offline";

    if (p === "/health") return offline ? { status: null, body: null } : json(200, { ok: true });
    if (p === "/.well-known/oauth-protected-resource") return json(200, { resource: "https://agate.example/mcp" });
    if (p === "/api/config") {
      // the app's liveness check reads this, so the "Connect outcome: offline" row turns it off too
      if (offline) return { status: null, body: null };
      const config: ServerConfig = { chainId: 10143, dollar: DOLLAR, routers: [ROUTER], factory: "real", shortSizingPrice: "8000000", maxGrantDays: 90, maxTradesPerDay: 50 };
      return json(200, config);
    }
    if (method === "GET" && p === "/api/me") {
      // like the server: only keys Dynamic's webhook recorded, so a made but never-delegated Assistant is not listed
      const delegations = w.assistant && (w.delegated || w.wasDelegated) ? [{ walletId: `wallet-${w.assistant.slice(2, 10)}`, address: w.assistant, status: w.delegated ? "active" : "revoked" }] : [];
      const nextPocketIndex = 1 + w.grants.reduce((m, g) => Math.max(m, g.pocketIndex), 0);
      return json(200, { userId: w.userId, email: w.email, wallets: [`wallet-${w.main.slice(2, 10)}`], delegations, grants: w.grants.map((g) => viewOf(g, now)), nextPocketIndex });
    }
    if (method === "GET" && p === "/api/grants") return json(200, w.grants.map((g) => viewOf(g, now)));
    if (method === "POST" && p === "/api/grants") {
      const r = b as unknown as GrantRequest;
      const notYet = "the AI's trading key is not delegated to agate yet: try again in a few seconds";
      if (!w.delegated) return err(409, notYet);
      if (w.connect === "notyet" && w.notYetLeft > 0) {
        w.notYetLeft -= 1;
        return err(409, notYet);
      }
      if (failOnce(w, "refused", w.connect === "refused")) return err(403, "the signed permission does not match the limits asked for");
      // grants.ts: the Assistant must be this person's own wallet
      if (!w.assistant || String(r.assistantAddress ?? "").toLowerCase() !== w.assistant.toLowerCase()) return err(403, "these wallets are not yours");
      if (w.grants.some((g) => g.pocketIndex === r.pocketIndex && g.status === "active")) return err(409, `pocket_in_use: pocket ${r.pocketIndex} already serves another AI`);
      const id = `g-${r.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${now.toString(36)}`;
      const g: GrantRow = {
        id,
        label: r.label,
        status: "active",
        pocket: pocketAddressOf(w.main, r.pocketIndex),
        mainAccount: w.main,
        assistant: r.assistantAddress,
        budget: r.budget,
        perTradeCap: r.perTradeCap,
        pocketIndex: r.pocketIndex,
        tradesPerDay: r.tradesPerDay,
        expiresAt: new Date(r.validUntil * 1000).toISOString(),
        createdAt: new Date(now).toISOString(),
        revokedAt: null,
      };
      w.grants.unshift(g);
      w.events.push(ev(now, "grant.created", id, { label: g.label, pocket: g.pocket, budget: g.budget, perTradeCap: g.perTradeCap, tradesPerDay: g.tradesPerDay, expiresAt: g.expiresAt }));
      return json(201, viewOf(g, now));
    }
    const grantAct = p.match(/^\/api\/grants\/([^/]+)\/(disconnect|connector)$/);
    if (method === "POST" && grantAct) {
      const g = w.grants.find((x) => x.id === decodeURIComponent(grantAct[1]));
      if (!g) return err(404, "no such AI connection");
      if (grantAct[2] === "connector") {
        if (g.status !== "active") return err(404, "no such live AI connection");
        const url = `https://agate.example/c/${fakeAddress(`${g.id}:${now}`).slice(2, 26)}/mcp`;
        w.events.push(ev(now, "grant.connector_issued", g.id, {}));
        return json(200, { url, claudeCode: `claude mcp add --transport http agate ${url}`, note: "Treat this URL like a password: anyone with it can use this AI connection." });
      }
      if (failOnce(w, `stop:${g.id}`, w.disc === "stopfail")) return { status: null, body: null };
      g.status = "revoked";
      g.revokedAt = now;
      for (const o of w.orders) if (o.grantId === g.id && o.status === "active") o.status = "stopped";
      // its requests still waiting end with it: nothing can be approved for an AI that is disconnected
      const ended = Date.parse(g.expiresAt) <= now;
      const reason = ended ? APPROVAL_ENDED_BY.ended : APPROVAL_ENDED_BY.disconnected;
      for (const a of w.approvals) if (a.grantId === g.id && a.status === "pending") w.events.push(ev(now, "approval.expired", g.id, { requestId: a.id, reason }));
      w.approvals = w.approvals.map((a) => (a.grantId === g.id && a.status === "pending" ? { ...a, status: "expired", result: { reason } } : a));
      w.events.push(ev(now, "grant.disconnected", g.id, { label: g.label }));
      return json(200, viewOf(g, now));
    }
    const req = p.match(/^\/api\/oauth\/requests\/([^/]+)(?:\/(approve|deny))?$/);
    if (req) {
      const rid = decodeURIComponent(req[1]);
      const row = requestRow(w, rid, now);
      if (!row || Date.parse(row.req.expiresAt) <= now) return err(404, "this request expired or belongs to someone else");
      if (!req[2]) return json(200, row.req);
      if (req[2] === "deny") {
        delete w.requests[rid];
        w.requests[`used:${rid}`] = row;
        return json(200, { redirect: `${row.redirectUri}?error=access_denied&state=example` });
      }
      const g = w.grants.find((x) => x.id === b.grantId);
      if (!g || g.status !== "active" || Date.parse(g.expiresAt) <= now) return err(409, "connect the AI first (no live connection with that id)");
      delete w.requests[rid];
      w.requests[`used:${rid}`] = row;
      w.events.push(ev(now, "grant.oauth_approved", g.id, { client: row.req.clientName }));
      return json(200, { redirect: `${row.redirectUri}?code=${fakeAddress(rid).slice(2, 34)}&state=example` });
    }
    if (method === "GET" && p === "/api/approvals") return json(200, w.approvals.map((a) => approvalNow(w, a, now)));
    const settle = p.match(/^\/api\/approvals\/([^/]+)\/(deny|done|failed)$/);
    if (method === "POST" && settle) {
      const i = w.approvals.findIndex((a) => a.id === decodeURIComponent(settle[1]));
      if (i < 0) return err(404, "no such approval");
      const a = approvalNow(w, w.approvals[i], now);
      const status = settle[2] === "deny" ? "denied" : (settle[2] as "done" | "failed");
      const late = a.status === "expired" && status !== "denied" && now < a.expiresAt + 15 * MIN;
      if (a.status !== "pending" && a.status !== "approved" && !late) return err(409, `this approval is ${a.status}`);
      w.approvals[i] = { ...a, status };
      w.events.push(ev(now, `approval.${status}`, a.grantId, { requestId: a.id, ...(status === "done" ? { txHash: b.txHash ?? null } : status === "failed" ? { reason: b.reason ?? "" } : {}) }));
      return json(200, w.approvals[i]);
    }
    if (method === "GET" && p === "/api/activity") {
      const grantId = url.searchParams.get("grantId");
      if (grantId && !w.grants.some((g) => g.id === grantId)) return err(404, "no such AI connection");
      const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 100));
      const list = w.events.filter((e) => !grantId || e.grantId === grantId).sort((x, y) => y.at - x.at);
      return json(200, list.slice(0, limit));
    }
    if (p === "/api/standing-orders") {
      if (method === "GET") {
        const grantId = url.searchParams.get("grantId");
        return json(200, w.orders.filter((o) => !grantId || o.grantId === grantId).sort((x, y) => y.createdAt - x.createdAt));
      }
      const g = w.grants.find((x) => x.id === b.grantId);
      if (!g || g.status !== "active" || Date.parse(g.expiresAt) <= now) return err(404, "no such live AI connection");
      const gpu = String(b.gpu ?? "");
      if (!["H100", "H200", "B200", "B300", "A100", "L40S"].includes(gpu)) return err(400, "gpu must be one of H100, H200, B200, B300, A100, L40S");
      const lead = typeof b.leadMinutes === "number" ? b.leadMinutes : 60;
      const existing = w.orders.find((o) => o.grantId === g.id && o.gpu === gpu && o.status === "active");
      if (existing) return json(200, existing);
      const o: StandingOrder = { id: `o-${g.id}-${gpu}-${now.toString(36)}`, grantId: g.id, gpu, kind: "roll_long", leadMinutes: lead, status: "active", createdAt: now, lastRunAt: null, lastResult: null };
      w.orders.push(o);
      w.events.push(ev(now, "autopilot.started", g.id, { orderId: o.id, gpu, leadMinutes: lead }));
      return json(201, o);
    }
    const stop = p.match(/^\/api\/standing-orders\/([^/]+)\/stop$/);
    if (method === "POST" && stop) {
      const o = w.orders.find((x) => x.id === decodeURIComponent(stop[1]));
      if (!o) return err(404, "no such autopilot order");
      o.status = "stopped";
      w.events.push(ev(now, "autopilot.stopped", o.grantId, { orderId: o.id, gpu: o.gpu, by: "person" }));
      return json(200, o);
    }
    return err(404, "not found");
  };
}

/** The pretend OAuth requests: any id is Claude asking from claude.ai, made on first read and good for 15 minutes.
 *  A few ids show the other cases: chatgpt, cursor, lookalike (a look-alike host), soon (under 2 minutes left),
 *  ended (gone). */
function requestRow(w: World, id: string, now: number): RequestRow | null {
  if (id === "ended" || id.startsWith("used:")) return null;
  if (w.requests[id]) return w.requests[id];
  if (w.requests[`used:${id}`]) return null;
  const who: Record<string, [string, string]> = { chatgpt: ["ChatGPT", "chatgpt.com"], cursor: ["Cursor", "cursor.com"], lookalike: ["Claude", "claude-connect.app"] };
  const [clientName, redirectHost] = who[id] ?? ["Claude", "claude.ai"];
  const life = id === "soon" ? 100_000 : 15 * MIN;
  const row: RequestRow = { req: { requestId: id, clientName, redirectHost, expiresAt: new Date(now + life).toISOString() }, redirectUri: `https://${redirectHost}/api/mcp/auth_callback` };
  w.requests[id] = row;
  return row;
}

/** The request ran out while Allow was running (the "expired" connect outcome). */
export function expireRequest(w: World, id: string) {
  const row = w.requests[id];
  if (row) row.req = { ...row.req, expiresAt: new Date(Date.now() - 1).toISOString() };
}

// ===== the pocket chain: getWallet(pocket) and the transfers in and out =====

export interface PocketRead {
  balance: number;
  positions: Position[];
}

export const fakeChain = {
  async pocket(w: World, pocket: string): Promise<PocketRead> {
    await wait(FAKE_MS.read);
    const p = w.pockets[pocket] ?? { balance: 0, positions: [] };
    return { balance: p.balance, positions: [...p.positions] };
  },
  /** fundPocketCalls from the main account; fails once under the "fundfail" connect outcome */
  async fund(w: World, pocket: string, dollars: number) {
    await wait(FAKE_MS.funding);
    if (failOnce(w, `fund:${pocket}`, w.connect === "fundfail")) throw new Error("UserOperationReverted: the funding operation did not land");
    const p = (w.pockets[pocket] ??= { balance: 0, positions: [] });
    p.balance = Math.round((p.balance + dollars) * 100) / 100;
    noteNet(w, dollars);
  },
  /** the main wallet, as the pocket's owner, sends the pocket's dollars home; fails once under "takebackfail" */
  async takeBack(w: World, pocket: string): Promise<number> {
    await wait(FAKE_MS.takeBack);
    if (failOnce(w, `back:${pocket}`, w.disc === "takebackfail")) throw new Error("UserOperationReverted: the transfer did not land");
    const p = w.pockets[pocket];
    const amount = p?.balance ?? 0;
    if (p) p.balance = 0;
    noteNet(w, -amount);
    return amount;
  },
};

// ===== the trading key: @agate/wallet's Assistant calls =====

export class StepUpNeeded extends Error {
  constructor() {
    super("the wallet:delegate scope has lapsed: confirm with a fresh code");
    this.name = "StepUpNeeded";
  }
}

export const fakeKey = {
  /** what the run needs to know before anything moves */
  state: (w: World) => ({ hasAssistant: !!w.assistant, address: w.assistant, delegated: w.delegated, canDelegate: w.canDelegate }),
  async ensureAssistant(w: World) {
    await wait(FAKE_MS.assistant);
    w.assistant ??= fakeAddress(`${w.main}:assistant`);
    return w.assistant;
  },
  async delegate(w: World) {
    await wait(FAKE_MS.delegate);
    if (!w.canDelegate) throw new StepUpNeeded();
    w.delegated = true;
    w.wasDelegated = true;
    w.events.push(ev(Date.now(), "wallet.delegation.created", null, {}, "dynamic"));
  },
  /** example accounts have no real passkey: a code, always */
  async stepUpSend(): Promise<"code" | "passkey"> {
    await wait(FAKE_MS.code);
    return "code";
  },
  async stepUpPasskey(w: World) {
    await wait(FAKE_MS.code);
    w.canDelegate = true;
  },
  /** any 6 digits confirm, as in the example sign-in */
  async stepUpVerify(w: World, code: string) {
    await wait(FAKE_MS.code);
    if (!/^\d{6}$/.test(code)) throw Object.assign(new Error("wrong_email_verification_token"), { name: "APIError" });
    w.canDelegate = true;
  },
  /** createPocketPermission: one signature by the main wallet; answers the pocket and its balance now */
  async signPermission(w: World, index: number) {
    await wait(FAKE_MS.permission);
    const pocket = pocketAddressOf(w.main, index);
    return { pocket, approval: `example-approval-${index}`, pocketBalance: w.pockets[pocket]?.balance ?? 0 };
  },
  /** revokeAssistant: Dynamic stops the key signing for every pocket; a later connect needs a fresh code */
  async revoke(w: World) {
    await wait(FAKE_MS.revoke);
    w.delegated = false;
    w.canDelegate = false;
    w.events.push(ev(Date.now(), "wallet.delegation.revoked", null, {}, "dynamic"));
  },
};

export type FakeWorld = World;
