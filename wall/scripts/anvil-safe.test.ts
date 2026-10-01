// anvil-safe.sh: cleanup on stop, the concurrency cap, the disk floor, parent death and the kill -9 sweep.
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
});
