// Small file helpers: atomic writes, appends, the wall home, the per-key lock and heartbeats (BUILD-SPEC 13.2, 13.4).
import { appendFileSync, closeSync, constants, existsSync, mkdirSync, openSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function wallHome(): string {
  return process.env.AGATE_WALL_HOME || join(homedir(), ".agate-wall");
}

export function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

let textScrub: ((s: string) => string) | null = null;

/** 13.6 (Oct 3): every text this process writes to a file (alerts, heartbeats, decisions, logs, events, the guardian
 *  log) passes through this, once the RPC endpoints are known (config.connect installs scrubSecrets). */
export function setFileScrubber(f: ((s: string) => string) | null): void {
  textScrub = f;
}
export function scrubText(s: string): string {
  return textScrub ? textScrub(s) : s;
}

/** One line for a terminal: every C0 and C1 control, DEL and line break becomes "?", so no string from the chain or
 *  a page (a reader swap's url or reason) can move the cursor, hide text or write the clipboard (fix round M1). */
export function printable(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "?");
}

/** Our own multi-line text (the CLI's help, a confirmation prompt, a multi-line error) for a terminal: each line
 *  through printable(), the line feeds kept. A chain string inside it goes through printable() where it is formatted,
 *  so a line break it carries is already "?" here. */
export function printableLines(s: string): string {
  return String(s).split("\n").map(printable).join("\n");
}

/** Write to a temp file and rename, so a reader never sees half a file. */
export function writeAtomic(path: string, data: string | Uint8Array): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, typeof data === "string" ? scrubText(data) : data);
  renameSync(tmp, path);
}

export function appendLine(path: string, obj: unknown): void {
  ensureDir(dirname(path));
  appendFileSync(path, `${scrubText(JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))}\n`);
}

export class LockHeld extends Error {}

/** One process per key (13.4): an exclusive lock the kernel releases when the process dies. Never decided by
 *  "is the pid alive". Returns the open descriptor; keep it for the life of the process. */
export function takeLock(path: string): number {
  ensureDir(dirname(path));
  let fd: number;
  if (process.platform === "darwin") {
    const O_EXLOCK = 0x20;
    const O_NONBLOCK = 0x4;
    try {
      fd = openSync(path, constants.O_RDWR | constants.O_CREAT | O_EXLOCK | O_NONBLOCK, 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EAGAIN" || (e as NodeJS.ErrnoException).code === "EWOULDBLOCK")
        throw new LockHeld(`another process holds ${path}`);
      throw e;
    }
  } else {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen(process.platform === "linux" ? "libc.so.6" : "libc.dylib", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    const LOCK_EX = 2;
    const LOCK_NB = 4;
    if (lib.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
      closeSync(fd);
      throw new LockHeld(`another process holds ${path}`);
    }
  }
  writeSync(fd, `${process.pid}\n`, 0);
  return fd;
}

export interface HeartbeatBody {
  pid: number;
  role: string;
  index: string;
  at: number;
  tick: number;
  lastAction: string;
}

export class Heartbeat {
  private n = 0;
  constructor(
    readonly path: string,
    readonly role: string,
    readonly index: string,
  ) {}
  beat(at: number, lastAction: string): void {
    this.n++;
    const body: HeartbeatBody = { pid: process.pid, role: this.role, index: this.index, at, tick: this.n, lastAction };
    writeAtomic(this.path, JSON.stringify(body));
  }
}

export function heartbeatPath(home: string, role: string, index?: string): string {
  return index ? join(home, role, index.toLowerCase(), "heartbeat.json") : join(home, role, "heartbeat.json");
}
