// Runs `cre workflow simulate` for one slice and turns its stdout into a TakeResult for the shared writer.
// The CLI runs in a runtime project folder the runner owns (<home>/primary/cre/<index8>/): project.yaml, workflow.yaml
// and a placeholder main.ts (the CLI checks the path exists), the prebuilt main.wasm and cfg.json. Every path handed
// to the CLI is relative and short, which keeps --config under the CLI's 97-character limit whatever AGATE_WALL_HOME
// is. Oct 3 (8.2, 13.6): project.yaml only ever holds a key-free URL from AGATE_CRE_RPC_URLS (scheme, host and port;
// never the Alchemy URL, which carries a key), the CLI child's environment holds no RPC list or URL from it, cfg.json
// carries the readers in force of the run's day, and a run line is logged before the CLI starts (8.5).
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type RpcEndpoints, scrubSecrets } from "@agate/report/env";
import type { Address, Hex } from "@agate/report/types";
import type { Panel } from "@agate/sources/types";
import type { Clock, ClockConfig, EntryJson, ReadingSource, SlotReaders, SourceLog, TakeResult } from "@agate/writer-standby";
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

export function toTake(r: WorkflowResult, ms: number, runId?: string): TakeResult {
  const ok = r.tx.status === TX_SUCCESS && (r.tx.receiverStatus ?? RECEIVER_SUCCESS) === RECEIVER_SUCCESS;
  const error = r.tx.error ?? (ok ? undefined : `writeReport status ${r.tx.status}, receiver ${r.tx.receiverStatus}`);
  return {
    reading: { readAt: r.t, dayId: r.dayId, slice: r.slice, entries: r.entries.map(entryFromJson), sources: r.sources },
    via: "cre",
    sent: { ok: ok && r.tx.hash !== null, sent: r.tx.hash !== null, ...(r.tx.hash ? { txHash: r.tx.hash } : {}), ...(error ? { error } : {}) },
    ms,
    ...(error ? { error } : {}),
    ...(runId ? { runId } : {}),
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
  /** The readers of swapped slots for the run's day (8.6); absent: every slot reads with the registered reader. */
  readers?: SlotReaders;
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
    ...(o.readers ? { readers: o.readers } : {}),
  };
}

/** A URL the CRE CLI may be given: http(s) with scheme, host and port only (no path, query or user info, so no API
 * key: 8.2 (2)). Throws a message without the URL otherwise. */
export function assertKeyFree(url: string, what = "AGATE_CRE_RPC_URLS"): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`${what} holds an entry that is not a URL`);
  }
  const bare = (u.protocol === "http:" || u.protocol === "https:") && u.username === "" && u.password === "" && u.search === "" && u.hash === "" && (u.pathname === "/" || u.pathname === "");
  if (!bare || /[@?#]/.test(url) || url.replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "").includes("/")) {
    throw new Error(`${what} must hold key-free URLs: scheme, host and port only (an RPC URL with a path may carry an API key)`);
  }
  return url;
}

/** The CRE CLI's RPC URLs (8.2 (2)): AGATE_CRE_RPC_URLS (comma-separated, key-free), default Monad's public testnet RPC.
 * Never a URL of AGATE_RPC_URLS_CMD or AGATE_RPC_URLS. */
export function creRpcUrls(env: Record<string, string | undefined>): string[] {
  const list = (env.AGATE_CRE_RPC_URLS ?? "https://testnet-rpc.monad.xyz")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (list.length === 0) throw new Error("AGATE_CRE_RPC_URLS is empty");
  return [...new Set(list.map((u) => assertKeyFree(u)))];
}

/** The CLI child's environment: this process's, without any RPC list or a variable that holds a configured URL or a
 * secret part of one (13.6: no child inherits them). */
export function childEnv(base: Record<string, string | undefined>, endpoints?: RpcEndpoints): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k === "AGATE_RPC_URLS_CMD" || k === "AGATE_RPC_URLS" || k === "AGATE_RPC_URL") continue;
    if (endpoints && scrubSecrets(v, endpoints) !== v) continue;
    out[k] = v;
  }
  return out;
}

/** The --limits value of a run (8.2 (1)): a panel reading a source over CRE's cap (the launch panel) runs with
 * "none" unless AGATE_CRE_LIMITS overrides; AGATE_CRE_LIMITS=default with such a panel refuses to start, so a capped
 * page never silently reads as 0. */
export function creLimits(env: string | undefined, overCap: boolean): string {
  const v = (env ?? "").trim();
  if (v === "") return overCap ? "none" : "default";
  if (v === "default" && overCap) throw new Error("the panel reads a source over CRE's cap; run with --limits none");
  return v;
}

/** project.yaml for the local-simulation target: one chain, the RPC URL the runner's pool currently trusts. */
export function projectYaml(target: string, chainName: string, rpcUrl: string): string {
  if (/["\n\r]/.test(rpcUrl) || /["\n\r]/.test(chainName) || /[:\s]/.test(target)) throw new Error("bad characters in the CRE project settings");
  return `# Written by the agate runner on every RPC change. Holds an RPC URL: never commit it.\n${target}:\n  rpcs:\n    - chain-name: ${chainName}\n      url: "${rpcUrl}"\n`;
}

export interface RuntimeDir {
  dir: string;
  /** Rewrites project.yaml when the URL changes (cheap when it does not). Only key-free URLs (assertKeyFree). */
  setRpc(url: string): void;
  /** Rewrites cfg.json when the run's readers change (8.6). */
  setReaders(readers: SlotReaders | undefined): void;
}

/** Prepares <dir>: workflow.yaml and main.ts from the repo's workflow folder, cfg.json, project.yaml. The wasm is the
 * caller's (compiled once at start into <dir>/main.wasm). */
export function prepareRuntime(o: { dir: string; workflowDir: string; target: string; chainName: string; config: ReturnType<typeof workflowConfig> }): RuntimeDir {
  mkdirSync(o.dir, { recursive: true });
  copyFileSync(join(o.workflowDir, "workflow.yaml"), join(o.dir, "workflow.yaml"));
  copyFileSync(join(o.workflowDir, "main.ts"), join(o.dir, "main.ts"));
  const cfgText = (readers: SlotReaders | undefined) => {
    const { readers: _r, ...base } = o.config as ReturnType<typeof workflowConfig> & { readers?: SlotReaders };
    return `${JSON.stringify(readers ? { ...base, readers } : base, null, 2)}\n`;
  };
  let cfg = cfgText((o.config as { readers?: SlotReaders }).readers);
  writeFileSync(join(o.dir, "cfg.json"), cfg);
  let current = "";
  return {
    dir: o.dir,
    setRpc(url: string) {
      const body = projectYaml(o.target, o.chainName, assertKeyFree(url));
      if (body === current && existsSync(join(o.dir, "project.yaml")) && readFileSync(join(o.dir, "project.yaml"), "utf8") === body) return;
      writeFileSync(join(o.dir, "project.yaml"), body);
      current = body;
    },
    setReaders(readers) {
      const next = cfgText(readers);
      if (next === cfg && existsSync(join(o.dir, "cfg.json"))) return;
      writeFileSync(join(o.dir, "cfg.json"), next);
      cfg = next;
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
  /** The child's environment (childEnv); default this process's. */
  env?: Record<string, string>;
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
  const env: Record<string, string | undefined> = { ...(o.env ?? process.env) };
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
  /** Called before each run: the key-free RPC URL the CLI should use (AGATE_CRE_RPC_URLS, 8.2 (2)). */
  rpcUrl?: () => string;
  /** Called after a run that gave no result: the next run tries the next key-free URL. */
  rpcFailed?: () => void;
  runtime?: RuntimeDir;
  /** The panels, to tell which slot's reader the compiled workflow could not use (8.2 (3)). */
  panels?: readonly Panel[];
  /** A reader this process allowed that the compiled workflow refused (its version missing from the WASM): the slot
   * read 0 (READER_MISSING). */
  onWorkflowRefused?: (x: { gpuId: Hex; gpu: string; slot: number; sourceId: string; parserVersion: string; why: string; dayId: number }) => void;
}

/** The slots whose reader this process passed as usable but the workflow's result marks refused. */
export function workflowRefusals(panels: readonly Panel[], readers: SlotReaders | undefined, sources: readonly SourceLog[]): { gpuId: Hex; gpu: string; slot: number; sourceId: string; parserVersion: string; why: string }[] {
  const out: { gpuId: Hex; gpu: string; slot: number; sourceId: string; parserVersion: string; why: string }[] = [];
  for (const p of panels) {
    const m = readers?.[p.gpuId] ?? readers?.[p.gpuId.toLowerCase()];
    if (!m) continue;
    for (const s of p.slots) {
      const r = m[String(s.slot)];
      if (!r || "refused" in r) continue;
      const why = sources.find((x) => x.sourceId === s.sourceId)?.refused?.[p.gpu];
      if (why) out.push({ gpuId: p.gpuId as Hex, gpu: p.gpu, slot: s.slot, sourceId: s.sourceId, parserVersion: r.parserVersion, why });
    }
  }
  return out;
}

/** Failover among the CLI's key-free URLs: the next one after a run without a result. */
export function creRpcRotation(urls: readonly string[]): { url: () => string; failed: () => void } {
  let i = 0;
  return { url: () => urls[i % urls.length]!, failed: () => void (i += 1) };
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
      const runId = randomBytes(8).toString("hex");
      try {
        if (hooks.runtime && hooks.rpcUrl) hooks.runtime.setRpc(hooks.rpcUrl());
        hooks.runtime?.setReaders(at.readers);
        out = hooks.exclusive
          ? await hooks.exclusive(
              () => {
                at.onRun?.(runId); // logged before the CLI starts (8.5): a post it makes is known to be ours
                return run(o);
              },
              Date.now() + Math.min(o.timeoutMs, 30_000),
            )
          : (at.onRun?.(runId), await run(o));
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
          say("simulate_other_slice", { want: { dayId: at.dayId, slice: at.slice }, got: { dayId: parsed.result.dayId, slice: parsed.result.slice } });
        }
        if (hooks.panels && hooks.onWorkflowRefused) {
          for (const x of workflowRefusals(hooks.panels, at.readers, parsed.result.sources)) hooks.onWorkflowRefused({ ...x, dayId: parsed.result.dayId });
        }
        return toTake(parsed.result, out.ms, runId);
      }
      hooks.rpcFailed?.();
      say("simulate_failed", { code: out.code, ms: out.ms, error: parsed.error, fallback: Boolean(fallback) });
      if (fallback) return { ...(await fallback.take(at)), error: `simulate failed: ${parsed.error}` };
      throw new Error(`simulate failed (exit ${out.code}): ${parsed.error}`);
    },
  };
}
