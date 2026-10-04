// Live real-fill check through the hosted MCP server: an AI app opens and closes small positions from the pocket.
// Issues a fresh connector secret for one grant (kept inside this process, never printed). Each step is one tool
// call, given as name=json on the command line, run in order:
// bun run scripts/mcp-fill.ts <grantId> 'get_prices={"gpu":"H200"}' 'open_long={"gpu":"H200","month":"2026-11","dollars":5}'
// Trade tools get an idempotency_key automatically.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/store.ts";

const [grantId, ...steps] = process.argv.slice(2);
if (!grantId || !steps.length) throw new Error("usage: mcp-fill.ts <grantId> name=json ...");
const base = process.env.AGATE_PUBLIC_BASE ?? "http://127.0.0.1:5191";
const WRITES = new Set(["open_long", "open_short", "close_long", "close_long_daily", "close_short", "get_test_dollars", "request_approval"]);
const secret = new Store().newConnectorSecret(grantId);
// the connector URL is a password: never let an error print it
const hide = (e: unknown) => {
  console.log("failed:", String((e as Error)?.message ?? e).replaceAll(secret, "<secret>").slice(0, 300));
  process.exit(1);
};
process.on("uncaughtException", hide);
process.on("unhandledRejection", hide);
const client = new Client({ name: "agate-fill-check", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/c/${secret}/mcp`))).catch(hide);
for (const s of steps) {
  const i = s.indexOf("=");
  const name = i < 0 ? s : s.slice(0, i);
  const args = i < 0 ? {} : (JSON.parse(s.slice(i + 1)) as Record<string, unknown>);
  if (WRITES.has(name) && !args.idempotency_key) args.idempotency_key = `fill-${name}-${Date.now()}`;
  const t = performance.now();
  const r = (await client.callTool({ name, arguments: args }).catch(hide)) as { isError?: boolean; content: { text: string }[] };
  console.log(`\n== ${name} ${JSON.stringify(args)} ${r.isError ? "(refused/error)" : ""} ${Math.round(performance.now() - t)} ms\n${r.content[0]!.text.slice(0, 1500)}`);
}
await client.close();
process.exit(0);
