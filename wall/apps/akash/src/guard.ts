// Start guards shared by the Akash reader's process: no key in the environment (13.1), one process (13.4).
import { closeSync, constants, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** Names of variables that look like a key: *_KEY, *_KEY_CMD, CRE_ETH_PRIVATE_KEY (and any extra names). */
export function keyVars(env: Record<string, string | undefined>, extra: readonly string[] = []): string[] {
  return Object.keys(env)
    .filter((k) => env[k] !== undefined && (/_KEY$/.test(k) || /_KEY_CMD$/.test(k) || k === "CRE_ETH_PRIVATE_KEY" || extra.includes(k)))
    .sort();
}

/** Throws (naming the variables, never their values) when any key variable is set. */
export function refuseKeys(env: Record<string, string | undefined>, who: string, extra: readonly string[] = []): void {
  const bad = keyVars(env, extra);
  if (bad.length > 0) throw new Error(`${who} holds no key and refuses to start with ${bad.join(", ")} set (BUILD-SPEC 13.1)`);
}

/** An exclusive lock the kernel drops when the process dies (13.4); throws when another process holds it. */
export function takeLock(path: string): number {
  mkdirSync(dirname(path), { recursive: true });
  if (process.platform !== "darwin") {
    const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
    writeSync(fd, `${process.pid}\n`, 0);
    return fd;
  }
  const O_EXLOCK = 0x20;
  const O_NONBLOCK = 0x4;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | O_EXLOCK | O_NONBLOCK, 0o600);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EAGAIN" || code === "EWOULDBLOCK") throw new Error(`another process holds ${path}`);
    throw e;
  }
  writeSync(fd, `${process.pid}\n`, 0);
  return fd;
}

export function releaseLock(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // already closed
  }
}
