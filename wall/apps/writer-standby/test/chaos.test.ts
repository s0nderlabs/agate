// D10 on the real AgateIndex: a writer killed at every step of a slice and restarted from its log (no duplicate
// transaction, no lost logged entry inside the window); RPC failover through a proxy (erroring, hanging, stale, on
// the wrong chain) with no missed slice; every URL down for two slices (RPC_DOWN, entries held and sent after).
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "@agate/report/types";
import { dayStart, sliceAt, sliceStart } from "../src/core/index.ts";
import type { IndexChain } from "../src/pipeline/chain.ts";
import { type LogLine, ReadingLog } from "../src/pipeline/log.ts";
import type { ReadingSource } from "../src/pipeline/writer.ts";
import { ADDR, haveAnvil } from "./helpers/anvil.ts";
import { D, makeWorld, type World } from "./helpers/world.ts";

const STANDBY = ADDR[2]!;
let world: World | undefined;
const stops: (() => void)[] = [];
afterEach(() => {
  world?.stop();
  world = undefined;
  for (const s of stops.splice(0)) s();
});

class Killed extends Error {}

/** Asserts the standby's chain record: each (gpu, day, slice) posted once, one transaction per post, no skip. */
async function oncePerSlice(w: World, slices: number[]) {
  const posted = (await w.posted(STANDBY)).filter((x) => x.day === D);
  const keys = posted.map((x) => `${x.gpuId}:${x.slice}`);
  expect(new Set(keys).size).toBe(keys.length);
  expect([...new Set(posted.map((x) => x.slice))].sort((a, b) => a - b)).toEqual(slices);
  expect(await w.txCount(STANDBY)).toBe(new Set((await w.posted(STANDBY)).map((x) => x.tx)).size);
  expect(await w.skipped()).toBe(0);
  const g = w.dep.panels[0]!.gpuId as Hex;
  const bits = (await w.readings(g, D, STANDBY)).sliceBits;
  expect(bits).toBe(slices.reduce((b, h) => b | (1n << BigInt(h)), 0n));
}

/** Runs one standby, kills it at `kill` during slice 2 (it is dropped, its memory lost), starts a new one on the same
 * home and runs both stretches through slice 4. */
async function killAndRestart(kill: (w: World, dead: { now: boolean }) => Parameters<World["writer"]>[1]) {
  const w = (world = await makeWorld());
  const c = w.clock;
  const dead = { now: false };
  const first = await w.writer("standby", { keyLock: false, sendWaitS: 1, ...kill(w, dead) });
  for (let t = dayStart(c, D) + 1; t < sliceStart(c, D, 3) && !dead.now; t += 20) await w.tickAll([first], t);
  expect(dead.now).toBe(true);
  // launchd restarts it at once (ThrottleInterval 10 s): the new process starts on the same home
  const second = await w.writer("standby", { home: first.home, keyLock: false, seed: 99 });
  await w.run([second], w.now + 10, sliceStart(c, D, 5));
  await oncePerSlice(w, [0, 1, 2, 3, 4]);
  return { w, first, second };
}

const inSlice2 = (w: World) => sliceAt(w.clock, w.now).slice === 2 && sliceAt(w.clock, w.now).dayId === D;

describe.skipIf(!haveAnvil)("restart at every step of a slice (idempotent: chain + log are the state)", () => {
  test("killed while fetching (nothing logged): the restart reads the slice inside its window", async () => {
    await killAndRestart((w, dead) => ({
      rand: () => 0.1, // reads early in each slice, so the restart lands inside slice 2's read window
      source: (direct): ReadingSource => ({
        take: async (at) => {
          if (at.slice === 2 && !dead.now) {
            dead.now = true;
            throw new Killed("killed mid-fetch");
          }
          return direct.take(at);
        },
      }),
    }));
  }, 120_000);

  test("killed after the log line, before the send: the restart posts the logged entry, read once", async () => {
    const { first } = await killAndRestart((w, dead) => ({
      chainWrap: (ch: IndexChain): IndexChain => ({
        ...ch,
        postReport: async (r, m, u) => {
          if (inSlice2(w) && !dead.now) {
            dead.now = true;
            throw new Killed("killed before the send");
          }
          return ch.postReport(r, m, u);
        },
      }),
    }));
    const reads = readLines(first.log).filter((l) => l.kind === "reading" && l.slice === 2);
    expect(reads.length).toBe(1); // the restart did not read slice 2 again: it reposted the logged entry
  }, 120_000);

  test("killed after the journal line, before the broadcast: the restart broadcasts the same signed bytes", async () => {
    let hash: Hex | undefined;
    const { w } = await killAndRestart((w, dead) => ({
      journalWrap: (l: ReadingLog) =>
        Object.assign(Object.create(Object.getPrototypeOf(l)), l, {
          append(line: LogLine) {
            l.append(line);
            if (line.kind === "tx" && inSlice2(w) && !dead.now) {
              dead.now = true;
              hash = line.hash;
              throw new Killed("killed before the broadcast");
            }
          },
        }) as ReadingLog,
    }));
    const s2 = (await w.posted(STANDBY)).filter((x) => x.day === D && x.slice === 2);
    expect(s2.every((x) => x.tx === hash)).toBe(true);
  }, 120_000);

  test("killed after the broadcast, before the receipt (tx still in the mempool): no second transaction", async () => {
    await killAndRestart((w, dead) => ({
      chainWrap: (ch: IndexChain): IndexChain => ({
        ...ch,
        postReport: async (r, m, u) => {
          if (!inSlice2(w) || dead.now) return ch.postReport(r, m, u);
          await w.a.test.setAutomine(false);
          try {
            const res = await ch.postReport(r, m, u);
            expect(res.pending).toBe(true);
            dead.now = true;
            throw new Killed("killed before the receipt");
          } finally {
            await w.a.test.setAutomine(true);
          }
        },
      }),
    }));
  }, 120_000);

  test("killed after the receipt, before the read-back: the restart finds the bit set and sends nothing", async () => {
    let posted = false;
    await killAndRestart((w, dead) => ({
      chainWrap: (ch: IndexChain): IndexChain => ({
        ...ch,
        postReport: async (r, m, u) => {
          const res = await ch.postReport(r, m, u);
          if (inSlice2(w)) posted = true;
          return res;
        },
        readings: async (g, d, wr) => {
          if (posted && !dead.now) {
            dead.now = true;
            throw new Killed("killed before the read-back");
          }
          return ch.readings(g, d, wr);
        },
      }),
    }));
  }, 120_000);
});

export function readLines(log: ReadingLog): LogLine[] {
  return readdirSync(log.dir)
    .sort()
    .flatMap((f) => readFileSync(join(log.dir, f), "utf8").trim().split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogLine);
}

// ---------------------------------------------------------------- RPC chaos through a proxy

type Mode = "ok" | "http500" | "hang" | "stale" | "wrongChain" | "down";

function proxy(target: string) {
  const p = { mode: "ok" as Mode, url: "", calls: 0 };
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const body = (await req.json()) as { id: number; method: string; params?: unknown[] };
      p.calls += 1;
      if (p.mode === "down") return new Response("bad gateway", { status: 502 });
      if (p.mode === "http500") return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "internal" } }, { status: 500 });
      if (p.mode === "hang") {
        await Bun.sleep(3_000);
        return new Response("late", { status: 504 });
      }
      if (p.mode === "wrongChain" && body.method === "eth_chainId") return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x1" });
      const res = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json()) as { result?: { timestamp?: string } };
      if (p.mode === "stale" && body.method === "eth_getBlockByNumber" && j.result?.timestamp) {
        j.result.timestamp = `0x${(Number(BigInt(j.result.timestamp)) - 3_600).toString(16)}`;
      }
      return Response.json(j);
    },
  });
  p.url = `http://127.0.0.1:${server.port}`;
  stops.push(() => server.stop(true));
  return p;
}

describe.skipIf(!haveAnvil)("RPC chaos", () => {
  test("first URL erroring, hanging, then stale: RPC_FAILOVER each time, no missed slice, no duplicate", async () => {
    const w = (world = await makeWorld());
    const c = w.clock;
    const A = proxy(w.a.rpc);
    const B = proxy(w.a.rpc);
    const s = await w.writer("standby", { urls: [A.url, B.url] });
    const modes: Mode[] = ["ok", "http500", "hang", "stale", "ok"];
    let t = dayStart(c, D) + 1;
    for (let h = 0; h < modes.length; h++) {
      A.mode = modes[h]!;
      s.pool.cur = 0; // as after a re-probe: the first URL is current again when its trouble starts
      for (; t < sliceStart(c, D, h + 1); t += 20) await w.tickAll([s], t);
    }
    await oncePerSlice(w, [0, 1, 2, 3, 4]);
    const why = s.alerts.filter((x) => x.code === "RPC_FAILOVER").map((x) => String((x.data as { why?: string }).why));
    expect(why.some((x) => /HTTP 500/.test(x))).toBe(true);
    expect(why.some((x) => /timed out|abort|timeout/i.test(x))).toBe(true);
    expect(why.some((x) => /stale head/.test(x))).toBe(true);
    expect(s.alerts.some((x) => x.code === "RPC_DOWN" || x.code === "RPC_SINGLE")).toBe(false);
  }, 120_000);

  test("a URL on the wrong chain is dropped at start; one URL alone raises RPC_SINGLE", async () => {
    const w = (world = await makeWorld());
    const A = proxy(w.a.rpc);
    A.mode = "wrongChain";
    const s = await w.writer("standby", { urls: [A.url, w.a.rpc] });
    expect(s.pool.urls).toEqual([w.a.rpc]);
    expect(s.alerts.some((x) => x.code === "RPC_FAILOVER" && x.severity === "action")).toBe(true);
    const one = await w.writer("primary", { urls: [w.a.rpc] });
    expect(one.alerts.map((x) => x.code)).toEqual(["RPC_SINGLE"]);
  }, 60_000);

  test("every URL down for two slices: readings logged, RPC_DOWN once, posts held and sent after, no nonce gap", async () => {
    const w = (world = await makeWorld());
    const c = w.clock;
    const A = proxy(w.a.rpc);
    const B = proxy(w.a.rpc);
    const s = await w.writer("standby", { urls: [A.url, B.url] });
    await w.run([s], dayStart(c, D) + 1, sliceStart(c, D, 2));
    A.mode = B.mode = "down";
    await w.run([s], sliceStart(c, D, 2), sliceStart(c, D, 4));
    expect(s.alerts.filter((x) => x.code === "RPC_DOWN").length).toBe(1);
    expect(readLines(s.log).filter((l) => l.kind === "reading").map((l) => (l as { slice: number }).slice)).toEqual([0, 1, 2, 3]);
    A.mode = B.mode = "ok";
    await w.run([s], sliceStart(c, D, 4), sliceStart(c, D, 5));
    await oncePerSlice(w, [0, 1, 2, 3, 4]);
    const nonces = await Promise.all((await w.posted(STANDBY)).map(async (x) => (await w.a.pub.getTransaction({ hash: x.tx })).nonce));
    const uniq = [...new Set(nonces)].sort((a, b) => a - b);
    expect(uniq).toEqual(uniq.map((_, i) => i)); // 0, 1, 2, ...: no gap, no reuse
  }, 120_000);
});
