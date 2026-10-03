// bun run test/fork/run.ts [--fixture-dir <dir>]: the fork replay (BOTS-SPEC 5.7 item 5). The handlers read the
// deployments the config was generated from (src/lib/deployments.generated.ts) and Envio reads config.yaml, both of
// the local test world in this folder; the fork's world has other addresses. So this copies the indexer into a
// scratch folder (node_modules linked, nothing installed), renders config.yaml and deployments.generated.ts there from
// the fork's deployments file (with the demo index's deploy block as its start), runs vitest on test/fork with
// AGATE_FORK_REPLAY=1, and removes the copy. No file of this folder changes; no network, no Docker.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseDeployments, renderConfig } from "../../scripts/config-gen.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const at = args.indexOf("--fixture-dir");
const fixtures = resolve(at >= 0 && args[at + 1] ? args[at + 1]! : join(ROOT, "test/fork/fixtures"));
const depPath = join(fixtures, "fork-deployments.json");
const lifePath = join(fixtures, "fork-lifecycle.json");
if (!existsSync(depPath) || !existsSync(lifePath)) {
  console.error(`no fork fixture in ${fixtures} (run the market fork e2e: wall/e2e/scripts/market-fork.ts)`);
  process.exit(2);
}
const d = parseDeployments(JSON.parse(readFileSync(depPath, "utf8")));
const life = JSON.parse(readFileSync(lifePath, "utf8")) as { indexStart: number };

const work = mkdtempSync(join(tmpdir(), "agate-indexer-fork-"));
let code = 1;
try {
  for (const p of ["abis", "src", "scripts", "test", ".envio", "schema.graphql", "package.json", "tsconfig.json", "envio-env.d.ts"]) {
    if (existsSync(join(ROOT, p))) cpSync(join(ROOT, p), join(work, p), { recursive: true, filter: (src) => !src.includes(`${join(ROOT, "test", "fixtures")}/local-lifecycle.json`) });
  }
  symlinkSync(join(ROOT, "node_modules"), join(work, "node_modules"), "dir");
  const { yaml, ts } = renderConfig(d, { indexStart: { demo: life.indexStart }, source: "test/fork/fixtures/fork-deployments.json" });
  writeFileSync(join(work, "config.yaml"), yaml);
  writeFileSync(join(work, "src/lib/deployments.generated.ts"), ts);
  const r = spawnSync(join(work, "node_modules/.bin/vitest"), ["run", "test/fork"], { cwd: work, env: { ...process.env, AGATE_FORK_REPLAY: "1", AGATE_FORK_FIXTURE_DIR: fixtures }, stdio: "inherit" });
  code = r.status ?? 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(code);
