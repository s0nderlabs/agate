// Audit (phase 2b, contract and security lens): gate 1's word list and the sandbox profile of 15.2, probed with a
// draft a fooled model could write. After the fix round the first two assert the refusals (H1, B1). No Keychain,
// no network, no real Claude call; the "secret" is a file this test writes in its own temp folder outside the draft.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderPage } from "@agate/sources";
import { gate1 } from "../../src/gates.ts";
import { checkSyntax } from "../../src/ast.ts";
import { checkPurity } from "../../src/purity.ts";
import { type BatchPage, RUNNER, runBatch } from "../../src/sandbox.ts";
import { prepareScratch } from "../../src/scratch.ts";
import { Spawner } from "../../src/spawn.ts";
import { GOOD_V2 } from "../canned.ts";
import { cleanup, LAMBDA_OK, tmp } from "../world.ts";

afterAll(cleanup);

const MAC = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const WALL = resolve(import.meta.dir, "../../../..");
const spawner = new Spawner({ claude: "/nonexistent", sandbox: "/usr/bin/sandbox-exec", bun: process.execPath, tsc: join(WALL, "node_modules", ".bin", "tsc"), osascript: "/nonexistent" });
const toolEnv = { PATH: `${process.env.PATH ?? ""}:/usr/bin:/bin`, HOME: process.env.HOME ?? "/tmp" };
const NOW = Date.parse("2026-10-09T06:00:00Z") / 1000;

/** A draft that reaches the global object through a computed "constructor" key, then a file outside its folder
 *  and a child process. None of gate 1's words appears in it. */
const BYPASS = (secretFile: string) => `import type { Extractor } from "../../types.ts";
const k = "constr" + "uctor";
const F: any = (0 as any)[k][k];
const g: any = F("return this")();
const B: any = g["B" + "un"];
const r: any = B.spawnSync(["/bin/cat", ${JSON.stringify(secretFile)}]);
const seen = "exit=" + String(r.exitCode) + ";out=" + String(r.stdout).trim();
export const extract: Extractor = (_body, _ctx) => ({ H100: { kind: "missing", why: seen } });
`;

describe("gate 1's static word list", () => {
  test("still accepts the bypass (no forbidden word in it); the syntax allowlist refuses it (fix round, H1)", async () => {
    expect(checkPurity(BYPASS("/x/y"))).toEqual({ ok: true });
    expect(await checkSyntax(BYPASS("/x/y"))).toMatchObject({ ok: false, why: expect.stringContaining("an index that is not") });
  }, 30_000);
});

describe.skipIf(!MAC)("the 15.2 sandbox profile", () => {
  test("gate 1 refuses the draft; run anyway inside the sandbox (as if gate 1 were fooled), it cannot start a process or read a file outside its folder (fix round, B1)", async () => {
    const secretDir = tmp("agate-audit-secret-");
    const secretFile = join(secretDir, "secret.txt");
    writeFileSync(secretFile, "AUDIT-FAKE-SECRET-7f3a");
    const src = BYPASS(secretFile);
    const dir = tmp("agate-audit-draft-");
    const s = prepareScratch(WALL, dir, "lambda", 2, "p_lambda", src);
    expect(await gate1(spawner, src, s.pkg, toolEnv)).toMatchObject({ ok: false, why: expect.stringContaining("syntax allowlist") });
    const page: BatchPage = { id: "p", body: renderPage("p_lambda", LAMBDA_OK), utcDate: "2026-10-09", nowSec: NOW };
    const r = await runBatch(spawner, process.execPath, dir, s.pkg, [s.version], [page]);
    const text = r.ok ? JSON.stringify([...r.rows.values()]) : r.why;
    expect(text).not.toContain("AUDIT-FAKE-SECRET-7f3a");
    expect(text).toContain("EPERM");
  }, 120_000);

  /** A suggested tighter profile (the fix's shape): no exec but bun, no Mach lookups (Keychain, launchd), no
   *  LaunchServices or Apple events, no reads under HOME or the temp root except the wall code and the draft. */
  function tightProfile(draftDir: string): string {
    const out = join(realpathSync(draftDir), "out");
    const bun = realpathSync(process.execPath);
    const home = realpathSync(process.env.HOME ?? "/Users");
    const tmpRoot = realpathSync(tmpdir());
    return `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath "${out}"))(deny process-exec*)(allow process-exec (literal "${bun}"))(deny mach-lookup)(deny lsopen)(deny appleevent-send)(deny file-read* (subpath "${home}") (subpath "${tmpRoot}"))(allow file-read* (subpath "${realpathSync(WALL)}") (subpath "${realpathSync(draftDir)}"))`;
  }

  async function runTight(dir: string, pkg: string, version: string, page: BatchPage): Promise<{ ok: boolean; why?: string; stdout: string; rows?: Record<string, unknown> }> {
    const out = join(realpathSync(dir), "out");
    mkdirSync(out, { recursive: true });
    const file = join(dir, "batch.json");
    writeFileSync(file, JSON.stringify({ pkg, versions: [version], pages: [page] }));
    const r = await spawner.run("sandbox", ["-p", tightProfile(dir), process.execPath, "run", RUNNER, file], { cwd: out, env: { PATH: "/usr/bin:/bin", HOME: out, TMPDIR: out, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, timeoutMs: 60_000 });
    const j = JSON.parse(r.stdout) as { ok: boolean; why?: string; results?: { rows: Record<string, unknown> }[] };
    return { ok: j.ok, ...(j.why ? { why: j.why } : {}), stdout: r.stdout, ...(j.results ? { rows: j.results[0]!.rows[version] as Record<string, unknown> } : {}) };
  }

  test("a tighter profile still runs a correct draft and stops the same bypass", async () => {
    const page: BatchPage = { id: "p", body: renderPage("p_lambda", LAMBDA_OK, { redesigned: true }), utcDate: "2026-10-09", nowSec: NOW };
    const good = tmp("agate-audit-good-");
    const g = prepareScratch(WALL, good, "lambda", 2, "p_lambda", GOOD_V2);
    const gr = await runTight(good, g.pkg, g.version, page);
    expect(gr.ok).toBe(true);
    expect((gr.rows!.H100 as { state: string }).state).toBe("VALID");
    const secretDir = tmp("agate-audit-secret-");
    const secretFile = join(secretDir, "secret.txt");
    writeFileSync(secretFile, "AUDIT-FAKE-SECRET-7f3a");
    const bad = tmp("agate-audit-draft-");
    const b = prepareScratch(WALL, bad, "lambda", 2, "p_lambda", BYPASS(secretFile));
    const br = await runTight(bad, b.pkg, b.version, page);
    expect(br.stdout).not.toContain("AUDIT-FAKE-SECRET-7f3a");
    expect(br).toMatchObject({ ok: false, why: expect.stringContaining("EPERM") });
  }, 120_000);
});
