// BOTS-SPEC 2.1 with audit M-K1: the bot takes its key from AGATE_KEY_CMD itself, so the key never sits in its
// exec-time environment (`ps -wwE` shows that block to any process of the same user for the process's whole life).
// Throwaway keys only; the key is never printed (assertions compare booleans).
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { KEY_CMD, runKeyCommand, StartError, takeKey } from "../src/runtime.ts";

const dir = mkdtempSync(join(tmpdir(), "agate-runtime-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const CHILD = join(import.meta.dir, "fake", "hold-key-child.ts");

async function childEnvBlock(env: Record<string, string>): Promise<{ out: { from: string; keyVar: string | null; cmdLeft: boolean; keyLeft: boolean }; ps: string }> {
  const p = Bun.spawn(["bun", "run", CHILD], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/", ...env }, stdout: "pipe", stderr: "pipe" });
  try {
    const reader = p.stdout.getReader();
    let text = "";
    while (!text.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const ps = Bun.spawnSync(["ps", "-wwE", "-o", "command=", "-p", String(p.pid)]).stdout.toString();
    return { out: JSON.parse(text.split("\n")[0]!), ps };
  } finally {
    p.kill("SIGKILL");
    await p.exited;
  }
}

describe("the key from AGATE_KEY_CMD (audit M-K1)", () => {
  test("run by the process itself: the key is in memory only, never in its exec-time environment; the command is gone from process.env", async () => {
    const key = generatePrivateKey();
    const file = join(dir, "key");
    writeFileSync(file, `${key}\n`);
    chmodSync(file, 0o600);
    const { out, ps } = await childEnvBlock({ [KEY_CMD]: `cat ${file}` });
    expect(out.from).toBe(privateKeyToAccount(key).address);
    expect(out.keyVar).toBe("AGATE_TEST_CHILD_KEY");
    expect(out.cmdLeft).toBe(false);
    expect(out.keyLeft).toBe(false);
    expect(ps.includes("hold-key-child")).toBe(true); // ps read the right process
    expect(ps.includes(key.slice(2))).toBe(false);
  });

  test("control: a key exported to the process stays readable there, whatever holdKey deletes (the leak the fix removes)", async () => {
    const key = generatePrivateKey();
    const { out, ps } = await childEnvBlock({ AGATE_TEST_CHILD_KEY: key });
    expect(out.keyLeft).toBe(false); // gone from process.env...
    expect(ps.includes(key.slice(2))).toBe(true); // ...but not from the exec-time block
  });

  test("runKeyCommand: errors name the variable, never the command's output", () => {
    expect(() => runKeyCommand("exit 3")).toThrow(`${KEY_CMD} failed (exit 3)`);
    let msg = "";
    try {
      runKeyCommand("echo not-a-key-but-a-secret-looking-text");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe(`${KEY_CMD} did not print a 32-byte hex key`);
    expect(() => runKeyCommand("  ")).toThrow(StartError);
  });

  test("takeKey: both sources set is refused; a dry run needs the address; nothing at all is refused", () => {
    expect(() => takeKey({ keyVar: "AGATE_T_KEY", addressVar: "AGATE_T_ADDRESS" }, { [KEY_CMD]: "true", AGATE_T_KEY: generatePrivateKey() })).toThrow(`set one of ${KEY_CMD} and AGATE_T_KEY`);
    expect(() => takeKey({ keyVar: "AGATE_T_KEY", addressVar: "AGATE_T_ADDRESS" }, { AGATE_DRY_RUN: "1" })).toThrow("AGATE_T_ADDRESS");
    expect(takeKey({ keyVar: "AGATE_T_KEY", addressVar: "AGATE_T_ADDRESS" }, { AGATE_DRY_RUN: "1", AGATE_T_ADDRESS: "0x00000000000000000000000000000000000000aa" })).toEqual({ keyVar: null, from: "0x00000000000000000000000000000000000000aa" });
    expect(() => takeKey({ keyVar: "AGATE_T_KEY", addressVar: "AGATE_T_ADDRESS" }, {})).toThrow(`neither ${KEY_CMD} nor AGATE_T_KEY is set`);
    const fake = generatePrivateKey();
    const env: Record<string, string | undefined> = { [KEY_CMD]: "anything" };
    expect(takeKey({ keyVar: "AGATE_T_KEY2", addressVar: "AGATE_T_ADDRESS" }, env, () => fake)).toEqual({ keyVar: "AGATE_T_KEY2", from: privateKeyToAccount(fake).address });
    expect(env[KEY_CMD]).toBeUndefined();
    expect(process.env.AGATE_T_KEY2).toBeUndefined();
  });
});
