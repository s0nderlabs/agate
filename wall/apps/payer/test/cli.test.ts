// BOTS-SPEC 2.7 and 4.7: the CLI without a chain: usage, `status` (files only: no key, no RPC), and the refusals at
// start that name the variable and never print a value.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
function run(args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bun", "run", "src/main.ts", ...args], { cwd: APP, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/", ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("payer CLI", () => {
  test("an unknown command or flag: usage, exit 2", () => {
    expect(run(["nope"]).code).toBe(2);
    expect(run(["run", "--dry"]).code).toBe(2);
    expect(run(["claim-once", "--now"]).err).toContain("usage");
  });

  test("status reads the files only: heartbeat, the payer's open alerts, the budget day, the state", () => {
    const home = mkdtempSync(join(tmpdir(), "agate-payer-cli-"));
    const dir = join(home, "market", "payer");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(home, "alerts"), { recursive: true });
    writeFileSync(join(dir, "heartbeat.json"), JSON.stringify({ pid: 1, role: "payer", index: "market", at: Math.floor(Date.now() / 1000) - 5, tick: 3, lastAction: "ok" }));
    writeFileSync(join(dir, "budget-2026-10-03.json"), JSON.stringify({ day: "2026-10-03", budgetWei: "100", spentWei: "40", safetyWei: "0", sends: 2 }));
    writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, series: { "0xaa": { lastClaimK: 3, sweepDone: false } }, badIds: {}, neverList: [], retryAt: {}, marketRetryAt: {} }));
    writeFileSync(join(dir, "cursor.json"), JSON.stringify({ next: "1234" }));
    writeFileSync(join(home, "alerts", "alerts.jsonl"), `${JSON.stringify({ id: "PAYER_FORCE_HELD:-:-:-:-:0xaa", code: "PAYER_FORCE_HELD", severity: "action", at: 1, message: "held" })}\n${JSON.stringify({ id: "R5_HEAD_LAG:-:-:-:-", code: "R5_HEAD_LAG", severity: "action", at: 1, message: "not ours" })}\n`);
    const r = run(["status"], { AGATE_WALL_HOME: home });
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out.trim().split("\n").at(-1)!);
    expect(j.heartbeat.tick).toBe(3);
    expect(j.alerts.map((a: { code: string }) => a.code)).toEqual(["PAYER_FORCE_HELD"]);
    expect(j.budget.spentWei).toBe("40");
    expect(j.state.series).toBe(1);
    expect(j.scanNext).toBe("1234");
  });

  test("no key and not a dry run: refused at start, naming the variable", () => {
    const r = run(["run"], { AGATE_RPC_URLS: "http://127.0.0.1:9,http://localhost:9", AGATE_DEPLOYMENTS: "/nonexistent" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("AGATE_PAYER_KEY");
  });

  test("a malformed key: refused naming the variable, never echoing the value", () => {
    const r = run(["run"], { AGATE_PAYER_KEY: "0xdeadbeefsecret", AGATE_RPC_URLS: "http://127.0.0.1:9,http://localhost:9" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("AGATE_PAYER_KEY");
    expect(r.err + r.out).not.toContain("deadbeefsecret");
  });

  test("a dry run without a key needs AGATE_PAYER_ADDRESS", () => {
    const r = run(["list-once", "--dry"], { AGATE_RPC_URLS: "http://127.0.0.1:9,http://localhost:9" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("AGATE_PAYER_ADDRESS");
  });

  test("an unknown config field stops the start", () => {
    const d = mkdtempSync(join(tmpdir(), "agate-payer-cli-cfg-"));
    writeFileSync(join(d, "c.json"), JSON.stringify({ claimEvery: 2 }));
    const r = run(["run"], { AGATE_PAYER_CONFIG: join(d, "c.json") });
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown field claimEvery");
  });
});
