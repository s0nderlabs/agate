// BUILD-SPEC 15.2: gate 1's typecheck, the sandbox (macOS only: sandbox-exec), and gates 2 to 4 on synthetic pages,
// including the replay's redesigned Lambda layout (7.9): a correct v2 passes, a v2 reading the spot cell fails gate 3.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { renderPage } from "@agate/sources";
import { fixturePages, gate1, gate2, gate3, gate4, type RunCtx } from "../src/gates.ts";
import { profileFor, runBatch, sandboxProfile, type BatchPage } from "../src/sandbox.ts";
import { prepareScratch } from "../src/scratch.ts";
import { Spawner } from "../src/spawn.ts";
import { ESCAPE_V2, GOOD_V2, LOOP_V2, NEW_ONLY_V2, SPOT_V2 } from "./canned.ts";
import { cleanup, LAMBDA_OK, tmp } from "./world.ts";

afterAll(cleanup);

const MAC = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const WALL = resolve(import.meta.dir, "../../..");
const spawner = new Spawner({ claude: "/nonexistent", sandbox: "/usr/bin/sandbox-exec", bun: process.execPath, tsc: join(WALL, "node_modules", ".bin", "tsc"), osascript: "/usr/bin/osascript" });
const toolEnv = { PATH: `${process.env.PATH ?? ""}:/usr/bin:/bin`, HOME: process.env.HOME ?? "/tmp" };
const NOW = Date.parse("2026-10-09T06:00:00Z") / 1000;
const DATE = "2026-10-09";

function draft(source: string): RunCtx & { version: string } {
  const dir = tmp("agate-draft-");
  const s = prepareScratch(WALL, dir, "lambda", 2, "p_lambda", source);
  return { spawner, bun: process.execPath, draftDir: dir, pkg: s.pkg, version: s.version };
}

const page = (id: string, body: string): BatchPage => ({ id, body, utcDate: DATE, nowSec: NOW });
const oldPages = [page("old-1", renderPage("p_lambda", LAMBDA_OK)), page("old-2", renderPage("p_lambda", { H100: { price: "3.99", count: 1 }, B200: { state: "not-rentable" } })), page("old-3", renderPage("p_lambda", { H100: { price: "4.29", count: 8 } }))];
const newPages = [1, 2, 3].map((i) => page(`new-${i}`, renderPage("p_lambda", LAMBDA_OK, { redesigned: true })));
const trackers = (_id: string, g: string) => (g === "H100" ? 3_990_000 : 6_690_000);

describe("the scratch copy and gate 1's typecheck", () => {
  test("the good draft typechecks under the pure settings; a draft with a type error does not", async () => {
    const d = draft(GOOD_V2);
    expect(await gate1(spawner, GOOD_V2, d.pkg, toolEnv)).toMatchObject({ ok: true });
    const bad = GOOD_V2.replace("export const extract: Extractor = (body, _ctx) =>", "export const extract: Extractor = (body: number, _ctx) =>");
    const e = draft(bad);
    expect(await gate1(spawner, bad, e.pkg, toolEnv)).toMatchObject({ ok: false, why: expect.stringContaining("does not typecheck") });
  }, 60_000);
  test("a Node API in the draft does not typecheck (no Node, Bun or DOM types)", async () => {
    const src = 'import type { Extractor } from "../../types.ts";\nexport const extract: Extractor = (body) => { const b = Buffer.from(body); return b.length ? {} : {}; };\n';
    const d = draft(src);
    expect((await gate1(spawner, src, d.pkg, toolEnv)).ok).toBe(false);
  }, 60_000);
});

describe.skipIf(!MAC)("the sandbox (macOS)", () => {
  test("the profile denies the network, writes outside out/, programs but bun, Mach lookups, LaunchServices, Apple events, signals and reads outside its folders", () => {
    const d = tmp("agate-draft-");
    const p = profileFor(d, process.execPath, ["/private/var/folders/x/page.gz"]);
    expect(p).toMatch(/^\(version 1\)\(allow default\)\(deny network\*\)\(deny file-write\*\)\(allow file-write\* \(subpath "\/private\/[^"]*\/out"\)\)\(deny process-exec\*\)\(allow process-exec \(literal "[^"]*bun"\)\)\(deny mach-lookup\)\(deny lsopen\)\(deny appleevent-send\)\(deny signal\)\(allow signal \(target self\)\)\(deny file-read\* /);
    expect(p).toContain(`(subpath "${realpathSync(homedir())}")`);
    expect(p).toContain('(subpath "/Users") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders")');
    expect(p).toContain(`(subpath "${realpathSync(WALL)}/packages") (subpath "${realpathSync(WALL)}/node_modules") (subpath "${realpathSync(WALL)}/apps/repair") (subpath "${realpathSync(d)}")`);
    expect(p).toContain('(literal "/private/var/folders/x/page.gz")');
    expect(p.endsWith(")")).toBe(true);
    expect(() => profileFor(join(tmp("agate-draft-"), 'a"b'))).toThrow("quote");
  });
  test("a draft that loops is killed at the timeout", async () => {
    const d = draft(LOOP_V2);
    const t0 = Date.now();
    const r = await runBatch(spawner, process.execPath, d.draftDir, d.pkg, [d.version], [page("p", renderPage("p_lambda", LAMBDA_OK))], 3_000);
    expect(r).toMatchObject({ ok: false, why: expect.stringContaining("killed") });
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 30_000);
  test("a draft that opens a socket or writes a file is stopped by the sandbox", async () => {
    let hits = 0;
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => (hits++, new Response("ok")) });
    try {
      const outside = join(tmp("agate-outside-"), "escaped.txt");
      const d = draft(ESCAPE_V2(srv.port!, outside));
      await runBatch(spawner, process.execPath, d.draftDir, d.pkg, [d.version], [page("p", "x")], 20_000);
      expect(hits).toBe(0);
      expect(existsSync(outside)).toBe(false);
      // control: the same code outside the sandbox does reach the server (the test is not vacuous)
      const res = await fetch(`http://127.0.0.1:${srv.port}/control`);
      expect(res.status).toBe(200);
      expect(hits).toBe(1);
    } finally {
      srv.stop(true);
    }
  }, 30_000);
  test("the environment inside is only PATH, HOME, TMPDIR and the transpiler cache switch", async () => {
    // this fixture bypasses gate 1 on purpose (eval inside the sandboxed child only) to read the environment it gets
    const src = 'import type { Extractor } from "../../types.ts";\nexport const extract: Extractor = (_b, _c) => ({ H100: { kind: "missing", why: Object.keys(eval("process").env).sort().join(",") } });\n';
    const d = draft(src);
    const r = await runBatch(spawner, process.execPath, d.draftDir, d.pkg, [d.version], [page("p", renderPage("p_lambda", LAMBDA_OK))]);
    if (!r.ok) throw new Error(r.why);
    const row = (r.rows.get("p")![d.version] as Record<string, { detail?: string }>).H100!;
    expect(row.detail).toBe("missing-row: BUN_RUNTIME_TRANSPILER_CACHE_PATH,HOME,PATH,TMPDIR");
  }, 30_000);
});

/** A probe that bypasses gate 1 on purpose (eval inside the sandboxed child only) and reports what one step did. */
const PROBE = (code: string) => `import type { Extractor } from "../../types.ts";
const B: any = eval("Bun");
const P: any = eval("process");
const FS: any = P.getBuiltinModule("fs");
let seen = "";
try { seen = String(${code}); } catch (e) { seen = "threw: " + String((e as Error).message).slice(0, 160); }
export const extract: Extractor = (_b, _c) => ({ H100: { kind: "missing", why: seen } });
`;

async function probe(code: string): Promise<string> {
  const d = draft(PROBE(code));
  const r = await runBatch(spawner, process.execPath, d.draftDir, d.pkg, [d.version], [page("p", renderPage("p_lambda", LAMBDA_OK))]);
  if (!r.ok) throw new Error(r.why);
  return String((r.rows.get("p")![d.version] as Record<string, { detail?: string }>).H100!.detail).replace(/^missing-row: /, "");
}

describe.skipIf(!MAC)("the tightened sandbox", () => {
  test("a draft cannot start a program", async () => {
    const seen = await probe('(() => { const r = B.spawnSync(["/bin/echo", "escaped-7f3a"]); return "exit=" + r.exitCode + ";out=" + String(r.stdout); })()');
    expect(seen).not.toContain("escaped-7f3a");
    expect(seen).toMatch(/EPERM|threw|exit=(?!0)/);
  }, 30_000);
  test("a draft cannot read a file outside its folder: in the temp root, or under the home folder (the wall's other apps)", async () => {
    const secretFile = join(tmp("agate-secret-"), "secret.txt");
    writeFileSync(secretFile, "FAKE-SECRET-7f3a");
    const a = await probe(`FS.readFileSync(${JSON.stringify(secretFile)}, "utf8")`);
    expect(a).not.toContain("FAKE-SECRET-7f3a");
    expect(a).toContain("threw");
    const other = join(WALL, "apps", "watcher", "package.json");
    expect(existsSync(other)).toBe(true);
    const b = await probe(`FS.readFileSync(${JSON.stringify(other)}, "utf8")`);
    expect(b).toContain("threw");
    expect(b).not.toContain("@agate/watcher");
    // control: the sandbox does let it read its own folder
    expect(await probe('FS.readFileSync("../extractor-check.txt", "utf8")')).toContain("threw"); // absent file
  }, 60_000);
  test("a draft cannot signal another process", async () => {
    const sleeper = Bun.spawn(["/bin/sleep", "30"]);
    try {
      const seen = await probe(`(() => { P.kill(${sleeper.pid}, "SIGTERM"); return "signalled"; })()`);
      expect(seen).not.toBe("signalled");
      expect(seen).toContain("threw");
      await Bun.sleep(200);
      expect(sleeper.exitCode).toBeNull(); // still running
    } finally {
      sleeper.kill();
    }
  }, 30_000);
  test("Mach lookups are denied: even a program allowed to run could not reach securityd (the Keychain)", async () => {
    // the real profile plus exec of /usr/bin/security; the control drops only the Mach deny
    const d = tmp("agate-mach-");
    mkdirSync(join(d, "out"), { recursive: true });
    const real = `${sandboxProfile({ draftDir: d, bun: process.execPath })}(allow process-exec (literal "/usr/bin/security"))`;
    const control = real.replace("(deny mach-lookup)", "");
    expect(control).not.toBe(real);
    // list-keychains names the search list only: no item is read
    const run = (p: string) => Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", p, "/usr/bin/security", "list-keychains"], { env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" }).exitCode;
    if (!existsSync("/usr/bin/security")) return;
    expect(run(control)).toBe(0);
    expect(run(real)).not.toBe(0);
  }, 30_000);
});

describe.skipIf(!MAC)("gates 2 to 4 on synthetic pages (redesigned Lambda, 7.9)", () => {
  test("the v1 reader reads the redesigned layout as NO_ROW for every GPU (the incident)", async () => {
    const d = draft(GOOD_V2);
    const r = await runBatch(spawner, process.execPath, d.draftDir, d.pkg, ["lambda/1"], newPages.slice(0, 1));
    if (!r.ok) throw new Error(r.why);
    const rows = r.rows.get("new-1")!["lambda/1"] as Record<string, { state: string }>;
    expect([rows.H100!.state, rows.B200!.state]).toEqual(["NO_ROW", "NO_ROW"]);
  }, 30_000);
  test("a correct v2 passes gates 2, 3 and 4", async () => {
    const d = draft(GOOD_V2);
    expect(await gate2(d, d.version, "lambda/1", ["H100", "B200"], oldPages)).toMatchObject({ ok: true, detail: "3 of 3 saved pages from before the incident read the same" });
    expect(await gate3(d, d.version, ["H100", "B200"], newPages, trackers)).toMatchObject({ ok: true });
    expect(await gate4(d, d.version, "lambda/1", ["H100", "B200"], fixturePages("p_lambda", NOW))).toMatchObject({ ok: true });
  }, 60_000);
  test("a v2 reading the spot cell fails gate 3", async () => {
    const d = draft(SPOT_V2);
    expect(await gate2(d, d.version, "lambda/1", ["H100", "B200"], oldPages)).toMatchObject({ ok: true });
    expect(await gate3(d, d.version, ["H100", "B200"], newPages, trackers)).toMatchObject({ ok: false, why: expect.stringContaining("more than 10% from the trackers") });
  }, 60_000);
  test("a v2 that forgot the old layout fails gate 2; gate 3 needs three new pages and a tracker value", async () => {
    const d = draft(NEW_ONLY_V2);
    expect(await gate2(d, d.version, "lambda/1", ["H100", "B200"], oldPages)).toMatchObject({ ok: false, why: expect.stringContaining("old-1") });
    const g = draft(GOOD_V2);
    expect(await gate3(g, g.version, ["H100", "B200"], newPages.slice(0, 2), trackers)).toMatchObject({ ok: false, why: expect.stringContaining("three needed") });
    expect(await gate3(g, g.version, ["H100", "B200"], newPages, () => null)).toMatchObject({ ok: false, why: expect.stringContaining("no tracker value") });
  }, 60_000);
  test("gate 4 catches a draft that reads a fixture differently from the reader in force", async () => {
    const d = draft(NEW_ONLY_V2);
    expect(await gate4(d, d.version, "lambda/1", ["H100", "B200"], fixturePages("p_lambda", NOW))).toMatchObject({ ok: false });
  }, 60_000);
});

// the scratch folder layout is outside the repo and holds the draft where install puts it
test("the scratch copy lays the draft out as install would", () => {
  const d = draft(GOOD_V2);
  expect(existsSync(join(d.pkg, "src", "pure", "parsers", "lambda.v2.ts"))).toBe(true);
  expect(existsSync(join(d.pkg, "node_modules", "@agate", "report", "src", "types.ts"))).toBe(true);
  expect(d.pkg.startsWith(WALL)).toBe(false);
  mkdirSync(join(d.draftDir, "x"), { recursive: true });
  writeFileSync(join(d.draftDir, "x", "y"), "");
});

// Gate 2 on the logger's real archive (read only; skipped without it): every archived Lambda page read by the reader in
// force and by the draft inside the sandbox.
const RAW = process.env.AGATE_RAW_DIR || join(process.env.HOME ?? "", ".agate-index-logger", "data", "raw");
const HAVE_RAW = existsSync(join(RAW, "2026-10-02", "12", "p_lambda.all.gz"));

describe.skipIf(!MAC || !HAVE_RAW)("gate 2 on the real logger archive (Lambda)", () => {
  test("a v2 that keeps v1's reading passes on every archived page; one that forgot it fails", async () => {
    const { archivePages } = await import("../src/pages.ts");
    const pages = archivePages(RAW, "p_lambda", Date.parse("2026-10-02T19:00:00Z") / 1000).map((p) => ({ id: p.id, file: p.file, utcDate: p.utcDate, nowSec: p.nowSec }));
    expect(pages.length).toBeGreaterThanOrEqual(40); // 50 hours from Sep 30 17 UTC (n = the archive)
    const good = draft(GOOD_V2);
    expect(await gate2(good, good.version, "lambda/1", ["H100", "B200"], pages)).toEqual({ ok: true, detail: `${pages.length} of ${pages.length} saved pages from before the incident read the same` });
    const bad = draft(NEW_ONLY_V2);
    expect(await gate2(bad, bad.version, "lambda/1", ["H100", "B200"], pages)).toMatchObject({ ok: false, why: expect.stringContaining("the reader in force read VALID 3990000") });
  }, 120_000);
});
