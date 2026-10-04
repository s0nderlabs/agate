// Lists the test-dollar transfers in transactions (who paid whom), plus balances now. Uses the server's market env.
// bun run scripts/transfers.ts 0xTX ... [--who 0xA,0xB]
import { type Address, formatUnits, type Hex, parseAbi, parseEventLogs } from "viem";
import { marketClient } from "../src/app.ts";

const c = marketClient();
const args = process.argv.slice(2);
const who = (args.find((a) => a.startsWith("--who="))?.slice(6).split(",") ?? []) as Address[];
const erc20 = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)", "function balanceOf(address) view returns (uint256)"]);
for (const hash of args.filter((a) => a.startsWith("0x")) as Hex[]) {
  const r = await c.pub.getTransactionReceipt({ hash });
  const t = parseEventLogs({ abi: erc20, logs: r.logs.filter((l) => l.address.toLowerCase() === c.dollar.toLowerCase()), eventName: "Transfer" });
  console.log(hash.slice(0, 10), t.map((e) => `${e.args.from.slice(0, 6)}->${e.args.to.slice(0, 6)} ${formatUnits(e.args.value, 6)}`).join(" | "));
}
for (const a of who) console.log(a.slice(0, 8), formatUnits(await c.pub.readContract({ address: c.dollar, abi: erc20, functionName: "balanceOf", args: [a] }), 6));
process.exit(0);
