// A synthetic index world for the repair agent's tests: the watcher's clocks, log lines and raw pages (synthetic
// pages from @agate/sources' renderers, never copies of real pages), the page check's saved tracker files, a fake
// Claude CLI that records argv, environment, stdin and cwd and prints a canned answer, and a config on a temp home.
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GpuModel, Hex, WatcherReading } from "@agate/report/types";
import { renderPage, type SynthPage } from "@agate/sources";
import type { Panel } from "@agate/sources/types";
import { AlertSink } from "@agate/watcher";
import { loadConfig, type RepairConfig } from "../src/config.ts";
import { Spawner } from "../src/spawn.ts";

export const INDEX = "0x00000000000000000000000000000000000a11ce";
export const H100_ID = "0x12aa97fa8c2e1cc1914a2e4d86b36c7b36fdccec7c4caacb5f202ccc6d9be955" as Hex;
export const B200_ID = "0xb200000000000000000000000000000000000000000000000000000000000000" as Hex;
export const EPOCH = Date.parse("2026-10-09T00:00:00Z") / 1000;
export const CLOCK = { day: 2_400, slice: 200, slices: 12, minReadings: 6, epochTs: EPOCH, epochDay: 20_735, timelock: 4_800 };
export const start = (k: number) => EPOCH + k * CLOCK.slice;
export const utcDate = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

export const PANELS: Panel[] = [
  { gpu: "H100", spec: "H100-SXM/on-demand-list/neocloud/v1", gpuId: H100_ID, families: [{ name: "Lambda", famQ: 1 }, { name: "Civo", famQ: 1 }], slots: [{ slot: 0, sourceId: "p_lambda", family: 0, liveAtStart: true }, { slot: 1, sourceId: "p_civo", family: 1, liveAtStart: true }] },
  { gpu: "B200", spec: "B200-SXM/on-demand-list/neocloud/v1", gpuId: B200_ID, families: [{ name: "Lambda", famQ: 1 }], slots: [{ slot: 2, sourceId: "p_lambda", family: 0, liveAtStart: true }] },
];

const dirs: string[] = [];
export function tmp(prefix = "agate-repair-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
export function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export const LAMBDA_OK: SynthPage = { H100: { price: "3.99", count: 8 }, B200: { price: "6.69", count: 8 } };

export interface World {
  home: string;
  cfg: RepairConfig;
  watcherDir: string;
  rec: string; // the fake Claude's record file
  answerFile: string;
  sink: (index: string | null) => AlertSink;
  now: { t: number };
}

export const HELP_FULL = ["Usage: claude [options]", "  -p, --print", "  --restricted  Restricted mode", "  --safe-mode  Start with all customizations disabled", '  --tools <tools...>  Use "" to disable all tools', "  --json-schema <schema>", "  --strict-mcp-config", "  --mcp-config <configs...>", "  --no-session-persistence", "  --disable-slash-commands", "  --output-format <format>", "  --system-prompt <prompt>", ""].join("\n");

/** A fake `claude`: `--help` prints the help file; otherwise it records one JSON line and prints the answer file. */
export function fakeClaude(dir: string, help = HELP_FULL): { bin: string; rec: string; answerFile: string } {
  const bin = join(dir, "fake-claude");
  const rec = join(dir, "claude-record.jsonl");
  const answerFile = join(dir, "claude-answer.json");
  const helpFile = join(dir, "claude-help.txt");
  writeFileSync(helpFile, help);
  writeFileSync(answerFile, "{}");
  writeFileSync(
    bin,
    `#!${process.execPath}
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--help") { process.stdout.write(readFileSync(${JSON.stringify(helpFile)}, "utf8")); process.exit(0); }
const stdin = await Bun.stdin.text();
appendFileSync(${JSON.stringify(rec)}, JSON.stringify({ args, env: { ...process.env }, stdin, cwd: process.cwd(), cwdList: readdirSync(process.cwd()) }) + "\\n");
process.stdout.write(readFileSync(${JSON.stringify(answerFile)}, "utf8"));
`,
  );
  chmodSync(bin, 0o755);
  return { bin, rec, answerFile };
}

/** The CLI's JSON output carrying an answer in structured_output. */
export function cliOutput(answer: unknown): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "", session_id: "x", structured_output: answer });
}

export function makeWorld(o: { help?: string; env?: Record<string, string>; panels?: Panel[] } = {}): World {
  const home = tmp();
  const fake = fakeClaude(home, o.help);
  const panelsFile = join(home, "panels.json");
  writeFileSync(panelsFile, JSON.stringify({ panels: o.panels ?? PANELS }));
  const watcherDir = join(home, "watcher", INDEX);
  mkdirSync(watcherDir, { recursive: true });
  writeFileSync(join(watcherDir, "clocks.json"), JSON.stringify({ ...CLOCK, epochTs: String(CLOCK.epochTs), tPend: 600, closeGrace: 200, grace: 2400, holdMove: 16800, holdMin: 1800, step: 400, reopenWait: 600, qMin: 1, demoLabel: true, signAll: false, chainSelector: "0", chainId: 31337 }));
  const rawDir = join(home, "logger-raw");
  mkdirSync(rawDir);
  const cfg = loadConfig({ AGATE_WALL_HOME: home, AGATE_INDEXES: INDEX, AGATE_PANELS: panelsFile, AGATE_RAW_DIR: rawDir, AGATE_CLAUDE_BIN: fake.bin, AGATE_REPAIR_NOTIFY: "0", AGATE_REPO: "/repo/agate", ...o.env });
  const now = { t: EPOCH };
  const sinks = new Map<string, AlertSink>();
  const sink = (index: string | null) => {
    const k = index ?? "";
    let s = sinks.get(k);
    if (!s) sinks.set(k, (s = new AlertSink(join(home, "alerts", "alerts.jsonl"), { now: () => now.t, role: "repair", print: false, ...(index ? { index } : {}) })));
    return s;
  };
  return { home, cfg, watcherDir, rec: fake.rec, answerFile: fake.answerFile, sink, now };
}

export function spawnerOf(cfg: RepairConfig): Spawner {
  return new Spawner({ claude: cfg.claudeBin, sandbox: cfg.sandboxExec, bun: cfg.bun, tsc: cfg.tsc, osascript: cfg.osascript });
}

/** One watcher interval of a source: its log line and (when served) its raw page. */
export function writeInterval(w: World, sourceId: string, k: number, page: string | null, gpus: Partial<Record<GpuModel, number | "NO_ROW" | "NOT_RENTABLE" | "BAD_VALUE" | "FAILED">>, extra: Partial<WatcherReading> & { location?: string } = {}): void {
  const t = start(k) + 60;
  const g: WatcherReading["gpus"] = {};
  for (const [m, v] of Object.entries(gpus) as [GpuModel, number | string][]) g[m] = typeof v === "number" ? { state: "VALID", valueU: v } : { state: v as "NO_ROW", valueU: 0 };
  const sha = page ? new Bun.CryptoHasher("sha256").update(page).digest("hex") : "";
  const line = { sourceId, interval: k, scheduledAt: t, fetchedAt: t, attempts: 1, httpStatus: page ? 200 : 503, bytes: page?.length ?? 0, sha256: sha, gpus: g, ...extra };
  mkdirSync(join(w.watcherDir, "log"), { recursive: true });
  appendFileSync(join(w.watcherDir, "log", `${utcDate(start(k))}.jsonl`), `${JSON.stringify(line)}\n`);
  if (page && line.httpStatus >= 200 && line.httpStatus < 300) {
    const dir = join(w.watcherDir, "raw", utcDate(start(k)), String(k));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sourceId}.gz`), Bun.gzipSync(new TextEncoder().encode(page)));
  }
}

/** The page check's saved tracker files for interval k (GPUTable shape, synthetic numbers). */
export function writeTrackers(w: World, k: number, rows: { provider: string; gpu: string; usd: number; count?: number }[]): void {
  const dir = join(w.home, "pagecheck", INDEX.slice(2, 10), "raw", utcDate(start(k)), String(k));
  mkdirSync(dir, { recursive: true });
  const data = rows.map((r) => ({ gpu: r.gpu, provider: r.provider, gpu_count: r.count ?? 8, price_per_hour_usd: r.usd, pricing_type: "on_demand", commitment_months: null }));
  writeFileSync(join(dir, "gputable.all.gz"), Bun.gzipSync(new TextEncoder().encode(JSON.stringify({ generated_at: "x", data }))));
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ k, at: start(k) + 30 }));
}

export const LAMBDA_TRACKERS = (h100 = 3.99, b200 = 6.69) => [
  { provider: "Lambda Labs", gpu: "H100 SXM", usd: h100 },
  { provider: "Lambda Labs", gpu: "B200", usd: b200 },
];

export const okLambda = () => renderPage("p_lambda", LAMBDA_OK);
export const redesignedLambda = (p: SynthPage = LAMBDA_OK) => renderPage("p_lambda", p, { redesigned: true });

export function records(w: World): { args: string[]; env: Record<string, string>; stdin: string; cwd: string; cwdList: string[] }[] {
  try {
    return readFileSync(w.rec, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
