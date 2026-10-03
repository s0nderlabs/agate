// The repair agent process (BUILD-SPEC 15.2): `bun run apps/repair/src/main.ts watch`, one process for every index.
// Env: AGATE_WALL_HOME, AGATE_INDEXES, AGATE_PANELS (AGATE_PANELS_<index8> overrides), AGATE_RPC_URLS_CMD (optional,
// read-only: readerHistory and queuedEta), AGATE_RAW_DIR, AGATE_CLAUDE_BIN, AGATE_REPAIR_MODEL, AGATE_REPO,
// AGATE_REPAIR_MAX_CALLS_INCIDENT / _DAY, AGATE_REPAIR_CLAUDE_TIMEOUT_S, AGATE_REPAIR_NOTIFY (0: no macOS
// notification), AGATE_NOTIFY_CMD. Refuses to start with any key variable or ANTHROPIC_API_KEY set.
import { join } from "node:path";
import type { Hex } from "@agate/report/types";
import { installScrubber, resolveRpcEndpoints, scrubSecrets } from "@agate/report/env";
import { AlertSink, Heartbeat, setFileScrubber, takeLock } from "@agate/watcher";
import { RepairAgent } from "./agent.ts";
import { type ChainView, viemChain } from "./chain.ts";
import { loadConfig, type RepairConfig } from "./config.ts";
import { Spawner } from "./spawn.ts";

const nowS = () => Math.floor(Date.now() / 1000);
const say = (event: string, data?: Record<string, unknown>) => console.log(JSON.stringify({ t: nowS(), role: "repair", event, ...data }));

export function spawnerOf(cfg: RepairConfig): Spawner {
  return new Spawner({ claude: cfg.claudeBin, sandbox: cfg.sandboxExec, bun: cfg.bun, tsc: cfg.tsc, osascript: cfg.osascript });
}

export function sinksOf(cfg: RepairConfig, now: () => number): (index: string | null) => AlertSink {
  const m = new Map<string, AlertSink>();
  return (index) => {
    const k = index ?? "";
    let s = m.get(k);
    if (!s) m.set(k, (s = new AlertSink(join(cfg.home, "alerts", "alerts.jsonl"), { now, role: "repair", ...(index ? { index } : {}), ...(cfg.notifyCmd ? { notifyCmd: cfg.notifyCmd } : {}) })));
    return s;
  };
}

export async function main(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  if (argv[0] !== "watch") {
    console.error("usage: bun run apps/repair/src/main.ts watch");
    return 2;
  }
  const cfg = loadConfig(env);
  let chain: ((index: string) => ChainView | null) | undefined;
  if (env.AGATE_RPC_URLS_CMD !== undefined || env.AGATE_RPC_URLS !== undefined || env.AGATE_RPC_URL !== undefined) {
    const ep = resolveRpcEndpoints(env);
    installScrubber(ep);
    setFileScrubber((s) => scrubSecrets(s, ep));
    const views = new Map<string, ChainView>();
    chain = (index) => {
      let v = views.get(index);
      if (!v) views.set(index, (v = viemChain(index as Hex, ep.http)));
      return v;
    };
  } else say("no_rpc", { why: "no AGATE_RPC_URLS_CMD: readers in force are the registered ones and swaps are not followed" });
  try {
    takeLock(join(cfg.dir, "repair.lock"));
  } catch (e) {
    console.error(`repair: ${(e as Error).message}; exiting`);
    return 3;
  }
  const agent = new RepairAgent({ cfg, spawner: spawnerOf(cfg), env, now: nowS, sink: sinksOf(cfg, nowS), ...(chain ? { chain } : {}), heartbeat: new Heartbeat(join(cfg.dir, "heartbeat.json"), "repair", "all"), say });
  await agent.start();
  say("start", { indexes: cfg.indexes.length, cli: agent.cli?.ok ?? false, dir: cfg.dir });
  let stop = false;
  for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => (stop = true));
  while (!stop) {
    try {
      await agent.tick(nowS(), agent.alertsWake());
    } catch (e) {
      say("tick_error", { error: e instanceof Error ? e.message : String(e) });
    }
    for (let i = 0; i < 10 && !stop; i++) await Bun.sleep(1_000);
  }
  say("stop");
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`repair: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
