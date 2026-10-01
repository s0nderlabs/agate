// The standby as a real process (src/main.ts) on a real-time anvil: it posts through the real contract, writes its
// heartbeat, raises RPC_SINGLE with one URL, refuses a second instance (flock) and stops cleanly on SIGTERM.
// Profile: a 120-second day of 12 ten-second slices (signAll, as the constructor requires for so short a day).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReplay } from "@agate/sources/io";
import { ADDR, type Anvil, type Deployed, deployIndex, haveAnvil, KEYS, PANELS_FILE, startAnvil } from "./helpers/anvil.ts";
import { PRICES } from "./helpers/world.ts";

const MAIN = join(import.meta.dir, "../src/main.ts");
const PROFILE = { day: 120, slices: 12, minReadings: 6, qMin: 1, demoLabel: true, signAll: true, epochDay: 20_727 };

let a: Anvil;
let dep: Deployed;
let replay: ReturnType<typeof startReplay>;
let home: string;

beforeAll(async () => {
  if (!haveAnvil) return;
  a = await startAnvil({ args: ["--block-time", "1"] });
  dep = await deployIndex(a, { profile: PROFILE });
  replay = startReplay({ clock: { t0: dep.epochTs, daySec: PROFILE.day, slices: PROFILE.slices }, scenario: PRICES });
  home = mkdtempSync(join(tmpdir(), "agate-svc-"));
}, 60_000);
afterAll(() => {
  replay?.stop();
  a?.stop();
});

function spawnStandby() {
  return Bun.spawn(["bun", "run", MAIN], {
    env: {
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      AGATE_WALL_HOME: home,
      AGATE_RPC_URLS: a.rpc,
      AGATE_CHAIN_ID: String(a.chainId),
      AGATE_INDEX: dep.index,
      AGATE_STANDBY_KEY: KEYS[2],
      AGATE_PANELS: PANELS_FILE,
      SOURCE_BASE_URL: `${replay.url}/r/standby`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function spawnWith(env: Record<string, string>) {
  return Bun.spawn(["bun", "run", MAIN], {
    env: {
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      AGATE_WALL_HOME: home,
      AGATE_CHAIN_ID: String(a.chainId),
      AGATE_INDEX: dep.index,
      AGATE_STANDBY_KEY: KEYS[2],
      AGATE_PANELS: PANELS_FILE,
      SOURCE_BASE_URL: `${replay.url}/r/standby`,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

const POSTED_EVENT = { type: "event", name: "ReadingsPosted", inputs: [{ name: "gpuId", type: "bytes32", indexed: true }, { name: "day", type: "uint32", indexed: true }, { name: "writer", type: "address", indexed: true }, { name: "slice", type: "uint8" }, { name: "readAt", type: "uint64" }, { name: "values", type: "uint32[]" }, { name: "validMask", type: "uint32" }, { name: "late", type: "bool" }] } as const;

describe.skipIf(!haveAnvil)("standby process", () => {
  test("posts in real time, heartbeat, RPC_SINGLE, one instance per index, clean SIGTERM", async () => {
    const p = spawnStandby();
    const out = new Response(p.stdout).text();
    const posted = async () =>
      (await a.pub.getLogs({
        address: dep.index,
        event: { type: "event", name: "ReadingsPosted", inputs: [{ name: "gpuId", type: "bytes32", indexed: true }, { name: "day", type: "uint32", indexed: true }, { name: "writer", type: "address", indexed: true }, { name: "slice", type: "uint8" }, { name: "readAt", type: "uint64" }, { name: "values", type: "uint32[]" }, { name: "validMask", type: "uint32" }, { name: "late", type: "bool" }] },
        args: { writer: ADDR[2]! },
        fromBlock: 0n,
      })).length;
    const t0 = Date.now();
    while ((await posted()) < 6 && Date.now() - t0 < 40_000) await Bun.sleep(500);
    expect(await posted()).toBeGreaterThanOrEqual(6); // two slices x three GPUs

    const hb = JSON.parse(readFileSync(join(home, "standby/heartbeat.json"), "utf8"));
    expect(hb).toMatchObject({ role: "standby", index: dep.index, pid: p.pid });
    expect(Math.abs(hb.at - Math.floor(Date.now() / 1000))).toBeLessThan(10);
    expect(hb.tick).toBeGreaterThan(3);
    const alerts = readFileSync(join(home, "alerts/alerts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(alerts.some((x) => x.code === "RPC_SINGLE" && x.severity === "action")).toBe(true);
    expect(existsSync(join(home, "standby", `${dep.index.toLowerCase()}.lock`))).toBe(true);

    const second = spawnStandby();
    expect(await second.exited).toBe(3);
    expect(await new Response(second.stderr).text()).toMatch(/another standby writer .* holds .*\.lock: exiting/);

    p.kill("SIGTERM");
    expect(await p.exited).toBe(0);
    const lines = (await out).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.some((l) => l.event === "start" && l.tPend === 30 && l.slices === 12)).toBe(true);
    expect(lines.at(-1).event).toBe("stop");
    expect((await out).includes(KEYS[2].slice(2))).toBe(false); // the key never reaches the log

    // the lock went with the process: a new one starts at once
    const third = spawnStandby();
    await Bun.sleep(1_500);
    expect(third.exitCode).toBeNull();
    third.kill("SIGTERM");
    expect(await third.exited).toBe(0);
  }, 90_000);

  test("booted with every RPC down: starts from the remembered clock, reads and logs, and its entries land once the RPC is back", async () => {
    // a proxy that answers 502 until switched on (the first test above left the remembered start in `home`)
    let up = false;
    const px = Bun.serve({
      port: 0,
      async fetch(req) {
        if (!up) return new Response("bad gateway", { status: 502 });
        const r = await fetch(a.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: await req.text() });
        return new Response(await r.text(), { headers: { "content-type": "application/json" } });
      },
    });
    try {
      const before = (await a.pub.getLogs({ address: dep.index, event: POSTED_EVENT, args: { writer: ADDR[2]! }, fromBlock: 0n })).length;
      const p = spawnWith({ AGATE_RPC_URLS: `http://127.0.0.1:${px.port}` });
      const out = new Response(p.stdout).text();
      const readsLogged = () => {
        const dir = join(home, "standby/readings");
        return readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n")).filter((l) => l.includes('"kind":"reading"')).length;
      };
      const r0 = readsLogged();
      const t0 = Date.now();
      while (readsLogged() < r0 + 2 && Date.now() - t0 < 40_000) await Bun.sleep(500);
      expect(readsLogged()).toBeGreaterThanOrEqual(r0 + 2); // pages read and logged with the chain unreachable
      expect((await a.pub.getLogs({ address: dep.index, event: POSTED_EVENT, args: { writer: ADDR[2]! }, fromBlock: 0n })).length).toBe(before);
      up = true;
      const t1 = Date.now();
      let after = before;
      while (after < before + 6 && Date.now() - t1 < 40_000) {
        await Bun.sleep(500);
        after = (await a.pub.getLogs({ address: dep.index, event: POSTED_EVENT, args: { writer: ADDR[2]! }, fromBlock: 0n })).length;
      }
      expect(after).toBeGreaterThanOrEqual(before + 6); // the held entries were sent once a URL answered
      p.kill("SIGTERM");
      expect(await p.exited).toBe(0);
      const lines = (await out).trim().split("\n").map((l) => JSON.parse(l));
      expect(lines.some((l) => l.event === "warning" && /remembered/.test(l.message))).toBe(true);
      expect(lines.some((l) => l.event === "rpc_verified")).toBe(true);
    } finally {
      px.stop(true);
    }
  }, 120_000);
});
