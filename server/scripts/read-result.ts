// Reads what landed batches did, with @agate/client's readResult, from their receipts. Uses the server's market env.
// bun run scripts/read-result.ts openLong:0xHASH closeShort:0xHASH ...
import { type Hex } from "viem";
import { type PlanAction, readResult } from "@agate/client";
import { marketClient } from "../src/app.ts";

const c = marketClient();
for (const arg of process.argv.slice(2)) {
  const [action, hash] = arg.split(":") as [PlanAction, Hex];
  const r = await c.pub.getTransactionReceipt({ hash });
  console.log(action, hash.slice(0, 10), JSON.stringify(readResult(c, action, r.logs)));
}
process.exit(0);
