// Recheck r2 helper: one process that tries the testnet mode's per-key lock once, at a given moment, and says whether
// it got it. Usage: bun run lock-child.ts <dir> <name> <start at, ms since 1970> <hold ms>
import { GateError, LockHeld, takeLock } from "../../../e2e/testnet.ts";

const [dir, name, at, hold] = process.argv.slice(2);
const wait = Number(at) - Date.now();
if (wait > 0) await Bun.sleep(wait);
try {
  const release = takeLock(dir!, name!);
  console.log("won");
  await Bun.sleep(Number(hold));
  release();
} catch (e) {
  console.log(e instanceof LockHeld ? "held" : e instanceof GateError ? "refused" : `error ${(e as Error).message}`);
}
