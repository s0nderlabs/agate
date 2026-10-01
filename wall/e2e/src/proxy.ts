// An RPC URL in front of the local anvil that a chaos script can break: ok (forwards), error (HTTP 503), hang (no
// answer until the client gives up), wrong-chain (eth_chainId answers another id). Each process gets two of them
// (13.4: two URLs), so failover and "every URL down" are real network behaviour, not mocks inside the apps.
export type ProxyMode = "ok" | "error" | "hang" | "wrong-chain";

export interface RpcProxy {
  url: string;
  mode: ProxyMode;
  calls: number;
  refused: number;
  stop(): void;
}

export function startProxy(target: string, name: string): RpcProxy {
  const p: RpcProxy = { url: "", mode: "ok", calls: 0, refused: 0, stop: () => {} };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      p.calls++;
      const body = await req.text();
      if (p.mode === "error") {
        p.refused++;
        return new Response(`${name}: scripted outage`, { status: 503 });
      }
      if (p.mode === "hang") {
        p.refused++;
        // longer than any client timeout of the harness (they are all under 2 s); then fail
        await Bun.sleep(3_000);
        return new Response(`${name}: scripted hang`, { status: 504 });
      }
      if (p.mode === "wrong-chain" && body.includes('"eth_chainId"')) {
        const id = (JSON.parse(body) as { id: unknown }).id;
        return Response.json({ jsonrpc: "2.0", id, result: "0x1" });
      }
      const r = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body });
      return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
    },
  });
  p.url = `http://127.0.0.1:${server.port}`;
  p.stop = () => server.stop(true);
  return p;
}
