// The launchd template and run script (BOTS-SPEC 2.8): written, never loaded. (The generated ABI's drift check is
// the shared layer's, wall/packages/market/test/reads.test.ts.)
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", "launchd");
const files = readdirSync(dir);
const plist = files.find((f) => f.endsWith(".plist.template"))!;
const script = files.find((f) => f.endsWith(".sh"))!;

describe("launchd template (marketmaker)", () => {
  test("a valid plist with the agreed Label, no key variable, KeepAlive, ThrottleInterval 10 and the run script", () => {
    const text = readFileSync(join(dir, plist), "utf8");
    expect(Bun.spawnSync(["/usr/bin/plutil", "-lint", join(dir, plist)]).exitCode).toBe(0);
    expect(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text)![1]).toBe("xyz.s0nderlabs.agate-marketmaker");
    const keys = [...text.matchAll(/<key>([A-Z_][A-Z0-9_]*)<\/key>/g)].map((m) => m[1]!);
    expect(keys.filter((k) => /_KEY$|PRIVATE_KEY/.test(k))).toEqual([]);
    for (const k of ["BUN", "AGATE_RPC_URLS_CMD", "AGATE_CHAIN_ID", "AGATE_DEPLOYMENTS", "AGATE_MM_CONFIG", "AGATE_WALL_HOME", "AGATE_KEY_CMD"]) expect(keys).toContain(k);
    expect(text).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(text).toContain("<key>ThrottleInterval</key>\n  <integer>10</integer>");
    expect(text).toContain(`apps/marketmaker/launchd/${script}`);
    expect(text).not.toMatch(/0x[0-9a-fA-F]{64}/);
    expect(text).not.toMatch(/alchemy\.com\/v2\/[A-Za-z0-9_-]{8,}/);
  });
  test("the run script parses, is executable, refuses to start without a key command or an RPC list", () => {
    const p = join(dir, script);
    expect(Bun.spawnSync(["/bin/sh", "-n", p]).exitCode).toBe(0);
    expect(statSync(p).mode & 0o111).not.toBe(0);
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent" };
    const noKey = Bun.spawnSync(["/bin/sh", p], { env, stderr: "pipe" });
    expect(noKey.exitCode).not.toBe(0);
    expect(noKey.stderr.toString()).toContain("AGATE_KEY_CMD");
    const noRpc = Bun.spawnSync(["/bin/sh", p], { env: { ...env, AGATE_KEY_CMD: "echo 0x00" }, stderr: "pipe" });
    expect(noRpc.exitCode).toBe(2);
    expect(noRpc.stderr.toString()).toContain("AGATE_RPC_URLS_CMD");
    // audit M-K1: the script never runs the key command nor exports a key; the process does it in memory
    const t = readFileSync(p, "utf8");
    expect(t).not.toContain("export AGATE_MM_KEY");
    expect(t).not.toMatch(/\$\(.*AGATE_KEY_CMD/);
    expect(t).not.toContain("unset AGATE_KEY_CMD");
  });
});
