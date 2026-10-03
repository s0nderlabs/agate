// The repair agent's environment (BUILD-SPEC 15.2). It holds no key: it refuses to start when any *_KEY, *_KEY_CMD,
// CRE_ETH_PRIVATE_KEY or ANTHROPIC_API_KEY variable is set (the last so `claude -p` uses Claude Code's own
// sign-in, never an API key).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { keyVars } from "@agate/pagecheck";
import type { Panel } from "@agate/sources/types";

export interface Budgets {
  perIncident: number;
  perDay: number;
  timeoutS: number;
}

export interface RepairConfig {
  home: string;
  dir: string; // <home>/repair
  indexes: string[]; // lowercase addresses
  panels: Record<string, Panel[]>; // by lowercase index
  rawDir: string; // the logger archive (read only)
  claudeBin: string;
  model?: string;
  budgets: Budgets;
  repo: string; // the operator's checkout, for the note's commands
  wallRoot: string; // the wall/ this code runs from (the installed app copy under launchd)
  bun: string;
  tsc: string;
  sandboxExec: string;
  osascript: string;
  notify: boolean;
  notifyCmd?: string;
  logDirOf(index: string): string;
}

export const index8 = (index: string) => index.slice(2, 10).toLowerCase();

export function refuseKeys(env: Record<string, string | undefined>): void {
  const bad = keyVars(env, ["ANTHROPIC_API_KEY"]);
  if (bad.length > 0) throw new Error(`the repair agent holds no key and refuses to start with ${bad.join(", ")} set (BUILD-SPEC 15.2)`);
}

function loadPanels(path: string): Panel[] {
  const j = JSON.parse(readFileSync(path, "utf8")) as Panel[] | { panels: Panel[] };
  const panels = Array.isArray(j) ? j : j.panels;
  if (!Array.isArray(panels) || panels.length === 0) throw new Error(`${path}: no panels`);
  return panels;
}

const int = (v: string | undefined, d: number, name: string) => {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a whole number`);
  return n;
};

export function loadConfig(env: Record<string, string | undefined>, wallRoot = resolve(import.meta.dir, "../../..")): RepairConfig {
  refuseKeys(env);
  const home = env.AGATE_WALL_HOME || join(homedir(), ".agate-wall");
  const indexes = (env.AGATE_INDEXES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (indexes.length === 0) throw new Error("set AGATE_INDEXES (the comma-separated index addresses the agent serves)");
  for (const i of indexes) if (!/^0x[0-9a-f]{40}$/.test(i)) throw new Error("AGATE_INDEXES: every entry must be an address");
  const panels: Record<string, Panel[]> = {};
  for (const i of indexes) {
    const p = env[`AGATE_PANELS_${index8(i)}`] || env.AGATE_PANELS;
    if (!p) throw new Error(`set AGATE_PANELS (or AGATE_PANELS_${index8(i)})`);
    panels[i] = loadPanels(p);
  }
  const cfg: RepairConfig = {
    home,
    dir: join(home, "repair"),
    indexes,
    panels,
    rawDir: env.AGATE_RAW_DIR || join(homedir(), ".agate-index-logger", "data", "raw"),
    claudeBin: env.AGATE_CLAUDE_BIN || "claude",
    budgets: {
      perIncident: int(env.AGATE_REPAIR_MAX_CALLS_INCIDENT, 3, "AGATE_REPAIR_MAX_CALLS_INCIDENT"),
      perDay: int(env.AGATE_REPAIR_MAX_CALLS_DAY, 8, "AGATE_REPAIR_MAX_CALLS_DAY"),
      timeoutS: int(env.AGATE_REPAIR_CLAUDE_TIMEOUT_S, 600, "AGATE_REPAIR_CLAUDE_TIMEOUT_S"),
    },
    repo: env.AGATE_REPO || resolve(wallRoot, ".."),
    wallRoot,
    bun: process.execPath,
    tsc: join(wallRoot, "node_modules", ".bin", "tsc"),
    sandboxExec: "/usr/bin/sandbox-exec",
    osascript: "/usr/bin/osascript",
    notify: env.AGATE_REPAIR_NOTIFY !== "0" && process.platform === "darwin" && existsSync("/usr/bin/osascript"),
    logDirOf: (index: string) => env[`AGATE_WATCHER_LOG_DIR_${index8(index)}`] || join(home, "watcher", index.toLowerCase()),
  };
  if (env.AGATE_REPAIR_MODEL) cfg.model = env.AGATE_REPAIR_MODEL;
  if (env.AGATE_NOTIFY_CMD) cfg.notifyCmd = env.AGATE_NOTIFY_CMD;
  return cfg;
}
