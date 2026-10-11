// Builds the npm package of @agate/client into dist/pkg without touching the workspace: the repo's apps keep importing
// the TypeScript source (package.json "exports" -> src/), while the published package is plain ES modules plus type
// declarations, usable from Node 18+, bundlers and Bun. Usage:
//   bun run scripts/pack.ts                  build dist/pkg and list what `npm pack` would ship (nothing is published)
//   AGATE_NPM_NAME=<name> bun run scripts/pack.ts   the same under another package name
// Publishing is a person's step: `npm publish ./dist/pkg --access public` (the ./ matters: a bare dist/pkg reads as a GitHub repo), signed in to npm.
import { $ } from "bun";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "dist/pkg");
const src = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string; dependencies: Record<string, string>; exports: Record<string, string> };
/** README.npm.md names the package by this default; a build under another name rewrites it there */
const DEFAULT_NAME = "@s0nderlabs/agate";
const name = process.env.AGATE_NPM_NAME || DEFAULT_NAME;

rmSync(join(root, "dist"), { recursive: true, force: true });
await $`bunx tsc -p ${join(root, "tsconfig.build.json")}`.cwd(root);

// the workspace's exports ("./src/x.ts"), pointed at the built files
const entry = (srcPath: string) => {
  const f = srcPath.replace(/^\.\/src\//, "./").replace(/\.ts$/, "");
  return { types: `${f}.d.ts`, import: `${f}.js`, default: `${f}.js` };
};
const exportsMap = Object.fromEntries(Object.entries(src.exports).map(([k, v]) => [k, entry(v)]));
writeFileSync(
  join(out, "package.json"),
  JSON.stringify(
    {
      name,
      version: src.version,
      description: "Read the open onchain price of renting a GPU for an hour, and trade agate's monthly GPU-hour markets on Monad, from TypeScript.",
      license: "MIT",
      type: "module",
      main: "./index.js",
      types: "./index.d.ts",
      exports: exportsMap,
      sideEffects: false,
      engines: { node: ">=18" },
      dependencies: { viem: src.dependencies.viem },
      repository: { type: "git", url: "git+https://github.com/s0nderlabs/agate.git", directory: "client" },
      homepage: "https://agate.elpabl0.xyz",
      keywords: ["agate", "gpu", "compute", "h100", "price", "index", "monad", "derivatives", "viem"],
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(join(out, "README.md"), readFileSync(join(root, "README.npm.md"), "utf8").replaceAll(DEFAULT_NAME, name));
copyFileSync(join(root, "../LICENSE"), join(out, "LICENSE"));

console.log(`built ${name}@${src.version} in dist/pkg`);
await $`npm pack --dry-run ${out}`.cwd(root);
