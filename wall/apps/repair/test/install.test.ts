// BUILD-SPEC 15.2 `repair install <draftId>`: refuses a non-TTY, a changed sha256 and an existing file; installs into
// a temporary copy of the sources package (never the real repo in a test); never runs git.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { install, SANDBOX_TESTS, UNSANDBOXED_TESTS } from "../src/install.ts";
import { Spawner } from "../src/spawn.ts";
import { GOOD_V2 } from "./canned.ts";
import { cleanup, tmp } from "./world.ts";

afterAll(cleanup);

const WALL = resolve(import.meta.dir, "../../..");
const MAC = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const DRAFT = "lambda-v2-1790000000-ab12";
const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

/** A wall/ with a copy of the sources package (the report package and modules linked, read only). */
function fakeWall(): string {
  const root = join(tmp("agate-wall-"), "wall");
  const src = join(WALL, "packages", "sources");
  const dst = join(root, "packages", "sources");
  mkdirSync(dst, { recursive: true });
  cpSync(join(src, "package.json"), join(dst, "package.json"));
  cpSync(join(src, "src"), join(dst, "src"), { recursive: true });
  cpSync(join(src, "test"), join(dst, "test"), { recursive: true });
  cpSync(join(src, "panels"), join(dst, "panels"), { recursive: true });
  symlinkSync(join(src, "node_modules"), join(dst, "node_modules"), "dir");
  symlinkSync(join(WALL, "packages", "report"), join(root, "packages", "report"), "dir");
  symlinkSync(join(WALL, "node_modules"), join(root, "node_modules"), "dir");
  cpSync(join(WALL, "package.json"), join(root, "package.json"));
  cpSync(join(WALL, "tsconfig.json"), join(root, "tsconfig.json"));
  return root;
}

function fakeRepair(source = GOOD_V2, noteSha = sha(GOOD_V2)): string {
  const dir = join(tmp("agate-home-"), "repair");
  const d = join(dir, "drafts", DRAFT);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "extractor.ts"), source);
  writeFileSync(join(d, "sha256"), `${sha(source)}\n`);
  writeFileSync(join(d, "gates.json"), JSON.stringify({ draftId: DRAFT, version: "lambda/2", sha256: sha(source), gates: {} }));
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(join(dir, "notes", "inc1.json"), JSON.stringify({ kind: "agate.repair-note", draft: { id: DRAFT, path: join(d, "extractor.ts"), sha256: noteSha }, incident: { sourceId: "p_lambda" } }));
  return dir;
}

function run(repairDir: string, wallRoot: string, isTTY = true) {
  const out: string[] = [];
  const spawner = new Spawner({ claude: "/nonexistent", sandbox: "/usr/bin/sandbox-exec", bun: "/usr/bin/false", tsc: join(WALL, "node_modules", ".bin", "tsc"), osascript: "/usr/bin/osascript" });
  const env = { PATH: `${process.env.PATH ?? ""}:/usr/bin:/bin`, HOME: process.env.HOME ?? "/tmp" };
  return { out, spawner, p: install({ draftId: DRAFT, repairDir, wallRoot, isTTY, spawner, env, out: (s) => out.push(s), bun: process.execPath }) };
}

describe("repair install", () => {
  test("refuses when stdin is not a TTY", async () => {
    const r = run(fakeRepair(), fakeWall(), false);
    expect(await r.p).toBe(1);
    expect(r.out[0]).toContain("not a TTY");
  });
  test("refuses a draft whose sha256 is not its note's", async () => {
    const r = run(fakeRepair(GOOD_V2, sha("something else")), fakeWall());
    expect(await r.p).toBe(1);
    expect(r.out[0]).toContain("the draft changed since its note");
  });
  test("refuses to overwrite an existing parser file", async () => {
    const wall = fakeWall();
    writeFileSync(join(wall, "packages", "sources", "src", "pure", "parsers", "lambda.v2.ts"), "// already here\n");
    const r = run(fakeRepair(), wall);
    expect(await r.p).toBe(1);
    expect(r.out[0]).toContain("never overwritten");
  });
  test("re-runs gate 1: an impure draft with a matching note is still refused", async () => {
    const bad = GOOD_V2.replace("export const extract", "const t = setTimeout;\nexport const extract");
    const r = run(fakeRepair(bad, sha(bad)), fakeWall());
    expect(await r.p).toBe(1);
    expect(r.out[0]).toContain("gate 1");
  }, 60_000);
  test.skipIf(!MAC)("installs: the parser file, its import and registry line, then the pure sources tests inside the sandbox and the next steps", async () => {
    const wall = fakeWall();
    const r = run(fakeRepair(), wall);
    const code = await r.p;
    if (code !== 0) console.log(r.out.join("\n"));
    expect(code).toBe(0);
    const parsers = join(wall, "packages", "sources", "src", "pure", "parsers");
    expect(readFileSync(join(parsers, "lambda.v2.ts"), "utf8")).toBe(GOOD_V2);
    const idx = readFileSync(join(parsers, "index.ts"), "utf8");
    expect(idx).toContain('import { extract as extractLambdaV2 } from "./lambda.v2.ts";\n\nexport const EXTRACTORS_BY_VERSION');
    expect(idx).toContain('  "lambda/2": { sourceId: "p_lambda", extract: extractLambdaV2 },\n  // repair:end');
    // tsc for gate 1, then the tests: only through sandbox-exec, with the 15.2 profile, never bun directly
    expect(r.spawner.log.map((x) => x.kind)).toEqual(["tsc", "sandbox"]);
    const argv = r.spawner.log[1]!.argv;
    expect(argv[1]).toBe("-p");
    expect(argv[2]).toContain("(deny network*)");
    expect(argv[2]).toContain("(deny process-exec*)");
    expect(argv[2]).toContain("(deny mach-lookup)");
    expect(argv.slice(3, 5)).toEqual([process.execPath, "test"]);
    expect(argv.slice(5)).toEqual(SANDBOX_TESTS.map((t) => join("packages", "sources", "test", `${t}.test.ts`)));
    const text = r.out.join("\n");
    expect(text).toContain("bun test (sandboxed: 8 pure test files of packages/sources): passed");
    expect(text).toContain("read the draft line by line before committing it");
    expect(text).toContain("next: run those tests and commit, then");
    expect(existsSync(join(WALL, "packages", "sources", "src", "pure", "parsers", "lambda.v2.ts"))).toBe(false); // the real repo untouched
  }, 60_000);
  test("every sources test file is either run in the sandbox or named as unsandboxed (a new one forces a decision)", () => {
    const files = readdirSync(join(WALL, "packages", "sources", "test")).filter((f) => f.endsWith(".test.ts")).map((f) => f.replace(/\.test\.ts$/, "")).sort();
    expect(files).toEqual([...SANDBOX_TESTS, ...UNSANDBOXED_TESTS].sort());
  });
  test.skipIf(!MAC)("a draft that escapes gate 1 still cannot reach the network or start a program from install's tests", async () => {
    // a canned draft with a matching note that would pass gate 1 is the case above; here the sandbox itself is shown
    // by a draft the test writes straight into a fake wall's registry (as if gate 1 had been fooled)
    const wall = fakeWall();
    const parsers = join(wall, "packages", "sources", "src", "pure", "parsers");
    const marker = join(tmp("agate-escape-"), "escaped.txt");
    writeFileSync(join(parsers, "evil.ts"), `try { (eval("Bun") as any).spawnSync(["/usr/bin/touch", ${JSON.stringify(marker)}]); } catch {}\nexport const x = 1;\n`);
    const idx = join(parsers, "index.ts");
    writeFileSync(idx, `import { x as evilX } from "./evil.ts";\nvoid evilX;\n${readFileSync(idx, "utf8")}`);
    const out = join(tmp("agate-out-"), "out");
    mkdirSync(out, { recursive: true });
    const { sandboxProfile } = await import("../src/sandbox.ts");
    const p = sandboxProfile({ draftDir: join(out, ".."), outDir: out, bun: process.execPath, wallRoot: wall, readDirs: [realpathSync(join(WALL, "packages", "report"))] });
    const r = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", p, process.execPath, "test", "packages/sources/test/readers.test.ts"], { cwd: wall, env: { PATH: "/usr/bin:/bin", HOME: out, TMPDIR: out, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdout: "pipe", stderr: "pipe" });
    expect(String(r.stderr)).toContain("pass");
    expect(existsSync(marker)).toBe(false);
  }, 60_000);
  test("never runs git (no code line names it; the spawn allowlist could not start it anyway)", () => {
    for (const f of ["install.ts", "cli.ts", "agent.ts", "spawn.ts"]) {
      const code = readFileSync(join(import.meta.dir, "../src", f), "utf8").split("\n").filter((l) => !l.trim().startsWith("//"));
      expect(`${f}: ${code.some((l) => /\bgit\b/.test(l))}`).toBe(`${f}: false`);
    }
  });
});
