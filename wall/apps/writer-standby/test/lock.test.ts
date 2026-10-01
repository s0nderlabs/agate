// One process per role and index, one sender per key (13.4): flock, released by the kernel when the holder dies.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLock, KeyLock } from "../src/pipeline/lock.ts";

const LOCK_TS = join(import.meta.dir, "../src/pipeline/lock.ts");

describe("flock", () => {
  test("a second taker in the same process is refused; release lets it in", () => {
    const path = join(mkdtempSync(join(tmpdir(), "agate-lock-")), "standby/0xabc.lock");
    const a = FileLock.tryTake(path, { role: "standby" });
    expect(a).not.toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ pid: process.pid, role: "standby" });
    expect(FileLock.tryTake(path)).toBeNull();
    a!.release();
    const b = FileLock.tryTake(path);
    expect(b).not.toBeNull();
    b!.release();
  });

  test("another process is refused while we hold it, and gets it once a holder is killed (no pidfile logic)", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "agate-lock-")), "p.lock");
    const mine = FileLock.tryTake(path)!;
    const probe = Bun.spawnSync(["bun", "-e", `import { FileLock } from ${JSON.stringify(LOCK_TS)}; process.exit(FileLock.tryTake(${JSON.stringify(path)}) ? 0 : 3);`]);
    expect(probe.exitCode).toBe(3);
    mine.release();
    // a child takes it and is killed with SIGKILL while holding it: the kernel frees it
    const holder = Bun.spawn(["bun", "-e", `import { FileLock } from ${JSON.stringify(LOCK_TS)}; const l = FileLock.tryTake(${JSON.stringify(path)}); console.log(l ? "held" : "no"); setInterval(() => {}, 1000);`], { stdout: "pipe" });
    const reader = holder.stdout.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first.trim()).toBe("held");
    expect(FileLock.tryTake(path)).toBeNull();
    holder.kill("SIGKILL");
    await holder.exited;
    const again = FileLock.tryTake(path);
    expect(again).not.toBeNull();
    again!.release();
  });

  test("KeyLock waits for a busy key and gives up after its wait", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "agate-lock-")), "keys/0x1.lock");
    const a = new KeyLock(path, 50);
    const b = new KeyLock(path, 50);
    expect(await a.acquire()).toBe(true);
    expect(await a.acquire()).toBe(true); // re-entrant for its holder
    const t0 = Date.now();
    expect(await b.acquire()).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
    setTimeout(() => a.release(), 30);
    expect(await b.acquire(500)).toBe(true);
    b.release();
  });
});
