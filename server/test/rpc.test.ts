import { describe, expect, test } from "bun:test";
import { createPublicClient } from "viem";
import { monadTestnet } from "@agate/wallet";
import { rpcTransport } from "@agate/client";

/** A JSON-RPC stand-in: answers eth_chainId with Monad testnet's id, counting the calls it got. */
function node(o: { status?: number } = {}) {
  let calls = 0;
  const s = Bun.serve({
    port: 0,
    fetch: async (req) => {
      calls++;
      if (o.status) return new Response("Too Many Requests", { status: o.status });
      const j = (await req.json()) as { id: number };
      return Response.json({ jsonrpc: "2.0", id: j.id, result: "0x279f" });
    },
  });
  return { url: `http://localhost:${s.port}`, calls: () => calls, stop: () => s.stop(true) };
}

// the server's chain reads (grants.ts publicClient, scripts/fund.ts, scripts/server-wallet.ts) all use this transport
describe("MONAD_RPC_URL through rpcTransport", () => {
  test("a comma list: a 429 from the first address moves the call to the next", async () => {
    const busy = node({ status: 429 });
    const ok = node();
    try {
      const pc = createPublicClient({ chain: monadTestnet, transport: rpcTransport(`${busy.url}, ${ok.url}`) });
      expect(await pc.getChainId()).toBe(10143);
      expect(busy.calls()).toBeGreaterThan(0);
      expect(ok.calls()).toBe(1);
    } finally {
      busy.stop();
      ok.stop();
    }
  });

  test("one address works as before", async () => {
    const ok = node();
    try {
      const pc = createPublicClient({ chain: monadTestnet, transport: rpcTransport(ok.url) });
      expect(await pc.getChainId()).toBe(10143);
    } finally {
      ok.stop();
    }
  });
});
