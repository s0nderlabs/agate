// The launchd template and run script of the payer (BOTS-SPEC 2.8): written, never loaded.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

describe("launchd template (payer)", () => {
  const dir = join(import.meta.dir, "..", "launchd");
  const files = readdirSync(dir);
  const plist = files.find((f) => f.endsWith(".plist.template"))!;
  const script = files.find((f) => f.endsWith(".sh"))!;
  test("a valid plist with the agreed Label, no key variable, KeepAlive, the run script and no URL", () => {
    const text = readFileSync(join(dir, plist), "utf8");
    if (existsSync("/usr/bin/plutil")) expect(Bun.spawnSync(["/usr/bin/plutil", "-lint", join(dir, plist)]).exitCode).toBe(0);
    expect(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text)![1]).toBe("xyz.s0nderlabs.agate-payer");
    const keys = [...text.matchAll(/<key>([A-Z_][A-Z0-9_]*)<\/key>/g)].map((m) => m[1]!);
    expect(keys.filter((k) => /_KEY$|PRIVATE_KEY/.test(k))).toEqual([]);
    expect(keys).toEqual(expect.arrayContaining(["BUN", "AGATE_RPC_URLS_CMD", "AGATE_CHAIN_ID", "AGATE_DEPLOYMENTS", "AGATE_PAYER_CONFIG", "AGATE_WALL_HOME", "AGATE_KEY_CMD"]));
    expect(text).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(text).toContain("<integer>10</integer>");
    expect(text).toContain(`apps/payer/launchd/${script}`);
    expect(text).not.toMatch(/https?:\/\/(?!www\.apple\.com)/);
  });
  test("the run script parses, is executable, never puts the key in a variable: the process runs AGATE_KEY_CMD itself (audit M-K1)", () => {
    expect(Bun.spawnSync(["/bin/sh", "-n", join(dir, script)]).exitCode).toBe(0);
    expect(statSync(join(dir, script)).mode & 0o111).not.toBe(0);
    const t = readFileSync(join(dir, script), "utf8");
    expect(t).not.toContain("export AGATE_PAYER_KEY");
    expect(t).not.toMatch(/\$\(.*AGATE_KEY_CMD/); // the script never runs the key command
    expect(t).not.toContain("unset AGATE_KEY_CMD"); // it reaches the process, which deletes it after use
    expect(t).toContain("unset AGATE_PAYER_KEY");
    expect(t).toContain("exec \"${BUN:-bun}\" run apps/payer/src/main.ts run");
  });
  test("the run script refuses to start without AGATE_KEY_CMD, or without an RPC list", () => {
    const run = (env: Record<string, string>) => Bun.spawnSync(["/bin/sh", join(dir, script)], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent-agate", ...env }, stdout: "pipe", stderr: "pipe" });
    const a = run({});
    expect(a.exitCode).not.toBe(0);
    expect(a.stderr.toString()).toContain("AGATE_KEY_CMD");
    const b = run({ AGATE_KEY_CMD: "echo 0x00" });
    expect(b.exitCode).toBe(2);
    expect(b.stderr.toString()).toContain("AGATE_RPC_URLS_CMD");
  });
});
