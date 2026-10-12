// The market maker's process (BOTS-SPEC 2.7, 3.8): bun run src/main.ts <command>
//   run (default)       loop forever: a tick every tickS of local time, at once on a websocket wake or a CLI request
//   status              the heartbeat, open MM_ alerts, the budget day and the state summary; sends nothing
//   kill [reason]       the KILL file; cancels within one tick (now, when no maker process runs)
//   unkill              removes it (also clears a loss kill: the limit re-arms maxLossU under the value then)
//   cancel-all          cancels every book once without killing; the next tick requotes
//   (with no maker process running, a request runs one tick here that places nothing: the next `run` quotes)
//   withdraw-all        with the kill switch on: every token and the dollar out of Kuru's MarginAccount
//   rebase              the loss baseline := the value now (after a float top-up)
// Env: AGATE_KEY_CMD (run by this process at start, the key held in memory only: audit M-K1; `kill` with it works
// while no maker runs) or, for tests, AGATE_MM_KEY (moved into memory at start), AGATE_RPC_URLS_CMD or
// AGATE_RPC_URLS, AGATE_CHAIN_ID, AGATE_DEPLOYMENTS, AGATE_MM_CONFIG, AGATE_WALL_HOME, AGATE_NOTIFY_CMD,
// AGATE_MAX_FEE_GWEI, AGATE_MARKET_GAS_LIMITS, AGATE_DRY_RUN=1 with AGATE_MM_ADDRESS.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RpcMeter } from "@agate/report/meter";
import { AlertSink, Heartbeat, LockHeld, type RpcPool, scrubText, Waker, wallHome, writeAtomic, WsWake, wsPreferFromEnv } from "@agate/watcher";
import { bootstrap, Budget, MarketSender, sessionFromEnv } from "@agate/market";
import { loadConfig, tickSeconds } from "./config.ts";
import { MarketMaker, ROLE, type Request } from "./mm.ts";

const now = () => Math.floor(Date.now() / 1000);
const KEY_VAR = "AGATE_MM_KEY";
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export function marketDir(home = wallHome()): string {
  return join(home, "market", ROLE);
}

function say(event: string, data: Record<string, unknown> = {}): void {
  console.log(scrubText(JSON.stringify({ t: now(), role: ROLE, event, ...data }, big)));
}

interface Booted {
  mm: MarketMaker;
  pool: RpcPool;
  ws: string[];
  lockFd: number | null;
  meter?: RpcMeter;
}

async function boot(): Promise<Booted> {
  // the shared bootstrap (BOTS-SPEC 2.1, 2.2, 2.5): the key into memory first (holdKey), the RPC list and the URL
  // scrubber, one process per role (LockHeld), the alert sink, the pool on the expected chain, the deployments file
  // read fail closed (the maker needs Kuru's margin account), MarketReads batched through Multicall3, the LIMIT table
  const rt = await bootstrap({ role: ROLE, keyVar: KEY_VAR, addressVar: "AGATE_MM_ADDRESS", now, marginAccount: "required" });
  const config = loadConfig(process.env.AGATE_MM_CONFIG);
  // no alerts on the budget itself: the maker raises MM_KEY_LOW and MM_BUDGET_SPENT (once a day) from its tick. A dry
  // run has none: it needs no MON, and a budget file it froze from an unfunded key would hold the real run the same
  // UTC day at 0 (review finding, Oct 3)
  const session = sessionFromEnv(process.env, "AGATE_MM");
  const budget = rt.dryRun ? undefined : new Budget({ dir: rt.dir, role: ROLE, keepWei: config.keepWei, lowBalanceWei: config.lowBalanceWei, runUntil: config.runUntil, lowCode: "MM_KEY_LOW", spentCode: "MM_BUDGET_SPENT", address: rt.from, headStartS: config.headStartS, ...(session ? { session } : {}) });
  let mm: MarketMaker | null = null;
  const sender = new MarketSender({
    pool: rt.pool,
    ...(rt.send ? { send: rt.send } : {}),
    role: ROLE,
    ...(rt.keyVar ? { keyEnv: rt.keyVar } : {}),
    from: rt.from,
    dryRun: rt.dryRun,
    limits: rt.limits,
    alerts: rt.alerts,
    maxFeeGwei: rt.maxFeeGwei,
    guard: { canSpend: (c, safety) => mm!.canSpend(c, safety), record: (c, safety) => mm!.record(c, safety) },
    lock: rt.sendLock,
    now,
    log: say,
  });
  mm = new MarketMaker({ reads: rt.reads, sender, deployments: rt.deployments, config, dir: rt.dir, alerts: rt.alerts, ...(budget ? { budget } : {}), dryRun: rt.dryRun, nowMs: () => Date.now(), log: say, heartbeat: new Heartbeat(join(rt.dir, "heartbeat.json"), ROLE, "-") });
  say("started", { maker: sender.from, dryRun: rt.dryRun, sessionMon: budget?.o.session ? Number(budget.o.session.wei) / 1e18 : 0, sessionUntil: budget?.o.session?.until ?? null, chainId: rt.pool.chainId, rpc: rt.pool.redactedUrls(), send: rt.send?.redactedUrls() ?? [], factories: config.factories.filter((f) => rt.deployments.factories[f]), gasLimits: process.env.AGATE_MARKET_GAS_LIMITS ? "AGATE_MARKET_GAS_LIMITS" : "the Foundry table (Ethereum prices; the testnet deploy sets AGATE_MARKET_GAS_LIMITS from Monad)" });
  return { mm, pool: rt.pool, ws: rt.endpoints.ws, lockFd: rt.lockFd, ...(rt.meter ? { meter: rt.meter } : {}) };
}

async function run(): Promise<void> {
  const b = await boot();
  const { mm, pool } = b;
  const waker = new Waker();
  let stopping = false;
  const stop = () => {
    stopping = true;
    mm.stop(); // the send in flight finishes; nothing new is sent
    waker.wake();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const dir = mm.d.dir;
  const watched = ["KILL", "UNKILL", "CANCEL_ALL", "WITHDRAW_ALL", "REBASE"];
  let lastSeen = "";
  const poll = setInterval(() => {
    const seen = watched.filter((f) => existsSync(join(dir, f))).join(",");
    if (seen !== lastSeen) {
      lastSeen = seen;
      waker.wake();
    }
  }, 1_000);
  const wakes = new Map<string, WsWake>();
  const days: number[] = [];
  for (const name of mm.d.config.factories) {
    const e = mm.d.deployments.factories[name];
    if (e) days.push((await mm.d.reads.indexClocks(e.index)).day);
  }
  const tickS = tickSeconds(mm.d.config, days);
  const prefer = wsPreferFromEnv(process.env);
  say("loop", { tickS });
  while (!stopping) {
    await pool.tick(now());
    try {
      const rep = await mm.tick();
      if (rep.sends.length > 0 || rep.killed) say("tick", { sends: rep.sends.length, killed: rep.killed, pnl: rep.pnl });
    } catch (e) {
      say("tick_error", { error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    }
    // websocket wake-ups: one subscription per book the maker quotes (hints only; the tick reads over HTTP)
    if (b.ws.length > 0) {
      const want = new Set([...Object.keys(mm.state.quoted), ...Object.keys(mm.state.orders)]);
      for (const m of want) {
        if (wakes.has(m)) continue;
        const w = new WsWake({ urls: b.ws, address: m, kinds: ["logs"], onWake: () => waker.wake(), alerts: mm.d.alerts as AlertSink, role: ROLE, log: say, prefer, ...(b.meter ? { meter: b.meter } : {}) });
        w.start();
        wakes.set(m, w);
      }
      for (const [m, w] of wakes) {
        if (!want.has(m)) {
          w.stop();
          wakes.delete(m);
        } else w.tick();
      }
    }
    if (!stopping) await waker.wait(tickS * 1000);
  }
  clearInterval(poll);
  for (const w of wakes.values()) w.stop();
  say("stopped");
}

/** A CLI request: the file for the running process; when none runs (the lock is free), one tick here that places,
 *  mints and deposits nothing (cancels, wind-down and the state requests only): this process exits right after, and a
 *  ladder nobody requotes could be picked off once fair moves (review finding, Oct 3). The next `run` quotes. */
async function request(name: Request | "KILL", body: string): Promise<void> {
  const dir = marketDir();
  writeAtomic(join(dir, name), body);
  if (name === "UNKILL") rmSync(join(dir, "KILL"), { force: true });
  let b: Booted;
  try {
    b = await boot();
  } catch (e) {
    if (e instanceof LockHeld) {
      say("request_queued", { request: name, note: "the running maker acts on it within one tick" });
      return;
    }
    say("request_queued", { request: name, note: `no maker process could start here (${e instanceof Error ? e.message.split("\n")[0] : String(e)}); the next start acts on it` });
    return;
  }
  const rep = await b.mm.tick({ oneShot: true });
  say("request_done", { request: name, sends: rep.sends, killed: rep.killed, note: "one tick, no quotes placed: start `run` to quote" });
}

function status(): void {
  const home = wallHome();
  const dir = marketDir(home);
  const read = (p: string) => {
    try {
      return JSON.parse(readFileSync(p, "utf8")) as unknown;
    } catch {
      return null;
    }
  };
  const alerts = new AlertSink(join(home, "alerts", "alerts.jsonl"), { now, print: false });
  const codes = /^(MM_|GAS_CAP|NONCE_STUCK|RPC_)/;
  const budgets = existsSync(dir) ? readdirSync(dir).filter((f) => /^budget-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : [];
  const state = read(join(dir, "state.json")) as { orders?: Record<string, unknown[]>; series?: Record<string, unknown>; baseline?: string; killed?: unknown } | null;
  console.log(
    JSON.stringify(
      {
        heartbeat: read(join(dir, "heartbeat.json")),
        kill: existsSync(join(dir, "KILL")) ? readFileSync(join(dir, "KILL"), "utf8").trim() || "kill" : null,
        alerts: alerts.open().filter((a) => codes.test(a.code)).map((a) => ({ code: a.code, severity: a.severity, at: a.at, message: a.message })),
        budget: budgets.length > 0 ? read(join(dir, budgets[budgets.length - 1]!)) : null,
        state: state ? { books: Object.fromEntries(Object.entries(state.orders ?? {}).map(([m, o]) => [m, o.length])), series: Object.keys(state.series ?? {}), baseline: state.baseline ?? null, killed: state.killed ?? null } : null,
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  const [cmd = "run", ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "run":
        await run();
        process.exit(0);
        break;
      case "status":
        status();
        break;
      case "kill":
        await request("KILL", rest.join(" ") || "manual");
        break;
      case "unkill":
        await request("UNKILL", "");
        break;
      case "cancel-all":
        await request("CANCEL_ALL", "");
        break;
      case "withdraw-all":
        if (!existsSync(join(marketDir(), "KILL"))) {
          console.error("withdraw-all needs the kill switch on: run kill first");
          process.exit(2);
        }
        await request("WITHDRAW_ALL", "");
        break;
      case "rebase":
        await request("REBASE", "");
        break;
      default:
        console.error("usage: bun run src/main.ts [run|status|kill [reason]|unkill|cancel-all|withdraw-all|rebase]");
        process.exit(2);
    }
    process.exit(0);
  } catch (e) {
    say("fatal", { error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    process.exit(1);
  }
}
