// The two market bots as child processes, started as launchd's run scripts start them (`bun run src/main.ts run`
// with AGATE_KEY_CMD, which the process runs itself, or for the other runs the key in its variable), each with a
// private AGATE_WALL_HOME under the run's scratch dir. Every start
// writes its own stdout and stderr files, so a restart never loses what the previous process printed. pause() and
// resume() freeze a process (SIGSTOP, SIGCONT) so the harness can read the chain at a moment the bot cannot act.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./fork.ts";

export type BotName = "marketmaker" | "payer";

export interface BotEnv {
  key?: string; // absent: a dry run with `address`, or keyCmd
  /** AGATE_KEY_CMD: the bot runs it itself and holds the key in memory only (audit M-K1); wins over `key` */
  keyCmd?: string;
  address?: string;
  urls: string[];
  deployments: string;
  config: unknown;
  home: string;
  chainId?: string;
}

export interface BotEvent {
  t?: number;
  event?: string;
  [k: string]: unknown;
}

export class Bot {
  proc: Bun.Subprocess | null = null;
  starts = 0;
  /** true from start() until stop(): a process that exits meanwhile has died */
  expected = false;
  /** the current process has exited (Bun leaves exitCode null after a signal, so this is tracked here) */
  private exitedNow = true;
  private outs: string[] = [];
  constructor(
    readonly name: BotName,
    readonly scratch: string,
    readonly env: BotEnv,
    readonly tag: string = name,
  ) {}

  get cwd(): string {
    return join(ROOT, "wall", "apps", this.name);
  }
  get dir(): string {
    return join(this.env.home, "market", this.name);
  }

  start(cmd: string[] = ["run"]): void {
    if (this.running) throw new Error(`${this.tag} is already running`);
    mkdirSync(this.env.home, { recursive: true });
    const cfg = join(this.scratch, `${this.tag}.config.json`);
    writeFileSync(cfg, JSON.stringify(this.env.config));
    const keyVar = this.name === "marketmaker" ? "AGATE_MM_KEY" : "AGATE_PAYER_KEY";
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/",
      AGATE_RPC_URLS: this.env.urls.join(","),
      AGATE_CHAIN_ID: this.env.chainId ?? "10143",
      AGATE_DEPLOYMENTS: this.env.deployments,
      AGATE_WALL_HOME: this.env.home,
      [this.name === "marketmaker" ? "AGATE_MM_CONFIG" : "AGATE_PAYER_CONFIG"]: cfg,
    };
    if (this.env.keyCmd) env.AGATE_KEY_CMD = this.env.keyCmd;
    else if (this.env.key) env[keyVar] = this.env.key;
    else {
      env.AGATE_DRY_RUN = "1";
      env[this.name === "marketmaker" ? "AGATE_MM_ADDRESS" : "AGATE_PAYER_ADDRESS"] = this.env.address ?? "";
    }
    const n = ++this.starts;
    const out = join(this.scratch, `${this.tag}.${n}.out`);
    const err = join(this.scratch, `${this.tag}.${n}.err`);
    this.outs.push(out, err);
    const p = Bun.spawn(["bun", "run", "src/main.ts", ...cmd], { cwd: this.cwd, env, stdout: Bun.file(out), stderr: Bun.file(err) });
    this.proc = p;
    this.exitedNow = false;
    void p.exited.then(() => {
      if (this.proc === p) this.exitedNow = true;
    });
    this.expected = cmd[0] === "run";
  }

  get running(): boolean {
    return this.proc !== null && !this.exitedNow;
  }

  async stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<number | null> {
    const p = this.proc;
    this.expected = false;
    if (!p) return null;
    if (!this.exitedNow) {
      p.kill("SIGCONT");
      p.kill(signal);
      const t = setTimeout(() => p.kill("SIGKILL"), 20_000);
      await p.exited;
      clearTimeout(t);
      this.exitedNow = true;
    }
    return p.exitCode;
  }

  pause(): void {
    this.proc?.kill("SIGSTOP");
  }
  resume(): void {
    this.proc?.kill("SIGCONT");
  }

  /** Every stdout line of every start of this bot, parsed (non-JSON lines are skipped). */
  events(): BotEvent[] {
    const out: BotEvent[] = [];
    for (const f of this.outs.filter((x) => x.endsWith(".out"))) {
      if (!existsSync(f)) continue;
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (!line.startsWith("{")) continue;
        try {
          out.push(JSON.parse(line) as BotEvent);
        } catch {
          // a torn last line
        }
      }
    }
    return out;
  }
  text(): string {
    return this.outs.filter(existsSync).map((f) => readFileSync(f, "utf8")).join("\n");
  }
  tail(n = 20): string {
    return this.text().split("\n").slice(-n).join("\n");
  }
  /** Every file the bot wrote under its home (state, budget, heartbeat, alerts, scanner files). */
  homeFiles(): string[] {
    const acc: string[] = [];
    const walk = (d: string) => {
      if (!existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else acc.push(p);
      }
    };
    walk(this.env.home);
    return acc;
  }
  alerts(): { code: string; severity: string; message: string; at?: number }[] {
    const f = join(this.env.home, "alerts", "alerts.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as { code: string; severity: string; message: string; at?: number });
  }
}

/** Waits for f() to return something truthy; fails with the bots' last lines when a bot died or time ran out. */
export async function until<T>(what: string, f: () => Promise<T | null | undefined | false>, bots: Bot[], ms = 120_000, pollMs = 250): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as T;
    for (const b of bots) if (b.expected && !b.running) throw new Error(`${what}: ${b.tag} exited ${b.proc?.exitCode}:\n${b.tail()}`);
    if (Date.now() > end) throw new Error(`${what}: timed out after ${ms} ms;\n${bots.map((b) => `--- ${b.tag}\n${b.tail(12)}`).join("\n")}`);
    await Bun.sleep(pollMs);
  }
}
