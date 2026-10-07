// What the AI screens say about a connection, its activity and an over-cap request: plain words from the server's
// shapes (api.ts). Pure, so the live server's answers read exactly like the pretend one's. Times in UTC.
import { monthLong, whenText } from "@/lib/data/derive";
import { usd0 } from "@/lib/format";
import { showHours } from "@/lib/size";
import { fromU, summaryDollars, type ActivityEvent, type Grant } from "./api";
import { autopilotText, refusedText, type AutopilotResult } from "./errors";
import { APPROVAL_ENDED_BY, type ApprovalView } from "./machine";

/** Where a connection stands on screen: the server says expired only on its next read, so the end date counts too. */
export type GrantState = "active" | "ended" | "disconnected";

export function grantState(g: Grant, now = Date.now()): GrantState {
  if (g.status === "revoked") return "disconnected";
  if (g.status === "expired" || Date.parse(g.expiresAt) <= now) return "ended";
  return "active";
}

export const isLive = (g: Grant, now = Date.now()) => grantState(g, now) === "active";

/** The limits in dollars. */
export const limitsOf = (g: Grant) => ({ budget: fromU(g.budget), perTradeCap: fromU(g.perTradeCap), tradesPerDay: g.tradesPerDay });

/** When it was disconnected: the grant.disconnected event's time (the connection itself does not keep it). */
export function disconnectedAt(g: Grant, events: ActivityEvent[] | undefined) {
  const e = events?.find((x) => x.grantId === g.id && x.name === "grant.disconnected");
  return e ? new Date(e.at).toISOString() : null;
}

/** "Connected", "Ended Oct 11, 14:02 UTC" or "Disconnected Oct 6, 10:15 UTC". */
export function statusText(g: Grant, events: ActivityEvent[] | undefined, now = Date.now()) {
  const st = grantState(g, now);
  if (st === "active") return "Connected";
  if (st === "ended") return `Ended ${whenText(g.expiresAt)}`;
  const at = disconnectedAt(g, events);
  return at ? `Disconnected ${whenText(at)}` : "Disconnected";
}

/** Every pocket.trade counts against "trades a day", landed or not, as the server counts them (store.tradesSince).
 *  An autopilot roll goes through the same path, so its pocket.trade is what counts, never autopilot.rolled. */
const isTrade = (e: ActivityEvent) => e.name === "pocket.trade";

/** Trades counted against "trades a day": the AI's own and the autopilot's rolls, over the last 24 hours. */
export function tradesIn24h(grantId: string, events: ActivityEvent[] | undefined, now = Date.now()) {
  return (events ?? []).filter((e) => e.grantId === grantId && now - e.at < 86_400_000 && isTrade(e)).length;
}

/** A pocket.trade's or approval's summary: the server nests it under detail.summary. */
export function summaryOf(d: Record<string, unknown>): Record<string, unknown> {
  return d.summary && typeof d.summary === "object" ? (d.summary as Record<string, unknown>) : {};
}

const OPENS = new Set(["openLong", "openLongDaily", "openShort"]);

/** Dollars its trades took from the pocket (the opens' most-spend from the server's trade summaries). */
export function spentOf(grantId: string, events: ActivityEvent[] | undefined): number | null {
  if (!events) return null;
  let sum = 0;
  for (const e of events) {
    if (e.grantId !== grantId || e.name !== "pocket.trade" || e.detail.success === false) continue;
    const s = summaryOf(e.detail);
    if (!OPENS.has(String(s.action))) continue;
    sum += summaryDollars(s.maxSpend) ?? 0;
  }
  return sum;
}

/** "November", or "" for a month the app cannot read. */
const month = (m: unknown) => (typeof m === "string" && monthLong(m)) || "";
const words = (...parts: string[]) => parts.filter(Boolean).join(" ");

/** "Long H100 November" from a trade summary or an MCP tool's arguments. */
export function tradeWhat(action: string, gpu: unknown, m: unknown, daily = false) {
  const g = typeof gpu === "string" ? gpu : "";
  const mo = month(m);
  switch (action) {
    case "openLong":
    case "open_long":
      return `${words("Long", g, mo)}${daily ? ", pay me daily" : ""}`;
    case "openLongDaily":
    case "open_long_daily":
      return `${words("Long", g, mo)}, pay me daily`;
    case "openShort":
    case "open_short":
      return words("Short", g, mo);
    case "closeLong":
    case "close_long":
      return words("Sold", g, mo);
    case "closeLongDaily":
    case "close_long_daily":
      return `${words("Closed its", g, mo)} Long`;
    case "closeShort":
    case "close_short":
      return `${words("Closed its", g, mo)} Short`;
    case "rollLong":
    case "roll_long":
      return `${words("Moved its", g)} Long into ${mo || "the next month"}`;
    case "drip":
      return "Took the day's free test dollars";
    default:
      return g || mo ? `A ${words(g, mo)} trade` : "A trade";
  }
}

/** The dollars an over-cap request is about, from the server's approval summary (the over-cap details plus runFrom):
 *  a Short's collateral, a Long's dollars, a buy-back's most dollars; maxSpend last, for any other shape. */
export function approvalDollars(a: { action: string; params?: Record<string, unknown>; summary?: Record<string, unknown> | null }): number | null {
  const p = a.params ?? {};
  const s = a.summary ?? {};
  const pos = (v: number | null) => (v !== null && v > 0 ? v : null);
  let v: number | null = null;
  if (a.action === "open_short") v = summaryDollars(s.collateral);
  else if (a.action === "open_long" || a.action === "open_long_daily") v = typeof p.dollars === "number" ? p.dollars : summaryDollars(s.dollars);
  else if (a.action === "close_short") v = summaryDollars(s.maxDollars);
  return pos(v) ?? pos(summaryDollars(s.maxSpend));
}

/** One activity row: the sentence, an amount on the right, the transaction for an Explorer link. Null: not shown. */
export interface ActivityLine {
  text: string;
  amount?: number;
  txHash?: string;
  /** a refusal or a failure: the line reads as one */
  quiet?: boolean;
}

export function activityLine(e: ActivityEvent, ai: string): ActivityLine | null {
  const d = e.detail;
  const tx = typeof d.txHash === "string" && d.txHash ? d.txHash : undefined;
  switch (e.name) {
    case "grant.created": {
      const budget = fromU(d.budget as string);
      return { text: budget > 0 ? `Connected. ${usd0(budget)} moved into the pocket.` : "Connected." };
    }
    case "grant.oauth_approved":
      return { text: `Allowed in from ${typeof d.client === "string" && d.client ? d.client : "its app"}.` };
    case "grant.disconnected":
      return { text: "Disconnected by you." };
    case "pocket.trade": {
      const s = summaryOf(d);
      // an autopilot roll: its autopilot.rolled (or autopilot.error) entry tells it, once
      if (s.autopilot) return null;
      const what = tradeWhat(String(s.action), s.gpu, s.month);
      if (d.landed === false || (tx === undefined && d.success === undefined)) return { text: `${what}: sent, not seen landing yet.` };
      if (d.success === false) return { text: "A trade didn't go through on Monad. Nothing changed.", txHash: tx, quiet: true };
      // a roll's maxSpend is its sale's least proceeds, not money spent
      const amount = s.action === "rollLong" ? null : summaryDollars(s.maxSpend);
      return { text: what, amount: amount && amount > 0 ? amount : undefined, txHash: tx };
    }
    case "pocket.refused":
      return { text: refusedText(typeof d.rule === "string" ? d.rule : null, ai), quiet: true };
    case "pocket.error":
      return { text: "A trade ran into a problem before it was sent. Nothing changed.", quiet: true };
    case "approval.requested": {
      // detail: { requestId, action (the MCP tool's), summary: the over-cap details plus runFrom, note }
      const s = summaryOf(d);
      const action = String(d.action ?? s.action);
      const amount = approvalDollars({ action, summary: s });
      // what it asks for, not what it did: "Close its H100 November Short"
      const what = action === "close_short" ? `${words("Close its", typeof s.gpu === "string" ? s.gpu : "", month(s.month))} Short` : tradeWhat(action, s.gpu, s.month, s.payMeDaily === true);
      return { text: `${ai} asked to go over its limit: ${what}.`, amount: amount ?? undefined };
    }
    case "approval.done":
      return { text: "You approved a trade over its limit. It ran from your account.", txHash: tx };
    case "approval.denied":
      return { text: "You declined a trade over its limit." };
    case "approval.expired":
      return {
        text: d.reason === APPROVAL_ENDED_BY.disconnected ? `A request to go over its limit ended when ${ai} was disconnected.` : d.reason === APPROVAL_ENDED_BY.ended ? `A request to go over its limit ended with ${ai}'s permission.` : "A request to go over its limit ended unanswered.",
        quiet: true,
      };
    case "approval.failed":
      return { text: "A trade over its limit that you approved didn't go through. Nothing changed.", quiet: true };
    case "autopilot.started":
      return { text: `Keep my hedge going started for ${d.gpu}.` };
    case "autopilot.stopped":
      return { text: d.by === "ai" ? `${ai} stopped keeping its ${d.gpu} hedge going.` : `Keep my hedge going stopped for ${d.gpu}.` };
    case "autopilot.rolled":
      // the roll landed but reverted (the server still logs it as rolled, with success false)
      if (d.success === false) return { text: `Keep my hedge going, ${d.gpu}: a move into the next month didn't go through on Monad. Nothing changed.`, txHash: tx, quiet: true };
    // falls through
    case "autopilot.skipped":
    case "autopilot.refused":
    case "autopilot.error": {
      const r = autopilotOf(d);
      if (!r) return null;
      return { text: `Keep my hedge going, ${d.gpu}: ${autopilotText(r)}`, txHash: tx, quiet: e.name !== "autopilot.rolled" };
    }
    case "wallet.delegation.revoked":
      return { text: "Its trading key was switched off with Dynamic." };
    default:
      return null;
  }
}

/** A standing order's result from an autopilot event's detail. */
function autopilotOf(d: Record<string, unknown>): AutopilotResult | null {
  if (d.rolled && typeof d.rolled === "object") return { rolled: d.rolled as { from: string; to: string; gpuHours: number }, txHash: typeof d.txHash === "string" ? d.txHash : undefined };
  if (typeof d.refused === "string") return { refused: d.refused, detail: typeof d.detail === "string" ? d.detail : undefined };
  if (typeof d.skip === "string") return { skip: d.skip };
  if (typeof d.error === "string") return { error: d.error };
  return null;
}

/** What an over-cap request asks for: "Long H100 November, $600" or "Short H100 November, 100 GPU-hours ($800 up
 *  front)". Null for what the app cannot read. */
export function approvalWhat(a: ApprovalView): { what: string; dollars: number | null; gpuHours: number | null } {
  const p = a.params;
  const s = a.summary;
  const daily = p.pay_me_daily === true || a.action === "open_long_daily";
  const gpu = typeof p.gpu === "string" ? p.gpu : "";
  const dollars = approvalDollars(a);
  if (a.action === "open_short") {
    const hours = typeof p.gpu_hours === "number" ? p.gpu_hours : typeof s.gpuHours === "number" ? s.gpuHours : null;
    return { what: `${words("Short", gpu, month(p.month))}, ${hours !== null ? `${showHours(hours)} GPU-hours` : "some GPU-hours"}${dollars ? ` (${usd0(dollars)} up front)` : ""}`, dollars, gpuHours: hours };
  }
  if (a.action === "close_short") return { what: `${words("Close its", gpu, month(p.month))} Short`, dollars, gpuHours: null };
  const hours = typeof s.gpuHours === "number" ? s.gpuHours : null;
  return { what: `${tradeWhat(a.action, p.gpu, p.month, daily)}${dollars !== null ? `, ${usd0(dollars)}` : ""}`, dollars, gpuHours: hours };
}

/** "11:20" until an ms time, or null once it has passed. */
export function clock(at: number, now: number) {
  const s = Math.ceil((at - now) / 1000);
  if (s <= 0) return null;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A short address: "0xF77c...6B70". */
export const shortAddress = (a: string | null | undefined) => (a && a.length > 12 ? `${a.slice(0, 6)}...${a.slice(-4)}` : (a ?? ""));

/** Monad's test-network explorer. */
export const explorerAddress = (a: string) => `https://testnet.monadexplorer.com/address/${a}`;
export const explorerTx = (h: string) => `https://testnet.monadexplorer.com/tx/${h}`;

/** Schemes that run script in this page or read local data: an AI app's return address with one is never opened. */
const UNSAFE_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "file:", "blob:", "about:"]);

/** An AI app's return address (OAuth redirect_uri from Agate's server), if it is safe to open from this page: http(s)
 *  and an app's own scheme (cursor://, vscode://) pass; one that would run script here (javascript:, data: ...) or does
 *  not parse is refused. The URL parser lowercases the scheme and drops the tabs and spaces that could hide it. */
export function safeReturn(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return UNSAFE_SCHEMES.has(new URL(url).protocol.toLowerCase()) ? null : url;
  } catch {
    return null;
  }
}
