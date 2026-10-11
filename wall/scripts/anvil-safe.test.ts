// anvil-safe.sh: cleanup on stop, the concurrency cap, the disk floor, parent death, the kill -9 sweep, and the kept
// states (a leading count) that let a read at "latest" survive a block mined under it.
// Every case runs under its own AGATE_ANVIL_ROOT, so it never touches the shared slots of a real run, and with
// the disk floor at 0 unless the case is about the floor.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAnvil } from "./anvil.ts";

const roots: string[] = [];

function freshRoot(): string {
  const r = mkdtempSync(join(tmpdir(), "agate-anvil-test-"));
  roots.push(r);
  return r;
}

const start = (root: string, env: Record<string, string> = {}) =>
  spawnAnvil(["--silent"], { env: { AGATE_ANVIL_ROOT: root, AGATE_ANVIL_MIN_FREE_GB: "0", ...env }, timeoutMs: 20_000 });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const runs = (root: string) => readdirSync(root).filter((n) => n.startsWith("run."));
const slots = (root: string) => (existsSync(join(root, "slots")) ? readdirSync(join(root, "slots")) : []);
const anvilPids = (root: string) =>
  existsSync(root) ? runs(root).map((r) => Number(readFileSync(join(root, r, "anvil.pid"), "utf8").trim())).filter((p) => p > 0) : [];

async function until(cond: () => boolean, ms = 5_000): Promise<boolean> {
  for (let t = 0; t < ms; t += 100) {
    if (cond()) return true;
    await Bun.sleep(100);
  }
  return cond();
}

afterAll(() => {
  // a failed assertion can leave an orphan whose only record is in these roots: stop it before deleting them
  for (const r of roots) {
    for (const p of anvilPids(r)) if (alive(p)) process.kill(p, "SIGKILL");
    rmSync(r, { recursive: true, force: true });
  }
});

describe.skipIf(!Bun.which("anvil"))("anvil-safe.sh", () => {
  test("serves RPC, then removes its run dir and slot on SIGTERM", async () => {
    const root = freshRoot();
    const a = await start(root);
    expect(runs(root).length).toBe(1);
    expect(slots(root)).toEqual([String(a.proc.pid)]);
    const [pid] = anvilPids(root);
    a.proc.kill("SIGTERM");
    await a.proc.exited;
    expect(await until(() => !alive(pid!))).toBe(true);
    expect(runs(root)).toEqual([]);
    expect(slots(root)).toEqual([]);
  }, 30_000);

  test("refuses a chain past AGATE_ANVIL_MAX with its reason, and the slot frees when the first stops", async () => {
    const root = freshRoot();
    const first = await start(root, { AGATE_ANVIL_MAX: "1" });
    await expect(start(root, { AGATE_ANVIL_MAX: "1", AGATE_ANVIL_SLOT_WAIT: "2" })).rejects.toThrow("no anvil slot free");
    expect(runs(root).length).toBe(1);
    first.proc.kill("SIGTERM");
    await first.proc.exited;
    const third = await start(root, { AGATE_ANVIL_MAX: "1" });
    third.proc.kill("SIGTERM");
    await third.proc.exited;
    expect(runs(root)).toEqual([]);
  }, 40_000);

  test("a burst of 6 starts against a cap of 3 admits exactly 3", async () => {
    const root = freshRoot();
    const env = { AGATE_ANVIL_MAX: "3", AGATE_ANVIL_SLOT_WAIT: "2" };
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => start(root, env)));
    const up = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    expect(up.length).toBe(3);
    expect(slots(root).length).toBe(3);
    expect(runs(root).length).toBe(3);
    for (const a of up) a.proc.kill("SIGTERM");
    await Promise.all(up.map((a) => a.proc.exited));
    expect(slots(root)).toEqual([]);
    expect(runs(root)).toEqual([]);
  }, 40_000);

  test("refuses to start under the free-disk floor, says why and leaves nothing behind", async () => {
    const root = freshRoot();
    await expect(start(root, { AGATE_ANVIL_MIN_FREE_GB: "100000000" })).rejects.toThrow("not starting anvil");
    expect(runs(root)).toEqual([]);
    expect(slots(root)).toEqual([]);
  }, 30_000);

  test("stops anvil and cleans up when the parent it watches exits", async () => {
    const root = freshRoot();
    const parent = Bun.spawn(["sleep", "60"]);
    const a = await start(root, { AGATE_ANVIL_PARENT: String(parent.pid) });
    const [pid] = anvilPids(root);
    parent.kill();
    await parent.exited;
    await a.proc.exited;
    expect(await until(() => !alive(pid!))).toBe(true);
    expect(runs(root)).toEqual([]);
    expect(slots(root)).toEqual([]);
  }, 30_000);

  test("a kill -9 leaves an orphan; the next start sweeps it, its run dir and its slot", async () => {
    const root = freshRoot();
    const a = await start(root);
    const [pid] = anvilPids(root);
    a.proc.kill("SIGKILL");
    await a.proc.exited;
    expect(alive(pid!)).toBe(true); // nothing could clean up
    expect(runs(root).length).toBe(1);
    const next = await start(root);
    expect(await until(() => !alive(pid!))).toBe(true);
    expect(runs(root).length).toBe(1); // only the new run
    expect(slots(root)).toEqual([String(next.proc.pid)]); // the dead holder's slot is gone
    next.proc.kill("SIGTERM");
    await next.proc.exited;
    expect(runs(root)).toEqual([]);
  }, 40_000);

  // A read at "latest" on a chain other processes send to: anvil resolves "latest" to block N, and when the next block
  // lands before N's state is read, the read becomes one at N under a head of N+1. With no state kept for N it fails
  // with -32602 "BlockOutOfRangeError: block height is N+1 but requested was N". Asked here directly, so no timing:
  // 20 blocks mined, then a call and a balance read 1, 16 and 17 blocks behind the head.
  async function readsBehindHead(rpc: string): Promise<Record<string, string>> {
    const ask = async (method: string, params: unknown[]) =>
      (await (await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result?: unknown; error?: { code: number; message: string } };
    const accts = (await ask("eth_accounts", [])).result as string[];
    for (let i = 0; i < 20; i++) await ask("eth_sendTransaction", [{ from: accts[1], to: accts[0], value: "0x1", gas: "0x5208" }]);
    let head = 0;
    for (let i = 0; i < 250 && head < 20; i++) {
      head = Number((await ask("eth_blockNumber", [])).result as string);
      if (head < 20) await Bun.sleep(20);
    }
    const at = (back: number) => `0x${(head - back).toString(16)}`;
    const said = (r: { error?: { code: number; message: string } }) => (r.error ? `${r.error.code} ${r.error.message.replace(/\d+/g, "N")}` : "ok");
    return {
      head: String(head),
      call1: said(await ask("eth_call", [{ to: accts[0], data: "0x" }, at(1)])),
      balance1: said(await ask("eth_getBalance", [accts[0], at(1)])),
      balance16: said(await ask("eth_getBalance", [accts[0], at(16)])),
      balance17: said(await ask("eth_getBalance", [accts[0], at(17)])),
    };
  }

  test("a leading count keeps that many states: it reaches anvil as --prune-history <n>, and a cleanup check still finds it", async () => {
    const root = freshRoot();
    const a = await spawnAnvil(["--silent"], { env: { AGATE_ANVIL_ROOT: root, AGATE_ANVIL_MIN_FREE_GB: "0" }, timeoutMs: 20_000, states: 16 });
    const [pid] = anvilPids(root);
    const cmd = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe" }).stdout.toString().trim();
    expect(cmd).toStartWith(`anvil --prune-history 16 --port ${a.port} `);
    // the e2e's leftover check (client/e2e/fork.ts anvilOnPort) and the wrapper's own sweep both match this line
    const found = Bun.spawnSync(["pgrep", "-f", `anvil --prune-history( [0-9]+)? --port ${a.port} `], { stdout: "pipe" }).stdout.toString().trim();
    expect(found).toBe(String(pid));
    a.proc.kill("SIGTERM");
    await a.proc.exited;
    expect(await until(() => !alive(pid!))).toBe(true);
    expect(runs(root)).toEqual([]);
    await expect(spawnAnvil(["--silent"], { states: 0 })).rejects.toThrow("states must be a positive integer");
  }, 30_000);

  test("a read behind the head: refused out of range with no states kept, answered within the 16 kept", async () => {
    const OUT = "-32602 BlockOutOfRangeError: block height is N but requested was N";
    const bare = await spawnAnvil(["--silent"], { env: { AGATE_ANVIL_ROOT: freshRoot(), AGATE_ANVIL_MIN_FREE_GB: "0" }, timeoutMs: 20_000 });
    const without = await readsBehindHead(bare.rpc);
    bare.proc.kill("SIGTERM");
    await bare.proc.exited;
    const kept = await spawnAnvil(["--silent"], { env: { AGATE_ANVIL_ROOT: freshRoot(), AGATE_ANVIL_MIN_FREE_GB: "0" }, timeoutMs: 20_000, states: 16 });
    const with16 = await readsBehindHead(kept.rpc);
    kept.proc.kill("SIGTERM");
    await kept.proc.exited;
    expect(without).toEqual({ head: "20", call1: OUT, balance1: OUT, balance16: OUT, balance17: OUT });
    expect(with16).toEqual({ head: "20", call1: "ok", balance1: "ok", balance16: "ok", balance17: OUT });
  }, 40_000);
});
