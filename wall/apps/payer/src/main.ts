// The payer and lister process (BOTS-SPEC 2.7, 4.7): bun run src/main.ts <command>
//   run (default)        loop for ever: list, then pay; an error inside a tick is logged, never fatal
//   status               the heartbeat, open alerts of the payer's codes, the budget day, the state; no key, no RPC
//   list-once [--dry]    one lister pass
//   claim-once [--dry]   one payer pass (after the log scan has caught up)
// Env: AGATE_KEY_CMD (run by this process at start; the key is held in memory only, audit M-K1) or, for tests,
// AGATE_PAYER_KEY (moved into memory and deleted from the environment), AGATE_RPC_URLS_CMD or AGATE_RPC_URLS, AGATE_CHAIN_ID, AGATE_DEPLOYMENTS, AGATE_PAYER_CONFIG,
// AGATE_WALL_HOME, AGATE_NOTIFY_CMD, AGATE_MAX_FEE_GWEI, AGATE_MARKET_GAS_LIMITS, AGATE_MARKET_LOG_CHUNK,
// AGATE_DRY_RUN=1 (simulate and estimate only, never sign) with AGATE_PAYER_ADDRESS when no key is given.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AlertSink, printable, readBeat, wallHome, Waker, WsWake } from "@agate/watcher";
import { buildApp, jsonLine } from "./app.ts";
import { loadConfig } from "./config.ts";
import { bootstrap } from "@agate/market";

const ROLE = "payer";
const CODES = /^(PAYER_|LISTER_|GAS_CAP|NONCE_STUCK|RPC_)/;
const now = () => Math.floor(Date.now() / 1000);
const say = (event: string, data: Record<string, unknown> = {}) => console.log(jsonLine({ t: now(), role: ROLE, event, ...data }));

function status(): void {
  const home = wallHome();
  const dir = join(home, "market", ROLE);
  const beat = readBeat(join(dir, "heartbeat.json"));
  const alerts = existsSync(join(home, "alerts", "alerts.jsonl")) ? new AlertSink(join(home, "alerts", "alerts.jsonl"), { now, print: false }).open().filter((a) => CODES.test(a.code)) : [];
  const budgets = existsSync(dir) ? readdirSync(dir).filter((f) => /^budget-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : [];
  const budget = budgets.length ? JSON.parse(readFileSync(join(dir, budgets[budgets.length - 1]!), "utf8")) : null;
  let state: Record<string, unknown> | null = null;
  try {
    const s = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { series: Record<string, { lastClaimK: number; sweepDone: boolean }>; badIds: Record<string, string>; neverList: string[]; retryAt: Record<string, number>; marketRetryAt: Record<string, number> };
    state = { series: Object.keys(s.series).length, swept: Object.values(s.series).filter((x) => x.sweepDone).length, lastClaimK: s.series, badIds: Object.keys(s.badIds).length, neverList: s.neverList, listRetries: Object.keys(s.retryAt).length, marketRetries: Object.keys(s.marketRetryAt).length };
  } catch {
    state = null;
  }
  let cursor: string | null = null;
  try {
    cursor = (JSON.parse(readFileSync(join(dir, "cursor.json"), "utf8")) as { next: string }).next;
  } catch {
    cursor = null;
  }
  console.log(printable(jsonLine({ role: ROLE, heartbeat: beat, ageS: beat ? now() - beat.at : null, alerts: alerts.map((a) => ({ code: a.code, severity: a.severity, at: a.at, message: a.message })), budget, state, scanNext: cursor })));
}

async function main(): Promise<number> {
  const cmd = process.argv[2] ?? "run";
  const flags = process.argv.slice(3);
  if (cmd === "status") {
    status();
    return 0;
  }
  if (!["run", "list-once", "claim-once"].includes(cmd) || flags.some((f) => f !== "--dry") || (cmd === "run" && flags.length > 0)) {
    console.error("usage: bun run src/main.ts [run | status | list-once [--dry] | claim-once [--dry]]");
    return 2;
  }
  if (flags.includes("--dry")) process.env.AGATE_DRY_RUN = "1";
  const config = loadConfig();
  const rt = await bootstrap({ role: ROLE, keyVar: "AGATE_PAYER_KEY", addressVar: "AGATE_PAYER_ADDRESS", now, marginAccount: "optional" });
  let stopping = false;
  const waker = new Waker();
  const stop = () => {
    stopping = true;
    waker.wake();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const chunkEnv = process.env.AGATE_MARKET_LOG_CHUNK;
  const app = await buildApp(rt, config, { now, stopping: () => stopping, ...(chunkEnv ? { logChunk: Math.max(10, Number(chunkEnv) | 0) } : {}) });
  say("start", { cmd, from: rt.from, dryRun: rt.dryRun, chainId: rt.pool.chainId, factories: app.factories.map((f) => f.name), tickS: app.tickS, rpc: rt.pool.redactedUrls(), gasLimits: process.env.AGATE_MARKET_GAS_LIMITS ? "AGATE_MARKET_GAS_LIMITS" : "the Foundry table (Ethereum prices; phase 4 sets AGATE_MARKET_GAS_LIMITS from Monad)" });
  if (cmd === "list-once") {
    const r = await app.tick({ payer: false });
    say("done", { listed: r.lister?.listed ?? [], created: r.lister?.created ?? [], waiting: r.lister?.waiting ?? [], owed: r.lister?.owed ?? [] });
    return 0;
  }
  if (cmd === "claim-once") {
    for (let i = 0; i < 100 && !app.scanner.caughtUp; i++) await app.scanner.sync();
    const r = await app.tick({ lister: false });
    say("done", { ...(r.payer ?? {}) });
    return 0;
  }
  const wakes = rt.endpoints.ws.length
    ? [...new Set(app.factories.map((f) => f.index.toLowerCase()))].map((address) => new WsWake({ urls: rt.endpoints.ws, address, kinds: ["logs"], onWake: () => {
          // 2.3 step 5: the nonce is read again at `pending` after a wake, never below the local counter (Monad's
          // `pending` lags `latest` right after our own transaction: audit P-L3)
          app.sender.refreshNonce();
          waker.wake();
        }, alerts: rt.alerts, role: ROLE, log: (event, data) => say(event, data) }))
    : [];
  for (const w of wakes) w.start();
  while (!stopping) {
    try {
      const r = await app.tick();
      say("tick", { t: r.t, balanceWei: r.balanceWei, listed: r.lister?.listed.length ?? 0, created: r.lister?.created.length ?? 0, waiting: r.lister?.waiting.length ?? 0, owed: r.lister?.owed.length ?? 0, due: r.payer?.due ?? 0, candidates: r.payer?.candidates ?? 0, claimed: r.payer?.paidIds ?? 0, paidU: r.payer?.paidU ?? 0n, sends: (r.lister?.sends ?? 0) + (r.payer?.sends ?? 0) });
    } catch (e) {
      say("tick_error", { error: (e instanceof Error ? e.message : String(e)).split("\n")[0] });
    }
    for (const w of wakes) w.tick();
    if (!stopping) await waker.wait(app.tickS * 1000);
  }
  for (const w of wakes) w.stop();
  say("stopped", {});
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`payer: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
    process.exit(1);
  },
);
