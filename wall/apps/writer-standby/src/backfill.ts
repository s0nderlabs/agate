// bun run src/backfill.ts --role primary|standby [--dry-run]
// Posts this writer's logged readings from firstDay on (8.4). Key: AGATE_PRIMARY_KEY or AGATE_STANDBY_KEY. Other env
// as main.ts. Run within GRACE (one DAY) of registerGpu. Holds the role's per-index lock, so stop the writer first.
import { join } from "node:path";
import type { Address } from "@agate/report/types";
import { privateKeyToAccount } from "viem/accounts";
import { backfill } from "./pipeline/backfill.ts";
import { indexChain } from "./pipeline/chain.ts";
import { FileLock } from "./pipeline/lock.ts";
import { ReadingLog, type Role, wallHome } from "./pipeline/log.ts";
import { alertSink } from "./pipeline/ops.ts";
import { RpcPool } from "./pipeline/rpc.ts";
import { timingFor } from "./pipeline/sender.ts";
import { env, loadPanels, loadSourcesApi, maxFeeFromEnv, measuredFromEnv, rpcUrlsFromEnv, startupChecks, takeKey } from "./pipeline/setup.ts";

const args = process.argv.slice(2);
const role = (args[args.indexOf("--role") + 1] ?? "") as Role;
if (role !== "primary" && role !== "standby") throw new Error("--role primary|standby");
const home = wallHome();
const index = env("AGATE_INDEX") as Address;
const lock = FileLock.tryTake(join(home, role, `${index.toLowerCase()}.lock`), { role, index, use: "backfill" });
if (!lock) {
  console.error(`the ${role} writer for ${index} is running: stop it before a backfill`);
  process.exit(3);
}
const key = takeKey(role === "primary" ? "AGATE_PRIMARY_KEY" : "AGATE_STANDBY_KEY");
const writer = privateKeyToAccount(key).address;
const alert = alertSink({ home, writer });
const pool = new RpcPool({ urls: rpcUrlsFromEnv(), ...(process.env.AGATE_CHAIN_ID ? { expectChainId: Number(process.env.AGATE_CHAIN_ID) } : {}), timeoutMs: 10_000, staleS: 60, alert });
await pool.init();
const log = new ReadingLog(home, role);
const chain = indexChain({
  pool,
  index,
  privateKey: key,
  journal: log,
  timing: timingFor(3_600),
  alert,
  measured: measuredFromEnv(),
  ...(maxFeeFromEnv() !== undefined ? { maxFeeWei: maxFeeFromEnv()! } : {}),
  keyLockPath: join(home, "keys", `${writer.toLowerCase()}.lock`),
});
const info = await startupChecks(chain, loadPanels(env("AGATE_PANELS")), await loadSourcesApi(), role === "primary" ? 0 : 1);
for (const w of info.warnings) console.error(`warning: ${w}`);
await chain.resync();
const res = await backfill({ chain, clock: info.clock, chainSelector: info.chainSelector, panels: info.panels, log, role, now: await chain.blockTime(), dryRun: args.includes("--dry-run") });
console.log(JSON.stringify(res, null, 2));
lock.release();
