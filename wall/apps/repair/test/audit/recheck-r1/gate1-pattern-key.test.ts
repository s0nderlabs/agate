// Recheck r1 (phase 2b): gate 1's syntax allowlist against a destructuring pattern whose property name is an
// escaped string literal. bind() checked a pattern's computed and identifier names, not a string-literal one, and
// the word list reads the raw source, where "constructor" is not the word. The draft below only reads
// Bun.version (no process, no file, no network); before the fix the sandbox run showed it reached the global object.
// Fixed (fix round 2): bind() checks every pattern key's cooked text, and the word list also runs on the cooked text
// of every name and string in the tree, so gate 1 refuses the draft and it never runs.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkSyntax } from "../../../src/ast.ts";
import { gate1 } from "../../../src/gates.ts";
import { checkPurity } from "../../../src/purity.ts";
import { prepareScratch } from "../../../src/scratch.ts";
import { Spawner } from "../../../src/spawn.ts";
import { cleanup, tmp } from "../../world.ts";

afterAll(cleanup);

const MAC = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const WALL = resolve(import.meta.dir, "../../../../..");
const spawner = new Spawner({ claude: "/nonexistent", sandbox: "/usr/bin/sandbox-exec", bun: process.execPath, tsc: join(WALL, "node_modules", ".bin", "tsc"), osascript: "/nonexistent" });
const toolEnv = { PATH: `${process.env.PATH ?? ""}:/usr/bin:/bin`, HOME: process.env.HOME ?? "/tmp" };

/** Reaches Function, then the global object, then Bun, through string-literal pattern keys only. */
const PATTERN_KEY = `import type { Extractor } from "../../types.ts";
const f = (x: number): number => x;
const { "constr\\u0075ctor": F }: any = f;
const g: any = F("return this")();
const { "B\\u0075n": B }: any = g;
const seen = "reached=" + String(B.version);
export const extract: Extractor = (_body, _ctx) => ({ H100: { kind: "missing", why: seen } });
`;

describe("gate 1 against string-literal keys in a destructuring pattern", () => {
  test("the word list still misses the escaped words; the syntax allowlist refuses the pattern key", async () => {
    expect(checkPurity(PATTERN_KEY)).toEqual({ ok: true });
    expect(await checkSyntax(PATTERN_KEY)).toMatchObject({ ok: false, why: expect.stringContaining('reads the property "constructor"') });
  }, 30_000);

  test("the syntax allowlist refuses a banned name as a string-literal pattern key (escaped or not)", async () => {
    expect((await checkSyntax(PATTERN_KEY)).ok).toBe(false);
    expect((await checkSyntax(PATTERN_KEY.replace("constr\\u0075ctor", "constructor"))).ok).toBe(false);
  }, 30_000);

  test.skipIf(!MAC)("gate 1 (tsc included) refuses the draft, so it is never run", async () => {
    const dir = tmp("agate-r1-draft-");
    const s = prepareScratch(WALL, dir, "lambda", 2, "p_lambda", PATTERN_KEY);
    expect(await gate1(spawner, PATTERN_KEY, s.pkg, toolEnv)).toMatchObject({ ok: false, why: expect.stringContaining("syntax allowlist") });
  }, 120_000);
});
