// The Akash traded-price reader (BUILD-SPEC 16): `bun run apps/akash/src/cli.ts <run | watch>`.
// One process for every index (it serves the app's comparison panel, not an index). No key, no RPC of ours.
// Env: AGATE_WALL_HOME (default ~/.agate-wall), AGATE_AKASH_INTERVAL_S (default 3,600), AGATE_AKASH_ENDPOINTS
// (comma-separated REST bases, default the four public endpoints of 16).
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_ENDPOINTS, outPath, runOnce } from "./fetch.ts";
import { refuseKeys, takeLock } from "./guard.ts";

const nowS = () => Math.floor(Date.now() / 1000);
const say = (event: string, data?: Record<string, unknown>) => console.log(JSON.stringify({ t: nowS(), role: "akash", event, ...data }));

export function akashHome(env: Record<string, string | undefined>): string {
  return join(env.AGATE_WALL_HOME || join(homedir(), ".agate-wall"), "akash");
}

export function intervalS(env: Record<string, string | undefined>): number {
  const v = Number(env.AGATE_AKASH_INTERVAL_S || 3_600);
  if (!Number.isSafeInteger(v) || v < 60) throw new Error("AGATE_AKASH_INTERVAL_S must be a whole number of seconds, at least 60");
  return v;
}

export function endpoints(env: Record<string, string | undefined>): string[] {
  const list = (env.AGATE_AKASH_ENDPOINTS ?? "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  for (const e of list) if (!/^https?:\/\/[^\s/]+/.test(e)) throw new Error("AGATE_AKASH_ENDPOINTS: every entry must be an http(s) URL");
  return list.length > 0 ? list : [...DEFAULT_ENDPOINTS];
}

function beat(home: string, tick: number, lastAction: string): void {
  const p = join(home, "heartbeat.json");
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, role: "akash", index: "all", at: nowS(), tick, lastAction }));
  renameSync(tmp, p);
}

async function once(home: string, eps: string[], tick: number): Promise<boolean> {
  const r = await runOnce({ home, endpoints: eps });
  const h = r.file.gpus.H100;
  say(r.ok ? "run" : "run_failed", { endpoint: r.file.endpoint, blockMs: r.file.blockMs, h100: h ? { median: h.median, gpus: h.gpus, leases: h.leases, sellers: h.sellers, buyers: h.buyers } : null, errors: r.errors, out: outPath(home) });
  beat(home, tick, r.ok ? `ok ${r.file.endpoint}` : "failed");
  return r.ok;
}

export async function main(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  const cmd = argv[0];
  if (cmd !== "run" && cmd !== "watch") {
    console.error("usage: bun run apps/akash/src/cli.ts <run|watch>");
    return 2;
  }
  refuseKeys(env, "the Akash reader");
  const home = akashHome(env);
  const eps = endpoints(env);
  const every = intervalS(env);
  try {
    takeLock(join(home, "akash.lock"));
  } catch (e) {
    console.error(`akash: ${(e as Error).message}; exiting`);
    return 3;
  }
  if (cmd === "run") return (await once(home, eps, 1)) ? 0 : 1;
  let stop = false;
  for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => (stop = true));
  say("start", { home, interval: every, endpoints: eps.length });
  for (let tick = 1; !stop; tick++) {
    try {
      await once(home, eps, tick);
    } catch (e) {
      say("tick_error", { error: e instanceof Error ? e.message : String(e) });
    }
    const until = nowS() + every;
    while (!stop && nowS() < until) {
      await Bun.sleep(Math.min(5_000, (until - nowS()) * 1000));
    }
  }
  say("stop");
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`akash: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
