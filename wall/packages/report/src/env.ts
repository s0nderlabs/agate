// RPC endpoints from a command, and redaction (BUILD-SPEC 13.6, Oct 3). Alchemy's URL carries the API key in its
// path, so every configured URL is a secret: it reaches a process only through AGATE_RPC_URLS_CMD at start, and
// nothing the process prints may contain it. Call resolveRpcEndpoints once at start, then installScrubber.
import { format } from "node:util";

export interface RpcEndpoints {
  http: string[]; // failover order
  ws: string[]; // subscription order
}

const CMD = "AGATE_RPC_URLS_CMD";
const LIST = "AGATE_RPC_URLS";
const ONE = "AGATE_RPC_URL";
export const RPC_CMD_TIMEOUT_MS = 10_000;

/** The whole environment of a command this wall runs (the RPC list command, a notifier): PATH and HOME only, so no
 *  role key (AGATE_*_KEY), RPC URL or other secret in the calling process's environment reaches it (M3). A token the
 *  command needs goes inside the command text or a file it reads. */
export function childEnv(): Record<string, string> {
  return { PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || "/" };
}

/** Runs the command with /bin/sh -c and returns its stdout; throws a message that never holds its output. The command
 *  sees childEnv() only: every caller resolves its endpoints while its role key may still be in process.env. */
export function runRpcCommand(cmd: string, timeoutMs: number = RPC_CMD_TIMEOUT_MS): string {
  const r = Bun.spawnSync(["/bin/sh", "-c", cmd], { env: childEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  if (r.exitedDueToTimeout) throw new Error(`${CMD} timed out after ${Math.ceil(timeoutMs / 1000)} s`);
  if (!r.success) throw new Error(`${CMD} failed (exit ${r.exitCode ?? r.signalCode ?? "?"})`);
  return r.stdout.toString();
}

/**
 * The process's RPC endpoints. Sources, in order: AGATE_RPC_URLS_CMD (run once), else AGATE_RPC_URLS, else
 * AGATE_RPC_URL (one URL: the caller raises RPC_SINGLE). Both of the first two set is refused. The list is comma- or
 * newline-separated; http(s) entries are HTTP endpoints, ws(s) entries websocket endpoints; at least one HTTP entry.
 * Errors never echo the command's output or a URL. Afterwards AGATE_RPC_URLS_CMD and AGATE_RPC_URLS are deleted from
 * env (pass process.env), so no child inherits them.
 */
export function resolveRpcEndpoints(env: Record<string, string | undefined>, run: (cmd: string) => string = runRpcCommand): RpcEndpoints {
  const cmd = env[CMD];
  const list = env[LIST];
  if (cmd !== undefined && list !== undefined) throw new Error(`set one of ${CMD} and ${LIST}`);
  let raw: string;
  let from: string;
  if (cmd !== undefined) {
    from = CMD;
    if (cmd.trim() === "") throw new Error(`${CMD} is empty`);
    try {
      raw = run(cmd);
    } catch (e) {
      // the default runner's messages are safe; anything else is replaced, never echoed
      const m = e instanceof Error ? e.message : "";
      throw new Error(/^AGATE_RPC_URLS_CMD (failed \(exit [^)]*\)|timed out after \d+ s)$/.test(m) ? m : `${CMD} failed`);
    }
  } else if (list !== undefined) {
    from = LIST;
    raw = list;
  } else if (env[ONE] !== undefined) {
    from = ONE;
    raw = env[ONE]!;
  } else {
    throw new Error(`set ${CMD} or ${LIST} (two RPC URLs from different providers, 13.6)`);
  }
  const bad = from === CMD ? `${CMD} did not print a list of URLs` : `${from} is not a list of http(s) or ws(s) URLs`;
  const entries = raw.split(/[,\r\n]+/).map((s) => s.trim()).filter((s) => s !== "");
  if (entries.length === 0) throw new Error(bad);
  const out: RpcEndpoints = { http: [], ws: [] };
  for (const s of entries) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      throw new Error(bad);
    }
    if (u.hostname === "") throw new Error(bad);
    if (u.protocol === "http:" || u.protocol === "https:") out.http.push(s);
    else if (u.protocol === "ws:" || u.protocol === "wss:") out.ws.push(s);
    else throw new Error(bad);
  }
  if (out.http.length === 0) throw new Error(bad);
  delete env[CMD];
  delete env[LIST];
  return out;
}

/** "https://monad-testnet.g.alchemy.com/v2/abc" -> "https://monad-testnet.g.alchemy.com/...": scheme, host and port
 *  only; anything after them (path, query, fragment, user info) becomes "/...". */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const rest = u.pathname.length > 1 || u.search !== "" || u.hash !== "" || u.username !== "" || u.password !== "";
    return `${u.protocol}//${u.host}${rest ? "/..." : ""}`;
  } catch {
    return "<url>";
  }
}

const REDACTED = "<redacted>";
const MIN_SECRET = 12;

/** The strings scrubSecrets replaces, longest first: each URL as configured and as parsed, then each path segment,
 *  query value and user-info part of 12 or more characters (raw and percent-decoded). */
function secretsOf(e: RpcEndpoints): { find: string; put: string }[] {
  const urls: { find: string; put: string }[] = [];
  const parts = new Set<string>();
  const addPart = (p: string) => {
    for (const v of [p, safeDecode(p)]) if (v.length >= MIN_SECRET) parts.add(v);
  };
  for (const url of [...e.http, ...e.ws]) {
    const put = redactUrl(url);
    urls.push({ find: url, put });
    try {
      const u = new URL(url);
      for (const v of [u.href, u.href.replace(/\/$/, "")]) if (v !== put) urls.push({ find: v, put });
      for (const seg of u.pathname.split("/")) addPart(seg);
      for (const [, v] of u.searchParams) addPart(v);
      addPart(u.username);
      addPart(u.password);
      addPart(u.hash.replace(/^#/, ""));
    } catch {
      // an unparsable entry was refused by resolveRpcEndpoints; only its literal is replaced
    }
  }
  const all = [...urls.filter((x) => x.find !== x.put && x.find !== ""), ...[...parts].map((p) => ({ find: p, put: REDACTED }))];
  return all.sort((a, b) => b.find.length - a.find.length);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Replaces every configured URL (by its redactUrl form) and every long path segment or query value in them. */
export function scrubSecrets(text: string, e: RpcEndpoints): string {
  let out = text;
  for (const { find, put } of secretsOf(e)) if (out.includes(find)) out = out.split(find).join(put);
  return out;
}

type Writer = (chunk: unknown, ...rest: unknown[]) => boolean;
const installed: { e: RpcEndpoints } = { e: { http: [], ws: [] } };
let wrapped = false;

function scrubChunk(chunk: unknown): unknown {
  if (typeof chunk === "string") return scrubSecrets(chunk, installed.e);
  if (chunk instanceof Uint8Array) {
    const s = new TextDecoder().decode(chunk);
    const t = scrubSecrets(s, installed.e);
    return t === s ? chunk : new TextEncoder().encode(t);
  }
  return chunk;
}

/**
 * Wraps console.log/info/warn/error/debug/trace and process.stdout/stderr.write of this process so every line
 * passes through scrubSecrets; an uncaught error or rejection is printed scrubbed (the process then exits 1, as
 * Bun's default does, unless the process has its own handler). Installing again adds the new endpoints.
 */
export function installScrubber(e: RpcEndpoints): void {
  installed.e = { http: [...installed.e.http, ...e.http], ws: [...installed.e.ws, ...e.ws] };
  if (wrapped) return;
  wrapped = true;
  for (const m of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    const orig = console[m].bind(console) as (...a: unknown[]) => void;
    console[m] = (...args: unknown[]) => orig(scrubSecrets(format(...args), installed.e));
  }
  for (const stream of [process.stdout, process.stderr]) {
    const orig = stream.write.bind(stream) as Writer;
    (stream as unknown as { write: Writer }).write = (chunk: unknown, ...rest: unknown[]) => orig(scrubChunk(chunk), ...rest);
  }
  const last = (kind: "uncaughtException" | "unhandledRejection") => (err: unknown) => {
    process.stderr.write(`${kind}: ${format(err)}\n`);
    if (process.listenerCount(kind) <= 1) process.exit(1);
  };
  process.on("uncaughtException", last("uncaughtException"));
  process.on("unhandledRejection", last("unhandledRejection"));
}
