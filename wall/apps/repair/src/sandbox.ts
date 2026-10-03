// The sandbox a draft runs in (BUILD-SPEC 15.2): never in the agent's process, a writer or the watcher; only as
// `sandbox-exec -p '<PROFILE>' <bun> run runner.ts <batch file>` with no network, no file writes outside the draft's
// out folder, no program but bun, no Mach lookups (so no Keychain and no launchd), no LaunchServices opens or Apple
// events, no signals to other processes, and no reads under the home folder, /Users, /Volumes or the temp roots
// except the wall code it needs, the draft folder and the batch's own pages. A tiny environment, a 60 s timeout per
// batch (then killed) and stdout capped at 4 MB.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ParseResult } from "@agate/sources/types";
import type { Spawner } from "./spawn.ts";

export const BATCH_TIMEOUT_MS = 60_000;
export const STDOUT_CAP = 4 * 1024 * 1024;
export const RUNNER = join(import.meta.dir, "runner.ts");
/** The wall/ this code runs from (the checkout, or the launchd app copy). */
export const WALL_ROOT = resolve(import.meta.dir, "../../..");

const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));

function quoted(p: string): string {
  if (/["\\\n\r]/.test(p)) throw new Error(`a sandbox path holds a quote, a backslash or a newline: ${JSON.stringify(p.slice(0, 80))}`);
  return `"${p}"`;
}

export interface ProfileOptions {
  /** where the draft may write (and read): its out folder is <writeDir>/out unless `outDir` says otherwise */
  draftDir: string;
  outDir?: string;
  bun: string;
  /** extra files the run may read (the batch's pages), by real path */
  readFiles?: readonly string[];
  /** extra folders the run may read */
  readDirs?: readonly string[];
  wallRoot?: string;
}

/** The sandbox profile of 15.2 (fix round Oct 3, audit B1): later rules win, so the read allowances come last. */
export function sandboxProfile(o: ProfileOptions): string {
  const wall = real(o.wallRoot ?? WALL_ROOT);
  const draft = real(o.draftDir);
  const out = o.outDir ? real(o.outDir) : join(draft, "out");
  const bun = real(o.bun);
  const home = real(homedir());
  const denyRoots = [...new Set([home, "/Users", "/Volumes", "/private/tmp", "/private/var/folders", real(tmpdir())])];
  const allowDirs = [...new Set([join(wall, "packages"), join(wall, "node_modules"), join(wall, "apps", "repair"), draft, ...(o.readDirs ?? [])].map(real))];
  // the wall folder itself (bun lists it), its root config files, and the batch's pages
  const allowFiles = [wall, join(wall, "package.json"), join(wall, "tsconfig.json"), join(wall, "bunfig.toml"), ...(o.readFiles ?? []).map(real)];
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*)",
    `(allow file-write* (subpath ${quoted(out)}))`,
    "(deny process-exec*)",
    `(allow process-exec (literal ${quoted(bun)}))`,
    "(deny mach-lookup)",
    "(deny lsopen)",
    "(deny appleevent-send)",
    "(deny signal)",
    "(allow signal (target self))",
    `(deny file-read* ${denyRoots.map((p) => `(subpath ${quoted(p)})`).join(" ")})`,
    `(allow file-read* ${allowDirs.map((p) => `(subpath ${quoted(p)})`).join(" ")} ${allowFiles.map((p) => `(literal ${quoted(p)})`).join(" ")})`,
  ].join("");
}

/** The profile for one draft folder and the pages of one batch (a real path: macOS resolves /tmp to /private/tmp). */
export function profileFor(draftDir: string, bun = process.execPath, pages: readonly string[] = []): string {
  return sandboxProfile({ draftDir, bun, readFiles: pages });
}

export interface BatchPage {
  id: string;
  file?: string; // a saved page (gzipped when it ends .gz)
  body?: string; // a synthetic page (gate 4 fixtures)
  utcDate: string;
  nowSec: number;
}

export type BatchResult = { ok: true; rows: Map<string, Record<string, ParseResult | { error: string }>> } | { ok: false; why: string };

export function sandboxAvailable(sandboxExec: string): boolean {
  return process.platform === "darwin" && existsSync(sandboxExec);
}

let seq = 0;

/** Parses every page with every version inside the sandbox. */
export async function runBatch(spawner: Spawner, bun: string, draftDir: string, pkg: string, versions: readonly string[], pages: readonly BatchPage[], timeoutMs = BATCH_TIMEOUT_MS): Promise<BatchResult> {
  const out = join(realpathSync(draftDir), "out");
  mkdirSync(out, { recursive: true });
  const dir = join(draftDir, "batches");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${Date.now()}-${process.pid}-${++seq}.json`);
  writeFileSync(file, JSON.stringify({ pkg, versions, pages }));
  let r;
  try {
    const files = pages.flatMap((p) => (p.file ? [p.file] : []));
    r = await spawner.run("sandbox", ["-p", profileFor(draftDir, bun, files), bun, "run", RUNNER, file], {
    cwd: out,
    env: { PATH: "/usr/bin:/bin", HOME: out, TMPDIR: out, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    timeoutMs,
    maxStdout: STDOUT_CAP,
  });
  } catch (e) {
    return { ok: false, why: `the sandbox could not be started (${(e as Error).message.slice(0, 80)})` };
  }
  if (r.timedOut) return { ok: false, why: `the sandboxed run did not finish within ${Math.round(timeoutMs / 1000)} s (killed)` };
  if (r.truncated) return { ok: false, why: "the sandboxed run printed more than 4 MB" };
  let j: { ok?: boolean; why?: string; results?: { id: string; rows: Record<string, ParseResult | { error: string }> }[] };
  try {
    j = JSON.parse(r.stdout);
  } catch {
    return { ok: false, why: `the sandboxed run printed no result (exit ${r.code}; ${r.stderr.split("\n").find((l) => l.trim())?.slice(0, 160) ?? "no message"})` };
  }
  if (!j.ok || !Array.isArray(j.results)) return { ok: false, why: `the sandboxed run failed: ${String(j.why ?? "no results").slice(0, 200)}` };
  return { ok: true, rows: new Map(j.results.map((x) => [x.id, x.rows])) };
}
