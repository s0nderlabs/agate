// Runs the maker's fork tests (test/fork/) against an anvil-safe fork of Monad testnet (BOTS-SPEC 3.12): checks the
// disk first (refuses under 30 GB free), starts the fork through wall/scripts/anvil.ts (anvil-safe.sh), runs bun test
// with MONAD_FORK_URL pointing at it, stops it, and checks that no anvil and no run dir of this run are left.
//   AGATE_FORGE_OUT=<forge out with src/market and MockIndex built> bun run scripts/fork-test.ts [bun test args]
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnAnvil } from "../../../scripts/anvil.ts";

const UPSTREAM = "https://testnet-rpc.monad.xyz";
const MIN_GB = Number(process.env.AGATE_ANVIL_MIN_FREE_GB ?? 30);
const ROOT = process.env.AGATE_ANVIL_ROOT ?? join(homedir(), ".cache", "agate-anvil");

function freeGb(): number {
  const out = Bun.spawnSync(["df", "-Pk", "/"]).stdout.toString().trim().split("\n")[1]!.split(/\s+/);
  return Math.floor(Number(out[3]) / 1_048_576);
}
function anvilTmpKb(): number {
  const p = join(homedir(), ".foundry", "anvil", "tmp");
  if (!existsSync(p)) return 0;
  return Number(Bun.spawnSync(["du", "-sk", p]).stdout.toString().split(/\s/)[0] ?? 0);
}
function runDirOf(wrapperPid: number): string | null {
  if (!existsSync(ROOT)) return null;
  for (const d of readdirSync(ROOT)) {
    if (!d.startsWith("run.")) continue;
    try {
      if (readFileSync(join(ROOT, d, "wrapper.pid"), "utf8").trim() === String(wrapperPid)) return join(ROOT, d);
    } catch {
      // not ours
    }
  }
  return null;
}

console.log(Bun.spawnSync(["df", "-h", "/"]).stdout.toString().trim());
if (freeGb() < MIN_GB) {
  console.error(`only ${freeGb()} GB free (floor ${MIN_GB} GB): not starting anvil`);
  process.exit(1);
}
const forgeOut = process.env.AGATE_FORGE_OUT ?? join(homedir(), ".agate-build", "p1", "out");
if (!existsSync(join(forgeOut, "AgateFactory.sol", "AgateFactory.json")) || !existsSync(join(forgeOut, "MockIndex.sol", "MockIndex.json"))) {
  console.error(`no Foundry artifacts in ${forgeOut}: cd contracts && FOUNDRY_OUT=... forge build src/market test/market/mocks/MockIndex.sol`);
  process.exit(1);
}
const tmpBefore = anvilTmpKb();
const anvil = await spawnAnvil(["--fork-url", UPSTREAM, "--code-size-limit", "131072"], { timeoutMs: 180_000 });
const runDir = runDirOf(anvil.proc.pid);
let code = 1;
try {
  const r = Bun.spawnSync(["bun", "test", "--timeout", "600000", "test/fork/", ...process.argv.slice(2)], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, MONAD_FORK_URL: anvil.rpc, AGATE_FORGE_OUT: forgeOut },
    stdout: "inherit",
    stderr: "inherit",
  });
  code = r.exitCode ?? 1;
} finally {
  anvil.proc.kill();
  await anvil.proc.exited;
  await Bun.sleep(500);
}
const left = runDir !== null && existsSync(runDir);
console.log(Bun.spawnSync(["df", "-h", "/"]).stdout.toString().trim());
console.log(`~/.foundry/anvil/tmp: ${anvilTmpKb()} KB (before ${tmpBefore}); this run's anvil-safe dir: ${runDir ?? "none"} ${left ? "LEFT BEHIND" : "removed"}`);
if (left) code = 1;
process.exit(code);
