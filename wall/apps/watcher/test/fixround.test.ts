// Fix round (phase 2b audit, contract and security lens M1, M3): the notifier gets PATH and HOME only, the attest and
// keep roles hold their key in memory (never in process.env), and every alert message is one printable line.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { AlertSink, notifyEnv, oneLine } from "../src/alerts.ts";
import { addressOfEnvKey, holdKey, readKey } from "../src/chain/sender.ts";
import { printable, printableLines } from "../src/fsutil.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "agate-fixround-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
// anvil's public test account 1 (never a real key)
const ANVIL1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

describe("M3: role keys and the notifier", () => {
  test("holdKey moves the key out of process.env; readKey and the address still work", () => {
    process.env.AGATE_FIXROUND_ATTESTER_KEY = ANVIL1;
    const k = holdKey("AGATE_FIXROUND_ATTESTER_KEY");
    expect(k).toBe(ANVIL1);
    expect(process.env.AGATE_FIXROUND_ATTESTER_KEY).toBeUndefined();
    expect(readKey("AGATE_FIXROUND_ATTESTER_KEY")).toBe(ANVIL1);
    expect(addressOfEnvKey("AGATE_FIXROUND_ATTESTER_KEY")).toBe(privateKeyToAccount(ANVIL1).address);
  });
  test("the notifier runs with PATH and HOME only", async () => {
    expect(Object.keys(notifyEnv()).sort()).toEqual(["HOME", "PATH"]);
    const d = tmp();
    const out = join(d, "env.txt");
    process.env.AGATE_FIXROUND_KEEPER_KEY = ANVIL1; // a role that did not hold its key: still not inherited
    try {
      const sink = new AlertSink(join(d, "alerts.jsonl"), { now: () => 1, print: false, notifyCmd: `/usr/bin/env > '${out}'` });
      sink.raise({ code: "KEY_LOW", severity: "action", message: "x" });
      for (let i = 0; i < 50 && !existsSync(out); i++) await Bun.sleep(50);
      await Bun.sleep(50);
      const env = readFileSync(out, "utf8");
      expect(env).not.toContain(ANVIL1.slice(2));
      const names = env.trim().split("\n").map((l) => l.split("=")[0]!).filter((n) => !["PWD", "SHLVL", "_", "OLDPWD", "__CF_USER_TEXT_ENCODING"].includes(n));
      expect(names.sort()).toEqual(["HOME", "PATH"]);
    } finally {
      delete process.env.AGATE_FIXROUND_KEEPER_KEY;
    }
  });
});

describe("M1: printable text", () => {
  test("printable turns every control, DEL, C1 and line break into ?", () => {
    expect(printable("a\u001b[2Jb\u0007c\nd\u009be\u007ff g\th")).toBe("a?[2Jb?c?d?e?f?g?h");
    expect(printable("plain https://lambda.ai/pricing ~!")).toBe("plain https://lambda.ai/pricing ~!");
  });
  test("printableLines keeps our own line feeds (the guardian's help, a confirmation prompt) and cleans each line", () => {
    expect(printableLines("guardian <command>\n  status\n  alerts")).toBe("guardian <command>\n  status\n  alerts");
    expect(printableLines("suspend writer 0xab\nType yes to send: ")).toBe("suspend writer 0xab\nType yes to send: ");
    expect(printableLines("a\u001b[2Jb\r\nc\u0007\td\u009b")).toBe("a?[2Jb?\nc??d?");
    // a chain string formatted through printable() first keeps its break as "?" inside one line
    expect(printableLines(`reason "${printable("x\ny")}"\nnext`)).toBe('reason "x?y"\nnext');
  });
  test("an alert message is stored as one printable line", () => {
    const d = tmp();
    const sink = new AlertSink(join(d, "alerts.jsonl"), { now: () => 1, print: false });
    const a = sink.raise({ code: "ONCHAIN_EVENT", severity: "action", message: 'reader swap queued -> https://x/\u001b]52;c;aGk=\u0007 reason "a\nb\r\nc\td"' });
    expect(a.message).toBe('reader swap queued -> https://x/?]52;c;aGk=? reason "a b c d"');
    expect(oneLine("x\u009by")).toBe("x?y");
  });
});
