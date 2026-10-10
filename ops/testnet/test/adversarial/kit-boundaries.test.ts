// Boundary checks of the testnet kit, offline: every Keychain, tmux and chain tool is a stub that records its call and
// fails, so nothing here reads a secret, opens a window or sends anything. `bun test ops/testnet/test` (repo root).
//
// - firstDay of the real-calendar index is always the UTC day after the deploy, and the deploy is refused in the last
//   15 minutes before 00:00 UTC (so it can never land on the other side of midnight), before any tool runs.
// - the window names agree across the scripts: every window up.sh can open (both stacks, testnet and fork) is one
//   down.sh closes and status.sh lists, and down.sh and status.sh name no window up.sh never opens.
// - indexer.sh starts each factory's index at its own deploy block when both indexes are recorded.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const KIT = resolve(import.meta.dir, "../..");
const ROOT = resolve(KIT, "../..");
const CONFIG = join(ROOT, "contracts/script/config");
const DAY = 86_400;

let tmp = "";
let calls = "";
let env: Record<string, string> = {};
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "agate-kit-bounds-"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  calls = join(tmp, "calls.log");
  for (const t of ["security", "tmux", "forge", "cast", "anvil", "podman", "docker", "envio", "osascript"]) {
    writeFileSync(join(bin, t), `#!/bin/sh\necho "${t} $*" >> '${calls}'\nexit 97\n`);
    chmodSync(join(bin, t), 0o755);
  }
  env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: process.env.HOME ?? tmp,
    AGATE_KIT_DEV_SESSION: "agate-dev", // hermetic: whatever ~/.agate-kit/dev-session says here
    TMPDIR: tmp,
    AGATE_KIT_OFFLINE: "1",
    AGATE_KIT_STATE: join(tmp, "state"),
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
const date = (d: number) => new Date(d * DAY * 1000).toISOString().slice(0, 10);

describe("firstDay of the real-calendar index", () => {
  const before = () => readFileSync(join(CONFIG, "testnet-production.json"), "utf8");

  // [chain time, expected firstDay or null for a refusal]
  const D = 20_731; // 2026-10-05
  const cases: [string, number, number | null][] = [
    ["00:00:00, the first second of a day", D * DAY, D + 1],
    ["12:00:00", D * DAY + 12 * 3600, D + 1],
    ["23:45:00, exactly 15 minutes before midnight", (D + 1) * DAY - 900, D + 1],
    ["23:45:01, under 15 minutes before midnight", (D + 1) * DAY - 899, null],
    ["23:59:59, the last second of a day", (D + 1) * DAY - 1, null],
  ];
  for (const [name, now, want] of cases) {
    test(`chain time ${name}: ${want === null ? "refused before any tool runs" : `firstDay ${want}`}`, () => {
      const cfg = before();
      const r = run("deploy-index.sh", ["testnet-production", "--dry-run"], { AGATE_KIT_NOW: String(now) });
      expect(readFileSync(join(CONFIG, "testnet-production.json"), "utf8")).toBe(cfg);
      if (want === null) {
        expect(r.code).not.toBe(0);
        expect(r.out).toContain("within 15 minutes of 00:00 UTC");
        expect(r.out).not.toContain("forge script");
      } else {
        expect({ code: r.code, tail: r.code === 0 ? "" : r.out.slice(-600) }).toEqual({ code: 0, tail: "" });
        expect(r.out).toContain(`firstDay ${want} (${date(want)})`);
        expect(r.out).toContain(`set "firstDay": ${want} in `);
        expect(r.out).toContain("(not written in a dry run)");
        // the GPUs register with that firstDay: no day before the deploy, so nothing to backfill
        expect(want).toBe(Math.floor(now / DAY) + 1);
      }
      expect(callLog()).toBe("");
    });
  }
});

describe("window names agree across up.sh, down.sh and status.sh", () => {
  test("every window up.sh can open is closed by down.sh and listed by status.sh, and nothing else is named", () => {
    const rec = join(tmp, "records.json");
    const dep = join(tmp, "deployments.json");
    writeFileSync(rec, JSON.stringify({ chainId: 10143, production: { status: "deployed", index: "0x1111111111111111111111111111111111111111", deployBlock: 100, firstDay: 20731 }, demo: { status: "deployed", session: "active", index: "0x2222222222222222222222222222222222222222", deployBlock: 200, firstDay: 20758, epochTs: 1791000000, day: 600, slices: 4 } }));
    writeFileSync(dep, JSON.stringify({ chainId: 10143, factories: {} }));
    const opened = new Set<string>();
    const fork = { AGATE_KIT_FORK_RPC: "http://127.0.0.1:8548", AGATE_KIT_TMUX_SOCKET: "agate-test", AGATE_KIT_TMUX_SESSION: "test" };
    for (const stack of ["production", "demo"]) {
      for (const extra of [{}, fork]) {
        const r = run("up.sh", [stack, "--dry-run", ...("AGATE_KIT_FORK_RPC" in extra ? ["--fork"] : [])], { AGATE_KIT_RECORDS: rec, AGATE_KIT_DEPLOYMENTS: dep, ...extra });
        expect({ stack, code: r.code, tail: r.code === 0 ? "" : r.out.slice(-600) }).toEqual({ stack, code: 0, tail: "" });
        for (const m of r.out.matchAll(/new-window -d -P -F '#\{window_id\}' -t \S+ -n (\S+) -c /g)) opened.add(m[1]!);
      }
    }
    // testnet adds shared-awake, a fork adds prod-log: both must have been seen
    expect(opened.has("shared-awake")).toBe(true);
    expect(opened.has("prod-log")).toBe(true);
    expect(opened.size).toBe(21);

    const down = readFileSync(join(KIT, "down.sh"), "utf8");
    const list = (v: string) => (down.match(new RegExp(`^${v}="([^"]+)"`, "m"))?.[1] ?? "").split(" ").filter(Boolean);
    const closes = new Set([...list("PROD_WINDOWS"), ...list("DEMO_WINDOWS"), ...list("SHARED_WINDOWS")]);
    expect([...opened].sort()).toEqual([...closes].sort());

    const status = readFileSync(join(KIT, "status.sh"), "utf8");
    const forList = status.match(/for n in ([^;]+); do\n\s+id="\$\(win_id/)?.[1] ?? "";
    const listed = new Set(forList.replace(/\\\n/g, " ").split(/\s+/).filter(Boolean));
    expect([...listed].sort()).toEqual([...closes].sort());

    for (const n of ["bun", "wall-log", "main", "kit"]) expect(closes.has(n)).toBe(false);
    expect(callLog()).toBe("");
  }, 60_000);
});

describe("indexer.sh with both indexes recorded", () => {
  test("each factory's index starts at its own deploy block", () => {
    const rec = join(tmp, "records-both.json");
    const dep = join(tmp, "deployments-both.json");
    const real = "0x1111111111111111111111111111111111111111";
    const demo = "0x2222222222222222222222222222222222222222";
    writeFileSync(rec, JSON.stringify({ chainId: 10143, production: { status: "deployed", index: real, deployBlock: 100 }, demo: { status: "deployed", session: "active", index: demo, deployBlock: 200 } }));
    const f = (index: string, tag: string) => ({ index, dollar: "0x3333333333333333333333333333333333333333", tag, factory: "0x4444444444444444444444444444444444444444", router: "0x5555555555555555555555555555555555555555", tPend: 210, startBlock: 1 });
    writeFileSync(dep, JSON.stringify({ chainId: 10143, factories: { demo: f(demo, "demo"), real: f(real.toUpperCase().replace("0X", "0x"), "") } }));
    const r = run("indexer.sh", ["run", "--dry-run"], { AGATE_DEPLOYMENTS: dep, AGATE_KIT_RECORDS: rec });
    expect({ code: r.code, tail: r.code === 0 ? "" : r.out.slice(-600) }).toEqual({ code: 0, tail: "" });
    expect(r.out).toContain("--index-start demo=200 --index-start real=100");
    expect(callLog()).toBe("");
  });
});
