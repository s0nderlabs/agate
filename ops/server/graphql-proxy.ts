// The public face of the indexer on the server: Tailscale Funnel (https, port 8443) reaches this proxy, never Hasura.
// It forwards only POST /v1/graphql to Hasura on localhost, drops every x-hasura-* header the caller sends (so a
// request always runs as Hasura's unauthorized public role, which can only read; envio dev's admin secret is the
// well-known "testing"), caps the body, and answers CORS for any origin (the data is public chain data). It also
// serves GET /akash-traded.json, the Akash robot's hourly comparison file, for the public app (AGATE_AKASH_URL).
//
//   bun run ops/server/graphql-proxy.ts      (AGATE_GQL_PROXY_PORT, default 8081; AGATE_GQL_UPSTREAM, default
//                                             http://127.0.0.1:8080/v1/graphql)
const port = Number(process.env.AGATE_GQL_PROXY_PORT ?? 8081);
const upstream = process.env.AGATE_GQL_UPSTREAM ?? "http://127.0.0.1:8080/v1/graphql";
const MAX_BODY = 64 * 1024;
const akashFile = `${process.env.AGATE_WALL_HOME ?? `${process.env.HOME}/.agate-wall`}/akash/akash-traded.json`;
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

Bun.serve({
  hostname: "127.0.0.1",
  port,
  // Bun refuses a larger body before buffering it (the check below only names it); no development error pages
  maxRequestBodySize: MAX_BODY,
  development: false,
  error: () => new Response("proxy error", { status: 500, headers: cors }),
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok", { headers: cors });
    // the Akash robot's hourly file (display only, never an index input), for the public app's comparison panel
    if (url.pathname === "/akash-traded.json" && req.method === "GET") {
      const f = Bun.file(akashFile);
      if (!(await f.exists())) return new Response("no Akash reading yet", { status: 404, headers: cors });
      return new Response(f, { headers: { ...cors, "content-type": "application/json", "cache-control": "public, max-age=300" } });
    }
    if (url.pathname !== "/v1/graphql") return new Response("not found", { status: 404, headers: cors });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return new Response("POST only", { status: 405, headers: cors });
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return new Response("query too large", { status: 413, headers: cors });
    const body = await req.arrayBuffer();
    if (body.byteLength > MAX_BODY) return new Response("query too large", { status: 413, headers: cors });
    try {
      const r = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(20_000) });
      return new Response(r.body, { status: r.status, headers: { ...cors, "content-type": r.headers.get("content-type") ?? "application/json" } });
    } catch {
      // Hasura restarting with the indexer window, or too slow: a clean 502 the app can read (CORS headers included)
      return new Response("indexer unavailable", { status: 502, headers: cors });
    }
  },
});
console.log(JSON.stringify({ at: new Date().toISOString(), event: "graphql-proxy.started", port, upstream }));
