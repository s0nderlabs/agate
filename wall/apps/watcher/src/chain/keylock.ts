// The per-key send lock (BUILD-SPEC 13.7, Oct 3): <home>/keys/<address lowercase>.lock, the same file and the same
// flock(2) the writers take around each send flight, so two processes sending with one key (an attester or keeper
// key serving two indexes, or the guardian CLI) never interleave nonces. The kernel releases a lock when its process
// dies; the note written into the file (pid, a per-acquire tag) is information, and lets the next holder see that
// someone else held the key since its own last flight (then it re-reads the nonce at `pending`).
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

let flockFn: ((fd: number, op: number) => number) | undefined;
function flock(fd: number, op: number): number {
  if (!flockFn) {
    const lib = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    flockFn = (f, o) => lib.symbols.flock(f, o) as number;
  }
  return flockFn(fd, op);
}

export function keyLockPath(home: string, address: string): string {
  return join(home, "keys", `${address.toLowerCase()}.lock`);
}

let tagSeq = 0;

export class SendLock {
  private fd: number | undefined;
  private myTag: string | null = null;

  constructor(
    readonly path: string,
    /** how long an acquire waits before giving up that send: max(30 s, slice / 4) */
    readonly waitMs: number,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  ) {}

  get held(): boolean {
    return this.fd !== undefined;
  }

  /** Takes the lock, polling up to waitMs. Returns null when it stayed busy; else whether another holder held the
   *  key since this lock's previous flight (the caller then re-reads its nonce). */
  async acquire(note: Record<string, unknown> = {}): Promise<{ otherHolder: boolean } | null> {
    if (this.held) return { otherHolder: false };
    const until = Date.now() + this.waitMs;
    mkdirSync(dirname(this.path), { recursive: true });
    for (;;) {
      const fd = openSync(this.path, "a+");
      if (flock(fd, LOCK_EX | LOCK_NB) === 0) {
        let prev = "";
        try {
          prev = readFileSync(this.path, "utf8");
        } catch {
          // information only
        }
        const tag = `${process.pid}-${Date.now()}-${++tagSeq}`;
        try {
          ftruncateSync(fd, 0);
          writeSync(fd, `${JSON.stringify({ pid: process.pid, at: Math.floor(Date.now() / 1000), tag, use: "send", ...note })}\n`);
        } catch {
          // information only
        }
        let prevTag: string | null = null;
        try {
          prevTag = (JSON.parse(prev.trim() || "{}") as { tag?: string }).tag ?? null;
        } catch {
          prevTag = null;
        }
        const otherHolder = this.myTag === null || prevTag !== this.myTag;
        this.fd = fd;
        this.myTag = tag;
        return { otherHolder };
      }
      closeSync(fd);
      if (Date.now() >= until) return null;
      await this.sleep(Math.min(100, Math.max(1, until - Date.now())));
    }
  }

  release(): void {
    if (this.fd === undefined) return;
    const fd = this.fd;
    this.fd = undefined;
    flock(fd, LOCK_UN);
    closeSync(fd);
  }
}
