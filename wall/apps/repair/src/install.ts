// `repair install <draftId>` (BUILD-SPEC 15.2), run by the operator from their checkout in a terminal: checks the draft
// against its approval note's sha256, re-runs gate 1, writes the parser file (never over an existing one), registers
// it between the repair markers, runs the sources package's pure tests inside the 15.2 sandbox (the draft is now in
// the registry they import) and prints the next steps. It never runs git.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gate1 } from "./gates.ts";
import { sandboxAvailable, sandboxProfile } from "./sandbox.ts";
import { draftFileName, nameOfVersion, prepareScratch, registryEdit } from "./scratch.ts";
import { sha256Hex } from "./pages.ts";
import type { Spawner } from "./spawn.ts";
import type { NoteJson } from "./note.ts";

/** The sources test files install runs in the sandbox: every one that needs no network and starts no program. */
export const SANDBOX_TESTS = ["readers", "parsers", "recipe", "money", "hostile", "launch-panel", "archive", "ecb"] as const;
/** The others open a local server or start tsc: they run at the commit review, after the operator has read the draft. */
export const REVIEW_ONLY_TESTS = ["io", "pure", "replay", "replay-upgrades"] as const;

export interface InstallOptions {
  draftId: string;
  repairDir: string; // <AGATE_WALL_HOME>/repair
  wallRoot: string; // the checkout's wall/
  isTTY: boolean;
  spawner: Spawner;
  env: Record<string, string>;
  out: (line: string) => void;
  /** the bun binary the sandbox may start (default: this process's) */
  bun?: string;
  sandboxExec?: string;
}

/** The approval note that names this draft, or null. */
export function noteOfDraft(repairDir: string, draftId: string): NoteJson | null {
  const dir = join(repairDir, "notes");
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    try {
      const n = JSON.parse(readFileSync(join(dir, f), "utf8")) as NoteJson;
      if (n.draft?.id === draftId) return n;
    } catch {
      // skip
    }
  }
  return null;
}

export async function install(o: InstallOptions): Promise<number> {
  const fail = (why: string) => {
    o.out(`repair install: refused: ${why}`);
    return 1;
  };
  if (!o.isTTY) return fail("run it by hand in a terminal (stdin is not a TTY)");
  if (!/^[a-z][a-z0-9]*-v\d+-\d+-[0-9a-f]{4}$/.test(o.draftId)) return fail("not a draft id");
  const draftDir = join(o.repairDir, "drafts", o.draftId);
  const srcPath = join(draftDir, "extractor.ts");
  if (!existsSync(srcPath)) return fail(`no draft at ${draftDir}`);
  const source = readFileSync(srcPath, "utf8");
  const sha = sha256Hex(source);
  const note = noteOfDraft(o.repairDir, o.draftId);
  if (!note?.draft) return fail("no approval note names this draft");
  if (note.draft.sha256 !== sha) return fail(`the draft changed since its note (sha256 ${sha} is not the note's ${note.draft.sha256})`);
  const gates = JSON.parse(readFileSync(join(draftDir, "gates.json"), "utf8")) as { version: string; sha256: string };
  if (gates.sha256 !== sha) return fail("the draft changed since its gates ran");
  const nv = nameOfVersion(gates.version);
  const sourceId = note.incident.sourceId;
  if (!nv || nv.n < 2) return fail(`odd version ${gates.version}`);
  const sources = join(o.wallRoot, "packages", "sources");
  if (!sandboxAvailable(o.sandboxExec ?? "/usr/bin/sandbox-exec")) return fail("no sandbox (sandbox-exec is missing): the tests that load the draft run only inside it");
  const testFiles = SANDBOX_TESTS.map((t) => join("packages", "sources", "test", `${t}.test.ts`));
  const missing = testFiles.filter((f) => !existsSync(join(o.wallRoot, f)));
  if (missing.length) return fail(`the sources tests are missing (${missing.join(", ")})`);
  const target = join(sources, "src", "pure", "parsers", draftFileName(nv.name, nv.n));
  if (existsSync(target)) return fail(`${target} already exists (never overwritten)`);
  const indexPath = join(sources, "src", "pure", "parsers", "index.ts");
  let edited: string;
  try {
    edited = registryEdit(readFileSync(indexPath, "utf8"), nv.name, nv.n, sourceId);
  } catch (e) {
    return fail((e as Error).message);
  }
  // gate 1 again, on a fresh scratch copy of this checkout's sources package
  const check = mkdtempSync(join(draftDir, "install-check-"));
  try {
    const pkg = prepareScratch(o.wallRoot, check, nv.name, nv.n, sourceId, source).pkg;
    const g1 = await gate1(o.spawner, source, pkg, o.env);
    if (!g1.ok) return fail(`gate 1: ${g1.why}`);
  } catch (e) {
    return fail(`gate 1: ${(e as Error).message}`);
  } finally {
    rmSync(check, { recursive: true, force: true });
  }
  writeFileSync(target, source);
  writeFileSync(indexPath, edited);
  o.out(`wrote ${target}`);
  o.out(`registered ${gates.version} for ${sourceId} in ${indexPath}`);
  // the draft runs here for the first time outside the gates: inside the same sandbox, writing only to out/
  const out = join(draftDir, "install-out");
  mkdirSync(out, { recursive: true });
  const bun = o.bun ?? process.execPath;
  const profile = sandboxProfile({ draftDir, outDir: out, bun, wallRoot: o.wallRoot, readDirs: moduleTargets(sources) });
  const t = await o.spawner.run("sandbox", ["-p", profile, bun, "test", ...testFiles], { cwd: o.wallRoot, env: { PATH: "/usr/bin:/bin", HOME: out, TMPDIR: out, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, timeoutMs: 600_000, maxStdout: 256 * 1024 });
  const tail = `${t.stdout}\n${t.stderr}`.trim().split("\n").slice(-6).join("\n");
  o.out(`bun test (sandboxed: ${SANDBOX_TESTS.length} pure test files of packages/sources): ${t.code === 0 ? "passed" : `FAILED (exit ${t.code})`}`);
  o.out(tail);
  o.out(`not run here (they open a local server or start a program): ${REVIEW_ONLY_TESTS.map((x) => `${x}.test.ts`).join(", ")}; the commit review runs them with the draft loaded and unsandboxed`);
  o.out("the gates are a filter, not a proof: read the draft line by line before the commit review (once committed it runs inside the writers and the watcher, beside their keys)");
  o.out("next: review and commit, then copy the committed wall/ to the launchd app copy and restart the readers (note step 5), then execute after eta (note step 6)");
  return t.code === 0 ? 0 : 1;
}

/** Where the sources package's modules really live (a test's copy links them from elsewhere): read only. */
function moduleTargets(sources: string): string[] {
  const nm = join(sources, "node_modules");
  if (!existsSync(nm)) return [];
  const out: string[] = [realpathSync(nm)];
  for (const e of readdirSync(nm)) {
    if (e.startsWith(".")) continue;
    const p = join(nm, e);
    if (e.startsWith("@")) for (const c of readdirSync(p)) out.push(realpathSync(join(p, c)));
    else out.push(realpathSync(p));
  }
  return [...new Set(out)];
}
