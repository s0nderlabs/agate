// The launchd template and run script of the repair app (BUILD-SPEC 13.2, 13.7): written, never loaded by a builder.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", "launchd");
const files = readdirSync(dir);
const plist = files.find((f) => f.endsWith(".plist.template"))!;
const script = files.find((f) => f.endsWith(".sh"))!;

describe("launchd template (repair)", () => {
  test("a valid plist with the agreed Label, no key variable, KeepAlive and the run script", () => {
    const text = readFileSync(join(dir, plist), "utf8");
    if (existsSync("/usr/bin/plutil")) expect(Bun.spawnSync(["/usr/bin/plutil", "-lint", join(dir, plist)]).exitCode).toBe(0);
    const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text)![1];
    expect(label).toBe("xyz.s0nderlabs.agate-repair");
    const keys = [...text.matchAll(/<key>([A-Z_][A-Z0-9_]*)<\/key>/g)].map((m) => m[1]!);
    expect(keys.filter((k) => /_KEY$|_KEY_CMD$|PRIVATE_KEY|ANTHROPIC/.test(k))).toEqual([]);
    expect(text).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(text).toContain(`apps/repair/launchd/${script}`);
  });
  test("the run script parses and is executable", () => {
    expect(Bun.spawnSync(["/bin/sh", "-n", join(dir, script)]).exitCode).toBe(0);
    expect(statSync(join(dir, script)).mode & 0o111).not.toBe(0);
  });
});
