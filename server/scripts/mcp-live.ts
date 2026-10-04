// Live end-to-end check of the hosted MCP server with the real MCP client SDK, over the public URL, as an AI app
// would connect. Issues a fresh connector secret for one grant (kept inside this process, never printed), lists the
// tools and calls the read tools plus one trade tool.
// bun run scripts/mcp-live.ts <grantId> [publicBase]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/store.ts";

const [grantId, base = process.env.AGATE_PUBLIC_BASE ?? "http://127.0.0.1:5191"] = process.argv.slice(2);
if (!grantId) throw new Error("usage: mcp-live.ts <grantId> [publicBase]");
const store = new Store();
const secret = store.newConnectorSecret(grantId);
const client = new Client({ name: "agate-live-check", version: "1" });
const t0 = performance.now();
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/c/${secret}/mcp`)));
console.log("connected in", Math.round(performance.now() - t0), "ms; server:", JSON.stringify(client.getServerVersion()));
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("tools:", tools.join(", "));
const show = async (name: string, args: Record<string, unknown> = {}) => {
  const t = performance.now();
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  console.log(`\n== ${name} ${r.isError ? "(refused/error)" : ""} ${Math.round(performance.now() - t)} ms\n${r.content[0]!.text.slice(0, 900)}`);
};
await show("my_limits");
await show("get_prices", { gpu: "H100" });
await show("get_portfolio");
await show("get_test_dollars", { idempotency_key: `live-${Date.now()}` });
await show("open_long", { gpu: "H100", month: "2026-11", dollars: 500, idempotency_key: `live-over-${Date.now()}` });
await show("activity", { limit: 5 });
await client.close();
process.exit(0);
