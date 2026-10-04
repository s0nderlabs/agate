// An AI company's own agent on agate: it rents GPUs, so it hedges its next month's GPU-hours with agate's Long.
// Its wallet is a Dynamic server wallet (TSS-MPC, 2-of-2 with Dynamic) that owns a Kernel smart account, so every
// trade is a sponsored user operation the wallet signs once. One rule, kept on purpose:
//   keep TARGET GPU-hours of GPU's next open month; buy the shortfall in parts of at most MAX dollars, only while the
//   best ask is at or under CEILING dollars a GPU-hour.
// Every decision goes to a journal (JSON lines) with the transaction hash the chain returned, never an invented one.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { type Abi, type Address, parseAbi, type PublicClient } from "viem";
import { type AgateClient, type Gpu, planBuyLong, planDrip, readResult, WriteError } from "@agate/client";
import { accountClient, kernelAccount, zerodev } from "@agate/wallet";
import { HOME, requireSecret } from "../config.ts";
import { serverWalletAccount } from "../dynamic/serverWallet.ts";
import type { Store } from "../store.ts";

export type HedgeRule = {
  gpu: Gpu;
  /** GPU-hours to hold of the next open month */
  target: number;
  /** dollars per trade at most */
  maxPerTrade: number;
  /** dollars per GPU-hour: never buy above this */
  ceiling: number;
  /** a month closing sooner than this is skipped (minutes) */
  minMinutesLeft?: number;
};

export type Decision = { at: string; agent: Address; rule: HedgeRule; month?: string; held?: number; ask?: number | null; action: "hedged" | "bought" | "dripped" | "waiting"; reason: string; txHash?: string; result?: Record<string, unknown> };

const balanceAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]) as Abi;
export const journalFile = () => join(HOME, "company-agent.jsonl");

/** The agent's account: the Kernel account (index 0) of its Dynamic server wallet, gas sponsored. */
export async function agentAccount(store: Store, label: string, pc: PublicClient, log?: (e: Record<string, unknown>) => void) {
  const account = await kernelAccount(pc, serverWalletAccount(store, label, log));
  return { account, client: accountClient(account, pc, zerodev(requireSecret("ZERODEV_RPC", "zerodev.env"))) };
}

/** One look at the market and at most one transaction. A refusal from agate's checks (price moved, thin book, the
 *  faucet not open yet) is journaled as "waiting" with its reason; anything else throws. */
export async function hedgeStep(store: Store, label: string, c: AgateClient, rule: HedgeRule, opts: { journal?: boolean; log?: (e: Record<string, unknown>) => void; now?: number } = {}): Promise<Decision> {
  try {
    return await hedgeStepInner(store, label, c, rule, opts);
  } catch (e) {
    if (!(e instanceof WriteError) && (e as Error)?.name !== "WriteError") throw e;
    const d: Decision = { at: new Date(opts.now ?? Date.now()).toISOString(), agent: (await agentAccount(store, label, c.pub as PublicClient)).account.address, rule, action: "waiting", reason: `${(e as WriteError).reason ?? "refused"}: ${(e as Error).message.slice(0, 200)}` };
    if (opts.journal !== false) appendFileSync(journalFile(), JSON.stringify(d) + "\n", { mode: 0o600 });
    return d;
  }
}

async function hedgeStepInner(store: Store, label: string, c: AgateClient, rule: HedgeRule, opts: { journal?: boolean; log?: (e: Record<string, unknown>) => void; now?: number } = {}): Promise<Decision> {
  const now = opts.now ?? Date.now();
  const { account, client } = await agentAccount(store, label, c.pub as PublicClient, opts.log);
  const me = account.address;
  const base = { at: new Date(now).toISOString(), agent: me, rule };
  const done = (d: Decision) => {
    if (opts.journal !== false) appendFileSync(journalFile(), JSON.stringify(d) + "\n", { mode: 0o600 });
    return d;
  };

  const m = await c.getMarket(rule.gpu);
  const minLeft = (rule.minMinutesLeft ?? 60) * 60_000;
  const s = m.series.filter((x) => (x.phase === "trading" || x.phase === "paying") && Date.parse(x.closesAt) - now > minLeft).sort((a, b) => a.month.localeCompare(b.month))[0];
  if (!s) return done({ ...base, action: "waiting", reason: `no ${rule.gpu} month open long enough` });
  const terms = (await c.seriesAt(rule.gpu, s.month)).terms;
  const held = Number((await c.pub.readContract({ address: terms.token, abi: balanceAbi, functionName: "balanceOf", args: [me] })) as bigint) / 1e6;
  const ask = s.quote?.ask ?? null;
  const at = { month: s.month, held, ask };
  if (held >= rule.target) return done({ ...base, ...at, action: "hedged", reason: `holds ${held} of ${rule.target} GPU-hours` });
  if (!ask || ask <= 0) return done({ ...base, ...at, action: "waiting", reason: "no ask to buy from" });
  if (ask > rule.ceiling) return done({ ...base, ...at, action: "waiting", reason: `ask ${ask} is above the ceiling ${rule.ceiling}` });

  const want = Math.min(rule.maxPerTrade, Math.ceil((rule.target - held) * ask * 1.02 * 100) / 100);
  // the chain, not the indexer: right after a drip the indexer can still show the old balance
  const dollars = Number((await c.pub.readContract({ address: c.dollar, abi: balanceAbi, functionName: "balanceOf", args: [me] })) as bigint) / 1e6;
  if (dollars < want) {
    // its own test dollars first (the faucet), in a sponsored operation like any other
    const plan = await planDrip(c, me);
    const r = await client.waitForUserOperationReceipt({ hash: await client.sendUserOperation({ calls: plan.calls.map(({ to, value, data }) => ({ to, value, data })) }), timeout: 120_000 });
    return done({ ...base, ...at, action: "dripped", reason: `had $${dollars}, needs $${want}`, txHash: r.receipt.transactionHash, result: readResult(c, "drip", r.logs) });
  }
  const plan = await planBuyLong(c, me, { gpu: rule.gpu, month: s.month, dollars: String(want), maxPrice: String(rule.ceiling) });
  const r = await client.waitForUserOperationReceipt({ hash: await client.sendUserOperation({ calls: plan.calls.map(({ to, value, data }) => ({ to, value, data })) }), timeout: 120_000 });
  if (!r.success) return done({ ...base, ...at, action: "waiting", reason: "the operation reverted", txHash: r.receipt.transactionHash });
  return done({ ...base, ...at, action: "bought", reason: `${held} of ${rule.target} GPU-hours held; bought with $${want}`, txHash: r.receipt.transactionHash, result: readResult(c, "openLong", r.logs) });
}
