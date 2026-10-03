// Oct 3 (BUILD-SPEC 8.2, 8.5, 8.6, 13.6): limits from the panel, key-free project.yaml and child environment, the run
// line before the CLI starts, the readers of the run's day in cfg.json; and the runner as a real process with
// AGATE_RPC_URLS_CMD and a fake CRE CLI (a script that records what it was given) on a private anvil.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcEndpoints } from "@agate/report/env";
import { startReplay } from "@agate/sources/io";
import type { Panel } from "@agate/sources/types";
import { clockOf } from "@agate/writer-standby";
import { type Anvil, type Deployed, deployIndex, haveAnvil, KEYS, LAUNCH_PANELS_FILE, PANELS_FILE, startAnvil } from "../../writer-standby/test/helpers/anvil.ts";
import { PRICES } from "../../writer-standby/test/helpers/world.ts";
import { CRE_SIM_FORWARDER, panelOverCap } from "../src/runner.ts";
import { assertKeyFree, childEnv, creLimits, creRpcRotation, creRpcUrls, creSource, prepareRuntime, workflowConfig, workflowRefusals } from "../src/simulate.ts";

const WORKFLOW = join(import.meta.dir, "../workflow");
const FAKE = "FAKEALCHEMYKEY0123456789";
const launch = (await Bun.file(LAUNCH_PANELS_FILE).json()) as { flags: { includeOverCap: boolean }; panels: Panel[] };
const flagless = (await Bun.file(PANELS_FILE).json()) as { flags: { includeOverCap: boolean }; panels: Panel[] };

describe("8.2 (1): limits follow the panel", () => {
  test("the launch panel runs with --limits none; the flagless one with default; AGATE_CRE_LIMITS overrides", () => {
    expect(panelOverCap(launch.flags, launch.panels)).toBe(true);
    expect(panelOverCap(flagless.flags, flagless.panels)).toBe(false);
    // a hand-made panel with CoreWeave but no flag is over the cap too: its page would silently read as 0
    expect(panelOverCap({}, launch.panels)).toBe(true);
    expect(creLimits(undefined, true)).toBe("none");
    expect(creLimits("", true)).toBe("none");
    expect(creLimits(undefined, false)).toBe("default");
    expect(creLimits("none", false)).toBe("none");
    expect(creLimits("./limits.yaml", true)).toBe("./limits.yaml");
  });

  test("AGATE_CRE_LIMITS=default with an over-cap panel refuses to start", () => {
    expect(() => creLimits("default", true)).toThrow("the panel reads a source over CRE's cap; run with --limits none");
    expect(creLimits("default", false)).toBe("default");
  });
});

describe("8.2 (2), 13.6: the CLI never gets a URL from the RPC list", () => {
  const endpoints: RpcEndpoints = { http: [`https://monad-testnet.g.alchemy.com/v2/${FAKE}`, "https://testnet-rpc.monad.xyz"], ws: [`wss://monad-testnet.g.alchemy.com/v2/${FAKE}`] };

  test("AGATE_CRE_RPC_URLS: key-free URLs only, default the public testnet RPC; failover among them", () => {
    expect(creRpcUrls({})).toEqual(["https://testnet-rpc.monad.xyz"]);
    expect(creRpcUrls({ AGATE_CRE_RPC_URLS: "http://127.0.0.1:8545, https://testnet-rpc.monad.xyz/" })).toEqual(["http://127.0.0.1:8545", "https://testnet-rpc.monad.xyz/"]);
    for (const bad of [`https://monad-testnet.g.alchemy.com/v2/${FAKE}`, "https://rpc.example/?key=abcdefabcdefabcdef", "https://user:pw@rpc.example", "ftp://rpc.example", "not a url"]) {
      expect(() => creRpcUrls({ AGATE_CRE_RPC_URLS: bad })).toThrow(/AGATE_CRE_RPC_URLS/);
      try {
        creRpcUrls({ AGATE_CRE_RPC_URLS: bad });
      } catch (e) {
        expect((e as Error).message.includes(FAKE)).toBe(false); // the refusal never echoes the URL
        expect((e as Error).message.includes("abcdefabcdef")).toBe(false);
      }
    }
    expect(assertKeyFree("https://testnet-rpc.monad.xyz")).toBe("https://testnet-rpc.monad.xyz");
    const r = creRpcRotation(["a", "b"]);
    expect(r.url()).toBe("a");
    r.failed();
    expect(r.url()).toBe("b");
    r.failed();
    expect(r.url()).toBe("a");
  });

  test("the child's environment holds no RPC list and no variable carrying a configured URL or its key", () => {
    const env = childEnv(
      {
        PATH: "/usr/bin",
        HOME: "/h",
        AGATE_RPC_URLS_CMD: "printf x",
        AGATE_RPC_URLS: "https://a,https://b",
        AGATE_RPC_URL: "https://a",
        SOME_COPY: `https://monad-testnet.g.alchemy.com/v2/${FAKE}`,
        BARE_KEY: FAKE,
        AGATE_INDEX: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
        UNDEF: undefined,
      },
      endpoints,
    );
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/h", AGATE_INDEX: "0x5FbDB2315678afecb367f032d93F642f64180aa3" });
  });
});

describe("8.2 (3), (4): readers in cfg.json, the run line before the CLI", () => {
  test("each run writes the day's readers into cfg.json (only when they change) and announces its run first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agate-cre-rd-"));
    const cfg = workflowConfig({ index: "0x5FbDB2315678afecb367f032d93F642f64180aa3", chainSelector: 1n, gasLimit: 777_371n, clock: clockOf({ day: 600, slices: 4, epochTs: 5, epochDay: 20_758 }), panels: launch.panels });
    const rt = prepareRuntime({ dir, workflowDir: WORKFLOW, target: "local-simulation", chainName: "monad-testnet", config: cfg });
    const order: string[] = [];
    const cfgSeen: unknown[] = [];
    const runner = async () => {
      order.push("cli");
      cfgSeen.push(JSON.parse(readFileSync(join(dir, "cfg.json"), "utf8")).readers ?? null);
      return { stdout: "no result", code: 1, ms: 1 };
    };
    const at = { dayId: 20_758, slice: 1, readAt: 1_800_000_000 };
    const fallback = { take: async () => ({ reading: { ...at, entries: [], sources: [] }, via: "direct" as const }) };
    const failed: number[] = [];
    let n = 0;
    const src = creSource({ creBin: "cre", dir, target: "local-simulation", configPath: "./cfg.json", broadcast: true, timeoutMs: 1 }, () => {}, fallback, runner, {
      exclusive: async (fn) => fn(),
      rpcUrl: () => "http://127.0.0.1:8545",
      rpcFailed: () => void failed.push(++n),
      runtime: rt,
    });
    const readers = { [launch.panels[0]!.gpuId]: { "2": { url: "https://lambda.ai/pricing", parserVersion: "lambda/2" } } };
    const ids: string[] = [];
    const r1 = await src.take({ ...at, readers, onRun: (id) => void (order.push("run-line"), ids.push(id)) });
    expect(order).toEqual(["run-line", "cli"]); // logged before the CLI starts
    expect(ids[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(cfgSeen[0]).toEqual(readers);
    expect(r1.via).toBe("direct");
    expect(r1.runId).toBeUndefined(); // the run was not parsed: the fallback's reading is not that run's
    expect(failed).toEqual([1]); // the next run tries the next key-free URL
    const mtime = statSync(join(dir, "cfg.json")).mtimeMs;
    await src.take({ ...at, readers, onRun: (id) => void ids.push(id) });
    expect(statSync(join(dir, "cfg.json")).mtimeMs).toBe(mtime); // unchanged readers: not rewritten
    expect(ids[1]).not.toBe(ids[0]);
    await src.take({ ...at, onRun: () => {} });
    expect(cfgSeen[2]).toBeNull(); // no swap in force: no readers key
    expect(readFileSync(join(dir, "project.yaml"), "utf8")).toContain('url: "http://127.0.0.1:8545"');
  });
});

describe("8.2 (3): a version the compiled workflow lacks", () => {
  test("is found in the run's result: the slot this process allowed came back refused (the runner raises READER_MISSING)", () => {
    const b200 = launch.panels.find((p) => p.gpu === "B200")!;
    const slot = b200.slots.find((s) => s.sourceId === "p_lambda")!.slot;
    const readers = { [b200.gpuId]: { [String(slot)]: { url: "https://lambda.ai/pricing", parserVersion: "lambda/2" } } };
    const sources = [{ sourceId: "p_lambda", httpStatus: 200, bytes: 1, rows: { B200: { state: "MISSED" as const, valueU: 0 } }, refused: { B200: "parser lambda/2 is not installed in this build" } }];
    expect(workflowRefusals(launch.panels, readers, sources)).toEqual([{ gpuId: b200.gpuId, gpu: "B200", slot, sourceId: "p_lambda", parserVersion: "lambda/2", why: "parser lambda/2 is not installed in this build" }]);
    // a reader this process refused itself is not the workflow's doing
    expect(workflowRefusals(launch.panels, { [b200.gpuId]: { [String(slot)]: { refused: "x" } } }, sources)).toEqual([]);
    expect(workflowRefusals(launch.panels, undefined, sources)).toEqual([]);
  });
});

// ---------------------------------------------------------------- the runner as a process

let a: Anvil;
let dep: Deployed;
let replay: ReturnType<typeof startReplay>;
const PROFILE = { day: 120, slices: 12, minReadings: 6, qMin: 1, demoLabel: true, signAll: true, epochDay: 20_727 };

beforeAll(async () => {
  if (!haveAnvil) return;
  a = await startAnvil({ args: ["--block-time", "1"] });
  dep = await deployIndex(a, { profile: PROFILE, forwarder: CRE_SIM_FORWARDER, panelsFile: LAUNCH_PANELS_FILE });
  replay = startReplay({ clock: { t0: dep.epochTs, daySec: PROFILE.day, slices: PROFILE.slices }, scenario: { ...PRICES, scripted: { ...PRICES.scripted, p_coreweave: { gpus: { H100: [{ from: { day: 0 }, price: "6.16", count: 8 }], H200: [{ from: { day: 0 }, price: "6.31", count: 8 }], B200: [{ from: { day: 0 }, price: "8.60", count: 8 }] } } } } });
}, 90_000);
afterAll(() => {
  replay?.stop();
  a?.stop();
});

/** A stand-in for the CRE CLI: records its arguments, environment and project.yaml, then fails like a CLI without a
 * login (so every run falls back to the direct path). Never prints anything it was given. */
function fakeCli(dir: string): string {
  const bin = join(dir, "fake-cre.sh");
  writeFileSync(
    bin,
    `#!/bin/sh
n=$(ls "${dir}"/run-*.args 2>/dev/null | wc -l | tr -d ' ')
printf '%s\\n' "$@" > "${dir}/run-$n.args"
env > "${dir}/run-$n.env"
cp project.yaml "${dir}/run-$n.project.yaml"
echo "authentication required: no credentials found"
exit 1
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
}

function runner(env: Record<string, string>) {
  return Bun.spawn(["bun", "run", join(import.meta.dir, "../src/runner.ts")], { env, stdout: "pipe", stderr: "pipe" });
}

describe.skipIf(!haveAnvil)("the primary runner with AGATE_RPC_URLS_CMD and the launch panel", () => {
  test("never leaks the RPC key: not in project.yaml, the CLI's environment, any file or any output; --limits none; run lines", async () => {
    const home = mkdtempSync(join(tmpdir(), "agate-run-cmd-"));
    const rec = mkdtempSync(join(tmpdir(), "agate-run-rec-"));
    const wasm = join(rec, "main.wasm");
    writeFileSync(wasm, "not a real wasm: the fake CLI never reads it");
    const p = runner({
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      AGATE_WALL_HOME: home,
      // the first URL is dead (forced RPC failures) and carries the fake key in its path, as Alchemy's does
      AGATE_RPC_URLS_CMD: `printf "http://127.0.0.1:1/v2/${FAKE},${a.rpc}"`,
      AGATE_CRE_RPC_URLS: a.rpc,
      AGATE_CHAIN_ID: String(a.chainId),
      AGATE_INDEX: dep.index,
      AGATE_PRIMARY_KEY: KEYS[1],
      AGATE_PANELS: LAUNCH_PANELS_FILE,
      AGATE_WRITE_MODE: "cre",
      AGATE_CRE_WASM: wasm,
      CRE_BIN: fakeCli(rec),
      SOURCE_BASE_URL: `${replay.url}/r/primary`,
    });
    const out = new Response(p.stdout).text();
    const err = new Response(p.stderr).text();
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000 && readdirSync(rec).filter((f) => f.endsWith(".args")).length < 2) await Bun.sleep(500);
    await Bun.sleep(1_500);
    p.kill("SIGTERM");
    expect(await p.exited).toBe(0);
    const runs = readdirSync(rec).filter((f) => f.endsWith(".args"));
    expect(runs.length).toBeGreaterThanOrEqual(2);
    for (const f of runs) {
      const args = readFileSync(join(rec, f), "utf8").split("\n");
      expect(args[args.indexOf("--limits") + 1]).toBe("none"); // the launch panel reads CoreWeave (436 KB)
      const env = readFileSync(join(rec, f.replace(".args", ".env")), "utf8");
      expect(env.includes(FAKE)).toBe(false);
      expect(/^AGATE_RPC_URLS(_CMD)?=/m.test(env)).toBe(false);
      expect(/^CRE_ETH_PRIVATE_KEY=/m.test(env)).toBe(true); // the broadcast key reaches the CLI child only
      const yaml = readFileSync(join(rec, f.replace(".args", ".project.yaml")), "utf8");
      expect(yaml).toContain(`url: "${a.rpc}"`);
      expect(yaml.includes(FAKE)).toBe(false);
    }
    const o = (await out) + (await err);
    expect(o.includes(FAKE)).toBe(false);
    expect(o.includes(KEYS[1].slice(2))).toBe(false);
    for (const f of filesUnder(home)) expect(readFileSync(f, "utf8").includes(FAKE), f).toBe(false);
    const lines = o.trim().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    expect(lines.some((l) => l.event === "mode" && l.mode === "cre" && l.limits === "none")).toBe(true);
    expect(lines.some((l) => l.event === "start" && l.rpcs === 2)).toBe(true);
    const logged = filesUnder(join(home, "primary/readings")).flatMap((f) => readFileSync(f, "utf8").trim().split("\n")).map((l) => JSON.parse(l));
    expect(logged.filter((l) => l.kind === "run").length).toBeGreaterThanOrEqual(2);
    expect(logged.some((l) => l.kind === "reading" && l.via === "direct" && l.sources.some((s: { sourceId: string; rows: { H100?: { state: string } } }) => s.sourceId === "p_coreweave" && s.rows.H100?.state === "VALID"))).toBe(true);
    expect(existsSync(join(home, "primary/cre", dep.index.slice(2, 10).toLowerCase(), "project.yaml"))).toBe(true);
  }, 120_000);

  test("AGATE_CRE_LIMITS=default with the launch panel refuses to start; both RPC variables set refuses too", async () => {
    const home = mkdtempSync(join(tmpdir(), "agate-run-lim-"));
    const base = {
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      AGATE_WALL_HOME: home,
      AGATE_CHAIN_ID: String(a.chainId),
      AGATE_INDEX: dep.index,
      AGATE_PRIMARY_KEY: KEYS[1],
      AGATE_PANELS: LAUNCH_PANELS_FILE,
      AGATE_WRITE_MODE: "cre",
      SOURCE_BASE_URL: `${replay.url}/r/primary`,
    };
    const p = runner({ ...base, AGATE_RPC_URLS: `${a.rpc},${a.rpc}/`, AGATE_CRE_LIMITS: "default", AGATE_CRE_RPC_URLS: a.rpc });
    expect(await p.exited).not.toBe(0);
    expect(await new Response(p.stderr).text()).toContain("the panel reads a source over CRE's cap; run with --limits none");
    const q = runner({ ...base, AGATE_RPC_URLS: a.rpc, AGATE_RPC_URLS_CMD: `printf "${a.rpc}"` });
    expect(await q.exited).not.toBe(0);
    expect(await new Response(q.stderr).text()).toContain("set one of AGATE_RPC_URLS_CMD and AGATE_RPC_URLS");
  }, 60_000);
});
