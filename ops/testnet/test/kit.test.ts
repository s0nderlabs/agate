// The testnet kit's scripts, each run with --dry-run (offline: no RPC, no Keychain, no tmux, no forge): what they
// print and what they never do. `bun test ops/testnet/test` from the repo root.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// each test spawns bash scripts; on a loaded machine (other processes at load 15 to 30) bun's 5 s default timed some out
setDefaultTimeout(60_000);

const KIT = resolve(import.meta.dir, "..");
const ROOT = resolve(KIT, "../..");
const CONFIG = join(ROOT, "contracts/script/config");
const LAUNCH = JSON.parse(readFileSync(join(ROOT, "wall/packages/sources/panels/launch.json"), "utf8")) as { deploy: { gpuId: string; recipeHash: string }[] };

const REAL = {
  deployer: "0x62565E5D1533af8C1f711C42E047e5f94C172411",
  owner: "0x016575774F23c2c43Ea1217a080FFC7db61EE681",
  primary: "0xF0be5c7461c0743acDE590A22BcCb66Fc2112335",
  standby: "0x7AB94Da3958d82dF236529c57e46B6D11FE90e92",
  attester: "0x98BEd8aD0d00D74F7D540d523a1f7Ee43673fdF1",
  keeper: "0x1a18eD8A5776f3D3b05cAb5A56fBF8baeC077881",
  guardian: "0x10280466C8c6eF47152523717dd83D3c97f95F02",
  kick: "0x220095EB92b3Ec9453d5dFcBdA7e4D05fb43C259",
  bot: "0xBFAa70A8b399097FACF4A84B98Da5B304587C8B8",
  payer: "0x3786e99fC370506391be896E1D327a49de6A9505",
};
const SVC: Record<string, string> = {
  AGATE_OWNER_KEY: "agate.wall.owner",
  AGATE_DEPLOYER_KEY: "agate.deployer",
};
const JQ_DIR = dirname(Bun.which("jq") ?? "/usr/bin/jq");
const KIT_WINDOWS = new Set([
  ..."prod-log prod-primary prod-standby prod-attest prod-keep prod-health prod-pagecheck".split(" "),
  ..."demo-replay demo-log demo-primary demo-standby demo-attest demo-keep demo-health demo-pagecheck".split(" "),
  ..."shared-maker shared-payer shared-indexer shared-repair shared-akash shared-awake".split(" "),
]);

let tmp = "";
let calls = "";
let env: Record<string, string> = {};

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "agate-kit-test-"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  calls = join(tmp, "calls.log");
  // a dry run must never reach these: each stub records its call and fails
  for (const t of ["security", "tmux", "forge", "cast", "anvil", "podman", "docker", "envio"]) {
    const p = join(bin, t);
    writeFileSync(p, `#!/bin/sh\necho "${t} $*" >> '${calls}'\nexit 97\n`);
    chmodSync(p, 0o755);
  }
  writeFileSync(join(tmp, "records.json"), JSON.stringify({ chainId: 10143, production: { status: "deployed", index: "0x1111111111111111111111111111111111111111", deployBlock: 100, firstDay: 20731 }, demo: { status: "deployed", session: "active", index: "0x2222222222222222222222222222222222222222", deployBlock: 200, firstDay: 20758, epochTs: 1791000000, day: 600, slices: 4 } }));
  writeFileSync(join(tmp, "deployments.json"), JSON.stringify({ chainId: 10143, dollar: "0x3333333333333333333333333333333333333333", kuru: { router: "0x7EFbE105Ca7415dE98F96622173458ac1c054630", marginAccount: "0xd029C2D98ff85D8F64799017fE00a59B1159CE02" }, factories: { real: { index: "0x1111111111111111111111111111111111111111", dollar: "0x3333333333333333333333333333333333333333", tag: "", factory: "0x4444444444444444444444444444444444444444", router: "0x5555555555555555555555555555555555555555", tPend: 21600, startBlock: 101 } } }));
  env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: process.env.HOME ?? tmp,
    TMPDIR: tmp,
    AGATE_KIT_OFFLINE: "1",
    AGATE_KIT_NOW: "1791100000",
    AGATE_KIT_STATE: join(tmp, "state"),
    // hermetic: never the repo's records or deployments files, whether or not a deploy has written them
    AGATE_KIT_RECORDS: join(tmp, "no-records.json"),
    AGATE_KIT_DEPLOYMENTS: join(tmp, "no-deployments.json"),
    AGATE_WALL_HOME: join(tmp, "wall-home"),
    FOUNDRY_OUT: join(tmp, "out"),
    FOUNDRY_CACHE_PATH: join(tmp, "cache"),
  };
});
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function run(script: string, args: string[], extra: Record<string, string> = {}): { code: number; out: string } {
  const r = Bun.spawnSync(["/bin/bash", join(KIT, script), ...args], { cwd: ROOT, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}
const callLog = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");
// each launcher of an up.sh dry run: "write <dir>/run/<name>.sh:" then its "    | " lines
const launchersOf = (out: string) => out.split(/\$ write \S+\/run\//).slice(1).map((b) => ({ name: b.slice(0, b.indexOf(".sh:")), body: b.split("\n").filter((l) => l.startsWith("    | ")).join("\n") }));

const RUNS: [string, string[], Record<string, string>?][] = [
  ["deploy-index.sh", ["testnet-production", "--dry-run"]],
  ["deploy-index.sh", ["testnet-demo", "--dry-run"]],
  ["deploy-market.sh", ["production", "--dry-run"]],
  ["deploy-market.sh", ["demo", "--dry-run"]],
  ["fund.sh", ["--dry-run", "--send"]],
  ["up.sh", ["production", "--dry-run"]],
  ["up.sh", ["demo", "--dry-run"]],
  ["down.sh", ["production", "--dry-run", "--shared"]],
  ["down.sh", ["demo", "--dry-run", "--shared", "--cancel-books"]],
  ["demo-session.sh", ["start", "--dry-run"]],
  ["demo-session.sh", ["stop", "--dry-run"]],
  ["status.sh", ["production", "--dry-run"]],
  ["indexer.sh", ["stop", "--dry-run"]],
];

describe("every script's dry run", () => {
  const outputs: Record<string, string> = {};
  const configsBefore: Record<string, string> = {};

  beforeAll(() => {
    for (const f of ["testnet-production.json", "testnet-demo.json", "market-testnet.json"]) configsBefore[f] = readFileSync(join(CONFIG, f), "utf8");
    for (const [s, a, e] of RUNS) {
      const r = run(s, a, e);
      outputs[`${s} ${a.join(" ")}`] = r.out;
      expect({ script: `${s} ${a.join(" ")}`, code: r.code, tail: r.code === 0 ? "" : r.out.slice(-800) }).toEqual({ script: `${s} ${a.join(" ")}`, code: 0, tail: "" });
    }
    const ix = run("indexer.sh", ["run", "--dry-run"], { AGATE_DEPLOYMENTS: join(tmp, "deployments.json"), AGATE_KIT_RECORDS: join(tmp, "records.json") });
    expect(ix.code).toBe(0);
    outputs["indexer.sh run --dry-run"] = ix.out;
    // with the indexes and the market recorded: the shared market windows open too
    for (const stack of ["production", "demo"]) {
      const r = run("up.sh", [stack, "--dry-run"], { AGATE_KIT_RECORDS: join(tmp, "records.json"), AGATE_KIT_DEPLOYMENTS: join(tmp, "deployments.json") });
      expect(r.code).toBe(0);
      outputs[`up.sh ${stack} --dry-run (deployed)`] = r.out;
    }
  }, 180_000);

  test("sends nothing and reads no Keychain item: no security, forge, cast, tmux, anvil or container call", () => {
    expect(callLog()).toBe("");
  });

  test("writes no config, records or deployments file", () => {
    for (const [f, before] of Object.entries(configsBefore)) expect(readFileSync(join(CONFIG, f), "utf8")).toBe(before);
    for (const f of ["kit-fork-testnet-production.json", "market-kit-demo.json", "market-kit-fork-demo.json"]) expect(existsSync(join(CONFIG, f))).toBe(false);
    expect(existsSync(join(tmp, "state"))).toBe(false);
  });

  test("no key value in any output: every 32-byte hex printed is a public gpuId or recipeHash", () => {
    const allowed = new Set(LAUNCH.deploy.flatMap((d) => [d.gpuId.toLowerCase(), d.recipeHash.toLowerCase()]));
    for (const [name, out] of Object.entries(outputs)) {
      const hex = out.match(/0x[0-9a-fA-F]{64}/g) ?? [];
      for (const h of hex) expect({ name, h, allowed: allowed.has(h.toLowerCase()) }).toEqual({ name, h, allowed: true });
      expect(out).not.toContain("--private-key");
      expect(out).not.toMatch(/alchemy\.com\/v2\/(?!%s)/);
    }
  });

  test("every signing command reads its key inline from the Keychain, into that one command's environment", () => {
    let signing = 0;
    for (const [name, out] of Object.entries(outputs)) {
      for (const line of out.split("\n").filter((l) => l.startsWith("$ "))) {
        const sends = /forge script \S+ .*--broadcast/.test(line) || /send\.ts (transfers|call)/.test(line);
        if (!sends) continue;
        signing++;
        const m = line.match(/(AGATE_[A-Z]+_KEY)="\$\(security find-generic-password -s (\S+) -a private-key -w\)" /);
        expect({ name, line, inline: Boolean(m) }).toEqual({ name, line, inline: true });
        expect(SVC[m![1]!]).toBe(m![2]!);
        if (line.includes("send.ts")) expect(line).toContain(`--key-env ${m![1]}`);
        expect(line).not.toContain("--unlocked");
      }
    }
    expect(signing).toBeGreaterThanOrEqual(6);
  });

  test("the process windows get key commands, never keys, and the RPC list only as a command", () => {
    const up = outputs["up.sh production --dry-run"]! + outputs["up.sh demo --dry-run"]!;
    for (const [v, svc] of [
      ["AGATE_PRIMARY_KEY_CMD", "agate.wall.primary"],
      ["AGATE_STANDBY_KEY_CMD", "agate.wall.standby"],
    ]) expect(up).toContain(`${v}='security find-generic-password -s ${svc} -a private-key -w'`);
    expect(up).toContain("AGATE_KEY_CMD='security find-generic-password -s agate.wall.attester -a private-key -w'");
    expect(up).toContain("AGATE_KEY_CMD='security find-generic-password -s agate.wall.keeper -a private-key -w'");
    // Alchemy light by default (Oct 4): only the signing windows read its key (inside their command), as a send: entry;
    // only the attester and the keeper get its websocket (with AGATE_WS_KIND=logs); every list has the three public RPCs
    for (const u of ["https://testnet-rpc.monad.xyz", "https://10143.rpc.thirdweb.com", "https://rpc.ankr.com/monad_testnet"]) expect(up).toContain(u);
    expect(up).not.toContain("drpc.org");
    for (const stack of ["production", "demo"]) {
      for (const { name, body } of launchersOf(outputs[`up.sh ${stack} --dry-run (deployed)`]!)) {
        const cmd = body.match(/AGATE_RPC_URLS_CMD='(.*)' \\$/m)?.[1] ?? "";
        const signer = /-(primary|standby|attest|keep)$|^shared-(maker|payer)$/.test(name);
        const ws = /-(attest|keep)$/.test(name);
        expect({ name, alchemy: cmd.includes("agate.alchemy-api-key") }).toEqual({ name, alchemy: signer });
        expect({ name, send: cmd.includes("send:https://monad-testnet.g.alchemy.com/v2/%s,") }).toEqual({ name, send: signer });
        expect({ name, wss: cmd.includes("wss://monad-testnet.g.alchemy.com/v2/%s") }).toEqual({ name, wss: ws });
        expect({ name, kind: body.includes("AGATE_WS_KIND='logs'") }).toEqual({ name, kind: ws });
        if (!signer) expect({ name, any: body.includes("alchemy") }).toEqual({ name, any: false });
      }
    }
    expect(up).not.toMatch(/AGATE_RPC_URLS=/);
    expect(up).toContain("env -i");
    // the production stack reads the running logger's log; the demo stack reads the replay
    expect(outputs["up.sh production --dry-run"]).toContain("AGATE_WATCHER_LOG_DIR=");
    expect(outputs["up.sh demo --dry-run"]).toContain("SOURCE_BASE_URL='http://127.0.0.1:8787'");
    expect(outputs["up.sh demo --dry-run"]).toContain("TRACKER_BASE_URL='http://127.0.0.1:8787'");
  });

  test("deploy-market renders its config: production with the demo entry disabled, demo with it enabled", () => {
    expect(outputs["deploy-market.sh production --dry-run"]).toContain("market-kit-production.json (market-testnet.json with the real factory on");
    expect(outputs["deploy-market.sh production --dry-run"]).toContain("the demo entry disabled");
    expect(outputs["deploy-market.sh production --dry-run"]).toContain("AGATE_MARKET_CONFIG=kit-production");
    expect(outputs["deploy-market.sh demo --dry-run"]).toContain("market-kit-demo.json (market-testnet.json with the demo entry enabled on");
    expect(outputs["deploy-market.sh demo --dry-run"]).toContain("AGATE_MARKET_CONFIG=kit-demo");
  });

  test("indexer.sh starts each index at its deploy block and takes the RPC URL at run time only", () => {
    const out = outputs["indexer.sh run --dry-run"]!;
    expect(out).toContain("--rpc --index-start real=100 --out config.yaml");
    expect(out).toContain("ENVIO_RPC_URL=<first http(s) URL printed by AGATE_RPC_URLS_CMD>");
    expect(out).not.toMatch(/https?:\/\/[^ ]*alchemy/);
  });

  test("the market maker and the payer, and no other window, get AGATE_MARKET_GAS_LIMITS from market-gas-limits.json", () => {
    const file = JSON.stringify(JSON.parse(readFileSync(join(KIT, "market-gas-limits.json"), "utf8")));
    for (const stack of ["production", "demo"]) {
      const out = outputs[`up.sh ${stack} --dry-run (deployed)`]!;
      const launchers = launchersOf(out);
      expect(launchers.length).toBeGreaterThan(8);
      expect(launchers.filter((l) => l.name === "shared-maker" || l.name === "shared-payer").length).toBe(2);
      for (const { name, body } of launchers) {
        const want = name === "shared-maker" || name === "shared-payer";
        expect({ name, has: body.includes(`AGATE_MARKET_GAS_LIMITS='${file}'`) }).toEqual({ name, has: want });
        if (!want) expect({ name, any: body.includes("AGATE_MARKET_GAS_LIMITS") }).toEqual({ name, any: false });
      }
      expect(out).toContain(`market bots' gas limits (AGATE_MARKET_GAS_LIMITS, from market-gas-limits.json): ${file}`);
    }
  });

  test("each window opens idle, gets its log pipe, and only then runs its launcher", () => {
    for (const stack of ["production", "demo"]) {
      const lines = outputs[`up.sh ${stack} --dry-run (deployed)`]!.split("\n").filter((l) => l.startsWith("$ tmux "));
      const names = [...new Set(lines.map((l) => l.match(/-n (\S+) -c /)?.[1]).filter(Boolean))] as string[];
      expect(names.length).toBeGreaterThan(8);
      for (const n of names) {
        const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
        const open = at(new RegExp(`-n ${n} -c \\S+ '/bin/sh -c '\\\\''exec sleep 300'\\\\'''`));
        const pipe = at(new RegExp(`pipe-pane -o -t '<id of ${n}>'`));
        const run = at(new RegExp(`respawn-pane -k -t '<id of ${n}>' -c \\S+ '/bin/sh \\S+/run/${n}\\.sh'`));
        expect({ n, open: open >= 0, order: open < pipe && pipe < run }).toEqual({ n, open: true, order: true });
      }
    }
  });

  test("up.sh and down.sh name only the kit's own windows, never bun or wall-log", () => {
    const named = new Set<string>();
    for (const [name, out] of Object.entries(outputs)) {
      if (!/^(up|down|demo-session)\.sh/.test(name)) continue;
      for (const m of out.matchAll(/-n (\S+) -c /g)) named.add(m[1]!);
      for (const m of out.matchAll(/window named exactly (\S+?)[,)]/g)) named.add(m[1]!);
      for (const m of out.matchAll(/<id of (\S+?)>/g)) named.add(m[1]!);
    }
    expect(named.size).toBeGreaterThan(10);
    for (const n of named) expect({ n, kit: KIT_WINDOWS.has(n) }).toEqual({ n, kit: true });
    expect(named.has("bun")).toBe(false);
    expect(named.has("wall-log")).toBe(false);
    const src = readFileSync(join(KIT, "down.sh"), "utf8");
    expect(src).not.toMatch(/kill-window -t "?[=$]?\$?\{?TMUX_SESSION/);
    expect(src).not.toMatch(/kill-(session|server)/);
  });

  test("down.sh refuses to close a window the kit did not create", () => {
    for (const w of ["wall-log", "bun", "main"]) {
      const r = run("down.sh", ["demo", "--dry-run", "--only-named"], { AGATE_KIT_ONLY: w });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("not a window this kit creates");
    }
  });
});

describe("modes that must refuse", () => {
  test("--fork refuses a non-loopback RPC and needs one", () => {
    expect(run("deploy-index.sh", ["testnet-production", "--fork", "--dry-run"], { AGATE_KIT_FORK_RPC: "https://testnet-rpc.monad.xyz" }).out).toContain("must be http://127.0.0.1");
    expect(run("deploy-index.sh", ["testnet-production", "--fork", "--dry-run"]).out).toContain("needs AGATE_KIT_FORK_RPC");
  });
  test("rehearsal roles only with --fork", () => {
    const r = run("deploy-index.sh", ["testnet-production", "--dry-run"], { AGATE_KIT_ROLES: "rehearsal" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("--fork only");
  });
  test("a fork run never opens windows in the operator's session or on the default tmux server", () => {
    const fork = { AGATE_KIT_FORK_RPC: "http://127.0.0.1:8548" };
    expect(run("up.sh", ["demo", "--fork", "--dry-run"], fork).out).toContain("private tmux server");
    expect(run("up.sh", ["demo", "--fork", "--dry-run"], { ...fork, AGATE_KIT_TMUX_SOCKET: "agate-rehearsal" }).out).toContain("never uses the session agate-dev");
    // status.sh too, although it only reads
    const s = run("status.sh", ["production", "--fork", "--dry-run"], fork);
    expect(s.code).not.toBe(0);
    expect(s.out).toContain("private tmux server");
    expect(run("status.sh", ["production", "--fork", "--dry-run"], { ...fork, AGATE_KIT_TMUX_SOCKET: "agate-rehearsal" }).out).toContain("never uses the session agate-dev");
  });
  test("the market bots' gas limits come from the file only: a shell override or a bad file opens nothing", () => {
    for (const s of [["up.sh", "demo", "--dry-run"], ["demo-session.sh", "start", "--dry-run"]]) {
      const r = run(s[0]!, s.slice(1), { AGATE_MARKET_GAS_LIMITS: '{"series.mint":200000}' });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("AGATE_MARKET_GAS_LIMITS is set in this shell");
    }
    for (const [name, body] of [["unknown-shape", '{"series.mintx": 200000}'], ["not-json", "{series.mint: 1"], ["empty-c", '{"series.sync": {}}']] as const) {
      const f = join(tmp, `${name}.json`);
      writeFileSync(f, body);
      const r = run("up.sh", ["production", "--dry-run"], { AGATE_KIT_MARKET_GAS_LIMITS: f });
      expect({ name, code: r.code === 0 }).toEqual({ name, code: false });
      expect(r.out).toMatch(/is not JSON|refused by the bots' parser/);
      expect(r.out).not.toContain("$ tmux");
    }
  });
});

describe("Alchemy modes (AGATE_KIT_ALCHEMY, Oct 4)", () => {
  const deployed = () => ({ AGATE_KIT_RECORDS: join(tmp, "records.json"), AGATE_KIT_DEPLOYMENTS: join(tmp, "deployments.json") });
  const rpcCmd = (body: string) => body.match(/AGATE_RPC_URLS_CMD='(.*)' \\$/m)?.[1] ?? "";

  test("off: no window gets Alchemy or AGATE_WS_KIND; all: every RPC window but the indexer does, with a warning", () => {
    const off = run("up.sh", ["demo", "--dry-run"], { ...deployed(), AGATE_KIT_ALCHEMY: "off" });
    expect(off.code).toBe(0);
    expect(off.out).toContain("Alchemy off: public RPCs only");
    expect(off.out).not.toMatch(/alchemy\.com|AGATE_WS_KIND|send:/);
    const all = run("up.sh", ["demo", "--dry-run"], { ...deployed(), AGATE_KIT_ALCHEMY: "all" });
    expect(all.code).toBe(0);
    expect(all.out).toContain("WARNING: AGATE_KIT_ALCHEMY=all");
    const ls = launchersOf(all.out).filter((l) => l.body.includes("AGATE_RPC_URLS_CMD="));
    expect(ls.length).toBeGreaterThan(6);
    for (const { name, body } of ls) {
      const cmd = rpcCmd(body);
      const want = name !== "shared-indexer";
      expect({ name, alchemyFirst: cmd.includes("printf '\\''https://monad-testnet.g.alchemy.com/v2/%s,") }).toEqual({ name, alchemyFirst: want });
      expect({ name, send: cmd.includes("send:") }).toEqual({ name, send: false });
      expect({ name, kind: body.includes("AGATE_WS_KIND='logs'") }).toEqual({ name, kind: want });
    }
    expect(callLog()).toBe("");
  });

  test("a bad mode, a stand-in off loopback, or a stand-in on a real run opens nothing (up.sh, status.sh, demo-session.sh)", () => {
    for (const e of [{ AGATE_KIT_ALCHEMY: "1" }, { AGATE_KIT_ALCHEMY: "everything" }, { AGATE_KIT_ALCHEMY_TEST_URL: "https://monad-testnet.g.alchemy.com/v2/x" }, { AGATE_KIT_ALCHEMY_TEST_URL: "http://192.168.1.2:80" }, { AGATE_KIT_ALCHEMY_TEST_URL: "http://127.0.0.1:9555" }, { AGATE_KIT_ALCHEMY_WS: "demo" }]) {
      for (const [s, a] of [["up.sh", ["demo", "--dry-run"]], ["status.sh", ["demo", "--dry-run"]], ["demo-session.sh", ["start", "--dry-run"]]] as const) {
        const r = run(s, [...a], { ...deployed(), ...e });
        expect({ s, e, code: r.code === 0 }).toEqual({ s, e, code: false });
        expect(r.out).toMatch(/AGATE_KIT_ALCHEMY must be one of: off light all|AGATE_KIT_ALCHEMY_TEST_URL must be http:\/\/127\.0\.0\.1|AGATE_KIT_ALCHEMY_TEST_URL is for --fork runs only|AGATE_KIT_ALCHEMY_WS must be on, prod or off/);
        expect(r.out).not.toContain("$ tmux");
        expect(r.out).not.toContain("$ write");
      }
    }
    expect(callLog()).toBe("");
  });

  test("a fork never gets the real Alchemy: off without the stand-in, the stand-in with it", () => {
    const fork = { ...deployed(), AGATE_KIT_FORK_RPC: "http://127.0.0.1:8549", AGATE_KIT_TMUX_SOCKET: "agate-rehearsal", AGATE_KIT_TMUX_SESSION: "rehearsal", AGATE_KIT_ROLES: "rehearsal" };
    const plain = run("up.sh", ["demo", "--fork", "--dry-run"], fork);
    expect(plain.code).toBe(0);
    expect(plain.out).toContain("Alchemy off on a fork (set AGATE_KIT_ALCHEMY_TEST_URL to a loopback stand-in to rehearse light)");
    expect(plain.out).not.toMatch(/alchemy\.com|send:|ws:\/\//);
    const stand = run("up.sh", ["demo", "--fork", "--dry-run"], { ...fork, AGATE_KIT_ALCHEMY_TEST_URL: "http://127.0.0.1:9555" });
    expect(stand.code).toBe(0);
    expect(stand.out).toContain("Alchemy light: the Alchemy stand-in http://127.0.0.1:9555 takes");
    expect(stand.out).not.toContain("alchemy.com");
    const by = Object.fromEntries(launchersOf(stand.out).map((l) => [l.name, rpcCmd(l.body)]));
    for (const n of ["demo-primary", "demo-standby", "shared-maker", "shared-payer"]) expect(by[n]).toBe("printf '\\''%s'\\'' '\\''send:http://127.0.0.1:9555,http://127.0.0.1:8549,http://localhost:8549'\\''");
    for (const n of ["demo-attest", "demo-keep"]) expect(by[n]).toBe("printf '\\''%s'\\'' '\\''send:http://127.0.0.1:9555,http://127.0.0.1:8549,http://localhost:8549,ws://127.0.0.1:9555'\\''");
    for (const n of ["demo-health", "demo-log", "shared-indexer", "shared-repair"]) expect(by[n]).toBe("printf '\\''http://127.0.0.1:8549,http://localhost:8549'\\''");
    expect(callLog()).toBe("");
  });

  test("AGATE_KIT_ALCHEMY_WS=prod: the production attester and keeper keep the websocket, the demo ones poll; the line says so", () => {
    for (const stack of ["production", "demo"]) {
      const r = run("up.sh", [stack, "--dry-run"], { ...deployed(), AGATE_KIT_ALCHEMY_WS: "prod" });
      expect(r.code).toBe(0);
      expect(r.out).toContain("the production attester's and keeper's websocket (AGATE_KIT_ALCHEMY_WS=prod)");
      for (const { name, body } of launchersOf(r.out)) {
        const ws = name === "prod-attest" || name === "prod-keep";
        expect({ name, wss: rpcCmd(body).includes("wss://") }).toEqual({ name, wss: ws });
        expect({ name, kind: body.includes("AGATE_WS_KIND='logs'") }).toEqual({ name, kind: ws });
      }
    }
  });

  test("AGATE_ALCHEMY_DAILY_CU set in the shell reaches every window; AGATE_KIT_INDEXER=0 leaves the indexer out", () => {
    const r = run("up.sh", ["production", "--dry-run"], { ...deployed(), AGATE_ALCHEMY_DAILY_CU: "250000", AGATE_KIT_INDEXER: "0" });
    expect(r.code).toBe(0);
    const ls = launchersOf(r.out);
    expect(ls.map((l) => l.name)).not.toContain("shared-indexer");
    expect(ls.map((l) => l.name)).toContain("shared-maker");
    for (const { name, body } of ls) expect({ name, cu: body.includes("AGATE_ALCHEMY_DAILY_CU='250000'") }).toEqual({ name, cu: true });
    expect(r.out).toContain("AGATE_KIT_INDEXER=0: no indexer window");
    expect(r.out).toContain("(budget 250000 CU a UTC day)");
  });

  test("demo-session.sh start plans the session's Alchemy spend at the measured rates and warns near the budget", () => {
    const at = (hours: string, e: Record<string, string> = {}) => run("demo-session.sh", ["start", "--hours", hours, "--dry-run"], { ...deployed(), ...e });
    // 5 h: 5 x (20,400 sends + 53,000 websocket) + 50,500 for the production stack = 417,500, 104% of 400,000
    const five = at("5");
    expect(five.code).toBe(0);
    expect(five.out).toContain("about 102000 CU for the sends and 265000 for the demo websocket; with the production stack's 50500 a UTC day, about 417500: 104% of the budget (400000 CU a UTC day)");
    expect(five.out).toContain("WARNING: this session and the production stack may spend the day's Alchemy budget before the session ends (about 104%)");
    expect(five.out).toContain("AGATE_KIT_ALCHEMY_WS=prod leaves the demo windows without the websocket (about 38%)");
    // the demo websocket out: 5 x 20,400 + 50,500 = 152,500, 38%, no warning
    const prod = at("5", { AGATE_KIT_ALCHEMY_WS: "prod" });
    expect(prod.out).toContain("about 152500: 38% of the budget");
    expect(prod.out).not.toContain("WARNING: this session");
    // a short session stays under 90%
    expect(at("3").out).not.toContain("WARNING: this session");
    // a budget the processes would refuse stops the start before anything is deployed
    const bad = at("5", { AGATE_ALCHEMY_DAILY_CU: "lots" });
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain("AGATE_ALCHEMY_DAILY_CU must be a whole number of compute units above 0");
    expect(bad.out).not.toContain("deploy-index");
  }, 60_000);

  // Oct 4 2026 live: the payer's budget, paced for the production horizon, refused the session's listings (BUDGET)
  test("demo-session.sh start gives the maker and the payer the session's MON on top of their budget; stop restarts them without it", () => {
    const start = run("demo-session.sh", ["start", "--hours", "5", "--dry-run"], deployed());
    expect(start.code).toBe(0);
    expect(start.out).toContain("the maker and the payer get 39.0 and 9.8 MON on top of their daily budget, once, until");
    expect(start.out).toContain("AGATE_MM_SESSION_MON='39.0'");
    expect(start.out).toContain("AGATE_PAYER_SESSION_MON='9.8'");
    // until = the session's planned end plus an hour (6 h from now for 5 h), within a minute
    const until = Number(/AGATE_MM_SESSION_UNTIL='(\d+)'/.exec(start.out)?.[1]);
    expect(Math.abs(until - (Math.floor(Date.now() / 1000) + 6 * 3_600))).toBeLessThan(60);
    expect(start.out).toContain(`AGATE_PAYER_SESSION_UNTIL='${until}'`);
    const stop = run("demo-session.sh", ["stop", "--dry-run"], { ...deployed(), AGATE_MM_SESSION_MON: "39.0", AGATE_PAYER_SESSION_MON: "9.8", AGATE_MM_SESSION_UNTIL: String(until), AGATE_PAYER_SESSION_UNTIL: String(until) });
    expect(stop.code).toBe(0);
    expect(stop.out).toContain("restarting the shared windows");
    expect(stop.out).not.toMatch(/AGATE_(MM|PAYER)_SESSION_(MON|UNTIL)=/);
    // a plan above the 1000 MON the bots accept stops before anything is deployed (review finding Oct 5)
    const big = run("demo-session.sh", ["start", "--hours", "200", "--dry-run"], deployed());
    expect(big.code).not.toBe(0);
    expect(big.out).toContain("above the 1000 the bots accept");
    expect(big.out).not.toContain("deploy-index");
  }, 60_000);

  // Oct 5 2026 live: between sessions the shared bots raised MM_INDEX_BEHIND and LISTER_STUCK every tick on the demo
  // factory, whose writers were stopped. AGATE_MM_CONFIG and AGATE_PAYER_CONFIG name a FILE (review finding: inline
  // JSON would have crash-looped both bots)
  test("the shared bots drop the demo factory once a stopped session's months are over; the operator's config wins", () => {
    const FILE = join(KIT, "bots-real-only.json");
    const rec = JSON.parse(readFileSync(join(tmp, "records.json"), "utf8"));
    const dep = JSON.parse(readFileSync(join(tmp, "deployments.json"), "utf8"));
    const both = join(tmp, "deployments-real-demo.json");
    writeFileSync(both, JSON.stringify({ ...dep, factories: { ...dep.factories, demo: { ...dep.factories.real, index: "0x2222222222222222222222222222222222222222", factory: "0x6666666666666666666666666666666666666666" } } }));
    const now = Math.floor(Date.now() / 1000);
    const up = (demo: Record<string, unknown> | null, extra: Record<string, string> = {}, deployments = both) => {
      const f = join(tmp, `records-demo-${JSON.stringify(demo).replace(/\W/g, "")}.json`);
      writeFileSync(f, JSON.stringify(demo === null ? { ...rec, demo: undefined } : { ...rec, demo: { ...rec.demo, ...demo } }));
      const r = run("up.sh", ["production", "--dry-run"], { ...deployed(), AGATE_KIT_RECORDS: f, AGATE_KIT_DEPLOYMENTS: deployments, ...extra });
      expect(r.code).toBe(0);
      return r.out;
    };
    const over = { session: "stopped", epochTs: now - 62 * 600 - 3_601 };
    // still running, or stopped less than two demo months (62 days of 600 s) and an hour after it began (the maker
    // still winds its books down), or no demo clock recorded, or no demo factory deployed: untouched
    for (const out of [up({}), up({ session: "stopped", epochTs: now - 3_600 }), up(null), up(over, {}, join(tmp, "deployments.json"))]) {
      expect(out).not.toContain("AGATE_MM_CONFIG=");
      expect(out).not.toContain("AGATE_PAYER_CONFIG=");
    }
    const after = up(over);
    expect(after).toContain(`AGATE_MM_CONFIG='${FILE}'`);
    expect(after).toContain(`AGATE_PAYER_CONFIG='${FILE}'`);
    const own = up(over, { AGATE_MM_CONFIG: "/tmp/my-maker.json" });
    expect(own).toContain(`AGATE_MM_CONFIG='/tmp/my-maker.json'`);
    expect(own).toContain(`AGATE_PAYER_CONFIG='${FILE}'`);
    // the file loads with the bots' own loaders and keeps only the real factory
    const check = Bun.spawnSync(["bun", "-e", `import { loadConfig as mm } from "./apps/marketmaker/src/config.ts"; import { loadConfig as payer } from "./apps/payer/src/config.ts"; console.log(JSON.stringify([mm(${JSON.stringify(FILE)}).factories, payer(${JSON.stringify(FILE)}).factories]));`], { cwd: join(ROOT, "wall") });
    expect(check.exitCode).toBe(0);
    expect(JSON.parse(check.stdout.toString().trim())).toEqual([["real"], ["real"]]);
  }, 60_000);

  // Oct 5 2026 live: the payer moved to its Dynamic server wallet and the old key's MON was swept, so a later up.sh or
  // demo-session.sh run without AGATE_PAYER_SIGNER would have put it back on the empty key. The records file remembers
  // an explicit choice once the payer started with it; the variable still wins both ways
  test("the payer's signer is remembered in the records file; AGATE_PAYER_SIGNER overrides it; a bad value stops", () => {
    const rec = JSON.parse(readFileSync(join(tmp, "records.json"), "utf8"));
    const wallet = join(tmp, "payer-wallet.json");
    const ADDR = "0x31BC1a1A7d4B6dD5888B584016ce194c27b82c45";
    writeFileSync(wallet, JSON.stringify({ address: ADDR }));
    chmodSync(wallet, 0o600);
    let files = 0;
    const memory = (v: unknown) => {
      // a counter, not the value: macOS file names ignore case ("dynamic" and "Dynamic" are one file)
      const f = join(tmp, `records-signer-${++files}.json`);
      writeFileSync(f, JSON.stringify({ ...rec, payerSigner: v }));
      return f;
    };
    const withMemory = memory("dynamic");
    const payerOf = (records: string, extra: Record<string, string> = {}, args = ["production", "--dry-run"]) => {
      const r = run("up.sh", args, { ...deployed(), AGATE_KIT_RECORDS: records, AGATE_DYNAMIC_WALLET_FILE: wallet, ...extra });
      return { ...r, payer: launchersOf(r.out).find((l) => l.name === "shared-payer")?.body ?? "" };
    };
    // remembered: dynamic without the variable, and nothing new to record
    const remembered = payerOf(withMemory);
    expect(remembered.code).toBe(0);
    expect(remembered.payer).toContain("AGATE_PAYER_SIGNER='dynamic'");
    expect(remembered.payer).toContain(`AGATE_PAYER_ADDRESS='${ADDR}'`);
    expect(remembered.payer).not.toContain("AGATE_KEY_CMD=");
    expect(remembered.out).not.toContain("remembered in");
    // the variable wins: key, and the change is recorded once the payer starts (a dry run prints the update only)
    const key = payerOf(withMemory, { AGATE_PAYER_SIGNER: "key" });
    expect(key.code).toBe(0);
    expect(key.payer).toContain("AGATE_KEY_CMD='security find-generic-password -s agate.market.payer -a private-key -w'");
    expect(key.payer).not.toContain("AGATE_PAYER_SIGNER=");
    expect(key.out).toContain("the payer's signer is now key, remembered in");
    expect(key.out).toContain("(not written in a dry run)");
    expect(JSON.parse(readFileSync(withMemory, "utf8")).payerSigner).toBe("dynamic");
    // review: a real run that stops before its windows (here at the Keychain check) records nothing
    const stopped = payerOf(withMemory, { AGATE_PAYER_SIGNER: "key" }, ["production"]);
    expect(stopped.code).not.toBe(0);
    expect(stopped.out).toContain("nothing opened");
    expect(stopped.out).not.toContain("remembered in");
    expect(JSON.parse(readFileSync(withMemory, "utf8")).payerSigner).toBe("dynamic");
    // no memory: key, unless the variable says dynamic (then recorded)
    const plain = payerOf(join(tmp, "records.json"));
    expect(plain.payer).toContain("AGATE_KEY_CMD='security find-generic-password -s agate.market.payer -a private-key -w'");
    const chosen = payerOf(join(tmp, "records.json"), { AGATE_PAYER_SIGNER: "dynamic" });
    expect(chosen.payer).toContain("AGATE_PAYER_SIGNER='dynamic'");
    expect(chosen.out).toContain("the payer's signer is now dynamic, remembered in");
    // a fork never reads the memory
    const fork = payerOf(withMemory, { AGATE_KIT_FORK_RPC: "http://127.0.0.1:8549", AGATE_KIT_TMUX_SOCKET: "agate-rehearsal", AGATE_KIT_TMUX_SESSION: "rehearsal", AGATE_KIT_ROLES: "rehearsal" }, ["production", "--dry-run", "--fork"]);
    expect(fork.code).toBe(0);
    expect(fork.payer).not.toContain("AGATE_PAYER_SIGNER=");
    // anything else, in the variable or the file, stops before a window is touched
    const bad = payerOf(withMemory, { AGATE_PAYER_SIGNER: "Dynamic" });
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain("AGATE_PAYER_SIGNER must be dynamic or key");
    expect(bad.out).not.toContain("write ");
    const badFile = payerOf(memory("Dynamic"));
    expect(badFile.code).not.toBe(0);
    expect(badFile.out).toContain('holds payerSigner "Dynamic": it must be dynamic or key');
    // fund.sh tops up the remembered signer's address, and says so when the wallet file is missing
    const fund = run("fund.sh", ["--dry-run"], { ...deployed(), AGATE_KIT_RECORDS: withMemory, AGATE_DYNAMIC_WALLET_FILE: wallet });
    expect(fund.code).toBe(0);
    expect(fund.out).toContain(ADDR);
    expect(fund.out).not.toContain(REAL.payer);
    const noFile = run("fund.sh", ["--dry-run"], { ...deployed(), AGATE_KIT_RECORDS: withMemory, AGATE_DYNAMIC_WALLET_FILE: join(tmp, "no-wallet.json") });
    expect(noFile.code).not.toBe(0);
    expect(noFile.out).toContain("cannot read the address in");
  }, 60_000);

  test("up.sh checks the Alchemy key's Keychain item (attributes only) in light and all, never in off or with the stand-in", () => {
    const bin = join(tmp, "kc-bin");
    mkdirSync(bin, { recursive: true });
    const log = join(tmp, "kc-calls");
    // security: attribute queries succeed and are recorded; a -w read would be recorded too (and must never happen)
    writeFileSync(join(bin, "security"), `#!/bin/sh\necho "security $*" >> '${log}'\nexit 0\n`);
    for (const t of ["tmux", "forge", "cast"]) writeFileSync(join(bin, t), `#!/bin/sh\necho "${t} $*" >> '${log}'\nexit 97\n`);
    for (const t of ["security", "tmux", "forge", "cast"]) chmodSync(join(bin, t), 0o755);
    const go = (e: Record<string, string>) => {
      rmSync(log, { force: true });
      const r = run("up.sh", ["demo"], { ...deployed(), ...e, PATH: `${bin}:${process.env.PATH}`, AGATE_KIT_OFFLINE: "0", AGATE_KIT_STATE: join(tmp, "kc-state") });
      expect(r.code).not.toBe(0); // the stub tmux has no session: it stops before opening anything
      expect(r.out).toContain("no tmux session");
      return existsSync(log) ? readFileSync(log, "utf8") : "";
    };
    for (const m of ["light", "all"]) {
      const c = go({ AGATE_KIT_ALCHEMY: m });
      expect(c).toContain("security find-generic-password -s agate.alchemy-api-key -a api-key\n");
      expect(c).not.toMatch(/ -w/);
    }
    const c = go({ AGATE_KIT_ALCHEMY: "off" });
    expect(c).not.toContain("agate.alchemy-api-key");
    expect(c).toContain("security find-generic-password -s agate.wall.primary -a private-key\n");
    // the stand-in is for a fork only: a real run with it set stops before any Keychain check
    rmSync(log, { force: true });
    const r = run("up.sh", ["demo"], { ...deployed(), AGATE_KIT_ALCHEMY_TEST_URL: "http://127.0.0.1:9555", PATH: `${bin}:${process.env.PATH}`, AGATE_KIT_OFFLINE: "0", AGATE_KIT_STATE: join(tmp, "kc-state") });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("AGATE_KIT_ALCHEMY_TEST_URL is for --fork runs only");
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
  });

  test("status.sh's Alchemy lines: each process's compute units today, the total against the budget, the stop", () => {
    const home = join(tmp, "meter-home");
    const day = new Date().toISOString().slice(0, 10);
    const dir = join(home, "rpc-meter", day);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "attest-41939400.json"), JSON.stringify({ date: day, role: "attest", scope: "41939400", methods: { eth_sendRawTransaction: 2, eth_subscribe: 1 }, wsBytes: 5000, cu: 290 }));
    writeFileSync(join(dir, "payer-market.json"), JSON.stringify({ date: day, role: "payer", scope: "market", methods: { eth_estimateGas: 10 }, wsBytes: 0, cu: 200 }));
    const h = join(tmp, "meter-harness.sh");
    writeFileSync(h, `#!/bin/bash\nsource '${join(KIT, "lib.sh")}'\nalchemy_today '${home}'\n`);
    const sh = (e: Record<string, string> = {}) => {
      const r = Bun.spawnSync(["/bin/bash", h], { cwd: ROOT, env: { PATH: `${JQ_DIR}:/usr/bin:/bin`, HOME: tmp, ...e }, stdout: "pipe", stderr: "pipe" });
      return `${r.stdout.toString()}${r.stderr.toString()}`;
    };
    const out = sh({ AGATE_ALCHEMY_DAILY_CU: "1000" });
    expect(out).toContain("attest-41939400 290 CU (eth_sendRawTransaction 2, eth_subscribe 1, ws 5000 bytes)");
    expect(out).toContain("payer-market 200 CU (eth_estimateGas 10)");
    expect(out).toContain(`total 490 of 1000 CU on ${day} (UTC): 49.0%`);
    expect(out).not.toContain("the budget is spent");
    writeFileSync(join(dir, ".alert-100"), "x");
    expect(sh()).toContain(`total 490 of 400000 CU on ${day} (UTC): 0.1%; the budget is spent: no Alchemy until 00:00 UTC`);
    rmSync(dir, { recursive: true });
    expect(sh()).toContain(`no Alchemy compute units counted on ${day} (UTC)`);
    const src = readFileSync(join(KIT, "status.sh"), "utf8");
    expect(src).toContain('alchemy_today "$KIT_WALL_HOME"');
  });
});

describe("the production windows wait for firstDay", () => {
  test("the writers 10 minutes before it, health 9: each says so in its first line", () => {
    const fd = Math.floor(Date.now() / 86_400_000) + 2;
    const rec = join(tmp, "records-fd.json");
    writeFileSync(rec, JSON.stringify({ chainId: 10143, production: { status: "deployed", index: "0x1111111111111111111111111111111111111111", deployBlock: 100, firstDay: fd } }));
    const r = run("up.sh", ["production", "--dry-run"], { AGATE_KIT_RECORDS: rec });
    expect(r.code).toBe(0);
    const at = (s: number) => new Date(s * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
    expect(r.out).toContain(`echo "prod-primary waits until ${at(fd * 86400 - 600)} (10 minutes before firstDay)"`);
    expect(r.out).toContain(`echo "prod-standby waits until ${at(fd * 86400 - 600)} (10 minutes before firstDay)"`);
    expect(r.out).toContain(`echo "prod-health waits until ${at(fd * 86400 - 540)} (9 minutes before firstDay)"`);
  });
});

describe("lib.sh: the deploy block and the fork records", () => {
  const IX = "0x419394b0Edf3d03164a7C06ea525cC1ED0e5Da36";
  const ix = IX.toLowerCase();
  // stub cast: chain-id, anvil_nodeInfo and eth_getTransactionReceipt answered from files; every call recorded
  const stub = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "cast");
    writeFileSync(
      p,
      `#!/bin/sh
echo "cast $*" >> '${dir}/calls'
case "$1 $2" in
  "chain-id "*) echo 10143 ;;
  "rpc anvil_nodeInfo") printf '{"currentBlockNumber":9,"forkConfig":{"forkUrl":"x","forkBlockNumber":%s}}' "$FB" ;;
  "rpc eth_getTransactionReceipt") cat '${dir}/receipt-'"$3"'.json' 2>/dev/null || echo null ;;
  *) exit 97 ;;
esac
`,
    );
    chmodSync(p, 0o755);
    return dir;
  };
  const harness = (body: string) => {
    const h = join(tmp, `h-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(h, `#!/bin/bash\nsource '${KIT}/lib.sh'\n${body}\n`);
    return h;
  };
  const sh = (h: string, e: Record<string, string>) => {
    const r = Bun.spawnSync(["/bin/bash", h], { cwd: ROOT, env: { HOME: tmp, ...e }, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
  };

  test("code_state: code, none, and an RPC error that is never read as none (deploy-index fails closed on it)", () => {
    const bin = join(tmp, "cs-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "cast"), `#!/bin/sh\ncase "$CS" in code) echo 0x6080 ;; none) echo 0x ;; *) echo "error: 429" >&2; exit 1 ;; esac\n`);
    chmodSync(join(bin, "cast"), 0o755);
    const h = harness(`kit_parse\nif s="$(code_state 0x1111111111111111111111111111111111111111)"; then echo "state=$s"; else echo "state=error"; fi`);
    const at = (cs: string) => sh(h, { PATH: `${bin}:${JQ_DIR}:/usr/bin:/bin`, CS: cs }).out.trim();
    expect(at("code")).toContain("state=code");
    expect(at("none")).toContain("state=none");
    expect(at("fail")).toContain("state=error");
    const src = readFileSync(join(KIT, "deploy-index.sh"), "utf8");
    expect(src).toContain('REC_CODE="$(code_state "$REC_IX")" || die');
    expect(src).not.toMatch(/\[ -n "\$REC_IX" \][^\n]*has_code "\$REC_IX"/);
  });

  test("down.sh refuses --cancel-books while the other stack runs, before closing anything or killing the maker", () => {
    const bin = join(tmp, "cb-bin");
    mkdirSync(bin, { recursive: true });
    const log = join(tmp, "cb-calls");
    writeFileSync(join(bin, "tmux"), `#!/bin/sh\necho "tmux $*" >> '${log}'\ncase "$*" in *list-windows*) printf '@1 prod-primary\\n@2 demo-primary\\n@3 shared-maker\\n' ;; *has-session*) exit 0 ;; *) exit 0 ;; esac\n`);
    chmodSync(join(bin, "tmux"), 0o755);
    for (const t of ["bun", "security", "forge", "cast"]) {
      writeFileSync(join(bin, t), `#!/bin/sh\necho "${t} $*" >> '${log}'\nexit 97\n`);
      chmodSync(join(bin, t), 0o755);
    }
    const r = run("down.sh", ["demo", "--cancel-books"], { PATH: `${bin}:${JQ_DIR}:/usr/bin:/bin`, AGATE_KIT_OFFLINE: "0" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("--cancel-books stops the maker on every factory");
    const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
    expect(calls).not.toMatch(/kill-window|send-keys|^bun /m);
  });

  test("deploy_block_of: a saved receipt, else the creation transaction's receipt from the chain, else pendingBlock", () => {
    const base = join(tmp, "dbo");
    const bin = stub(join(base, "bin"));
    const h = harness(`kit_parse\nFOUNDRY_BROADCAST="$BCAST"\ndeploy_block_of ${IX} production\necho "block=$DEPLOY_BLOCK from=$DEPLOY_BLOCK_FROM"`);
    const go = (name: string, files: Record<string, unknown>, pending: number | null) => {
      const b = join(base, name, "broadcast");
      const d = join(b, "DeployIndex.s.sol/10143");
      mkdirSync(d, { recursive: true });
      for (const [f, j] of Object.entries(files)) writeFileSync(join(d, f), JSON.stringify(j));
      const rec = join(base, name, "records.json");
      writeFileSync(rec, JSON.stringify({ chainId: 10143, production: { status: "pending", index: IX, firstDay: 20731, ...(pending === null ? {} : { pendingBlock: pending }) } }));
      return sh(h, { PATH: `${bin}:${JQ_DIR}:/usr/bin:/bin`, BCAST: b, AGATE_KIT_RECORDS: rec, AGATE_KIT_STATE: join(base, name, "state") }).out.trim();
    };
    const create = (hash: string) => ({ transactionType: "CREATE", contractName: "AgateIndex", contractAddress: ix, hash });
    const call = (hash: string | null) => ({ transactionType: "CALL", contractName: "AgateIndex", contractAddress: ix, hash });
    // 1. forge saved the receipt
    expect(go("saved", { "run-latest.json": { transactions: [create("0xa1"), call("0xa2")], receipts: [{ contractAddress: ix, status: "0x1", blockNumber: "0x64" }, { contractAddress: null, status: "0x1", blockNumber: "0x65" }] } }, 90)).toBe("block=100 from=receipt");
    // 2. no receipt saved; the creation transaction's receipt is read from the chain (never a CALL's)
    writeFileSync(join(base, "bin", "receipt-0xb1.json"), JSON.stringify({ contractAddress: ix, status: "0x1", blockNumber: "0xc8" }));
    writeFileSync(join(base, "bin", "receipt-0xb2.json"), JSON.stringify({ contractAddress: null, status: "0x1", blockNumber: "0xc9" }));
    expect(go("hash", { "run-latest.json": { transactions: [call("0xb2"), create("0xb1")], receipts: [] }, "run-1.json": { transactions: [call(null)], receipts: [] } }, 150)).toBe("block=200 from=receipt");
    expect(readFileSync(join(base, "bin", "calls"), "utf8")).not.toContain("0xb2");
    // 3. the chain names another address or a failed creation: the pendingBlock lower bound, never the current block
    writeFileSync(join(base, "bin", "receipt-0xc1.json"), JSON.stringify({ contractAddress: "0x0000000000000000000000000000000000000001", status: "0x1", blockNumber: "0x12c" }));
    writeFileSync(join(base, "bin", "receipt-0xc2.json"), JSON.stringify({ contractAddress: ix, status: "0x0", blockNumber: "0x12d" }));
    expect(go("other", { "run-latest.json": { transactions: [create("0xc1"), create("0xc2")], receipts: [{ contractAddress: ix, status: "0x0", blockNumber: "0x12e" }] } }, 150)).toBe("block=150 from=pendingBlock");
    // 4. nothing at all: empty (deploy-index.sh then stops)
    expect(go("none", {}, null)).toBe("block= from=");
    expect(readFileSync(join(base, "bin", "calls"), "utf8")).not.toMatch(/block-number|cast block/);
  });

  test("check_fork: the fork-kit records belong to one fork, named by port and fork block", () => {
    const base = join(tmp, "marker");
    const bin = stub(join(base, "bin"));
    const contracts = join(base, "contracts");
    mkdirSync(join(contracts, "deployments"), { recursive: true });
    const h = harness(`CONTRACTS='${contracts}'\nkit_parse --fork $DRY\ncheck_fork\necho checked`);
    const go = (port: number, fb: number, dry = "") => sh(h, { PATH: `${bin}:${JQ_DIR}:/usr/bin:/bin`, AGATE_KIT_FORK_RPC: `http://127.0.0.1:${port}`, FB: String(fb), DRY: dry, AGATE_KIT_STATE: join(base, "state") });
    const marker = join(contracts, "deployments/fork-kit-fork.json");
    expect(go(8601, 5, "--dry-run").out).toContain("checked");
    expect(existsSync(marker)).toBe(false); // a dry run writes nothing
    expect(go(8601, 5).out).toContain("checked");
    expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({ port: 8601, forkBlock: 5 });
    writeFileSync(join(contracts, "deployments/fork-kit-10143-indexes.json"), "{}");
    expect(go(8601, 5).out).toContain("checked");
    for (const [p, f] of [[8601, 6], [8602, 5]] as const) {
      const r = go(p, f);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("belong to another fork");
    }
    rmSync(marker);
    const r = go(8601, 5);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("has no fork-kit-fork.json naming its fork");
  });
});

describe("market-gas-limits.json against Monad's own estimates", () => {
  // Monad testnet's eth_estimateGas of the bots' calls, the fork's state passed as a state override (read only, Oct 3
  // and 4; the fork session's sends replayed one by one): every one fits its cap with 1.25 headroom; the first mint, a
  // redeem and a settle on one side (priced as the redeem: it burns one side and pays dollars) are refused by the
  // Ethereum table the bots ship with.
  test("each call Monad priced fits its cap with 1.25 headroom; mint, redeem and settle need the file", async () => {
    const { LimitTable, capFor } = await import("../../../wall/packages/market/src/limits.ts");
    const { encodeFunctionData } = await import("../../../wall/packages/market/node_modules/viem");
    const { agateSeriesAbi, agateFactoryAbi } = await import("../../../wall/packages/market/src/abi.ts");
    const table = LimitTable.fromEnv({ AGATE_MARKET_GAS_LIMITS: JSON.stringify(JSON.parse(readFileSync(join(KIT, "market-gas-limits.json"), "utf8"))) });
    const shipped = LimitTable.fromEnv({});
    const enc = (abi: unknown, functionName: string, args: unknown[]) => encodeFunctionData({ abi, functionName, args } as never);
    const U = REAL.bot as `0x${string}`;
    const rows: [string, `0x${string}`, number, { c?: number; n?: number }, boolean][] = [
      ["series.mint", enc(agateSeriesAbi, "mint", [7_000_000_000n, U]), 220_815, {}, true], // the maker's first mint of a series
      ["series.mint", enc(agateSeriesAbi, "mint", [7_000_000_000n, U]), 147_952, {}, false], // a later one
      ["series.redeem", enc(agateSeriesAbi, "redeem", [250_000_000n, U]), 121_781, {}, true],
      ["series.settle", enc(agateSeriesAbi, "settle", [0, 250_000_000n, U]), 121_781, { c: 0 }, true],
      ["series.sync", enc(agateSeriesAbi, "sync", [1n]), 164_558, { c: 1 }, false],
      ["series.sync", enc(agateSeriesAbi, "sync", [2n]), 188_246, { c: 2 }, false],
      ["series.claimMany", enc(agateSeriesAbi, "claimMany", [[1n, 2n]]), 121_979, { c: 0, n: 2 }, false],
      ["factory.list", enc(agateFactoryAbi, "list", [LAUNCH.deploy[0]!.gpuId, 24323]), 3_627_233, {}, false],
      ["factory.createMarket", enc(agateFactoryAbi, "createMarket", [U]), 1_283_747, {}, false],
    ];
    for (const [shape, data, est, o, needsFile] of rows) {
      const want = Math.ceil(est * 1.2);
      const headroom = Number(capFor(table, shape as never, data, o)) / want;
      expect({ shape, est, ok: headroom >= 1.25 }).toEqual({ shape, est, ok: true });
      expect({ shape, est, refusedShipped: Number(capFor(shipped, shape as never, data, o)) < want }).toEqual({ shape, est, refusedShipped: needsFile });
    }
  });
});

describe("send.ts refuses before any RPC call", () => {
  const send = (args: string[], extra: Record<string, string> = {}) => {
    const r = Bun.spawnSync([process.execPath, "run", join(KIT, "send.ts"), ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...extra }, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` };
  };
  const base = ["transfers", `${REAL.primary}=1`, "--rpc", "http://127.0.0.1:1", "--from", REAL.deployer];
  test("an empty or malformed key in the named variable", () => {
    for (const v of ["", "0x1234", "deadbeef".repeat(8)]) {
      const r = send([...base, "--key-env", "AGATE_DEPLOYER_KEY"], { AGATE_DEPLOYER_KEY: v });
      expect(r.code).toBe(1);
      expect(r.out).toContain("is missing or is not a 0x-prefixed 32-byte hex key (nothing sent)");
      if (v) expect(r.out).not.toContain(v);
    }
  });
  test("--unlocked anywhere but a loopback fork, and no key source at all", () => {
    expect(send(["transfers", `${REAL.primary}=1`, "--rpc", "https://testnet-rpc.monad.xyz", "--from", REAL.deployer, "--unlocked"]).out).toContain("--unlocked is for a local fork only");
    expect(send(base).out).toContain("give exactly one of --key-env <VAR> and --unlocked");
  });
});

describe("the testnet configs", () => {
  const cfg = (n: string) => JSON.parse(readFileSync(join(CONFIG, `${n}.json`), "utf8"));
  test("both index configs pin launch.json's six GPUs, the real role addresses and the CRE simulation forwarder", () => {
    for (const n of ["testnet-production", "testnet-demo"]) {
      const c = cfg(n);
      expect(c.gpus).toEqual(LAUNCH.deploy);
      expect(c.gpus.map((g: { gpu: string }) => g.gpu)).toEqual(["H100", "H200", "B200", "B300", "A100", "L40S"]);
      expect(c.roles).toEqual({ owner: REAL.owner, primary: REAL.primary, standby: REAL.standby, attester: REAL.attester, guardian0: REAL.guardian, guardian1: "0x0000000000000000000000000000000000000000" });
      expect(c.forwarder).toBe("0xB9F79d863261869B234c481D1f9A7af84AeAd192");
      expect(c.deployMockForwarder).toBe(false);
      expect(c.writerMode).toBe(0);
      expect(readFileSync(join(CONFIG, `${n}.json`), "utf8")).toContain('"chainSelector": 2183018362218727504');
    }
    expect(cfg("testnet-production").profile).toMatchObject({ day: 86400, slices: 24, minReadings: 12, qMin: 1, demoLabel: true, signAll: false, epochDay: 0, epochFromBlock: false });
    expect(cfg("testnet-demo").profile).toEqual({ day: 600, slices: 4, minReadings: 2, qMin: 1, demoLabel: true, signAll: false, epochDay: 20758, epochFromBlock: true, firstDay: 20758 });
  });
  test("market-testnet.json: the deployer mints and administers, the maker gets the float; the kit renders copies of it", () => {
    const m = cfg("market-testnet");
    expect(m.chainId).toBe(10143);
    expect(m.dollar.minter).toBe(REAL.deployer);
    expect(m.marketAdmin).toBe(REAL.deployer);
    expect(m.botFloat.to).toBe(REAL.bot);
    expect(m.kuru).toMatchObject({ router: "0x7EFbE105Ca7415dE98F96622173458ac1c054630", marginAccount: "0xd029C2D98ff85D8F64799017fE00a59B1159CE02" });
    expect(m.factories.find((f: { name: string }) => f.name === "pilot").enabled).toBe(false);
    expect(m.gpus.map((g: { label: string }) => g.label)).toEqual(["H100", "H200", "B200"]);
    // the committed template is never edited (a wall test pins its bytes): the kit writes market-kit-<kind>.json
    const g = Bun.spawnSync(["git", "show", "HEAD:contracts/script/config/market-testnet.json"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    if (g.exitCode === 0) expect(readFileSync(join(CONFIG, "market-testnet.json"), "utf8")).toBe(g.stdout.toString());
    const src = readFileSync(join(KIT, "deploy-market.sh"), "utf8");
    expect(src).not.toMatch(/-i '' [^\n]*market-testnet/);
    expect(src).toContain("market-kit-production.json");
    expect(src).toContain("market-kit-demo.json");
  });
  test("the kit's role table matches every address above", () => {
    const lib = readFileSync(join(KIT, "lib.sh"), "utf8");
    for (const [role, addr] of Object.entries(REAL)) expect(lib).toMatch(new RegExp(`${role}\\) echo ${addr} ;;`));
  });
});

describe("repo files", () => {
  test("no em dash and no build-process words in the kit", () => {
    const files = ["lib.sh", "deploy-index.sh", "deploy-market.sh", "fund.sh", "up.sh", "down.sh", "demo-session.sh", "status.sh", "indexer.sh", "notify.sh", "send.ts", "gas-headroom.ts", "market-gas-limits.json", "rehearse.sh", "rehearse/days.ts", "rehearse/status.ts", "RUNBOOK.md", "test/kit.test.ts", "test/adversarial/kit-adversarial.test.ts"];
    const dash = String.fromCharCode(0x2014);
    const words = new RegExp(["pha" + "se", "rech" + "eck", "fix ro" + "und", "orches" + "trator", "/se" + "al", "/go" + "al", "foun" + "der"].join("|"), "i");
    for (const f of files) {
      const p = join(KIT, f);
      if (!existsSync(p)) continue;
      const t = readFileSync(p, "utf8");
      expect({ f, dash: t.includes(dash) }).toEqual({ f, dash: false });
      expect({ f, word: t.match(words)?.[0] ?? null }).toEqual({ f, word: null });
      expect({ f, privatePath: t.includes(["", "Users", ""].join("/")) }).toEqual({ f, privatePath: false });
    }
  });
});
