// flock(2) locks (BUILD-SPEC 13.4). The kernel releases a lock when its process dies, so a crashed or orphaned
// writer never blocks a restart; the pid written into the file is information only, never a decision.
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, ftruncateSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

let flockFn: ((fd: number, op: number) => number) | undefined;
function flock(fd: number, op: number): number {
  if (!flockFn) {
    const lib = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    flockFn = (f, o) => lib.symbols.flock(f, o) as number;
  }
  return flockFn(fd, op);
}

export class FileLock {
  private constructor(
    readonly path: string,
    private fd: number | undefined,
  ) {}

  /** Takes the exclusive lock now or returns null (another open file description holds it). */
  static tryTake(path: string, note?: Record<string, unknown>): FileLock | null {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, "a+");
    if (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
      closeSync(fd);
      return null;
    }
    try {
      ftruncateSync(fd, 0);
      writeSync(fd, `${JSON.stringify({ pid: process.pid, at: Math.floor(Date.now() / 1000), ...note })}\n`);
    } catch {
      // information only
    }
    return new FileLock(path, fd);
  }

  /** Polls for the lock until waitMs has passed. */
  static async take(path: string, waitMs: number, note?: Record<string, unknown>, sleep = (ms: number) => Bun.sleep(ms)): Promise<FileLock | null> {
    const until = Date.now() + waitMs;
    for (;;) {
      const l = FileLock.tryTake(path, note);
      if (l || Date.now() >= until) return l;
      await sleep(Math.min(100, Math.max(1, until - Date.now())));
    }
  }

  get held(): boolean {
    return this.fd !== undefined;
  }

  release(): void {
    if (this.fd === undefined) return;
    const fd = this.fd;
    this.fd = undefined;
    flock(fd, LOCK_UN);
    closeSync(fd);
  }
}

/** A lock held only around sends: one sender per key across processes (two indexes may share a writer key). */
export class KeyLock {
  private lock: FileLock | null = null;
  constructor(
    readonly path: string,
    private readonly waitMs: number,
  ) {}

  get held(): boolean {
    return Boolean(this.lock?.held);
  }

  async acquire(waitMs = this.waitMs): Promise<boolean> {
    if (this.held) return true;
    this.lock = await FileLock.take(this.path, waitMs, { use: "send" });
    return this.held;
  }

  release(): void {
    this.lock?.release();
    this.lock = null;
  }
}
