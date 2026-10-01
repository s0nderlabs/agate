// Runs `cre workflow simulate` for one slice and turns its stdout into a TakeResult for the shared writer.
// The CLI runs in a runtime project folder the runner owns (<home>/primary/cre/<index8>/): project.yaml written from
// the RPC pool's current URL (so the CLI follows a failover), workflow.yaml and a placeholder main.ts (the CLI checks
// the path exists), the prebuilt main.wasm and cfg.json. Every path handed to the CLI is relative and short, which
// keeps --config under the CLI's 97-character limit whatever AGATE_WALL_HOME is.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "@agate/report/types";
import type { Panel } from "@agate/sources/types";
import type { Clock, ClockConfig, EntryJson, ReadingSource, SourceLog, TakeResult } from "@agate/writer-standby";
import { entryFromJson } from "@agate/writer-standby";

/** The workflow's return value (handler.ts). */
export interface WorkflowResult {
  agate: 1;
  t: number;
  index: Address;
  dayId: number;
  slice: number;
  entries: EntryJson[];
  sources: SourceLog[];
  tx: { status: number; receiverStatus: number | null; hash: Hex | null; error: string | null };
}

export const TX_SUCCESS = 2; // TxStatus.SUCCESS
export const RECEIVER_SUCCESS = 0; // ReceiverContractExecutionStatus.SUCCESS
export const CONFIG_PATH_MAX = 97; // the CLI refuses a longer --config or --wasm

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Finds the workflow's JSON result (printed as a JSON-encoded string after "Workflow Simulation Result"). */
export function parseSimulateOutput(stdout: string): { result: WorkflowResult | null; error?: string } {
  const lines = stdout.replace(ANSI, "").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('"{\\"agate\\":1')) continue;
    try {
      const inner = JSON.parse(line) as string;
      const r = JSON.parse(inner) as WorkflowResult;
      if (!Array.isArray(r.entries) || typeof r.dayId !== "number" || typeof r.slice !== "number" || !r.tx) throw new Error("result misses fields");
      return { result: r };
    } catch (e) {
      return { result: null, error: `unparseable result: ${String(e)}` };
    }
  }
  const i = lines.findIndex((l) => /✗|error|Error|panic/.test(l));
  if (i < 0) return { result: null, error: "no workflow result in simulate output" };
  // the CLI prints the detail on the next line ("✗ validation error" / "ConfigPath must be ...")
  const detail = lines.slice(i, i + 3).map((l) => l.trim()).filter(Boolean).join(" | ");
  return { result: null, error: detail.slice(0, 500) };
}

export function toTake(r: WorkflowResult, ms: number): TakeResult {
  const ok = r.tx.status === TX_SUCCESS && (r.tx.receiverStatus ?? RECEIVER_SUCCESS) === RECEIVER_SUCCESS;
  const error = r.tx.error ?? (ok ? undefined : `writeReport status ${r.tx.status}, receiver ${r.tx.receiverStatus}`);
  return {
    reading: { readAt: r.t, dayId: r.dayId, slice: r.slice, entries: r.entries.map(entryFromJson), sources: r.sources },
    via: "cre",
    sent: { ok: ok && r.tx.hash !== null, sent: r.tx.hash !== null, ...(r.tx.hash ? { txHash: r.tx.hash } : {}), ...(error ? { error } : {}) },
    ms,
    ...(error ? { error } : {}),
  };
}

export interface WorkflowConfigInput {
  index: Address;
  chainSelector: bigint;
  gasLimit: bigint;
  clock: Clock;
  panels: readonly Panel[];
  sourceBaseUrl?: string;
  schedule?: string;
}

/** The config the workflow reads (handler.ts Config): the index's own clock and panels, never typed by hand. */
export function workflowConfig(o: WorkflowConfigInput) {
  // signAll travels too: the workflow derives the clock the way the contract does, and a short day needs it (T8)
  const clock: ClockConfig = { day: o.clock.day, slices: o.clock.slices, epochTs: o.clock.epochTs, epochDay: o.clock.epochDay, signAll: o.clock.signAll };
  return {
    index: o.index,
    chainSelector: o.chainSelector.toString(),
    gasLimit: o.gasLimit.toString(),
    schedule: o.schedule ?? "0 7 * * * *",
    role: "primary",
    timeout: `${Math.min(10, Math.max(1, Math.floor(o.clock.slice / 10)))}s`, // CRE caps an HTTP call at 10 s
    ...(o.sourceBaseUrl ? { sourceBaseUrl: o.sourceBaseUrl } : {}),
    clock,
    panels: o.panels,
  };
}

/** project.yaml for the local-simulation target: one chain, the RPC URL the runner's pool currently trusts. */
export function projectYaml(target: string, chainName: string, rpcUrl: string): string {
  if (/["\n\r]/.test(rpcUrl) || /["\n\r]/.test(chainName) || /[:\s]/.test(target)) throw new Error("bad characters in the CRE project settings");
  return `# Written by the agate runner on every RPC change. Holds an RPC URL: never commit it.\n${target}:\n  rpcs:\n    - chain-name: ${chainName}\n      url: "${rpcUrl}"\n`;
}

export interface RuntimeDir {
  dir: string;
  /** Rewrites project.yaml when the URL changes (cheap when it does not). */
  setRpc(url: string): void;
}

/** Prepares <dir>: workflow.yaml and main.ts from the repo's workflow folder, cfg.json, project.yaml. The wasm is the
 * caller's (compiled once at start into <dir>/main.wasm). */
export function prepareRuntime(o: { dir: string; workflowDir: string; target: string; chainName: string; config: ReturnType<typeof workflowConfig> }): RuntimeDir {
  mkdirSync(o.dir, { recursive: true });
  copyFileSync(join(o.workflowDir, "workflow.yaml"), join(o.dir, "workflow.yaml"));
  copyFileSync(join(o.workflowDir, "main.ts"), join(o.dir, "main.ts"));
  writeFileSync(join(o.dir, "cfg.json"), `${JSON.stringify(o.config, null, 2)}\n`);
  let current = "";
  return {
    dir: o.dir,
    setRpc(url: string) {
      const body = projectYaml(o.target, o.chainName, url);
      if (body === current && existsSync(join(o.dir, "project.yaml")) && readFileSync(join(o.dir, "project.yaml"), "utf8") === body) return;
      writeFileSync(join(o.dir, "project.yaml"), body);
      current = body;
    },
  };
}

export interface SimulateOptions {
  creBin: string;
  /** The runtime project folder (cwd of the CLI): project.yaml, workflow.yaml, main.ts, cfg.json, main.wasm. */
  dir: string;
  target: string;
  configPath: string; // relative to dir, e.g. ./cfg.json
  wasm?: string; // relative to dir, e.g. ./main.wasm
  envFile?: string; // the CRE CLI's .env (CRE_ETH_PRIVATE_KEY): read by the CLI, never by this process
  /** Else the broadcast key goes to the CLI child only, as CRE_ETH_PRIVATE_KEY (no key file). Never logged. */
  key?: string;
  limits?: string; // "default" | "none" | path
  broadcast: boolean;
  timeoutMs: number;
  receiptTimeout?: string;
}

export function simulateArgs(o: SimulateOptions): string[] {
  for (const [flag, v] of [["--config", o.configPath], ["--wasm", o.wasm ?? ""]] as const) {
    if (v.length > CONFIG_PATH_MAX) throw new Error(`${flag} ${v} is longer than ${CONFIG_PATH_MAX} characters`);
  }
  return [
    "workflow",
    "simulate",
    ".",
    "-R",
    ".",
    "--target",
    o.target,
    "--non-interactive",
    "--trigger-index",
    "0",
    "--config",
    o.configPath,
    ...(o.wasm ? ["--wasm", o.wasm] : []),
    ...(o.limits ? ["--limits", o.limits] : []),
    ...(o.envFile ? ["-e", o.envFile] : []),
    ...(o.receiptTimeout ? ["--evm-receipt-timeout", o.receiptTimeout] : []),
    ...(o.broadcast ? ["--broadcast"] : []),
  ];
}

export async function runSimulate(o: SimulateOptions): Promise<{ stdout: string; code: number; ms: number }> {
  if (!existsSync(join(o.dir, "project.yaml"))) throw new Error(`${o.dir}/project.yaml is missing`);
  const t0 = Date.now();
  const env = { ...process.env };
  if (o.key && !o.envFile) env.CRE_ETH_PRIVATE_KEY = o.key.replace(/^0x/, "");
  const p = Bun.spawn([o.creBin, ...simulateArgs(o)], { cwd: o.dir, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => p.kill(), o.timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { stdout: `${out}\n${err}`, code, ms: Date.now() - t0 };
}

export interface CreHooks {
  /** Runs the CLI holding the key with nothing of ours in flight (TxSender.exclusive); undefined: not now. */
  exclusive?: <T>(fn: () => Promise<T>, untilMs: number) => Promise<T | undefined>;
  /** Called before each run: the RPC URL the CLI should use (the pool's current one). */
  rpcUrl?: () => string;
  runtime?: RuntimeDir;
}

/** The CRE reading path: one simulate run per slice; the workflow fetches, parses, builds and broadcasts. When a
 * run gives no result (CLI, login or RPC failure, the key busy), the slice is read and posted directly instead
 * (logged "direct"). */
export function creSource(
  o: SimulateOptions,
  say: (e: string, d?: Record<string, unknown>) => void,
  fallback?: ReadingSource,
  run: (o: SimulateOptions) => Promise<{ stdout: string; code: number; ms: number }> = runSimulate,
  hooks: CreHooks = {},
): ReadingSource {
  return {
    async take(at) {
      let out: { stdout: string; code: number; ms: number } | undefined;
      let parsed: ReturnType<typeof parseSimulateOutput>;
      try {
        if (hooks.runtime && hooks.rpcUrl) hooks.runtime.setRpc(hooks.rpcUrl());
        out = hooks.exclusive ? await hooks.exclusive(() => run(o), Date.now() + Math.min(o.timeoutMs, 30_000)) : await run(o);
      } catch (e) {
        out = { stdout: String(e), code: -1, ms: 0 };
      }
      if (out) parsed = parseSimulateOutput(out.stdout);
      else {
        out = { stdout: "", code: -2, ms: 0 };
        parsed = { result: null, error: "key busy: a transaction of ours is still in flight" };
      }
      if (parsed.result) {
        if (parsed.result.dayId !== at.dayId || parsed.result.slice !== at.slice) {
          say("simulate_other_slice", { want: at, got: { dayId: parsed.result.dayId, slice: parsed.result.slice } });
        }
        return toTake(parsed.result, out.ms);
      }
      say("simulate_failed", { code: out.code, ms: out.ms, error: parsed.error, fallback: Boolean(fallback) });
      if (fallback) return { ...(await fallback.take(at)), error: `simulate failed: ${parsed.error}` };
      throw new Error(`simulate failed (exit ${out.code}): ${parsed.error}`);
    },
  };
}
