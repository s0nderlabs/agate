// A counting JSON-RPC proxy for tests and the fork rehearsal (Oct 4): it stands in for one RPC provider (Alchemy, a
// public node) in front of a local chain, forwards every call (HTTP, and a websocket to the upstream's ws://), and
// counts what reached it: calls by method, websocket subscribe calls and the bytes of each subscription event. Its
// mode makes it fail like a provider that is down (HTTP 502). Loopback only: it listens on 127.0.0.1 and refuses an
// upstream that is not a loopback URL, so no public network ever receives a transaction through it.
//
//   bun run scripts/counting-proxy.ts --upstream http://127.0.0.1:8549 [--port 9555] [--log <file.jsonl>]
//
// The CLI prints its URLs, appends one line per call to --log ({t, via, method, bytes?}) and, on SIGINT or SIGTERM,
// writes the totals as the log's last line.
import { appendFileSync } from "node:fs";

export type ProxyMode = "forward" | "error";

export interface CountingProxy {
  url: string;
  wsUrl: string;
  /** calls by method (HTTP and websocket together) */
  counts: Map<string, number>;
  /** calls by method that came over HTTP */
  http: Map<string, number>;
  /** websocket: subscribe calls, events and the events' bytes */
  ws: { subscribes: number; events: number; bytes: number; connections: number };
  mode: ProxyMode;
  /** the methods seen, sorted */
  methods(): string[];
  reset(): void;
  stop(): void;
}

const LOOPBACK = /^(https?|wss?):\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;

export function startCountingProxy(o: { upstream: string; upstreamWs?: string; port?: number; log?: (line: Record<string, unknown>) => void }): CountingProxy {
  if (!LOOPBACK.test(o.upstream)) throw new Error("the counting proxy forwards to a loopback upstream only");
  const upWs = o.upstreamWs ?? o.upstream.replace(/^http/, "ws");
  if (!LOOPBACK.test(upWs)) throw new Error("the counting proxy forwards to a loopback upstream only");
  const counts = new Map<string, number>();
  const http = new Map<string, number>();
  const ws = { subscribes: 0, events: 0, bytes: 0, connections: 0 };
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const p: CountingProxy = {
    url: "",
    wsUrl: "",
    counts,
    http,
    ws,
    mode: "forward",
    methods: () => [...counts.keys()].sort(),
    reset: () => {
      counts.clear();
      http.clear();
      Object.assign(ws, { subscribes: 0, events: 0, bytes: 0, connections: 0 });
    },
    stop: () => server.stop(true),
  };
  type Data = { up: WebSocket | null; queue: string[] };
  const server = Bun.serve<Data>({
    hostname: "127.0.0.1",
    port: o.port ?? 0,
    async fetch(req, srv) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (p.mode === "error") return new Response("down", { status: 502 });
        return srv.upgrade(req, { data: { up: null, queue: [] } }) ? undefined : new Response("no upgrade", { status: 400 });
      }
      const text = await req.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return new Response("not json", { status: 400 });
      }
      for (const c of Array.isArray(body) ? body : [body]) {
        const method = String((c as { method?: unknown }).method ?? "?");
        bump(counts, method);
        bump(http, method);
        o.log?.({ t: Date.now(), via: "http", method });
      }
      if (p.mode === "error") return new Response("provider down", { status: 502 });
      const r = await fetch(o.upstream, { method: "POST", headers: { "content-type": "application/json" }, body: text });
      return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
    },
    websocket: {
      open(sock) {
        ws.connections++;
        const up = new WebSocket(upWs);
        sock.data.up = up;
        up.onopen = () => {
          for (const m of sock.data.queue) up.send(m);
          sock.data.queue = [];
        };
        up.onmessage = (ev) => {
          const t = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
          try {
            const m = JSON.parse(t) as { method?: string };
            if (m.method === "eth_subscription") {
              const bytes = new TextEncoder().encode(t).length;
              ws.events++;
              ws.bytes += bytes;
              o.log?.({ t: Date.now(), via: "ws", method: "eth_subscription", bytes });
            }
          } catch {
            // not JSON: forwarded as is
          }
          sock.send(t);
        };
        up.onclose = () => sock.close();
        up.onerror = () => sock.close();
      },
      message(sock, msg) {
        const t = typeof msg === "string" ? msg : new TextDecoder().decode(msg);
        try {
          const m = JSON.parse(t) as { method?: string };
          const method = String(m.method ?? "?");
          bump(counts, method);
          if (method === "eth_subscribe") ws.subscribes++;
          o.log?.({ t: Date.now(), via: "ws", method });
        } catch {
          // forwarded as is
        }
        const up = sock.data.up;
        if (up && up.readyState === WebSocket.OPEN) up.send(t);
        else sock.data.queue.push(t);
      },
      close(sock) {
        try {
          sock.data.up?.close();
        } catch {
          // already closed
        }
      },
    },
  });
  p.url = `http://127.0.0.1:${server.port}`;
  p.wsUrl = `ws://127.0.0.1:${server.port}`;
  return p;
}

if (import.meta.main) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const upstream = arg("--upstream");
  if (!upstream) {
    console.error("usage: bun run scripts/counting-proxy.ts --upstream http://127.0.0.1:<port> [--port N] [--log file.jsonl]");
    process.exit(2);
  }
  const logFile = arg("--log");
  const port = arg("--port");
  const p = startCountingProxy({ upstream, ...(port ? { port: Number(port) } : {}), ...(logFile ? { log: (l) => appendFileSync(logFile, `${JSON.stringify(l)}\n`) } : {}) });
  console.log(JSON.stringify({ event: "listening", url: p.url, wsUrl: p.wsUrl, upstream }));
  const totals = () => ({ event: "totals", t: Date.now(), methods: Object.fromEntries([...p.counts].sort()), http: Object.fromEntries([...p.http].sort()), ws: p.ws });
  const timer = setInterval(() => console.log(JSON.stringify(totals())), 60_000);
  for (const s of ["SIGINT", "SIGTERM"] as const)
    process.on(s, () => {
      clearInterval(timer);
      if (logFile) appendFileSync(logFile, `${JSON.stringify(totals())}\n`);
      console.log(JSON.stringify(totals()));
      p.stop();
      process.exit(0);
    });
}
