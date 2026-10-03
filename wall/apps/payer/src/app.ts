// The payer and lister wired over one runtime (BOTS-SPEC 4): one key, one nonce stream, one MON budget. A tick reads
// chain time (never the local clock, 2.2), freezes the day's budget, lists first (a month that is not listed cannot
// trade at all, 4.2), then pays.
import { join } from "node:path";
import { Heartbeat } from "@agate/watcher";
import type { PayerConfig } from "./config.ts";
import { type ListerGas, Lister, type ListerReport } from "./lister.ts";
import { Budget, type FactoryEntry, firstBlock, type LimitTable, MarketScanner, MarketSender, monToWei, type Runtime } from "@agate/market";
import { Payer, type PayerReport } from "./payer.ts";
import { Positions } from "./positions.ts";
import { StateStore } from "./state.ts";

export class AppError extends Error {}

export type Log = (event: string, data: Record<string, unknown>) => void;

export function jsonLine(o: unknown): string {
  return JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export interface AppOptions {
  now: () => number;
  log?: Log;
  stopping?: () => boolean;
  /** AGATE_MARKET_LOG_CHUNK */
  logChunk?: number;
  /** ms between two eth_getLogs chunks of one catch-up (audit P-M2; default SCAN_PACE_MS) */
  scanPaceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

export interface TickReport {
  t: bigint;
  balanceWei: bigint;
  lister?: ListerReport;
  payer?: PayerReport;
}

export interface PayerApp {
  rt: Runtime;
  config: PayerConfig;
  factories: FactoryEntry[];
  budget: Budget;
  sender: MarketSender;
  state: StateStore;
  scanner: MarketScanner;
  positions: Positions;
  lister: Lister;
  payer: Payer;
  heartbeat: Heartbeat;
  tickS: number;
  log: Log;
  tick(which?: { lister?: boolean; payer?: boolean }): Promise<TickReport>;
}

/** A catch-up of up to 500 chunks stays near 10 eth_getLogs a second (Alchemy's per-second budget, audit P-M2). */
export const SCAN_PACE_MS = 100;

/** Wei one listing needs at a fee: list then createMarket, each ceil(1.2 x (LIMIT + 21,000 + calldata)) (P-L2), or
 *  the gas limit the sender last planned for it when that is more (recheck R1-H1: the claims leave the lister only this
 *  much plus what one tick of pacing frees, so a reserve below one send's planned cost would never let it through). */
export function listingCostWei(limits: LimitTable, maxFeePerGas: bigint, seen?: Partial<ListerGas>): bigint {
  const one = (limit: number, calldata: number, s = 0n) => {
    const table = (BigInt(limit + 21_000 + calldata) * 6n + 4n) / 5n;
    return s > table ? s : table;
  };
  return (one(limits.limitFor("factory.list"), 1_200, seen?.list) + one(limits.limitFor("factory.createMarket"), 700, seen?.createMarket)) * maxFeePerGas;
}

/** Whether the claims keep one listing's cost back after this lister pass (P-L2, recheck R1-H1): the lister owes a
 *  list or a createMarket, or a factory's pass failed (what it owes is unknown). */
export function listerOwes(rep: ListerReport): boolean {
  return rep.owed.length > 0 || rep.errors > 0;
}

export function selectFactories(rt: Runtime, config: PayerConfig): FactoryEntry[] {
  const names = config.factories ?? Object.keys(rt.deployments.factories);
  return names.map((n) => {
    const f = rt.deployments.factories[n];
    if (!f) throw new AppError(`AGATE_PAYER_CONFIG.factories names ${n}, which the deployments file does not have`);
    return f;
  });
}

export async function buildApp(rt: Runtime, config: PayerConfig, o: AppOptions): Promise<PayerApp> {
  const log: Log = o.log ?? ((event, data) => console.log(jsonLine({ t: o.now(), role: rt.role, event, ...data })));
  const factories = selectFactories(rt, config);
  const budget = new Budget({ dir: rt.dir, role: rt.role, keepWei: monToWei(config.keepMon), lowBalanceWei: monToWei(config.lowBalanceMon), runUntil: config.runUntil, alerts: rt.alerts, lowCode: "PAYER_KEY_LOW", spentCode: "PAYER_BUDGET_SPENT", address: rt.from });
  const sender = new MarketSender({
    pool: rt.pool,
    role: rt.role,
    ...(rt.keyVar ? { keyEnv: rt.keyVar } : {}),
    from: rt.from,
    dryRun: rt.dryRun,
    limits: rt.limits,
    alerts: rt.alerts,
    maxFeeGwei: rt.maxFeeGwei,
    guard: budget,
    lock: rt.sendLock,
    now: o.now,
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
    log,
  });
  const scanner = new MarketScanner({ pool: rt.pool, dir: rt.dir, fromBlock: firstBlock(rt.deployments, factories.map((f) => f.name)), factories: factories.map((f) => f.factory), chainId: rt.pool.chainId, chunk: o.logChunk ?? config.logChunk, paceMs: o.scanPaceMs ?? SCAN_PACE_MS, log });
  // the state belongs to the scan's chain, start block and factory set (P-M3)
  const state = new StateStore(rt.dir, scanner.identity);
  if (state.resetWhy) log("state_reset", { why: state.resetWhy });
  const positions = new Positions(factories);
  const stopping = o.stopping ?? (() => false);
  const lister = new Lister({ reads: rt.reads, sender, factories, state, alerts: rt.alerts, log, stopping });
  // P-L2, as fixed by recheck R1-H1: while the lister owes anything (a month of its window not listed, for whatever
  // reason, including a ready month whose list the budget refused; a listed series of a Kuru factory without its
  // market; or a factory whose pass failed), the claims leave one listing's cost to the lister, until it lands
  let owes = false;
  const reserveWei = (fee: bigint) => (owes ? listingCostWei(rt.limits, fee, lister.gasSeen) : 0n);
  // a dry run needs no MON and must not move the day's alerts (BOTS-SPEC 2.3 step 7): no budget cut, no BUDGET_SPENT
  const payer = new Payer({ reads: rt.reads, sender, scanner, positions, state, limits: rt.limits, config, ...(rt.dryRun ? {} : { budget }), reserveWei, alerts: rt.alerts, log, stopping });
  const heartbeat = new Heartbeat(join(rt.dir, "heartbeat.json"), rt.role, "market");
  let tickS = config.tickS;
  if (tickS === null) {
    const days = await Promise.all([...new Set(factories.map((f) => f.index))].map(async (ix) => (await rt.reads.indexClocks(ix)).day));
    tickS = Math.min(300, Math.max(10, Math.floor(Math.min(...days) / 20)));
  }
  const app: PayerApp = {
    rt,
    config,
    factories,
    budget,
    sender,
    state,
    scanner,
    positions,
    lister,
    payer,
    heartbeat,
    tickS,
    log,
    async tick(which = {}) {
      await rt.pool.tick(o.now());
      const t = await rt.reads.blockTime();
      const balanceWei = await rt.reads.monBalance(rt.from);
      // a dry run never ticks the budget: that would write and freeze today's budget file in the real bot's directory
      // (a real start the same UTC day reloads it, at 0 from an unfunded key) and raise PAYER_KEY_LOW (review finding)
      if (!rt.dryRun) budget.tick(t, balanceWei);
      const rep: TickReport = { t, balanceWei };
      if ((which.lister ?? true) && config.lister) {
        rep.lister = await lister.tick(t);
        owes = listerOwes(rep.lister);
      }
      if ((which.payer ?? true) && config.payer && !stopping()) rep.payer = await payer.tick(t);
      const d = budget.today;
      heartbeat.beat(o.now(), jsonLine({ t, listed: rep.lister?.listed.length ?? 0, created: rep.lister?.created.length ?? 0, claimed: rep.payer?.paidIds ?? 0, spentWei: d?.spentWei ?? 0n, budgetWei: d?.budgetWei ?? 0n }));
      return rep;
    },
  };
  return app;
}
