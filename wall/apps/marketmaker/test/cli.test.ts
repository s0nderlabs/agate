// The CLI without a chain (BOTS-SPEC 2.7, 3.8): status reads files only; kill, unkill and the requests leave their
// file for the running process when no maker can start here; withdraw-all needs the kill switch.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agate-mm-cli-"));
const dir = join(home, "market", "marketmaker");
afterAll(() => rmSync(home, { recursive: true, force: true }));

function cli(...args: string[]) {
  const r = Bun.spawnSync(["bun", "run", "src/main.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AGATE_WALL_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("CLI", () => {
  test("status with nothing yet: every part null, nothing sent", () => {
    const r = cli("status");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ heartbeat: null, kill: null, alerts: [], budget: null, state: null });
  });
  test("kill writes the KILL file with the reason; with no maker able to start here the request waits", () => {
    const r = cli("kill", "test", "reason");
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "KILL"), "utf8")).toBe("test reason");
    expect(r.out).toContain('"event":"request_queued"');
    expect(r.out).toContain("AGATE_MM_KEY"); // the variable's name, never a value
    expect(JSON.parse(cli("status").out).kill).toBe("test reason");
  });
  test("withdraw-all needs the kill switch; unkill removes it and leaves UNKILL for the process", () => {
    expect(cli("withdraw-all").code).toBe(0);
    expect(existsSync(join(dir, "WITHDRAW_ALL"))).toBe(true);
    const u = cli("unkill");
    expect(u.code).toBe(0);
    expect(existsSync(join(dir, "KILL"))).toBe(false);
    expect(existsSync(join(dir, "UNKILL"))).toBe(true);
    rmSync(join(dir, "WITHDRAW_ALL"));
    const w = cli("withdraw-all");
    expect(w.code).toBe(2);
    expect(w.err).toContain("kill switch");
  });
  test("an unknown command prints the usage", () => {
    const r = cli("dance");
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage");
  });
});
