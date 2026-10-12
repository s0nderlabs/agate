// Labeled test trader: keeps the November books moving until outside traders arrive. In each market of the month it
// reads when the market last traded (the indexer) and its own last trade (its state file): when nothing has traded
// for an hour it makes one trade at the maker's price, buying $10 to $20 when it holds under $2 and selling what it
// holds (up to $20) when it holds more, so its position stays near zero. It never trades while the indexer cannot be
// read or lags the chain, since it would then be trading blind.
//
//   ops/testnet/test-trader.sh [--month 2026-11] [--markets H100,H200,B200]        the launcher (restarts on a crash)
//   AGATE_TEST_TRADER_KEY_CMD='security find-generic-password -s agate.test.user -a private-key -w' \
//     bun run scripts/test-trader.ts [--month 2026-11] [--markets H100,H200,B200] [--dry-run] [--once]
//
// Daily caps (00:00 UTC): 72 trades and $1,000 of volume, buys and sales alike. A MON floor of 11 stops it before its
// gas runs out. One live run per key at a time (the same pid lock the live check uses), and nothing while a send of
// its key is still pending. A send whose outcome is unknown is counted against the caps, ends the pass and holds every
// send for UNCERTAIN_WAIT_MIN; a book wider than MAX_SPREAD_PCT (a stray order at the top) is not traded. Logs one
// JSON line per market per pass; trades also go to ~/.agate-test-trader/trades.jsonl. Exit 0 is a stop (Ctrl-C), 2 a
// refusal that needs an operator (a bad option, the key command, a state file it cannot read or write), anything else
// a crash.
//
// The wallet is 0x14fB2CE8Fb6d7016e4E416bE7E58ca028Cc2C84a (Keychain agate.test.user). It is Agate's own address, named
// as such in docs/site/16-limits.md, so its trades are never counted as outside traders'.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createWalletClient, formatEther, http, type Address } from "viem";
import { accountFromCommand, GateError, LockHeld, LOCK_DIR, lockName, takeLock } from "../e2e/testnet.ts";
import { graphql, Q } from "../src/graphql.ts";
import { abi, buyLong, createAgateClient, type Gpu, type MarketGpu, PUBLIC_RPC, sellLong, WriteError, type WriteResult, type RoutedResult } from "../src/index.ts";
import { dollarsOf, hoursOf, LOT, U } from "../src/units.ts";

const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
/** A refusal an operator must fix: the launcher stops on exit 2 instead of starting it again. */
const refuse = (msg: string): never => {
  console.error(msg);
  process.exit(2);
};

export const MONTH_GPUS: MarketGpu[] = ["H100", "H200", "B200"];
export const IDLE_MIN = 60;
export const MIN_DOLLARS = 10;
export const MAX_DOLLARS = 20;
export const DAILY_TRADES = 72;
export const DAILY_VOLUME = 1000;
export const MON_FLOOR = 11;
export const DUST_DOLLARS = 2;
/** the maker quotes about 2% wide; a top of book wider than this is someone else's stray order, not the maker's price */
export const MAX_SPREAD_PCT = 10;
/** after a send whose outcome is unknown, nothing more is signed for this long (whatever the RPC says is pending) */
export const UNCERTAIN_WAIT_MIN = 15;
/** the indexer is trusted only this close to the chain head (Monad makes ~2 blocks a second: about 2.5 minutes) */
const LAG_BLOCKS = 300n;
const STATE_DIR = join(homedir(), ".agate-test-trader");
const STATE_FILE = join(STATE_DIR, "state.json");
const TRADES_FILE = join(STATE_DIR, "trades.jsonl");
const GRAPHQL = "https://agate-1.tailf06dd7.ts.net:8443/v1/graphql";

const argv = process.argv.slice(2);
const flag = (name: string, def: string): string => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) refuse(`--${name} needs a value`);
  argv.splice(i, 2);
  return v!;
};
const bool = (name: string): boolean => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};

/** The command line, read once from run() (never at import: a test imports this module). */
function config() {
  const month = flag("month", "2026-11");
  const markets = flag("markets", MONTH_GPUS.join(",")).split(",") as MarketGpu[];
  const dryRun = bool("dry-run");
  const once = bool("once");
  const tickSec = Number(flag("tick-sec", "300"));
  if (argv.length > 0) refuse(`unknown argument: ${argv[0]}`);
  for (const m of markets) if (!MONTH_GPUS.includes(m)) refuse(`unknown market GPU ${m} (one of ${MONTH_GPUS.join(", ")}; the other GPUs have a price and no market)`);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) refuse(`--month must be YYYY-MM, not ${month}`);
  if (!Number.isFinite(tickSec) || tickSec < 10) refuse(`--tick-sec must be 10 or more, not ${tickSec}`);
  return { month, markets, dryRun, once, tickSec };
}

export interface DayState {
  day: string;
  trades: number;
  volume: number;
  /** each market's last trade by this bot (ms): kept across days, it is the hour gate when the indexer is slow */
  lastTrade: Record<string, number>;
  /** when a send whose outcome is unknown last happened (ms), kept across days */
  uncertainAt?: number;
}

const todayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The day's counters, reset at 00:00 UTC; the per-market last trades carry over. */
export function rollDay(s: DayState, nowMs: number): DayState {
  return s.day === todayOf(nowMs) ? s : { ...s, day: todayOf(nowMs), trades: 0, volume: 0 };
}

function loadState(nowMs: number): DayState {
  if (!existsSync(STATE_FILE)) return { day: todayOf(nowMs), trades: 0, volume: 0, lastTrade: {} };
  let s: DayState | null = null;
  try {
    s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as DayState;
  } catch {
    // a torn or corrupt file must never read as "nothing traded today": the daily caps would start again
    return refuse(`${STATE_FILE} cannot be read: move it aside to start the day's counts again (they are not reset silently)`);
  }
  if (!s || typeof s.day !== "string" || typeof s.trades !== "number" || typeof s.volume !== "number" || typeof s.lastTrade !== "object" || s.lastTrade === null) {
    return refuse(`${STATE_FILE} is not a state file: move it aside to start the day's counts again`);
  }
  return rollDay(s, nowMs);
}

/** Written through a temporary file and renamed, so a stop mid-write cannot leave half a state file. */
function saveState(s: DayState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 1));
  renameSync(tmp, STATE_FILE);
}

export interface MarketView {
  gpu: Gpu;
  /** token base units in the wallet, exactly as the token holds them */
  held: bigint;
  /** when the market last traded, in ms; null when it has never traded (a month listed with no fill yet) */
  lastTradeAt: number | null;
  /** the best bid and ask in u per GPU-hour, exactly as the book holds them; 0n for an empty side */
  bid: bigint;
  ask: bigint;
}

export interface Plan {
  action: "skip" | "buy" | "sell";
  reason: string;
  dollars?: number;
  /** a sale's size in token base units, a whole number of lots */
  units?: bigint;
  /** the price bound the write gets, in u per GPU-hour: the best ask for a buy, the best bid for a sale */
  maxPrice?: bigint;
  minPrice?: bigint;
}

/** The sale size: what it holds, floored to whole lots, and no more than MAX_DOLLARS at the bid (u). Exact. */
export function saleUnits(held: bigint, bid: bigint): bigint {
  const lots = (x: bigint) => x - (x % LOT);
  const most = bid > 0n ? lots((BigInt(MAX_DOLLARS) * U * U) / bid) : 0n;
  const all = lots(held);
  return all < most ? all : most;
}

/** One market, one pass: buy, sell, or skip with the reason. Pure but for `rand` (the buy's size), so the tests can
 *  pin it. `lastTradeAt` is null for a month that has never traded: that is idle, and the first trade is made. */
export function decide(m: MarketView, day: DayState, nowMs: number, rand: () => number): Plan {
  if (day.trades >= DAILY_TRADES) return { action: "skip", reason: `daily trade cap (${DAILY_TRADES})` };
  if (day.volume >= DAILY_VOLUME) return { action: "skip", reason: `daily volume cap ($${DAILY_VOLUME})` };
  if (m.lastTradeAt !== null) {
    const idleSec = (nowMs - m.lastTradeAt) / 1000;
    if (idleSec < IDLE_MIN * 60) return { action: "skip", reason: `traded ${Math.round(idleSec / 60)}m ago (wait ${IDLE_MIN}m)` };
  }
  // a top of book far wider than the maker's quotes is a stray order: neither bought from nor sold to
  if (m.bid > 0n && m.ask > 0n && (m.ask - m.bid) * 100n > m.ask * BigInt(MAX_SPREAD_PCT)) return { action: "skip", reason: `book wider than ${MAX_SPREAD_PCT}% (bid $${dollarsOf(m.bid)}, ask $${dollarsOf(m.ask)})` };
  // a sale needs only bids, a buy only asks; a holding is valued at the higher side, so a low (or missing) bid never
  // makes it look like dust to buy more on top of
  const worth = (m.held * (m.ask > m.bid ? m.ask : m.bid)) / U;
  if (worth >= BigInt(DUST_DOLLARS) * U) {
    if (m.bid === 0n) return { action: "skip", reason: "no bid to sell to" };
    const units = saleUnits(m.held, m.bid);
    if (units === 0n) return { action: "skip", reason: "holds less than one lot" };
    const value = dollarsOf((units * m.bid) / U);
    if (day.volume + value > DAILY_VOLUME) return { action: "skip", reason: `volume cap ($${day.volume.toFixed(2)} + $${value.toFixed(2)} > $${DAILY_VOLUME})` };
    return { action: "sell", reason: `holds ${hoursOf(m.held)} GPU-hours`, units, minPrice: m.bid };
  }
  if (m.ask === 0n) return { action: "skip", reason: "no ask to buy from" };
  // whole dollars, $10 to $20 inclusive (rand is in [0, 1))
  const dollars = MIN_DOLLARS + Math.floor(rand() * (MAX_DOLLARS - MIN_DOLLARS + 1));
  if (day.volume + dollars > DAILY_VOLUME) return { action: "skip", reason: `volume cap ($${day.volume.toFixed(2)} + $${dollars} > $${DAILY_VOLUME})` };
  return { action: "buy", reason: `holds under $${DUST_DOLLARS}`, dollars, maxPrice: m.ask };
}

/** Whether a failed write may have sent something. The client throws a WriteError from its first send on (a refused
 *  wallet, a missing receipt, a step after an earlier one landed: stage send or receipt, or landed txs), so anything
 *  else (a check, the simulation or the gas estimate, a read before the write, an amount refused) sent nothing. */
export function maySent(e: unknown): boolean {
  return e instanceof WriteError && (e.txs.length > 0 || e.stage === "send" || e.stage === "receipt");
}

/** A plan as a log line (bigints as GPU-hours and dollars). */
const shown = (p: Plan) => ({ ...p, units: p.units === undefined ? undefined : hoursOf(p.units), maxPrice: p.maxPrice === undefined ? undefined : dollarsOf(p.maxPrice), minPrice: p.minPrice === undefined ? undefined : dollarsOf(p.minPrice) });

/** Counts a trade (or a send that may have landed) against the caps and saves it before anything more is signed. A
 *  state it cannot save stops the trader (exit 2): the next pass would read the old counts and the caps would not hold.
 *  The trades file is only a log: a failed append is reported and the trader goes on. */
function book(state: DayState, gpu: string, dollars: number, line: Record<string, unknown>, uncertain: boolean): void {
  state.trades += 1;
  state.volume += dollars;
  state.lastTrade[gpu] = Date.now();
  if (uncertain) state.uncertainAt = Date.now();
  try {
    saveState(state);
  } catch (e) {
    refuse(`${STATE_FILE} cannot be written (${(e as Error).message}): stopped so the daily caps hold; the trade is in the log above`);
  }
  try {
    appendFileSync(TRADES_FILE, `${JSON.stringify(line)}\n`);
  } catch (e) {
    console.log(JSON.stringify({ event: "trades_file_error", error: String(e).slice(0, 200) }));
  }
}

async function run(): Promise<void> {
  const { month: MONTH, markets: MARKETS, dryRun: DRY_RUN, once: ONCE, tickSec: TICK_SEC } = config();
  const keyCmd = process.env.AGATE_TEST_TRADER_KEY_CMD ?? "";
  if (!keyCmd) refuse("AGATE_TEST_TRADER_KEY_CMD is required");
  let account: ReturnType<typeof accountFromCommand>;
  try {
    account = accountFromCommand(keyCmd, process.env);
  } catch (e) {
    // the shared reader names the live check's variable; this bot's is AGATE_TEST_TRADER_KEY_CMD
    if (e instanceof GateError) return refuse(e.message.replaceAll("AGATE_E2E_KEY_CMD", "AGATE_TEST_TRADER_KEY_CMD"));
    throw e;
  }
  const user = account.address.toLowerCase() as Address;
  const c = createAgateClient({ graphqlUrl: GRAPHQL });
  const gql = graphql(GRAPHQL);
  const w = createWalletClient({ account, chain: c.chain, transport: http(PUBLIC_RPC) });
  console.log(JSON.stringify({ event: "start", address: user, month: MONTH, markets: MARKETS, dryRun: DRY_RUN, once: ONCE }));

  // a stop finishes the trade in progress and saves it (Ctrl-C, a kill, a closed terminal)
  let stop = false;
  const onSignal = (how: string) => () => {
    console.log(JSON.stringify({ event: how }));
    stop = true;
  };
  process.on("SIGINT", onSignal("interrupt"));
  process.on("SIGTERM", onSignal("terminate"));
  process.on("SIGHUP", onSignal("hangup"));
  const nap = async (sec: number) => {
    for (let waited = 0; waited < sec && !stop; waited += 5) await new Promise((r) => setTimeout(r, 5_000));
  };

  // a dry run sends nothing, so it takes no lock: it must stay usable while the trader runs (and while the live
  // check holds the same key). A real run takes the same per-key lock, so no two runs sign with one key.
  let release: () => void = () => {};
  while (!DRY_RUN && !stop) {
    try {
      release = takeLock(LOCK_DIR, lockName(user, PUBLIC_RPC, false));
      break;
    } catch (e) {
      // held by another run of this key, or lost a takeover race with one: wait (only a lock it cannot make stops it)
      if (!(e instanceof LockHeld) && !(e instanceof GateError && /changed hands/.test(e.message))) throw e;
      console.log(JSON.stringify({ event: "lock_held", note: "another run of this key (the live check, or a second trader): trying again in 60 s" }));
      if (ONCE) return;
      await nap(60);
    }
  }
  if (stop) return;

  /** One pass. The MON floor, a pending send, an unreadable or lagging indexer stop it before any market; a send
   *  whose outcome is unknown stops it after that market (counted against the caps). */
  const tick = async (): Promise<void> => {
    const nowMs = Date.now();
    const state = loadState(nowMs);
    if (state.uncertainAt !== undefined && nowMs - state.uncertainAt < UNCERTAIN_WAIT_MIN * 60_000) {
      console.log(JSON.stringify({ event: "uncertain_wait", since: new Date(state.uncertainAt).toISOString(), minutes: UNCERTAIN_WAIT_MIN }));
      return;
    }
    const [wei, pending, latest, head] = await Promise.all([c.pub.getBalance({ address: user }), c.pub.getTransactionCount({ address: user, blockTag: "pending" }), c.pub.getTransactionCount({ address: user, blockTag: "latest" }), c.pub.getBlockNumber()]);
    const mon = Number(formatEther(wei));
    if (mon < MON_FLOOR) {
      console.log(JSON.stringify({ event: "low_mon", mon, floor: MON_FLOOR }));
      return;
    }
    if (pending > latest) {
      console.log(JSON.stringify({ event: "pending_tx", pending, latest }));
      return;
    }
    const listed = await Promise.all(MARKETS.map((gpu) => c.listedAt(gpu, MONTH)));
    const series = listed.filter((s) => s !== null).map((s) => s.terms.series.toLowerCase());
    let lastAt: Map<string, number | null>;
    try {
      const r = await gql.query<{ PricePoint: { id: string; lastTradeAt: string | null }[]; chain_metadata: { latest_processed_block: number }[] }>(Q.lastTradesHead, { series });
      const at = BigInt(r.chain_metadata[0]?.latest_processed_block ?? 0);
      if (head - at > LAG_BLOCKS) {
        console.log(JSON.stringify({ event: "indexer_behind", indexerBlock: at.toString(), head: head.toString() }));
        return;
      }
      lastAt = new Map(r.PricePoint.map((p) => [p.id.toLowerCase(), p.lastTradeAt ? Number(p.lastTradeAt) * 1000 : null]));
    } catch (e) {
      // trading blind is the one thing it must not do: a market's last trade it cannot read stops the pass
      console.log(JSON.stringify({ event: "indexer_down", error: String(e).slice(0, 200) }));
      return;
    }

    // every market's holding in one parallel round (a failed read skips only its market)
    const holdings = await Promise.all(listed.map((s) => (s ? (c.pub.readContract({ address: s.terms.token, abi: abi.agateTokenAbi as never, functionName: "balanceOf", args: [user] }) as Promise<bigint>).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))) : null)));

    for (const [i, gpu] of MARKETS.entries()) {
      if (stop) return;
      const s = listed[i];
      if (!s) {
        console.log(JSON.stringify({ event: "not_listed", gpu, month: MONTH }));
        continue;
      }
      if (!s.market || !s.book) {
        console.log(JSON.stringify({ event: "no_book", gpu, month: MONTH }));
        continue;
      }
      // a series the indexer has no row for is not "never traded": it cannot tell, so the market is skipped
      if (!lastAt.has(s.terms.series.toLowerCase())) {
        console.log(JSON.stringify({ event: "not_indexed", gpu, month: MONTH, series: s.terms.series }));
        continue;
      }
      const mine = state.lastTrade[gpu] ?? null;
      const indexed = lastAt.get(s.terms.series.toLowerCase()) ?? null;
      const lastTradeAt = indexed === null ? mine : mine === null ? indexed : Math.max(indexed, mine);
      const held = holdings[i];
      if (held instanceof Error) {
        console.log(JSON.stringify({ event: "error", gpu, stage: "read", error: String(held).slice(0, 300) }));
        continue;
      }
      const view: MarketView = { gpu, held: held!, lastTradeAt, bid: s.book.bids[0]?.[0] ?? 0n, ask: s.book.asks[0]?.[0] ?? 0n };
      const plan = decide(view, state, nowMs, Math.random);
      console.log(JSON.stringify({ event: "tick", gpu, held: hoursOf(view.held), lastTradeAt: lastTradeAt === null ? "never" : new Date(lastTradeAt).toISOString(), bid: dollarsOf(view.bid), ask: dollarsOf(view.ask), plan: shown(plan) }));
      if (plan.action === "skip") continue;
      if (DRY_RUN) {
        console.log(JSON.stringify({ event: "dry_run", gpu }));
        continue;
      }
      const planned = plan.action === "buy" ? plan.dollars! : dollarsOf((plan.units! * plan.minPrice!) / U);
      let result: WriteResult<RoutedResult>;
      try {
        if (plan.action === "buy") result = await buyLong(c, w, { gpu, month: MONTH, dollars: String(plan.dollars!), maxPrice: plan.maxPrice! });
        else result = await sellLong(c, w, { gpu, month: MONTH, gpuHours: plan.units!, minPrice: plan.minPrice! });
      } catch (e) {
        const sent = maySent(e);
        const hash = e instanceof WriteError ? (e.hash ?? null) : null;
        console.log(JSON.stringify({ event: "error", gpu, stage: e instanceof WriteError ? e.stage : "unknown", maySent: sent, hash, error: String(e).slice(0, 300) }));
        if (!sent) continue;
        // it may have landed: count it against the caps and the hour gate, and sign nothing more for a while
        book(state, gpu, planned, { ts: new Date().toISOString(), gpu, action: plan.action, dollars: planned, hash, uncertain: true }, true);
        return;
      }
      const vol = plan.action === "buy" ? result.result.spent : result.result.received;
      const trade = { ts: new Date().toISOString(), gpu, action: plan.action, dollars: vol, hash: result.hash };
      console.log(JSON.stringify({ event: "trade", ...trade, gpuHours: result.result.gpuHours, avgPrice: result.result.avgPrice }));
      book(state, gpu, vol, trade, false);
    }
  };

  while (!stop) {
    try {
      await tick();
    } catch (e) {
      console.log(JSON.stringify({ event: "tick_error", error: String(e).slice(0, 300) }));
    }
    if (ONCE) break;
    await nap(TICK_SEC);
  }
  release();
  console.log(JSON.stringify({ event: "stopped" }));
}

if (import.meta.main) run().catch((e) => (e instanceof GateError ? refuse(e.message) : fail(String(e))));
