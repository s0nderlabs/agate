// 13.6 (Oct 3): the watcher and the guardian take their RPC list from AGATE_RPC_URLS_CMD, and a fake API key in those
// URLs never reaches any file under AGATE_WALL_HOME or any captured stdout or stderr: the start line, RPC_SINGLE,
// RPC_FAILOVER and RPC_DOWN, viem's errors (which embed the request URL), heartbeats and alerts. Real processes
// (`bun run src/main.ts`, the guardian CLI) against a local fake RPC that answers eth_chainId and fails the rest.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveClocks, PROFILES } from "../src/clock.ts";
import { writeAtomic } from "../src/fsutil.ts";

const SECRET = "FAKEALCHEMYKEY0123456789";
const INDEX = "0xaaaaaaaa00000000000000000000000000000001";
const WATCHER = join(import.meta.dir, "..");
const GUARDIAN = join(import.meta.dir, "..", "..", "guardian");
const KEEPER_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"; // anvil #5, never on a public chain

let server: ReturnType<typeof Bun.serve> | null = null;
let port = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json().catch(() => ({}))) as { id?: number; method?: string } | { id?: number; method?: string }[];
      const one = (b: { id?: number; method?: string }) => (b.method === "eth_chainId" ? { jsonrpc: "2.0", id: b.id, result: "0x7a69" } : null);
      if (Array.isArray(body)) return new Response("no batches", { status: 500 });
      const r = one(body);
      return r ? Response.json(r) : new Response("upstream exploded", { status: 500 });
    },
  });
  port = server.port!;
});
afterAll(() => server?.stop(true));

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "agate-redact-"));
  const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
  writeAtomic(join(h, "watcher", INDEX, "clocks.json"), JSON.stringify({ ...deriveClocks({ ...PROFILES.FAST, epochTs: 1_000 }), chainId: 31_337 }, big));
  writeAtomic(join(h, "panels.json"), JSON.stringify([{ gpu: "H100", gpuId: `0x${"12".repeat(32)}`, slots: [{ slot: 0, sourceId: "p_lambda" }] }]));
  return h;
}

function envFor(h: string, cmd: string): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("AGATE_")) base[k] = v;
  return { ...base, AGATE_WALL_HOME: h, AGATE_INDEX: INDEX, AGATE_PANELS: join(h, "panels.json"), AGATE_RPC_URLS_CMD: cmd, AGATE_HEALTH_EXTRA: "" };
}

async function run(cwd: string, args: string[], env: Record<string, string>, ms: number): Promise<string> {
  const p = Bun.spawn(["bun", "run", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const out = new Response(p.stdout).text();
  const err = new Response(p.stderr).text();
  const timer = setTimeout(() => p.kill("SIGTERM"), ms);
  const hard = setTimeout(() => p.kill("SIGKILL"), ms + 5_000); // a role asleep in its period or an RPC retry: never left running
  await p.exited;
  clearTimeout(timer);
  clearTimeout(hard);
  return `${await out}\n${await err}`;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

describe("13.6: AGATE_RPC_URLS_CMD and redaction (watcher and guardian)", () => {
  test("the fake key never appears in any file or captured output (start line, failovers, RPC_DOWN, viem errors, RPC_SINGLE)", async () => {
    const h = home();
    const cmd = `printf "http://127.0.0.1:${port}/v2/${SECRET},http://127.0.0.1:2/v2/${SECRET},ws://127.0.0.1:3/v2/${SECRET}"`;
    const outs: string[] = [];
    // keep: starts from the cached clocks, then every call fails (HTTP 500 with the URL in viem's error, a refused port)
    outs.push(await run(WATCHER, ["src/main.ts", "keep"], { ...envFor(h, cmd), AGATE_KEEPER_KEY: KEEPER_KEY }, 6_000));
    // status: heartbeats and open alerts, printed
    outs.push(await run(WATCHER, ["src/main.ts", "status"], envFor(h, cmd), 15_000));
    // the guardian CLI with the same command
    outs.push(await run(GUARDIAN, ["src/cli.ts", "status"], envFor(h, cmd), 15_000));
    // one URL only: RPC_SINGLE names it
    outs.push(await run(WATCHER, ["src/main.ts", "status"], envFor(h, `printf "http://127.0.0.1:${port}/v2/${SECRET}"`), 15_000));
    const text = outs.join("\n");
    // the processes really ran and failed where they should
    expect(text).toContain('"event":"start"');
    expect(text).toContain("http://127.0.0.1:");
    expect(text).toContain("RPC_SINGLE");
    const files = filesUnder(h);
    const alerts = readFileSync(join(h, "alerts", "alerts.jsonl"), "utf8");
    expect(alerts).toContain("RPC_DOWN");
    expect(alerts).toContain("RPC_SINGLE");
    expect(files.some((f) => f.endsWith("heartbeat-keep.json"))).toBe(true);
    // the key itself: nowhere
    expect(text.includes(SECRET)).toBe(false);
    for (const f of files) expect([f, readFileSync(f, "utf8").includes(SECRET)]).toEqual([f, false]);
  }, 60_000);

  test("both variables set, a failing command and output that is not a URL list stop the process without echoing", async () => {
    const h = home();
    const both = await run(WATCHER, ["src/main.ts", "status"], { ...envFor(h, `printf "http://127.0.0.1:${port}/v2/${SECRET}"`), AGATE_RPC_URLS: `http://x/${SECRET}` }, 15_000);
    expect(both).toContain("set one of AGATE_RPC_URLS_CMD and AGATE_RPC_URLS");
    const fail = await run(WATCHER, ["src/main.ts", "status"], envFor(h, `printf "${SECRET}" >&2; exit 3`), 15_000);
    expect(fail).toContain("AGATE_RPC_URLS_CMD failed (exit 3)");
    const junk = await run(WATCHER, ["src/main.ts", "status"], envFor(h, `printf "not-a-url-${SECRET}"`), 15_000);
    expect(junk).toContain("did not print a list of URLs");
    for (const t of [both, fail, junk]) expect(t.includes(SECRET)).toBe(false);
  }, 60_000);
});
