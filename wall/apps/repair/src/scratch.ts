// The scratch copy of the sources package a draft is typechecked and run in (BUILD-SPEC 15.2 gate 1): outside the
// repo (drafts/<draftId>/pkg/), with the draft written where `repair install` would put it and registered between
// the repair markers exactly as install registers it, so every gate tests the installed shape.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Spawner } from "./spawn.ts";

export const BEGIN = "// repair:begin";
export const END = "// repair:end";

/** "lambda/1" -> "lambda"; null for anything that is not "<name>/<N>". */
export function nameOfVersion(v: string): { name: string; n: number } | null {
  const m = /^([a-z][a-z0-9]{0,23})\/([1-9]\d{0,3})$/.exec(v);
  return m ? { name: m[1]!, n: Number(m[2]) } : null;
}

export const draftFileName = (name: string, n: number) => `${name}.v${n}.ts`;
export const aliasOf = (name: string, n: number) => `extract${name[0]!.toUpperCase()}${name.slice(1)}V${n}`;

/** Adds one installed version to parsers/index.ts: the import as the last line of the import block, the entry before
 *  the end marker. Throws when the markers are missing or the version is already there. */
export function registryEdit(src: string, name: string, n: number, sourceId: string): string {
  if (!/^[a-z][a-z0-9]{0,23}$/.test(name) || !/^p_[a-z0-9]{1,24}$/.test(sourceId) || !Number.isSafeInteger(n) || n < 2) throw new Error("bad version name");
  if (src.split(BEGIN).length !== 2 || src.split(END).length !== 2 || src.indexOf(BEGIN) > src.indexOf(END)) throw new Error("parsers/index.ts lacks one `// repair:begin` ... `// repair:end` block");
  const version = `${name}/${n}`;
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  if (new RegExp(`^\\s*"${esc(version)}"\\s*:`, "m").test(src) || new RegExp(`^import\\b.*"\\./${esc(draftFileName(name, n))}";`, "m").test(src)) throw new Error(`${version} is already registered`);
  const lines = src.split("\n");
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) if (/^import\b.*;\s*$/.test(lines[i]!)) lastImport = i;
  if (lastImport < 0) throw new Error("parsers/index.ts has no import block");
  const alias = aliasOf(name, n);
  lines.splice(lastImport + 1, 0, `import { extract as ${alias} } from "./${draftFileName(name, n)}";`);
  const endAt = lines.findIndex((l) => l.includes(END));
  const indent = /^(\s*)/.exec(lines[endAt]!)![1]!;
  lines.splice(endAt, 0, `${indent}"${version}": { sourceId: "${sourceId}", extract: ${alias} },`);
  return lines.join("\n");
}

/** The highest installed version number of a parser name in a sources package (registry keys and files). */
export function highestVersion(sourcesDir: string, name: string): number {
  let n = 1;
  const idx = join(sourcesDir, "src", "pure", "parsers", "index.ts");
  if (existsSync(idx)) for (const m of readFileSync(idx, "utf8").matchAll(new RegExp(`"${name}/(\\d+)"`, "g"))) n = Math.max(n, Number(m[1]));
  const dir = join(sourcesDir, "src", "pure", "parsers");
  if (existsSync(dir)) for (const f of readdirSync(dir)) {
    const m = new RegExp(`^${name}\\.v(\\d+)\\.ts$`).exec(f);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return n;
}

/** Links every package the sources package resolves (its node_modules: @agate/report, viem) into the copy, read only. */
function linkModules(from: string, to: string): void {
  if (!existsSync(from)) throw new Error(`${from} is missing: run bun install in wall/`);
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from)) {
    if (e.startsWith(".")) continue;
    if (e.startsWith("@")) {
      mkdirSync(join(to, e), { recursive: true });
      for (const c of readdirSync(join(from, e))) if (!existsSync(join(to, e, c))) symlinkSync(realpathSync(join(from, e, c)), join(to, e, c), "dir");
    } else if (!existsSync(join(to, e))) symlinkSync(realpathSync(join(from, e)), join(to, e), "dir");
  }
}

const TSCONFIG = {
  compilerOptions: {
    target: "ESNext",
    module: "ESNext",
    moduleResolution: "bundler",
    lib: ["ESNext"],
    types: [],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    forceConsistentCasingInFileNames: true,
    noFallthroughCasesInSwitch: true,
    noImplicitOverride: true,
    verbatimModuleSyntax: true,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
  },
  include: ["src/types.ts", "src/pure/**/*.ts"],
};

export interface Scratch {
  pkg: string;
  draftFile: string;
  version: string;
}

/** Copies the installed sources package (types, the pure layer, the synthetic renderer) to <draftDir>/pkg, links
 *  @agate/report for imports, writes the draft and a type check of it, and registers the draft (source null: the
 *  copy only, for a URL-only swap read with the installed version). */
export function prepareScratch(wallRoot: string, draftDir: string, name: string, n: number, sourceId: string, source: string | null): Scratch {
  const from = join(wallRoot, "packages", "sources");
  const pkg = join(draftDir, "pkg");
  mkdirSync(join(pkg, "src"), { recursive: true });
  cpSync(join(from, "package.json"), join(pkg, "package.json"));
  cpSync(join(from, "src", "types.ts"), join(pkg, "src", "types.ts"));
  cpSync(join(from, "src", "synthetic.ts"), join(pkg, "src", "synthetic.ts"));
  cpSync(join(from, "src", "pure"), join(pkg, "src", "pure"), { recursive: true });
  linkModules(join(from, "node_modules"), join(pkg, "node_modules"));
  writeFileSync(join(pkg, "tsconfig.json"), `${JSON.stringify(TSCONFIG, null, 1)}\n`);
  const draftFile = join(pkg, "src", "pure", "parsers", draftFileName(name, n));
  if (source === null) return { pkg, draftFile: "", version: "" }; // a URL-only swap: the copy as installed
  if (existsSync(draftFile)) throw new Error(`${draftFileName(name, n)} already exists in the sources package`);
  writeFileSync(draftFile, source);
  writeFileSync(
    join(pkg, "src", "pure", "parsers", "zz_gate1_check.ts"),
    `// gate 1: the draft's extract has the Extractor type (scratch only, never installed)\nimport type { Extractor } from "../../types.ts";\nimport { extract } from "./${draftFileName(name, n)}";\nexport const gate1Check: Extractor = extract;\n`,
  );
  const idx = join(pkg, "src", "pure", "parsers", "index.ts");
  writeFileSync(idx, registryEdit(readFileSync(idx, "utf8"), name, n, sourceId));
  return { pkg, draftFile, version: `${name}/${n}` };
}

/** Gate 1's typecheck: tsc on the scratch copy under the pure settings (no Node, Bun or DOM types). */
export async function typecheckScratch(spawner: Spawner, pkg: string, env: Record<string, string>): Promise<{ ok: true } | { ok: false; why: string }> {
  let r;
  try {
    r = await spawner.run("tsc", ["-p", join(pkg, "tsconfig.json"), "--noEmit", "--pretty", "false"], { cwd: pkg, env, timeoutMs: 120_000, maxStdout: 64 * 1024 });
  } catch (e) {
    return { ok: false, why: `tsc could not be started (${(e as Error).message.slice(0, 80)})` };
  }
  if (r.timedOut) return { ok: false, why: "tsc timed out" };
  if (r.code !== 0) {
    const first = `${r.stdout}\n${r.stderr}`.split("\n").filter((l) => /error TS\d+/.test(l)).slice(0, 3).map((l) => l.replace(pkg, "pkg").slice(0, 200));
    return { ok: false, why: `the draft does not typecheck under the pure settings: ${first.join(" | ") || `tsc exit ${r.code}`}` };
  }
  return { ok: true };
}
