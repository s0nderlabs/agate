// Autopilot: standing orders the server runs for an AI connection. "Keep my hedge going" (kind roll_long) rolls the
// pocket's Long of one GPU into the next listed month when the month it holds closes within `leadMinutes`, through
// the same path an AI's roll_long call takes (the plan, the allowed-call list, the Assistant's signature, the onchain
// session key). It counts against the connection's daily trades and stays under the per-trade cap by rolling in
// parts, one part per tick.
import { type Abi, type Address, parseAbi } from "viem";
import { type AgateClient, type Gpu, planRollLong } from "@agate/client";
import { dailyLimitRefusal, pocketTrade } from "./grants.ts";
import { serial } from "./serial.ts";
import type { GrantRow, StandingOrderRow, Store } from "./store.ts";

/** below this a held month is left alone (rolling dust costs more in spread than it moves) */
export const MIN_ROLL_HOURS = 0.1;
/** a part's proceeds stay this far under the cap, so a better fill than the best bid still fits */
const CAP_SLACK = 0.95;

export type AutopilotDeps = {
  store: Store;
  client: () => AgateClient;
  log?: (e: Record<string, unknown>) => void;
  /** test seams */
  trade?: typeof pocketTrade;
  now?: () => number;
};

export type RollDue = { from: string; to: string; gpuHours: number; held: number } | { skip: string };

const balanceAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]) as Abi;

/** What a roll_long order should do now for a pocket: roll `gpuHours` of `from` into `to`, or skip (and why). */
export async function rollDue(c: AgateClient, pocket: Address, gpu: Gpu, leadMinutes: number, capDollars: number, now: number): Promise<RollDue> {
  const m = await c.getMarket(gpu);
  const open = m.series.filter((s) => (s.phase === "trading" || s.phase === "paying") && Date.parse(s.closesAt) > now).sort((a, b) => a.month.localeCompare(b.month));
  for (const s of open) {
    const closes = Date.parse(s.closesAt);
    if (closes - now > leadMinutes * 60_000) continue;
    const terms = (await c.seriesAt(gpu, s.month)).terms;
    const held = Number((await c.pub.readContract({ address: terms.token, abi: balanceAbi, functionName: "balanceOf", args: [pocket] })) as bigint) / 1e6;
    if (held < MIN_ROLL_HOURS) continue;
    // the next month that will still be open after this lead window, so the rolled hedge is not due again at once
    const to = open.find((x) => x.month > s.month && Date.parse(x.closesAt) - now > leadMinutes * 60_000);
    if (!to) return { skip: `${gpu} ${s.month} closes soon but no later month is listed yet` };
    const bid = s.quote?.bid ?? 0;
    if (!(bid > 0)) return { skip: `${gpu} ${s.month} has no bid to sell into` };
    const perPart = Math.floor(((capDollars * CAP_SLACK) / bid) * 1e4) / 1e4;
    const gpuHours = Math.min(Math.floor(held * 1e4) / 1e4, perPart);
    if (gpuHours < MIN_ROLL_HOURS) return { skip: `the per-trade cap ($${capDollars}) is below one useful part at ${bid}` };
    return { from: s.month, to: to.month, gpuHours, held };
  }
  return { skip: "nothing due" };
}

/** One pass over the active orders (the server runs it every minute). Returns what each order did. */
export async function runAutopilot(d: AutopilotDeps): Promise<{ orderId: string; result: Record<string, unknown> }[]> {
  const now = d.now ?? Date.now;
  const doTrade = d.trade ?? pocketTrade;
  const out: { orderId: string; result: Record<string, unknown> }[] = [];
  for (const o of d.store.standingOrdersOf({ status: "active" })) {
    const g = d.store.grant(o.grantId);
    const record = (result: Record<string, unknown>, event?: string) => {
      d.store.setStandingOrder(o.id, { lastRunAt: now(), lastResult: result });
      if (event) d.store.event({ source: "autopilot", name: event, userId: o.userId, grantId: o.grantId, detail: { orderId: o.id, gpu: o.gpu, ...result } });
      out.push({ orderId: o.id, result });
    };
    if (!g || g.status !== "active" || g.expiresAt <= now()) {
      d.store.setStandingOrder(o.id, { status: "stopped" });
      record({ stopped: "the AI connection is no longer live" }, "autopilot.stopped");
      continue;
    }
    try {
      const r = await runOrder(d, o, g, doTrade, now);
      record(r.result, r.event);
    } catch (e) {
      record({ error: (e as Error).message.slice(0, 300) }, "autopilot.error");
    }
  }
  return out;
}

async function runOrder(d: AutopilotDeps, o: StandingOrderRow, g: GrantRow, doTrade: typeof pocketTrade, now: () => number): Promise<{ result: Record<string, unknown>; event?: string }> {
  const c = d.client();
  const due = await rollDue(c, g.pocket as Address, o.gpu as Gpu, o.leadMinutes, Number(g.perTradeCap) / 1e6, now());
  if ("skip" in due) {
    // a skip is recorded on the order; only a change of reason becomes an activity entry
    const changed = (o.lastResult as { skip?: string } | null)?.skip !== due.skip;
    return { result: { skip: due.skip }, ...(changed && due.skip !== "nothing due" ? { event: "autopilot.skipped" } : {}) };
  }
  return serial(g.id, async () => {
    const daily = dailyLimitRefusal(d.store, g, now());
    if (daily) return { result: { skip: `daily_limit: ${daily.detail}`, due }, event: "autopilot.skipped" };
    const plan = await planRollLong(c, g.pocket as Address, { gpu: o.gpu as Gpu, fromMonth: due.from, toMonth: due.to, gpuHours: String(due.gpuHours) });
    const r = await doTrade(d.store, g, plan.calls.map(({ to, value, data }) => ({ to, value, data })), d.log, undefined, { summary: { ...plan.summary, autopilot: o.id } });
    if ("refused" in r) return { result: { refused: r.refused, detail: r.detail, due }, event: "autopilot.refused" };
    return { result: { rolled: due, txHash: r.receipt.receipt.transactionHash, success: r.receipt.success }, event: "autopilot.rolled" };
  });
}

/** Starts the minute loop; runs never overlap. */
export function startAutopilot(d: AutopilotDeps, everyMs = 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const done = await runAutopilot(d);
      for (const x of done) if (!("skip" in x.result) || (x.result as { skip: string }).skip !== "nothing due") d.log?.({ event: "autopilot.tick", ...x });
    } catch (e) {
      d.log?.({ event: "autopilot.failed", error: (e as Error).message.slice(0, 300) });
    } finally {
      running = false;
    }
  };
  const t = setInterval(tick, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}
