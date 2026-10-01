// The primary runner as a real process (src/runner.ts) on a real-time anvil. With AGATE_WRITE_MODE=cre and an index
// whose forwarder is not the CRE simulation forwarder, every CRE report would be refused inside the forwarder's
// try/catch: the runner must see that at start and post directly instead of burning a transaction per slice.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReplay } from "@agate/sources/io";
import { ADDR, type Anvil, type Deployed, deployIndex, haveAnvil, KEYS, PANELS_FILE, startAnvil } from "../../writer-standby/test/helpers/anvil.ts";
import { PRICES } from "../../writer-standby/test/helpers/world.ts";

const RUNNER = join(import.meta.dir, "../src/runner.ts");
const PROFILE = { day: 120, slices: 12, minReadings: 6, qMin: 1, demoLabel: true, signAll: true, epochDay: 20_727 };

let a: Anvil;
let dep: Deployed;
let replay: ReturnType<typeof startReplay>;

beforeAll(async () => {
  if (!haveAnvil) return;
  a = await startAnvil({ args: ["--block-time", "1"] });
  dep = await deployIndex(a, { profile: PROFILE });
  replay = startReplay({ clock: { t0: dep.epochTs, daySec: PROFILE.day, slices: PROFILE.slices }, scenario: PRICES });
}, 60_000);
afterAll(() => {
  replay?.stop();
  a?.stop();
});

describe.skipIf(!haveAnvil)("primary runner process", () => {
  test("refuses the CRE path for a non-CRE forwarder at start and posts directly", async () => {
    const home = mkdtempSync(join(tmpdir(), "agate-run-"));
    const p = Bun.spawn(["bun", "run", RUNNER], {
      env: {
        PATH: process.env.PATH!,
        HOME: process.env.HOME!,
        AGATE_WALL_HOME: home,
        AGATE_RPC_URLS: `${a.rpc},${a.rpc}/`,
        AGATE_CHAIN_ID: String(a.chainId),
        AGATE_INDEX: dep.index,
        AGATE_PRIMARY_KEY: KEYS[1],
        AGATE_PANELS: PANELS_FILE,
        AGATE_WRITE_MODE: "cre",
        SOURCE_BASE_URL: `${replay.url}/r/primary`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = new Response(p.stdout).text();
    const t0 = Date.now();
    let n = 0;
    while (n < 3 && Date.now() - t0 < 40_000) {
      await Bun.sleep(500);
      n = (
        await a.pub.getLogs({
          address: dep.index,
          event: { type: "event", name: "ReadingsPosted", inputs: [{ name: "gpuId", type: "bytes32", indexed: true }, { name: "day", type: "uint32", indexed: true }, { name: "writer", type: "address", indexed: true }, { name: "slice", type: "uint8" }, { name: "readAt", type: "uint64" }, { name: "values", type: "uint32[]" }, { name: "validMask", type: "uint32" }, { name: "late", type: "bool" }] },
          args: { writer: ADDR[1]! },
          fromBlock: 0n,
        })
      ).length;
    }
    p.kill("SIGTERM");
    expect(await p.exited).toBe(0);
    expect(n).toBeGreaterThanOrEqual(3);
    const lines = (await out).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.some((l) => l.event === "warning" && /not the CRE simulation forwarder/.test(l.message))).toBe(true);
    expect(lines.some((l) => l.event === "start" && l.rpcs === 2)).toBe(true);
    const reads = readFileSync(join(home, "primary/readings", (await Array.fromAsync(new Bun.Glob("*.jsonl").scan(join(home, "primary/readings"))))[0]!), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((l) => l.kind === "reading");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((l) => l.via === "direct")).toBe(true);
    expect((await out).includes(KEYS[1].slice(2))).toBe(false);
  }, 90_000);
});
