// Fix round (phase 2b audit, contract and security lens M2, M3): a writer's action alerts (KEY_MISMATCH above all)
// run AGATE_NOTIFY_CMD once per alert id, and the notifier's environment is PATH and HOME only.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "@agate/report/types";
import { alertSink, runNotify } from "../src/pipeline/ops.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "agate-notify-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const W = "0x00000000000000000000000000000000000000b2" as Address;
const INDEX = "0x00000000000000000000000000000000000a11ce" as Address;

describe("writer alerts reach AGATE_NOTIFY_CMD (M2)", () => {
  test("an action alert notifies once per id; info alerts and repeats do not", () => {
    const calls: { cmd: string; json: string }[] = [];
    const sink = alertSink({ home: tmp(), writer: W, index: INDEX, print: () => {}, notifyCmd: "notify-me", notify: (cmd, json) => calls.push({ cmd, json }) });
    const km = { code: "KEY_MISMATCH" as const, severity: "action" as const, gpuId: `0x${"11".repeat(32)}` as `0x${string}`, day: 20_729, slot: 5, message: "a second user of this writer's key posted slice 5" };
    sink(km);
    sink(km); // the next scan raises it again: still one notification
    sink({ code: "RPC_FAILOVER", severity: "info", message: "info only" });
    sink({ ...km, day: 20_730 }); // another day: another id
    expect(calls.length).toBe(2);
    expect(calls[0]!.cmd).toBe("notify-me");
    expect(JSON.parse(calls[0]!.json)).toMatchObject({ code: "KEY_MISMATCH", severity: "action", index: INDEX.toLowerCase(), writer: W });
  });
  test("without AGATE_NOTIFY_CMD nothing runs", () => {
    const calls: string[] = [];
    const sink = alertSink({ home: tmp(), writer: W, print: () => {}, notify: (c) => calls.push(c) });
    sink({ code: "KEY_MISMATCH", severity: "action", message: "x" });
    expect(calls).toEqual([]);
  });
});

describe("the notifier's environment (M3)", () => {
  test("PATH and HOME only: a key or an RPC URL in the writer's environment never reaches it", async () => {
    const d = tmp();
    const envOut = join(d, "env.txt");
    const stdinOut = join(d, "stdin.txt");
    const before = process.env.AGATE_RPC_URLS;
    process.env.AGATE_FIXROUND_FAKE_KEY = "0xFAKEKEY-not-a-real-key";
    process.env.AGATE_RPC_URLS = "https://example.invalid/v2/FAKEALCHEMY";
    try {
      runNotify(`/usr/bin/env > '${envOut}'; /bin/cat > '${stdinOut}'`, '{"code":"KEY_MISMATCH"}');
      for (let i = 0; i < 50 && !(existsSync(stdinOut) && readFileSync(stdinOut, "utf8").length > 0); i++) await Bun.sleep(50);
      const env = readFileSync(envOut, "utf8");
      expect(env).not.toContain("FAKEKEY");
      expect(env).not.toContain("FAKEALCHEMY");
      const names = env.trim().split("\n").map((l) => l.split("=")[0]!).filter((n) => !["PWD", "SHLVL", "_", "OLDPWD", "__CF_USER_TEXT_ENCODING"].includes(n));
      expect(names.sort()).toEqual(["HOME", "PATH"]);
      expect(readFileSync(stdinOut, "utf8")).toBe('{"code":"KEY_MISMATCH"}');
    } finally {
      delete process.env.AGATE_FIXROUND_FAKE_KEY;
      if (before === undefined) delete process.env.AGATE_RPC_URLS;
      else process.env.AGATE_RPC_URLS = before;
    }
  });
});
