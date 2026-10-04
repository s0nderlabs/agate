// The live check on Monad testnet: the user's journey of the fork mode (e2e/flows.ts), against the LIVE demo factory
// of a running demo session, in real time, with no time travel: drip, buy long $200, sell part, a short of 10
// GPU-hours opened and closed, pay me daily $100, a limit bid placed and cancelled (the margin withdrawn), then a wait
// for the next final demo day and the daily claim, then a wait for the demo month's end: the final claims, and the
// settle (or redeem) of what is left. Every market write passes the price read a moment before it (maxPrice /
// minPrice), and every step is checked through the client's reads and the indexer.
//
//   AGATE_E2E_KEY_CMD='security find-generic-password -s <item> -a private-key -w' \
//     bun run e2e/run.ts testnet --i-mean-testnet [options]
//
// Gates, each checked before anything is sent:
//   --i-mean-testnet is required; a loopback RPC (a local fork, in any spelling: e2e/fork.ts isLoopback) is refused
//   unless --allow-fork, and an RPC that answers a local node's methods (anvil_nodeInfo, hardhat_metadata) or another
//   chain id is refused whatever its URL;
//   the key comes only from AGATE_E2E_KEY_CMD, run once: never from a variable (AGATE_E2E_KEY and the like are
//   refused, and so is a key the command prints that is also the value of any variable), never from argv (any
//   argument holding 64 hex digits in a row is refused unshown), never printed or written (nothing the command writes
//   is shown, even when it fails, and every run of 64 hex digits is hidden from the output and the report, but the
//   transaction hashes of this run); a command that holds a key literally is accepted only on a loopback fork;
//   one live run per key (a pid lock in ~/.agate-e2e/locks, released on exit; a lock whose process is gone is taken
//   over), and none while a transaction of the key is still pending (its pending nonce above its latest);
//   the user's address, MON and tUSD are printed first, then any role in the index or the market refuses the run (the
//   index's owner, writers, attester and guardians, the factories' market admin, the dollar's minter, read on chain,
//   and every role address of ops/testnet/lib.sh and the deploy configs, the maker and the payer among them);
//   the demo factory by default, and only while its session is active; the production factory only with
//   --factory real (a demo entry that points at production, or an index on the production clock, is refused);
//   a spend cap (--max-dollars, default 500 tUSD): the journey's planned maximum is checked before the first send, and
//   each write's maximum before it is sent; a MON floor (--min-mon, default 1) before every step.
// Resumable: a run that stops (Ctrl-C, which finishes the step in progress or stops a wait at once; --stop-after; an
// RPC error) starts again where the chain says it is: each step is looked up first (the router's flows of this user
// and month, its Kuru orders, its positions, balances and orders through the client's reads, the indexer up to its
// newest block and the chain's logs above it) and is skipped when it is done, finished when it is half done, and only
// sent when it was not. Without --month a run continues the newest month this key holds something in or has a journey
// in on this factory (the --report file of a previous run, or the chain's history), finished or not, so a rerun after
// a finished journey sends nothing; a new month needs --month.
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Abi, type AbiEvent, type Address, createPublicClient, createWalletClient, defineChain, fallback, formatEther, type Hex, http, parseAbi, parseEther, type PublicClient, type Transport, type WalletClient } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import {
  abi,
  type AgateClient,
  AmountError,
  buyLong,
  cancelLimit,
  claimDaily,
  closeShort,
  createAgateClient,
  type Deployments,
  drip,
  type FactoryRecord,
  type Gpu,
  GPUS,
  monthLabel,
  MULTICALL3,
  openLongDaily,
  openShort,
  parseDollars,
  placeLimit,
  type Position,
  PUBLIC_RPC,
  redeem,
  sellLong,
  type SeriesLive,
  settle,
  TICK,
  toNumber6,
  type TxSummary,
  U,
  withdrawMargin,
  WriteError,
} from "../src/index.ts";
import { isLoopback, redactUrl, scrubUrls } from "./fork.ts";
import { big } from "./flows.ts";
import { waitIndexed } from "./indexer.ts";

const ROOT = join(import.meta.dir, "..", "..");
export const DEFAULT_DEPLOYMENTS = join(ROOT, "contracts", "deployments", "10143.json");
export const DEFAULT_GRAPHQL = "http://localhost:8080/v1/graphql";
const CHAIN_ID = 10143;

/** A refusal before anything (more) is sent. Its text passes redact(): it never carries a key. */
export class GateError extends Error {
  override name = "GateError";
  constructor(message: string) {
    super(redact(message));
  }
}
/** A refusal because another run of the same key holds its lock: this run leaves that run's --report file alone. */
export class LockHeld extends GateError {
  override name = "LockHeld";
}
/** The run stopped where it was asked to (--stop-after, Ctrl-C): run it again to continue. */
export class StopRequested extends Error {
  override name = "StopRequested";
}

/** Variables a key would sit in; any of them set refuses the run. */
export const KEY_VARS = ["AGATE_E2E_KEY", "AGATE_E2E_PRIVATE_KEY", "AGATE_KEY", "PRIVATE_KEY", "ETH_PRIVATE_KEY", "AGATE_OWNER_KEY", "AGATE_DEPLOYER_KEY", "AGATE_PAYER_KEY", "AGATE_MM_KEY"];
const KEY_ONLY = /^(0x)?[0-9a-fA-F]{64}$/;
/** 64 hex digits in a row anywhere, whatever stands beside them (`0x<key>ff` and `ab<key>` hold one); decimal digits
 *  are hex digits, so a key written in decimal (77 digits) holds one too */
const HEX64 = /[0-9a-fA-F]{64}/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const STEPS = ["drip", "buy", "sell", "short-open", "short-close", "daily", "limit", "claim", "month-end", "settle"] as const;
export type StepName = (typeof STEPS)[number];
const MARKET_GPUS: Gpu[] = ["H100", "H200", "B200"];

/** The journey's sizes. */
export const SIZES = { buy: "200", sell: "10", short: "10", daily: "100", limit: "10" } as const;
/** The client's default slippage allowance (bps): a buy-back may spend the shown cost plus this. */
const SLIP_BPS = 100n;

/** Gas limits per step from the fork's measured table (client/README.md), times 1.7 (Monad's estimates run up to
 *  1.7 x anvil's): what the MON check expects the rest of the journey to need. */
const STEP_GAS: Record<StepName, bigint> = {
  drip: 90_000n,
  buy: 396_000n,
  sell: 402_000n,
  "short-open": 698_000n,
  "short-close": 432_000n,
  daily: 595_000n,
  limit: 561_000n,
  claim: 200_000n,
  "month-end": 607_000n,
  settle: 160_000n,
};
const journeyGas = (from = 0) => (STEPS.slice(from).reduce((a, s) => a + STEP_GAS[s], 0n) * 17n) / 10n;

// ------------------------------------------------------------------ what is shown

/** Transaction hashes this run sent or read from the chain: the only runs of 64 hex digits it shows. */
const shownHashes = new Set<string>();
/** A transaction hash (0x and 64 hex digits) of a receipt, a router flow or a claim: shown in the lines and the table. */
export function knownHash(h: string | null | undefined): void {
  if (h && /^0x[0-9a-fA-F]{64}$/.test(h)) shownHashes.add(h.slice(2).toLowerCase());
}
/** The --rpc URLs of this run (parseTestnetArgs): shown by scheme, host and port only, since a provider's key rides in
 *  the path (an Alchemy key is 32 characters, under the 64-digit rule). */
const hiddenUrls = new Set<string>();
/** Each run of 16 or more hex digits in this run's arguments: a key split across two arguments shows no half. */
const hiddenRuns = new Set<string>();
/** Registers the runs of 16 or more hex digits of `argv` with redact() (a run of 4 or more distinct digits: a row of
 *  zeros in a path never hides an amount). */
function hideArgRuns(argv: readonly string[]): void {
  for (const a of argv) for (const m of a.matchAll(/[0-9a-fA-F]{16,}/g)) if (new Set(m[0].toLowerCase()).size >= 4) hiddenRuns.add(m[0].toLowerCase());
}
/** An argument as a refusal quotes it: a URL by scheme, host and port only. */
function shownArg(a: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(a) ? redactUrl(a) : a;
}
/** Every run of 64 or more hex digits (with or without 0x, whatever stands beside it, a decimal number that long too)
 *  is hidden, unless it is exactly a transaction hash this run sent or read from the chain; so is every run of 16 or
 *  more hex digits of the run's arguments, and the --rpc URLs show only their scheme, host and port.
 *  Applied to every line the testnet mode prints, every refusal and the report file. */
export function redact(s: string): string {
  let t = hiddenUrls.size > 0 ? scrubUrls(s, [...hiddenUrls]) : s;
  // the 64-digit rule first: a run of the arguments hidden inside a longer run must not leave the rest of it shown
  t = t.replace(/[0-9a-fA-F]{64,}/g, (run) => (run.length === 64 && shownHashes.has(run.toLowerCase()) ? run : "[64+ hex digits hidden]"));
  for (const r of hiddenRuns) t = t.replace(new RegExp(r, "gi"), "[hex digits hidden]");
  return t;
}

// ------------------------------------------------------------------ options

export interface TestnetOptions {
  rpc: string;
  allowFork: boolean;
  graphql: string | null;
  deploymentsFile: string;
  indexesFile: string;
  factory: "demo" | "real";
  gpu: Gpu;
  month: string | null;
  maxDollars: bigint;
  minMonWei: bigint;
  keyCmd: string;
  stopAfter: StepName | null;
  timeTravel: boolean;
  report: string | null;
  fromBlock: bigint | null;
  listingWaitMin: number;
  claimWaitMin: number;
}

const BOOL_FLAGS = new Set(["i-mean-testnet", "allow-fork", "no-indexer", "time-travel"]);
const VALUE_FLAGS = new Set(["rpc", "graphql", "deployments", "indexes", "factory", "gpu", "month", "max-dollars", "min-mon", "stop-after", "report", "from-block", "listing-wait-min", "claim-wait-min"]);

export const USAGE = `usage: AGATE_E2E_KEY_CMD='<a command printing the key>' bun run e2e/run.ts testnet --i-mean-testnet
  [--factory demo|real] [--gpu H100|H200|B200] [--month YYYY-MM] [--max-dollars 500] [--min-mon 1]
  [--rpc URL] [--allow-fork] [--time-travel] [--graphql URL | --no-indexer] [--deployments FILE] [--indexes FILE]
  [--stop-after ${STEPS.join("|")}] [--from-block N] [--listing-wait-min 60] [--claim-wait-min 45] [--report FILE]`;

/** The command line and the environment, checked: every refusal here comes before any read or send. */
export function parseTestnetArgs(argv: string[], env: Record<string, string | undefined>): TestnetOptions {
  // a key never travels on the command line (every process can read argv) nor in a variable; no option of this mode
  // takes 64 hex digits, so any argument holding them is refused, before anything else and without being shown
  for (const [i, a] of argv.entries()) if (HEX64.test(a)) throw new GateError(`refused: argument ${i + 1} after "testnet" holds 64 hex digits in a row, what a private key looks like (argv is visible to every process on this machine; the argument is not shown): no option of this mode takes such a value, and the key comes only from AGATE_E2E_KEY_CMD; nothing was read or sent`);
  // shorter runs (half a key) are never shown either: every refusal and line from here on passes redact()
  hideArgRuns(argv);
  for (const n of KEY_VARS) if (env[n]) throw new GateError(`refused: ${n} is set: the testnet mode never takes a key from a variable, only from the command in AGATE_E2E_KEY_CMD (run once, e.g. a Keychain read); unset ${n}; nothing was read or sent`);
  const o: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new GateError(`unknown argument "${shownArg(a)}"\n${USAGE}`);
    const n = a.slice(2);
    if (n === "key" || n === "private-key") throw new GateError("refused: a key is never passed as an option: use AGATE_E2E_KEY_CMD; nothing was read or sent");
    if (BOOL_FLAGS.has(n)) o[n] = true;
    else if (VALUE_FLAGS.has(n)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new GateError(`--${n} needs a value\n${USAGE}`);
      o[n] = v;
    } else throw new GateError(`unknown option --${n}\n${USAGE}`);
  }
  if (o["i-mean-testnet"] !== true) throw new GateError("refused: the testnet mode sends real transactions to Monad testnet with a real key; run it again with --i-mean-testnet once you mean it; nothing was read or sent");
  const allowFork = o["allow-fork"] === true;
  // one URL, or several separated by commas (tried in order: the public RPC allows 15 requests a second per IP, shared
  // with every process on the machine); a fork is one loopback URL
  const rpc = String(o.rpc ?? PUBLIC_RPC);
  const rpcs = rpc.split(",");
  for (const u of rpcs) if (!/^https?:\/\/[^\s,]+$/i.test(u) || !URL.canParse(u)) throw new GateError(`--rpc ${redactUrl(u)} is not an http(s) URL`);
  // a provider's URL carries its key: from here on every line and the report show these by scheme, host and port
  for (const u of rpcs) hiddenUrls.add(u);
  // the loopback test parses each URL as fetch will (any case, a trailing dot, 127.0.0.0/8 in any notation, ::1, 0.0.0.0)
  const loop = rpcs.filter((u) => isLoopback(u));
  if (loop.length > 0 && !allowFork) throw new GateError(`refused: ${redactUrl(loop[0]!)} is a loopback URL, a local fork, not Monad testnet; pass --allow-fork to run against a fork (for testing); nothing was read or sent`);
  if (loop.length > 0 && rpcs.length > 1) throw new GateError("refused: a fork is one loopback URL, never mixed with others in --rpc");
  const timeTravel = o["time-travel"] === true;
  if (timeTravel && !(allowFork && loop.length === 1)) throw new GateError("refused: --time-travel moves a fork's clock and is for a loopback fork with --allow-fork only");
  if (env.AGATE_E2E_FACTORY !== undefined && o.factory === undefined) throw new GateError("refused: AGATE_E2E_FACTORY is set: the testnet mode takes the factory only from --factory (default demo; the production factory needs --factory real); nothing was read or sent");
  const factory = String(o.factory ?? "demo");
  if (factory !== "demo" && factory !== "real") throw new GateError(`--factory is demo or real, not ${factory}`);
  const gpu = String(o.gpu ?? "H100") as Gpu;
  if (!MARKET_GPUS.includes(gpu)) throw new GateError(`--gpu is one of ${MARKET_GPUS.join(", ")} (the GPUs with months), not ${gpu}`);
  const month = o.month === undefined ? null : String(o.month);
  if (month !== null && !MONTH.test(month)) throw new GateError(`--month is YYYY-MM, not ${month}`);
  let maxDollars: bigint;
  try {
    maxDollars = parseDollars(String(o["max-dollars"] ?? "500"), "--max-dollars");
  } catch (e) {
    throw new GateError((e as AmountError).message);
  }
  if (maxDollars === 0n) throw new GateError("--max-dollars must be above 0");
  const minMon = String(o["min-mon"] ?? "1");
  if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(minMon)) throw new GateError(`--min-mon is a plain decimal of MON, not ${minMon}`);
  const keyCmd = (env.AGATE_E2E_KEY_CMD ?? "").trim();
  if (!keyCmd) throw new GateError("refused: AGATE_E2E_KEY_CMD is not set: the key comes only from a command the run executes once, e.g. AGATE_E2E_KEY_CMD='security find-generic-password -s <item> -a private-key -w'; nothing was read or sent");
  if (HEX64.test(keyCmd) && !(allowFork && loop.length === 1)) throw new GateError("refused: AGATE_E2E_KEY_CMD holds a key literally (the variable would hold the key): give a command that reads it, e.g. from the Keychain; a literal key is accepted only against a loopback fork with --allow-fork (an anvil test key); nothing was read or sent");
  const stopAfter = o["stop-after"] === undefined ? null : (String(o["stop-after"]) as StepName);
  if (stopAfter !== null && !STEPS.includes(stopAfter)) throw new GateError(`--stop-after is one of ${STEPS.join(", ")}`);
  const deploymentsFile = String(o.deployments ?? DEFAULT_DEPLOYMENTS);
  const num = (n: string, d: number) => {
    const v = o[n] === undefined ? d : Number(o[n]);
    if (!Number.isFinite(v) || v <= 0) throw new GateError(`--${n} must be a positive number`);
    return v;
  };
  let fromBlock: bigint | null = null;
  if (o["from-block"] !== undefined) {
    if (!/^\d+$/.test(String(o["from-block"]))) throw new GateError("--from-block is a block number");
    fromBlock = BigInt(String(o["from-block"]));
  }
  const noIndexer = o["no-indexer"] === true;
  if (noIndexer && o.graphql !== undefined) throw new GateError("--graphql and --no-indexer contradict each other");
  return {
    rpc,
    allowFork,
    graphql: noIndexer ? null : String(o.graphql ?? env.AGATE_E2E_GRAPHQL ?? env.NEXT_PUBLIC_AGATE_GRAPHQL_URL ?? DEFAULT_GRAPHQL),
    deploymentsFile,
    indexesFile: String(o.indexes ?? deploymentsFile.replace(/\.json$/, "-indexes.json")),
    factory,
    gpu,
    month,
    maxDollars,
    minMonWei: parseEther(minMon),
    keyCmd,
    stopAfter,
    timeTravel,
    report: o.report === undefined ? null : String(o.report),
    fromBlock,
    listingWaitMin: num("listing-wait-min", 60),
    claimWaitMin: num("claim-wait-min", 45),
  };
}

// ------------------------------------------------------------------ the key

/** Runs the key command once (sh -c) and returns what it printed. Nothing it writes is ever shown, on stdout or
 *  stderr: a failure says only its exit code (or the signal that stopped it). */
export function runKeyCommand(cmd: string, env: Record<string, string | undefined>): string {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  let r: ReturnType<typeof Bun.spawnSync>;
  try {
    r = Bun.spawnSync(["/bin/sh", "-c", cmd], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: clean });
  } catch {
    throw new GateError("AGATE_E2E_KEY_CMD could not be started (/bin/sh); nothing was sent");
  }
  if (!r.success) throw new GateError(`AGATE_E2E_KEY_CMD failed (${r.signalCode ? `stopped by ${r.signalCode}` : `exit ${r.exitCode}`}); what it wrote is not shown (run it by hand to see why); nothing was sent`);
  return r.stdout?.toString() ?? "";
}

/** The account of the key the command prints; refused when the output is not one key, or when that key is also the
 *  value of a variable of the environment (a command that only echoes a variable holding the key). */
export function accountFromCommand(cmd: string, env: Record<string, string | undefined>, run: (cmd: string, env: Record<string, string | undefined>) => string = runKeyCommand): PrivateKeyAccount {
  const out = run(cmd, env).trim();
  if (!KEY_ONLY.test(out)) throw new GateError("refused: AGATE_E2E_KEY_CMD did not print exactly one 32-byte hex key (what it printed is not shown); nothing was sent");
  const key = (out.startsWith("0x") || out.startsWith("0X") ? `0x${out.slice(2)}` : `0x${out}`).toLowerCase() as Hex;
  for (const [n, v] of Object.entries(env)) {
    if (!v) continue;
    const t = v.trim().toLowerCase();
    if (t === key || `0x${t}` === key) throw new GateError(`refused: the key AGATE_E2E_KEY_CMD printed is also the value of the variable ${n}: a key never sits in the environment; unset ${n} and read it from the Keychain instead; nothing was sent`);
  }
  try {
    return privateKeyToAccount(key);
  } catch {
    // the curve library's message names the value; this one does not
    throw new GateError("refused: AGATE_E2E_KEY_CMD printed 32 bytes that are not a valid secp256k1 key (what it printed is not shown); nothing was sent");
  }
}

// ------------------------------------------------------------------ one run per key

/** Where the per-key lock files live: one pid file per key address (and per fork). */
export const LOCK_DIR = join(homedir(), ".agate-e2e", "locks");
/** The lock files this process holds: removed when it exits, a second Ctrl-C included. */
const heldLocks = new Set<string>();
let exitHook = false;

function lockHolder(file: string): number | null {
  const j = readJsonMaybe(file) as { pid?: unknown } | null;
  return typeof j?.pid === "number" && Number.isInteger(j.pid) && j.pid > 0 ? j.pid : null;
}
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lock's name: the key's address, and a fork's port (a fork is another chain: its run does not race testnet's). */
export function lockName(user: string, rpc: string, fork: boolean): string {
  if (!fork) return l(user);
  const u = new URL(rpc);
  return `${l(user)}-fork-${u.port || (u.protocol === "https:" ? "443" : "80")}`;
}

const changedHands = (file: string) => `refused: the lock ${file} changed hands while this run took over a stale one (another run of this key started at the same moment); nothing was sent`;
const cannotTake = (file: string, e: unknown) => `refused: the run's lock ${file} cannot be taken (${(e as Error).message}); nothing was sent`;
/** A takeover guard older than this was left by a run that died in the middle of one. */
const TAKEOVER_STALE_MS = 10_000;

/** Takes over the stale lock `file` (its holder `pid` is gone, or null for a garbage file) under a guard, the directory
 *  `<file>.takeover`, which only one process can make: the lock is checked again, removed and linked anew, all under the
 *  guard. Without it two runs that both found the lock stale both removed it, the second removing the first one's new
 *  lock, and both ran (8 runs raced on a stale lock gave 2 winners once in 5 tries). A run that cannot make the guard,
 *  finds the lock changed since it read it, or is beaten to the link, is refused. */
function takeOver(file: string, pid: number | null, tmp: string): void {
  const guard = `${file}.takeover`;
  try {
    mkdirSync(guard);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new GateError(cannotTake(file, e));
    // a guard that outlived its run is removed, so the next run goes ahead; this one is refused either way
    try {
      if (Date.now() - statSync(guard).mtimeMs > TAKEOVER_STALE_MS) rmSync(guard, { recursive: true, force: true });
    } catch {
      // gone meanwhile
    }
    throw new GateError(changedHands(file));
  }
  try {
    // only a guard holder removes a lock, and only the one it read: a lock that appeared meanwhile is never removed
    if (existsSync(file)) {
      if (lockHolder(file) !== pid) throw new GateError(changedHands(file));
      rmSync(file, { force: true });
    }
    try {
      linkSync(tmp, file);
    } catch (e) {
      throw new GateError((e as NodeJS.ErrnoException).code === "EEXIST" ? changedHands(file) : cannotTake(file, e));
    }
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}

/** Takes the lock `name` in `dir` for this process: a pid file that appears whole (linked from a file written first).
 *  A lock whose process is gone is stale and taken over; one whose process lives refuses the run. Returns the release,
 *  which also runs when the process exits. */
export function takeLock(dir: string, name: string): () => void {
  const file = join(dir, `${name}.pid`);
  const tmp = join(dir, `${name}.${process.pid}.${Date.now()}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch (e) {
    throw new GateError(`refused: the run's lock cannot be written in ${dir} (${(e as Error).message}); nothing was sent`);
  }
  try {
    try {
      linkSync(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new GateError(cannotTake(file, e));
      const pid = lockHolder(file);
      // a pid equal to this process's own is a lock this process holds, or one left by a process of the same pid
      // before a restart
      const live = pid !== null && (pid === process.pid ? heldLocks.has(file) : pidAlive(pid));
      if (live) throw new LockHeld(`refused: another run of this key is going (pid ${pid}, lock ${file}): one live run per key, since two runs race through the same steps and could buy twice; wait for it to end or stop it (Ctrl-C); if no such run exists, remove the file; nothing was sent`);
      takeOver(file, pid, tmp);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  heldLocks.add(file);
  if (!exitHook) {
    exitHook = true;
    process.on("exit", () => {
      for (const f of heldLocks) if (lockHolder(f) === process.pid) rmSync(f, { force: true });
    });
  }
  return () => {
    if (!heldLocks.delete(file)) return;
    if (lockHolder(file) === process.pid) rmSync(file, { force: true });
  };
}

// ------------------------------------------------------------------ what the node is

/** How long the probe for a local node waits for each answer. */
export const PROBE_MS = 5_000;

/** Whether the node behind a client is a local one (anvil, hardhat), whatever its URL: one read each of
 *  anvil_nodeInfo and hardhat_metadata, no retry, at most `ms`. Returns the method a node answered, or null; an error
 *  or no answer in time is a node without them (Monad's RPCs answer "method not found"). */
export async function localNodeMethod(pub: PublicClient, ms = PROBE_MS): Promise<string | null> {
  const ask = (method: string) =>
    new Promise<string | null>((done) => {
      const timer = setTimeout(() => done(null), ms);
      pub.request({ method } as never, { retryCount: 0, signal: AbortSignal.timeout(ms) }).then(
        (r) => {
          clearTimeout(timer);
          done(r === null || r === undefined ? null : method);
        },
        () => {
          clearTimeout(timer);
          done(null);
        },
      );
    });
  const [a, h] = await Promise.all([ask("anvil_nodeInfo"), ask("hardhat_metadata")]);
  return a ?? h;
}

// ------------------------------------------------------------------ roles

const ROLE_ABI = parseAbi([
  "function owner() view returns (address)",
  "function writers() view returns (address[2])",
  "function attester() view returns (address)",
  "function guardians() view returns (address[2])",
  "function marketAdmin() view returns (address)",
  "function minter() view returns (address)",
  "function index() view returns (address)",
  "function router() view returns (address)",
  "function dollar() view returns (address)",
  "function clocks() view returns ((uint32 day, uint32 slice, uint32 tPend, uint32 closeGrace, uint32 grace, uint32 holdMove, uint32 holdMin, uint32 step, uint32 reopenWait, uint32 timelock, uint8 slices, uint8 minReadings, uint8 qMin, bool demoLabel, bool signAll, uint64 epochTs, uint32 epochDay, uint64 chainSelector))",
]);

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/;
type Roles = Map<string, string[]>;
function addRole(m: Roles, a: unknown, role: string): void {
  if (typeof a !== "string" || !ADDR.test(a) || ZERO.test(a)) return;
  const k = a.toLowerCase();
  const have = m.get(k) ?? [];
  if (!have.includes(role)) m.set(k, [...have, role]);
}
function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}
function readJsonMaybe(file: string): unknown {
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

/** Every role address the repo names: ops/testnet/lib.sh (the real keys and the public rehearsal keys, the maker and
 *  the payer among them), the index configs' roles and the market config's admin, minter and maker. Fails closed:
 *  a list that cannot be read refuses the run. */
export function staticRoles(root = ROOT): Roles {
  const m: Roles = new Map();
  let lib: string;
  try {
    lib = readFileSync(join(root, "ops", "testnet", "lib.sh"), "utf8");
  } catch {
    throw new GateError("refused: ops/testnet/lib.sh (the role addresses) cannot be read, so the role check cannot run; nothing was sent");
  }
  for (const [fn, tag] of [["role_addr_real", ""], ["role_addr_rehearsal", "rehearsal "]] as const) {
    const at = lib.indexOf(`${fn}() {`);
    if (at < 0) continue;
    const body = lib.slice(at, lib.indexOf("\n}", at));
    for (const r of body.matchAll(/^\s*([a-z][a-z |]*)\)\s*echo\s+(0x[0-9a-fA-F]{40})/gm)) addRole(m, r[2], `${tag}${r[1]!.trim()} (ops/testnet/lib.sh)`);
  }
  if (m.size < 10) throw new GateError("refused: ops/testnet/lib.sh names fewer role addresses than expected, so the role check cannot be trusted; nothing was sent");
  const cfg = join(root, "contracts", "script", "config");
  for (const f of ["testnet-production.json", "testnet-demo.json"]) {
    const j = readJsonMaybe(join(cfg, f)) as { roles?: Record<string, unknown> } | null;
    for (const [r, a] of Object.entries(j?.roles ?? {})) addRole(m, a, `${r} (${f})`);
  }
  const mk = readJsonMaybe(join(cfg, "market-testnet.json")) as { marketAdmin?: unknown; dollar?: { minter?: unknown }; botFloat?: { to?: unknown } } | null;
  addRole(m, mk?.marketAdmin, "market admin (market-testnet.json)");
  addRole(m, mk?.dollar?.minter, "dollar minter (market-testnet.json)");
  addRole(m, mk?.botFloat?.to, "the market maker (market-testnet.json botFloat.to)");
  return m;
}

/** The roles on chain of every factory in the deployments: each index's owner, writers, attester and guardians, each
 *  factory's market admin, the dollar's minter. A read that fails refuses the run (never read as "no role"). */
export async function chainRoles(pub: PublicClient, d: Deployments): Promise<Roles> {
  const m: Roles = new Map();
  const rd = async (address: string, functionName: string): Promise<unknown> => {
    try {
      return await pub.readContract({ address: address as Address, abi: ROLE_ABI, functionName } as never);
    } catch (e) {
      throw new GateError(`refused: the role read ${functionName}() at ${address} failed (${(e as Error).message.split("\n")[0]}), so the role check cannot run; nothing was sent`);
    }
  };
  const indexes = new Set(Object.values(d.factories).map((f) => f.index.toLowerCase()));
  for (const ix of indexes) {
    addRole(m, await rd(ix, "owner"), `index owner (${ix})`);
    const ws = (await rd(ix, "writers")) as readonly string[];
    ws.forEach((a, i) => addRole(m, a, `index writer ${i} (${ix})`));
    addRole(m, await rd(ix, "attester"), `index attester (${ix})`);
    const gs = (await rd(ix, "guardians")) as readonly string[];
    gs.forEach((a, i) => addRole(m, a, `index guardian ${i} (${ix})`));
  }
  for (const [name, f] of Object.entries(d.factories)) addRole(m, await rd(f.factory, "marketAdmin"), `market admin (factory ${name})`);
  addRole(m, await rd(d.dollar, "minter"), "dollar minter");
  return m;
}

// ------------------------------------------------------------------ spend

export interface MarketView {
  month: string;
  symbol: string;
  floor: bigint;
  cap: bigint;
  n: number;
  k: number;
  S: bigint;
  /** best ask and bid, u per GPU-hour (0 for an empty side) */
  ask: bigint;
  bid: bigint;
  /** every day applied: nothing is left to trade, only the final claims and the settle */
  settled?: boolean;
}

/** The limit bid's price: five ticks under the best bid, never under the band's bottom, always under the best ask. */
export function limitPriceOf(v: MarketView): bigint {
  const n = BigInt(v.n);
  const left = n - BigInt(Math.min(v.k, v.n));
  const lo = (((v.S + left * v.floor) / n + TICK - 1n) / TICK) * TICK;
  let p = v.bid - 5n * TICK;
  if (p < lo) p = lo;
  if (p >= v.ask) p = v.ask - TICK;
  return p;
}

const hoursU = (h: string) => BigInt(Math.round(Number(h) * 1e6));
const ceilU = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** The most tUSD each write of the journey may move out of the wallet (its approval: the buy, the short's collateral,
 *  the buy-back's quote plus slippage, the pay-me-daily buy, the limit bid's deposit; a sale, a claim, a cancel, a
 *  withdrawal or a settle moves none out), and their sum. */
export function planSpend(v: MarketView): { items: { step: StepName; max: bigint; what: string }[]; total: bigint } {
  if (v.settled) return { items: [], total: 0n };
  const short = hoursU(SIZES.short);
  const limit = hoursU(SIZES.limit);
  const items: { step: StepName; max: bigint; what: string }[] = [
    { step: "buy", max: parseDollars(SIZES.buy), what: `buy long $${SIZES.buy}` },
    { step: "short-open", max: ceilU(short * v.cap, U), what: `the short's collateral, ${SIZES.short} x $${toNumber6(v.cap)} (the sale comes back in the same transaction)` },
    { step: "short-close", max: buyBackMax(short, v.ask), what: `the buy-back of ${SIZES.short} GPU-hours at the ask $${toNumber6(v.ask)} plus 1%` },
    { step: "daily", max: parseDollars(SIZES.daily), what: `pay me daily $${SIZES.daily}` },
    { step: "limit", max: ceilU(limit * limitPriceOf(v), U), what: `the limit bid's deposit, ${SIZES.limit} x $${toNumber6(limitPriceOf(v))} (withdrawn after the cancel)` },
  ];
  return { items, total: items.reduce((a, x) => a + x.max, 0n) };
}

/** A buy-back's most: q x the shown ask plus the slippage allowance (closeShort's bound with maxPrice). */
export function buyBackMax(q: bigint, ask: bigint): bigint {
  const cost = ceilU(q * ask, U);
  return (cost * (10_000n + SLIP_BPS) + 9_999n) / 10_000n;
}

/** The run's spend cap: a write whose maximum would take the run past --max-dollars is refused before it is sent. */
export class Budget {
  spent = 0n;
  constructor(readonly cap: bigint) {}
  take(step: string, max: bigint): void {
    if (this.spent + max > this.cap) throw new GateError(`refused: ${step} may move up to $${toNumber6(max)} out of the wallet and this run has used $${toNumber6(this.spent)} of its --max-dollars $${toNumber6(this.cap)}; nothing was sent for this step (raise --max-dollars and run again to continue)`);
    this.spent += max;
  }
}

// ------------------------------------------------------------------ the ledger (step table)

export interface Row {
  step: string;
  label: string;
  hash: string;
  gasLimit: bigint;
  gasUsed: bigint;
  gasPrice: bigint;
  /** wei: the gas limit at the transaction's gas price (Monad bills the limit) */
  mon: bigint;
}
export interface Check {
  step: string;
  name: string;
  ok: boolean;
  detail?: unknown;
}

const fmtMon = (wei: bigint, dp = 4) => Number(formatEther(wei)).toFixed(dp);
const fmtUsd = (u: bigint) => toNumber6(u).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const l = (a: string) => a.toLowerCase();

export class Ledger {
  rows: Row[] = [];
  checks: Check[] = [];
  notes: string[] = [];
  constructor(
    readonly log: (s: string) => void,
    readonly pub: PublicClient | null,
  ) {}
  async txs(step: string, txs: TxSummary[]): Promise<void> {
    for (const t of txs) {
      knownHash(t.hash);
      if (this.rows.some((r) => r.hash === t.hash)) continue;
      let price = 0n;
      try {
        price = this.pub ? ((await this.pub.getTransactionReceipt({ hash: t.hash })).effectiveGasPrice ?? 0n) : 0n;
      } catch {
        price = 0n;
      }
      const row = { step, label: t.label, hash: t.hash, gasLimit: t.gasLimit, gasUsed: t.gasUsed, gasPrice: price, mon: t.gasLimit * price };
      this.rows.push(row);
      this.log(`  sent ${t.label}: ${t.hash} (gas limit ${t.gasLimit.toLocaleString("en-US")}, used ${t.gasUsed.toLocaleString("en-US")}, ${fmtMon(row.mon)} MON)`);
    }
  }
  check(step: string, name: string, ok: boolean, detail?: unknown): void {
    this.checks.push({ step, name, ok, detail });
    this.log(`  ${ok ? "pass" : "FAIL"}  ${name}${detail !== undefined && !ok ? `  ${big(detail)}` : ""}`);
  }
  note(step: string, text: string): void {
    this.notes.push(`${step}: ${text}`);
    this.log(`  note  ${text}`);
  }
  failed(): Check[] {
    return this.checks.filter((c) => !c.ok);
  }
  table(): string {
    const steps = [...new Set([...this.checks.map((c) => c.step), ...this.rows.map((r) => r.step)])];
    const lines = ["| step | transaction | tx hash | gas limit | gas used | gwei | MON (limit x price) | checks passed |", "|---|---|---|---|---|---|---|---|"];
    for (const s of steps) {
      const cs = this.checks.filter((c) => c.step === s);
      const passed = `${cs.filter((c) => c.ok).length} of ${cs.length}`;
      const rs = this.rows.filter((r) => r.step === s);
      if (rs.length === 0) lines.push(`| ${s} | (reads only) | | | | | | ${passed} |`);
      rs.forEach((r, i) => lines.push(`| ${i === 0 ? s : ""} | ${r.label} | ${r.hash} | ${r.gasLimit.toLocaleString("en-US")} | ${r.gasUsed.toLocaleString("en-US")} | ${(Number(r.gasPrice) / 1e9).toFixed(1)} | ${fmtMon(r.mon)} | ${i === 0 ? passed : ""} |`));
    }
    const lim = this.rows.reduce((a, r) => a + r.gasLimit, 0n);
    const used = this.rows.reduce((a, r) => a + r.gasUsed, 0n);
    const mon = this.rows.reduce((a, r) => a + r.mon, 0n);
    lines.push(`| total | ${this.rows.length} transactions | | ${lim.toLocaleString("en-US")} | ${used.toLocaleString("en-US")} | | ${fmtMon(mon)} | ${this.checks.filter((c) => c.ok).length} of ${this.checks.length} |`);
    return lines.join("\n");
  }
}

// ------------------------------------------------------------------ preflight

interface IndexRecords {
  production?: { index?: string };
  demo?: { index?: string; session?: string; deployBlock?: number; epochTs?: number };
}

export interface Preflight {
  c: AgateClient;
  pub: PublicClient;
  transport: Transport;
  account: PrivateKeyAccount;
  user: Address;
  deployments: Deployments;
  f: FactoryRecord;
  fork: boolean;
  gql: string | null;
  month: string;
  view: MarketView;
  plan: ReturnType<typeof planSpend>;
  gasPrice: bigint;
  mon0: bigint;
  usd0: bigint;
  /** releases this key's lock (the run calls it when it ends; it also goes when the process exits) */
  release: () => void;
}

/** What the default market view needs to pick the month (pickMonth). */
export interface MarketViewArgs {
  c: AgateClient;
  pub: PublicClient;
  user: Address;
  gpu: Gpu;
  month: string | null;
  o: TestnetOptions;
  /** the factory's address and whether the RPC is a fork: a previous run's report counts only when both match */
  factory: Address;
  fork: boolean;
  /** where a chain log scan starts without an indexer */
  startBlock: bigint;
  log: (s: string) => void;
}

export interface Deps {
  /** the RPC transport of a URL (tests: a fake that records every send) */
  transport?: (url: string) => Transport;
  /** runs AGATE_E2E_KEY_CMD (tests: a fake) */
  runKeyCommand?: (cmd: string, env: Record<string, string | undefined>) => string;
  /** the month's band and book once it is listed (default: waits for the listing and the maker's book) */
  marketView?: (p: MarketViewArgs) => Promise<MarketView>;
  /** the static role list (default: staticRoles()) */
  staticRoles?: () => Roles;
  /** where the per-key lock files go (default LOCK_DIR) */
  lockDir?: string;
  /** how long the local-node probe waits per answer (default PROBE_MS) */
  probeMs?: number;
  log?: (s: string) => void;
}

/** The deployments' entry for the chosen factory, checked: the demo entry shares no address with another factory and
 *  is not the production index, and its session is active. */
export function factoryFileGate(o: Pick<TestnetOptions, "factory" | "indexesFile" | "deploymentsFile">, d: Deployments, records: IndexRecords | null): FactoryRecord {
  if (d.chainId !== CHAIN_ID) throw new GateError(`refused: ${o.deploymentsFile} is for chain ${d.chainId}, not ${CHAIN_ID}`);
  const f = d.factories[o.factory];
  if (!f) throw new GateError(`refused: ${o.deploymentsFile} has no "${o.factory}" factory${o.factory === "demo" ? " (no demo session has been deployed: ops/testnet/demo-session.sh start)" : ""}; nothing was sent`);
  if (o.factory === "demo") {
    const mine = [f.factory, f.index, f.router].map(l);
    for (const [n, g] of Object.entries(d.factories)) {
      if (n === "demo") continue;
      const hit = [g.factory, g.index, g.router].find((x) => mine.includes(l(x)));
      if (hit) throw new GateError(`refused: the demo entry of ${o.deploymentsFile} shares ${hit} with the "${n}" factory: it would trade the production market; the production factory runs only with --factory real; nothing was sent`);
    }
    if (records?.production?.index && l(records.production.index) === l(f.index)) throw new GateError(`refused: the demo entry's index ${f.index} is the production index (${o.indexesFile}): the production factory runs only with --factory real; nothing was sent`);
    const demo = records?.demo;
    if (!demo?.index || l(demo.index) !== l(f.index)) throw new GateError(`refused: ${o.indexesFile} records no demo session for the index ${f.index}; nothing was sent`);
    if (demo.session !== "active") throw new GateError(`refused: the demo session of index ${f.index} is ${demo.session ? `"${demo.session}"` : "not marked active"} in ${o.indexesFile}: no writer posts its days, so no day would turn final; start a session (ops/testnet/demo-session.sh start) and run again; nothing was sent`);
  }
  return f;
}

function chainFor(rpc: string) {
  return defineChain({ id: CHAIN_ID, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } }, contracts: { multicall3: { address: MULTICALL3 } } });
}

/** Every gate before the first send, then the month's band and book. Returns what the journey needs; sends nothing. */
export async function preflight(o: TestnetOptions, env: Record<string, string | undefined>, deps: Deps, log: (s: string) => void): Promise<Preflight> {
  let deployments: Deployments;
  try {
    deployments = readJson(o.deploymentsFile) as Deployments;
  } catch (e) {
    throw new GateError(`refused: ${o.deploymentsFile} cannot be read (${(e as Error).message})`);
  }
  const records = readJsonMaybe(o.indexesFile) as IndexRecords | null;
  const f = factoryFileGate(o, deployments, records);
  const one = (u: string) => http(u, { timeout: 30_000, retryCount: 3, retryDelay: 1_000 });
  const urls = o.rpc.split(",");
  const transport = (deps.transport ?? ((u: string) => (urls.length > 1 ? fallback(urls.map(one)) : one(u))))(o.rpc);
  const pub = createPublicClient({ chain: chainFor(urls[0]!), transport }) as PublicClient;
  const fork = urls.length === 1 && isLoopback(o.rpc);
  // each URL answers Monad testnet's chain id; and, but for a loopback fork with --allow-fork, none is a local node
  // (anvil, hardhat) reached by a name or an address the URL gate does not read as this machine
  for (const u of urls) {
    const q = urls.length === 1 ? pub : (createPublicClient({ chain: chainFor(u), transport: (deps.transport ?? one)(u) }) as PublicClient);
    const id = await q.getChainId();
    if (id !== CHAIN_ID) throw new GateError(`refused: ${redactUrl(u)} answers chain ${id}, not ${CHAIN_ID}; nothing was sent`);
    if (fork) continue;
    const m = await localNodeMethod(q, deps.probeMs);
    if (m) throw new GateError(`refused: ${redactUrl(u)} answers ${m}, a local node's method (anvil or hardhat, a fork), so it is not Monad testnet whatever its URL says; a fork runs only by its loopback URL with --allow-fork; nothing was sent`);
  }
  if (fork) {
    const info = (await pub.request({ method: "anvil_nodeInfo" as never }).catch(() => null)) as { forkConfig?: { forkBlockNumber?: number } } | null;
    if (!info?.forkConfig?.forkBlockNumber) throw new GateError(`refused: ${redactUrl(o.rpc)} is a loopback URL but not an anvil fork of Monad testnet`);
  }
  log(`${fork ? `FORK at ${redactUrl(o.rpc)} (a local anvil fork; --allow-fork)` : `MONAD TESTNET through ${redactUrl(o.rpc)}`}; factory ${o.factory} ${f.factory} (index ${f.index}, router ${f.router}); deployments ${o.deploymentsFile}`);

  // the key: one run of the command; its output is never printed or written
  const account = accountFromCommand(o.keyCmd, env, deps.runKeyCommand ?? runKeyCommand);
  const user = account.address;
  // one live run per key: two would race through the same steps (both read "not bought yet", both buy)
  const release = takeLock(deps.lockDir ?? LOCK_DIR, lockName(user, o.rpc, fork));
  try {
    const c = createAgateClient({ deployments, factory: o.factory, rpcUrl: urls[0]!, graphqlUrl: o.graphql, publicClient: pub });
    const [mon0, usd0] = await Promise.all([pub.getBalance({ address: user }), pub.readContract({ address: deployments.dollar as Address, abi: abi.agateDollarAbi as Abi, functionName: "balanceOf", args: [user] }) as Promise<bigint>]);
    log(`user ${user}: ${fmtMon(mon0)} MON, ${fmtUsd(usd0)} tUSD`);

    // no transaction of this key still in flight (a run that stopped mid-send; a run of this key elsewhere)
    const [landed, pending] = await Promise.all([pub.getTransactionCount({ address: user }).catch(() => null), pub.getTransactionCount({ address: user, blockTag: "pending" }).catch(() => null)]);
    if (landed === null) throw new GateError(`refused: the nonce of ${user} cannot be read, so a transaction still in flight cannot be ruled out; nothing was sent`);
    if (pending === null) log(`the RPC does not answer ${user}'s pending nonce: only the lock rules out another run of this key`);
    else if (pending > landed) throw new GateError(`refused: ${user} has ${pending - landed} transaction${pending - landed === 1 ? "" : "s"} still pending (nonce ${landed} landed, ${pending} with the pending ones): a run that stopped mid-send, or a run of this key elsewhere; wait until it lands, then run again (the run continues from the chain); nothing was sent`);

    // no role of the index or the market
    const roles = new Map([...(deps.staticRoles ?? (() => staticRoles()))()]);
    for (const [a, rs] of await chainRoles(pub, deployments)) for (const r of rs) addRole(roles, a, r);
    const mine = roles.get(l(user));
    if (mine) throw new GateError(`refused: ${user} holds a role: ${mine.join("; ")}. The live check runs as a plain user only; use a fresh test key; nothing was sent`);
    log(`role check: ${user} holds none of the ${roles.size} role addresses (lib.sh, the deploy configs, and on chain: each index's owner, writers, attester and guardians, the market admins, the dollar's minter)`);

    // the factory on chain is the one the file names, and a demo factory runs on a demo clock
    const [fIndex, fRouter, fDollar] = (await Promise.all(["index", "router", "dollar"].map((fn) => pub.readContract({ address: f.factory as Address, abi: ROLE_ABI, functionName: fn } as never)))) as string[];
    if (l(fIndex!) !== l(f.index) || l(fRouter!) !== l(f.router) || l(fDollar!) !== l(deployments.dollar)) throw new GateError(`refused: the factory ${f.factory} on chain names index ${fIndex}, router ${fRouter}, dollar ${fDollar}, not the deployments' ${f.index}, ${f.router}, ${deployments.dollar}; nothing was sent`);
    const ck = (await pub.readContract({ address: f.index as Address, abi: ROLE_ABI, functionName: "clocks" })) as { day: number };
    if (o.factory === "demo" && Number(ck.day) >= 86_400) throw new GateError(`refused: the demo factory's index ${f.index} runs a day of ${ck.day} s (the production clock): this is not a demo session's index; the production factory runs only with --factory real; nothing was sent`);

    // the indexer: answers, and indexes this deploy (the factory's index from its deploy; the factory's own row appears
    // with its first listing)
    if (o.graphql) {
      const ok = await c.gql!.query<{ PriceIndex: { id: string }[]; chain_metadata: { latest_processed_block: number | null }[] }>(`query($i: String!) { PriceIndex(where: {id: {_eq: $i}}) { id } chain_metadata { latest_processed_block } }`, { i: l(f.index) }).catch((e: Error) => e);
      if (ok instanceof Error) throw new GateError(`refused: the indexer at ${o.graphql} does not answer (${ok.message}): start it, or pass --no-indexer for chain-only checks (a resume then scans the chain's logs)`);
      if (ok.PriceIndex.length === 0) throw new GateError(`refused: the indexer at ${o.graphql} does not index the index ${f.index} of the ${o.factory} factory (a config of another deploy, or still catching up to its deploy block): restart it on ${o.deploymentsFile}, or pass --no-indexer`);
      const head = await pub.getBlockNumber();
      const at = BigInt(ok.chain_metadata[0]?.latest_processed_block ?? 0);
      log(`indexer ${o.graphql}: answers and indexes the index; processed block ${at} of ${head}${head > at + 600n ? " (far behind: the indexer checks wait for it, up to 10 minutes each)" : ""}`);
    } else log("no indexer (--no-indexer): chain-only checks; a resume scans the chain's logs from the factory's start block");

    // MON: the floor plus what the journey's gas needs at the chain's price
    const gasPrice = await pub.getGasPrice();
    const need = journeyGas() * gasPrice;
    log(`gas price ${(Number(gasPrice) / 1e9).toFixed(1)} gwei: the whole journey needs up to ${fmtMon(need)} MON (the fork's gas x 1.7), the floor is ${fmtMon(o.minMonWei)} MON`);
    if (mon0 < o.minMonWei) throw new GateError(`refused: ${fmtMon(mon0)} MON is under the floor --min-mon ${fmtMon(o.minMonWei)}; nothing was sent`);
    if (mon0 < o.minMonWei + need) log(`WARNING: ${fmtMon(mon0)} MON may not carry the whole journey above the floor (${fmtMon(o.minMonWei + need)}): the run stops at the floor and resumes after a top-up`);

    // the month, listed, with the maker's book; then the spend plan against the cap
    const view = await (deps.marketView ?? liveMarketView)({ c, pub, user, gpu: o.gpu, month: o.month, o, factory: f.factory as Address, fork, startBlock: o.fromBlock ?? BigInt(f.startBlock), log });
    const plan = planSpend(view);
    log(`spend plan on ${view.symbol} (${o.gpu} ${view.month}), the most each write may move out of the wallet:`);
    for (const x of plan.items) log(`  ${x.step.padEnd(12)} $${fmtUsd(x.max).padStart(10)}  ${x.what}`);
    log(`  total        $${fmtUsd(plan.total).padStart(10)}  (cap --max-dollars $${fmtUsd(o.maxDollars)})`);
    if (plan.total > o.maxDollars) throw new GateError(`refused: the journey may move up to $${fmtUsd(plan.total)} out of the wallet, over --max-dollars $${fmtUsd(o.maxDollars)}; nothing was sent`);
    return { c, pub, transport, account, user, deployments, f, fork, gql: o.graphql, month: view.month, view, plan, gasPrice, mon0, usd0, release };
  } catch (e) {
    release();
    throw e;
  }
}

// ------------------------------------------------------------------ the month

/** The month of a previous run's report (the --report file, when it exists): its month when it is a testnet-mode
 *  report of this user, factory and GPU, on a fork or not as this run is; else null (no file, another key, unreadable). */
export function monthFromReport(file: string | null, w: { user: string; factory: string; gpu: Gpu; fork: boolean }): string | null {
  if (!file) return null;
  const j = readJsonMaybe(file) as { mode?: unknown; user?: unknown; factoryAddress?: unknown; gpu?: unknown; fork?: unknown; month?: unknown } | null;
  if (!j || j.mode !== "testnet" || typeof j.month !== "string" || !MONTH.test(j.month)) return null;
  if (typeof j.user !== "string" || l(j.user) !== l(w.user) || typeof j.factoryAddress !== "string" || l(j.factoryAddress) !== l(w.factory)) return null;
  return j.gpu === w.gpu && j.fork === w.fork ? j.month : null;
}

/** The months of `gpu` on this factory in which the user has a router flow, newest first (a journey begun there,
 *  finished or not): the indexer's RouterFlow rows up to its newest block, the chain's Routed logs of the user above
 *  it (from `startBlock` without an indexer). */
export async function journeyMonths(c: Pick<AgateClient, "gql" | "router" | "getSeries">, pub: PublicClient, user: Address, gpu: Gpu, startBlock: bigint, log?: (s: string) => void): Promise<string[]> {
  const monthOf = new Map((await c.getSeries(gpu)).filter((s) => !ZERO.test(s.address)).map((s) => [l(s.address), s.month]));
  const seen = new Set<string>();
  let from = startBlock;
  if (c.gql) {
    const r = await c.gql.query<{ RouterFlow: { series_id: string }[]; chain_metadata: { latest_processed_block: number | null }[] }>(`query($a: String!) { RouterFlow(where: {user_id: {_eq: $a}}, order_by: [{block: desc}], limit: 1000) { series_id } chain_metadata { latest_processed_block } }`, { a: l(user) });
    for (const x of r.RouterFlow) seen.add(l(x.series_id));
    const ib = BigInt(r.chain_metadata[0]?.latest_processed_block ?? 0) + 1n;
    if (ib > from) from = ib;
  }
  const head = await pub.getBlockNumber();
  for (const g of await scanLogs(pub, { address: c.router, event: ROUTED, args: { user } }, from, head, log)) seen.add(l(String(g.args.series)));
  return [...new Set([...seen].map((a) => monthOf.get(a)).filter((m): m is string => !!m))].sort().reverse();
}

/** The month this run trades, and why: --month; else the newest of the months of the GPU where the wallet holds
 *  something (a run to resume) and the months this key already has a journey in on this factory (finished or not:
 *  from the --report file of a previous run, or the chain's history), so a rerun after a finished journey finds it
 *  done and sends nothing; else, for a key with no journey here yet, the factory's current month. A new month for a
 *  key that has one needs --month. */
export function chooseMonth(m: { given: string | null; held: string[]; journeyed: string[]; current: string }): { month: string; why: string } {
  if (m.given) return { month: m.given, why: "--month" };
  const mine = [...new Set([...m.held, ...m.journeyed])].sort().reverse();
  if (mine[0]) return { month: mine[0], why: "the newest month this key holds something in or has a journey in on this factory (finished or not: a run continues it; another month needs --month)" };
  return { month: m.current, why: "the factory's current month (this key has no journey on this factory yet)" };
}

/** chooseMonth's inputs, read: the wallet's positions, the --report file, the router's flows of this key. */
export async function pickMonth(p: MarketViewArgs): Promise<{ month: string; why: string }> {
  if (p.month) return chooseMonth({ given: p.month, held: [], journeyed: [], current: p.month });
  const w = await p.c.getWallet(p.user);
  const held = w.positions.filter((x) => x.gpu === p.gpu).map((x) => x.month);
  const fromReport = monthFromReport(p.o.report, { user: p.user, factory: p.factory, gpu: p.gpu, fork: p.fork });
  const journeyed = [...(fromReport ? [fromReport] : []), ...(await journeyMonths(p.c, p.pub, p.user, p.gpu, p.startBlock, p.log))];
  const current = held.length > 0 || journeyed.length > 0 ? "" : monthLabel(await p.c.currentMonth());
  return chooseMonth({ given: null, held, journeyed, current });
}

/** Waits until the month is listed with a Kuru market and the maker quotes both sides; a line every 2 minutes. */
async function liveMarketView(p: MarketViewArgs): Promise<MarketView> {
  const { month, why } = await pickMonth(p);
  p.log(`month ${p.gpu} ${month}: ${why}`);
  const t0 = Date.now();
  let said = 0;
  for (;;) {
    checkStop();
    const s = await p.c.listedAt(p.gpu, month);
    // a settled month (a run that resumes after the month's end) needs no book: only claims and the settle are left
    if (s && s.k >= s.terms.n) return { month, symbol: s.terms.symbol, floor: s.terms.floor, cap: s.terms.cap, n: s.terms.n, k: s.k, S: s.S, ask: s.book?.asks[0]?.[0] ?? 0n, bid: s.book?.bids[0]?.[0] ?? 0n, settled: true };
    if (s?.market && s.book && s.book.asks.length > 0 && s.book.bids.length > 0) {
      if (Date.now() - t0 > 5_000) p.log(`  ${s.terms.symbol} is listed and quoted after ${Math.round((Date.now() - t0) / 1000)} s`);
      return { month, symbol: s.terms.symbol, floor: s.terms.floor, cap: s.terms.cap, n: s.terms.n, k: s.k, S: s.S, ask: s.book.asks[0]![0], bid: s.book.bids[0]![0] };
    }
    if (Date.now() - t0 > p.o.listingWaitMin * 60_000) throw new GateError(`refused: ${p.gpu} ${month} is not listed and quoted after ${p.o.listingWaitMin} minutes (--listing-wait-min); nothing was sent`);
    if (Date.now() - said >= 120_000) {
      const why = !s ? "not listed yet" : !s.market ? "listed, no Kuru market yet" : "listed, the maker's book is not on both sides yet";
      let when = "";
      if (!s) {
        const up = (await p.c.getSeries(p.gpu).catch(() => [])).find((x) => x.month === month);
        if (up?.opensOn) when = ` (expected to list from ${up.opensOn})`;
      }
      p.log(`  waiting for ${p.gpu} ${month} on the ${p.o.factory} factory: ${why}${when}`);
      said = Date.now();
    }
    await sleep(15_000);
  }
}

// ------------------------------------------------------------------ stop requests

let stopFlag: string | null = null;
export function requestStop(why: string): void {
  stopFlag = why;
}
function checkStop(): void {
  if (stopFlag) throw new StopRequested(stopFlag);
}
async function sleep(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    checkStop();
    await Bun.sleep(Math.min(1_000, end - Date.now()));
  }
}

// ------------------------------------------------------------------ what the chain says is done

const FLOW = ["OPEN_LONG", "OPEN_LONG_DAILY", "OPEN_SHORT", "CLOSE_LONG", "CLOSE_SHORT", "CLOSE_LONG_DAILY"] as const;
type FlowName = (typeof FLOW)[number];
interface FlowRec {
  flow: FlowName;
  txHash: Hex;
  block: bigint;
  positionIds: bigint[];
}
const ROUTED = (abi.agateRouterAbi as readonly { type: string; name?: string }[]).find((x) => x.type === "event" && x.name === "Routed") as AbiEvent;
const ORDER_CREATED = (abi.kuruOrderBookAbi as readonly { type: string; name?: string }[]).find((x) => x.type === "event" && x.name === "OrderCreated") as AbiEvent;
const CLAIMED = (abi.agateSeriesAbi as readonly { type: string; name?: string }[]).find((x) => x.type === "event" && x.name === "Claimed") as AbiEvent;

/** eth_getLogs in 100-block ranges (the public RPC's limit), retried on a transport error. */
async function scanLogs(pub: PublicClient, q: { address: Address; event: AbiEvent; args?: Record<string, unknown> }, from: bigint, to: bigint, log?: (s: string) => void): Promise<{ args: Record<string, unknown>; transactionHash: Hex; blockNumber: bigint }[]> {
  const out: { args: Record<string, unknown>; transactionHash: Hex; blockNumber: bigint }[] = [];
  const total = to >= from ? Number(to - from + 1n) : 0;
  let said = Date.now();
  for (let b = from; b <= to; b += 100n) {
    const e = b + 99n > to ? to : b + 99n;
    for (let attempt = 0; ; attempt++) {
      try {
        const r = (await pub.getLogs({ address: q.address, event: q.event, args: q.args, fromBlock: b, toBlock: e } as never)) as unknown as { args: Record<string, unknown>; transactionHash: Hex; blockNumber: bigint }[];
        out.push(...r);
        break;
      } catch (err) {
        if (attempt >= 5) throw err;
        await Bun.sleep(1_000 * (attempt + 1));
      }
    }
    if (log && Date.now() - said > 30_000) {
      log(`  scanning the chain's logs: block ${e} of ${to} (${Math.round((Number(e - from) / Math.max(1, total)) * 100)}%)`);
      said = Date.now();
    }
  }
  return out;
}

/** The newest block the indexer has processed, or null without one. */
async function indexerBlock(c: AgateClient): Promise<bigint | null> {
  if (!c.gql) return null;
  const r = await c.gql.query<{ chain_metadata: { latest_processed_block: number | null }[] }>("{ chain_metadata { latest_processed_block } }").catch(() => null);
  const b = r?.chain_metadata[0]?.latest_processed_block;
  return b === null || b === undefined ? null : BigInt(b);
}

interface Ctx {
  o: TestnetOptions;
  p: Preflight;
  c: AgateClient;
  pub: PublicClient;
  w: WalletClient;
  user: Address;
  gpu: Gpu;
  month: string;
  L: Ledger;
  budget: Budget;
  log: (s: string) => void;
  /** where a chain log scan starts when no indexer covers it: --from-block, else the factory's start block */
  startBlock: bigint;
  /** poll faster on a fork (one-second blocks) */
  fastPoll: boolean;
}

/** The router's flows of this user on this series: the indexer's rows up to its newest block, the chain's Routed logs
 *  (indexed by user and series) above it, or from the factory's start block without an indexer. */
async function flowsOf(x: Ctx, series: Address): Promise<FlowRec[]> {
  const rows: FlowRec[] = [];
  let from = x.startBlock;
  if (x.c.gql) {
    const r = await x.c.gql.query<{ RouterFlow: { flow: string; txHash: string | null; block: string; positionIds: string[] }[]; chain_metadata: { latest_processed_block: number | null }[] }>(
      `query($a: String!, $s: String!) { RouterFlow(where: {user_id: {_eq: $a}, series_id: {_eq: $s}}, order_by: [{block: asc}, {id: asc}], limit: 1000) { flow txHash block positionIds } chain_metadata { latest_processed_block } }`,
      { a: l(x.user), s: l(series) },
    );
    for (const f of r.RouterFlow) if (f.txHash) rows.push({ flow: f.flow as FlowName, txHash: f.txHash as Hex, block: BigInt(f.block), positionIds: f.positionIds.map((i) => BigInt(i)) });
    from = BigInt(r.chain_metadata[0]?.latest_processed_block ?? 0) + 1n;
  }
  const head = await x.pub.getBlockNumber();
  const logs = await scanLogs(x.pub, { address: x.c.router, event: ROUTED, args: { user: x.user, series } }, from, head, x.log);
  for (const g of logs) {
    if (rows.some((r) => l(r.txHash) === l(g.transactionHash))) continue;
    rows.push({ flow: FLOW[Number(g.args.flow)]!, txHash: g.transactionHash, block: g.blockNumber, positionIds: ((g.args.positionIds as bigint[]) ?? []).map((i) => BigInt(i)) });
  }
  for (const r of rows) knownHash(r.txHash);
  return rows;
}

/** The Kuru order ids this user created on the market: the indexer's BookOrder rows, the chain's OrderCreated logs
 *  above its newest block. */
async function ordersOf(x: Ctx, market: Address): Promise<bigint[]> {
  const ids: bigint[] = [];
  let from = x.startBlock;
  if (x.c.gql) {
    const r = await x.c.gql.query<{ BookOrder: { orderId: string }[]; chain_metadata: { latest_processed_block: number | null }[] }>(
      `query($a: String!, $m: String!) { BookOrder(where: {owner: {_eq: $a}, market_id: {_eq: $m}}, limit: 1000) { orderId } chain_metadata { latest_processed_block } }`,
      { a: l(x.user), m: l(market) },
    );
    for (const o of r.BookOrder) ids.push(BigInt(o.orderId));
    from = BigInt(r.chain_metadata[0]?.latest_processed_block ?? 0) + 1n;
  }
  const head = await x.pub.getBlockNumber();
  for (const g of await scanLogs(x.pub, { address: market, event: ORDER_CREATED }, from, head, x.log)) {
    if (l(String(g.args.owner)) === l(x.user) && !ids.includes(BigInt(g.args.orderId as bigint))) ids.push(BigInt(g.args.orderId as bigint));
  }
  return ids;
}

interface Progress {
  s: SeriesLive & { market: Address };
  flows: FlowRec[];
  orders: bigint[];
  tokens: Position | undefined;
  shortBal: Position | undefined;
  shorts: Position[];
  dailies: Position[];
  resting: { id: string }[];
  marginUsd: number;
  canDrip: boolean;
  usd: number;
}

async function readProgress(x: Ctx): Promise<Progress> {
  const s = (await x.c.seriesAt(x.gpu, x.month)) as SeriesLive & { market: Address };
  if (!s.market) throw new Error(`${x.gpu} ${x.month} has no Kuru market`);
  const sid = l(s.terms.series);
  const [w, oo, flows, orders] = await Promise.all([x.c.getWallet(x.user), x.c.openOrders(x.user), flowsOf(x, s.terms.series), ordersOf(x, s.market)]);
  const mine = w.positions.filter((p) => p.series === sid);
  return {
    s,
    flows,
    orders,
    tokens: mine.find((p) => p.kind === "tokens"),
    shortBal: mine.find((p) => p.kind === "shortBalance"),
    shorts: mine.filter((p) => p.kind === "position" && p.side === "short"),
    dailies: mine.filter((p) => p.kind === "position" && p.side === "long"),
    resting: oo.filter((r) => l(r.market) === l(s.market)),
    marginUsd: w.marginBalance,
    canDrip: w.canDrip,
    usd: w.balance,
  };
}

const has = (pr: Progress, f: FlowName) => pr.flows.some((x) => x.flow === f);

// ------------------------------------------------------------------ exact payout math (AgateSeries)

const owedLong = (q: bigint, n: bigint, k: bigint, S: bigint, F: bigint) => (q * (S + (n - k) * F)) / (n * U);
const owedShort = (q: bigint, n: bigint, k: bigint, S: bigint, C: bigint) => (q * (k * C - S)) / (n * U);

/** The series' stored (k, S) at a block (state(): what the last sync applied). */
async function stateAt(x: Ctx, series: Address, block: bigint): Promise<{ k: bigint; S: bigint }> {
  const st = (await x.pub.readContract({ address: series, abi: abi.agateSeriesAbi as Abi, functionName: "state", blockNumber: block })) as readonly unknown[];
  return { k: BigInt(st[0] as number), S: BigInt(st[1] as bigint) };
}
/** (k, S) as they stood when an event saying `k` was emitted in `block`: the stored state at the block, or the block
 *  before when the transaction did not sync. */
async function kSAt(x: Ctx, series: Address, block: bigint, k: bigint): Promise<{ k: bigint; S: bigint } | null> {
  for (const b of [block, block - 1n]) {
    const st = await stateAt(x, series, b).catch(() => null);
    if (st && st.k === k) return st;
  }
  return null;
}
async function positionAt(x: Ctx, series: Address, id: bigint, block?: bigint): Promise<{ owner: string; q: bigint; paid: bigint; side: number; daily: boolean }> {
  const p = (await x.pub.readContract({ address: series, abi: abi.agateSeriesAbi as Abi, functionName: "position", args: [id], ...(block !== undefined ? { blockNumber: block } : {}) })) as { owner: string; q: bigint; paid: bigint; side: number; daily: boolean };
  return { owner: p.owner, q: BigInt(p.q), paid: BigInt(p.paid), side: Number(p.side), daily: p.daily };
}

/** The PositionOpened events of a landed transaction: id, q, paidNow, k. */
async function openedIn(x: Ctx, hash: Hex): Promise<{ id: bigint; q: bigint; paidNow: bigint; k: bigint; side: number }[]> {
  const rc = await x.pub.getTransactionReceipt({ hash });
  const { decodeLogs } = await import("../src/writes.ts");
  return decodeLogs(rc.logs as never)
    .filter((e) => e.name === "PositionOpened")
    .map((e) => ({ id: BigInt(e.args.id as bigint), q: BigInt(e.args.q as bigint), paidNow: BigInt(e.args.paidNow as bigint), k: BigInt(e.args.k as number), side: Number(e.args.side) }));
}

/** The Claimed events of positions (ids) of a series since a block: the indexer's Claim rows, the chain's logs above
 *  its newest block. */
async function claimsOf(x: Ctx, series: Address, ids: bigint[], since: bigint): Promise<{ id: bigint; amount: bigint; paidTotal: bigint; k: bigint; txHash: Hex; block: bigint; by: string | null }[]> {
  const out: { id: bigint; amount: bigint; paidTotal: bigint; k: bigint; txHash: Hex; block: bigint; by: string | null }[] = [];
  let from = since;
  if (x.c.gql) {
    const r = await x.c.gql.query<{ Claim: { position_id: string; amount: string; paidTotal: string; k: number; txHash: string | null; block: string; by: string | null }[]; chain_metadata: { latest_processed_block: number | null }[] }>(
      `query($p: [String!]!) { Claim(where: {position_id: {_in: $p}}, order_by: [{block: asc}, {id: asc}], limit: 1000) { position_id amount paidTotal k txHash block by } chain_metadata { latest_processed_block } }`,
      { p: ids.map((i) => `${l(series)}-${i}`) },
    );
    for (const c of r.Claim) if (c.txHash && BigInt(c.block) >= since) out.push({ id: BigInt(c.position_id.split("-").pop()!), amount: BigInt(c.amount), paidTotal: BigInt(c.paidTotal), k: BigInt(c.k), txHash: c.txHash as Hex, block: BigInt(c.block), by: c.by });
    const ib = BigInt(r.chain_metadata[0]?.latest_processed_block ?? 0) + 1n;
    if (ib > from) from = ib;
  }
  const head = await x.pub.getBlockNumber();
  for (const g of await scanLogs(x.pub, { address: series, event: CLAIMED, args: { id: ids } }, from, head, x.log)) {
    if (out.some((c) => l(c.txHash) === l(g.transactionHash) && c.id === BigInt(g.args.id as bigint))) continue;
    out.push({ id: BigInt(g.args.id as bigint), amount: BigInt(g.args.amount as bigint), paidTotal: BigInt(g.args.paidTotal as bigint), k: BigInt(g.args.k as number), txHash: g.transactionHash, block: g.blockNumber, by: null });
  }
  for (const c of out) knownHash(c.txHash);
  return out;
}

// ------------------------------------------------------------------ the indexer's view of a step

/** Waits until the indexer has processed `block` (at most 10 minutes; it fails when it stops moving for 3), then runs
 *  the check; without an indexer, nothing. */
async function idx(x: Ctx, step: string, block: bigint, name: string, f: () => Promise<{ ok: boolean; detail?: unknown }>): Promise<void> {
  if (!x.c.gql) return;
  try {
    await waitIndexed(x.c.gql.url, block, { stallMs: 180_000, maxMs: 600_000, log: x.log });
    const r = await f();
    x.L.check(step, `indexer: ${name}`, r.ok, r.detail);
  } catch (e) {
    x.L.check(step, `indexer: ${name}`, false, (e as Error).message);
  }
}

async function bookNow(x: Ctx) {
  return x.c.book(x.gpu, x.month);
}

/** Waits (up to 3 minutes) until the book's `side` holds `size` GPU-hours at its best level. */
async function waitSide(x: Ctx, side: "asks" | "bids", size: number): Promise<{ price: number; size: number }> {
  const t0 = Date.now();
  for (;;) {
    const b = await bookNow(x);
    const top = b[side][0];
    if (top && top.size >= size) return top;
    if (Date.now() - t0 > 180_000) throw new Error(`the ${side} of ${x.gpu} ${x.month} hold less than ${size} GPU-hours at the top after 3 minutes`);
    await sleep(5_000);
  }
}

const price2 = (n: number) => n.toFixed(2);

// ------------------------------------------------------------------ the journey

async function stepDrip(x: Ctx): Promise<void> {
  const st = "drip";
  const w0 = await x.c.getWallet(x.user);
  const r = await drip(x.c, x.w);
  await x.L.txs(st, r.txs);
  const w1 = await x.c.getWallet(x.user);
  const amount = (await x.pub.readContract({ address: x.c.dollar, abi: abi.agateDollarAbi as Abi, functionName: "dripAmount" })) as bigint;
  const period = (await x.pub.readContract({ address: x.c.dollar, abi: abi.agateDollarAbi as Abi, functionName: "dripPeriod" })) as bigint;
  x.L.check(st, `drip pays the dollar's dripAmount ($${toNumber6(amount)}); canDrip turns false; the next drip opens dripPeriod (${period} s) later`, r.result.amount === toNumber6(amount) && near(w1.balance - w0.balance, toNumber6(amount)) && !w1.canDrip && w1.nextDrip !== null && w1.lastDrip !== null && Date.parse(w1.nextDrip) - Date.parse(w1.lastDrip) === Number(period) * 1000, { result: r.result, before: w0.balance, after: w1.balance, nextDrip: w1.nextDrip });
}

async function stepBuy(x: Ctx): Promise<void> {
  const st = "buy";
  const ask = await waitSide(x, "asks", 100);
  const w0 = await x.c.getWallet(x.user);
  const t0 = w0.positions.find((p) => p.kind === "tokens" && p.month === x.month && p.gpu === x.gpu)?.q ?? 0;
  x.budget.take(st, parseDollars(SIZES.buy));
  const r = await buyLong(x.c, x.w, { gpu: x.gpu, month: x.month, dollars: SIZES.buy, maxPrice: price2(ask.price) });
  await x.L.txs(st, r.txs);
  const w1 = await x.c.getWallet(x.user);
  const t1 = w1.positions.find((p) => p.kind === "tokens" && p.month === x.month && p.gpu === x.gpu)?.q ?? 0;
  x.L.check(st, `bought at the shown ask $${price2(ask.price)} or better (within 1%): spent + refund = $${SIZES.buy}`, r.result.gpuHours > 0 && r.result.spent <= Number(SIZES.buy) && near(r.result.spent + r.result.refund, Number(SIZES.buy)) && r.result.avgPrice <= ask.price * 1.01 + 1e-6, r.result);
  x.L.check(st, "the wallet holds the new tokens; its tUSD fell by exactly what was spent", near(t1 - t0, r.result.gpuHours) && near(w0.balance - w1.balance, r.result.spent), { tokens: [t0, t1], usd: [w0.balance, w1.balance], spent: r.result.spent });
  const block = r.txs.at(-1)!.block;
  await idx(x, st, block, "the fill is in recentFills (taker buy, this transaction) and the router flow is OPEN_LONG", async () => {
    const fills = await x.c.recentFills(x.gpu, x.month, 50);
    const mine = fills.filter((f) => l(f.txHash) === l(r.hash));
    const flows = await flowsOf(x, (await x.c.seriesAt(x.gpu, x.month)).terms.series);
    return { ok: mine.length > 0 && mine.every((f) => f.side === "buy") && near(mine.reduce((a, f) => a + f.size, 0), r.result.gpuHours, 1e-4) && flows.some((f) => l(f.txHash) === l(r.hash) && f.flow === "OPEN_LONG"), detail: { fills: mine, flows } };
  });
}

async function stepSell(x: Ctx): Promise<void> {
  const st = "sell";
  const w0 = await x.c.getWallet(x.user);
  const held = w0.positions.find((p) => p.kind === "tokens" && p.month === x.month && p.gpu === x.gpu);
  const inWallet = held ? held.q - held.inMargin : 0;
  const q = inWallet >= 2 * Number(SIZES.sell) ? SIZES.sell : (Math.floor((inWallet / 2) * 1e4) / 1e4).toFixed(4);
  if (Number(q) <= 0) throw new Error(`nothing to sell: the wallet holds ${inWallet} GPU-hours of ${x.gpu} ${x.month}`);
  const bid = await waitSide(x, "bids", Number(q));
  const r = await sellLong(x.c, x.w, { gpu: x.gpu, month: x.month, gpuHours: q, minPrice: price2(bid.price) });
  await x.L.txs(st, r.txs);
  const w1 = await x.c.getWallet(x.user);
  const t1 = w1.positions.find((p) => p.kind === "tokens" && p.month === x.month && p.gpu === x.gpu)?.q ?? 0;
  x.L.check(st, `sold ${q} GPU-hours at the shown bid $${price2(bid.price)} or better (within 1%), fill-or-kill`, near(r.result.gpuHours, Number(q)) && r.result.avgPrice >= bid.price * 0.99 - 1e-6 && near(r.result.received, r.result.avgPrice * Number(q), 1e-4), r.result);
  x.L.check(st, "the wallet's tokens fell by the size sold; its tUSD rose by the proceeds", near((held?.q ?? 0) - t1, Number(q)) && near(w1.balance - w0.balance, r.result.received), { tokens: [held?.q, t1], usd: [w0.balance, w1.balance] });
  await idx(x, st, r.txs.at(-1)!.block, "the fill is in recentFills (taker sell, this transaction)", async () => {
    const mine = (await x.c.recentFills(x.gpu, x.month, 50)).filter((f) => l(f.txHash) === l(r.hash));
    return { ok: mine.length > 0 && mine.every((f) => f.side === "sell") && near(mine.reduce((a, f) => a + f.size, 0), Number(q), 1e-4), detail: mine };
  });
}

async function stepShortOpen(x: Ctx): Promise<void> {
  const st = "short-open";
  const q = SIZES.short;
  const bid = await waitSide(x, "bids", Number(q));
  const s = await x.c.seriesAt(x.gpu, x.month);
  const w0 = await x.c.getWallet(x.user);
  x.budget.take(st, ceilU(hoursU(q) * s.terms.cap, U));
  const r = await openShort(x.c, x.w, { gpu: x.gpu, month: x.month, gpuHours: q, parts: 1, daily: true, minPrice: price2(bid.price) });
  await x.L.txs(st, r.txs);
  const w1 = await x.c.getWallet(x.user);
  const opened = await openedIn(x, r.hash);
  const o = opened[0];
  x.L.check(st, `puts up ${q} x the cap $${toNumber6(s.terms.cap)}, sells ${q} at the shown bid $${price2(bid.price)} or better (within 1%)`, r.result.cost === toNumber6(hoursU(q) * s.terms.cap / U) && r.result.avgPrice >= bid.price * 0.99 - 1e-6 && near(w1.balance - w0.balance, r.result.received - r.result.cost), { result: r.result, usd: [w0.balance, w1.balance] });
  const pos = w1.positions.find((p) => p.kind === "position" && p.positionId === String(o?.id));
  x.L.check(st, `one short position of ${q} GPU-hours, paid daily, owned by and paying the user`, opened.length === 1 && !!pos && pos.side === "short" && pos.daily && near(pos.q, Number(q)) && pos.payee === l(x.user), { opened, pos });
  if (o) {
    const ks = await kSAt(x, s.terms.series, r.txs.at(-1)!.block, o.k);
    const want = ks ? owedShort(o.q, BigInt(s.terms.n), ks.k, ks.S, s.terms.cap) : null;
    x.L.check(st, `paid at once what has vested: q (kC - S) / N at k ${o.k} = $${want === null ? "?" : toNumber6(want)}`, want !== null && o.paidNow === want, { paidNow: o.paidNow, want, k: o.k, at: ks });
  }
  await idx(x, st, r.txs.at(-1)!.block, "the position is OPEN (short, daily) and its entry is the sale price", async () => {
    const wi = await x.c.getWallet(x.user);
    const p = wi.positions.find((y) => y.positionId === String(o?.id) && y.series === l(s.terms.series));
    return { ok: !!p && p.openedAt !== "" && near(p.entry, r.result.avgPrice, 0.011), detail: p };
  });
}

async function stepShortClose(x: Ctx, pr: Progress): Promise<void> {
  const st = "short-close";
  const open = pr.flows.filter((f) => f.flow === "OPEN_SHORT").flatMap((f) => f.positionIds);
  const s = await x.c.seriesAt(x.gpu, x.month);
  const live: { id: bigint; q: bigint; paid: bigint }[] = [];
  for (const id of open) {
    const p = await positionAt(x, s.terms.series, id);
    if (l(p.owner) === l(x.user)) live.push({ id, q: p.q, paid: p.paid });
  }
  if (live.length === 0) throw new Error("no open short position of this run's to close");
  const q = live.reduce((a, p) => a + p.q, 0n);
  const ask = await waitSide(x, "asks", toNumber6(q));
  x.budget.take(st, buyBackMax(q, parseDollars(price2(ask.price))));
  const w0 = await x.c.getWallet(x.user);
  const r = await closeShort(x.c, x.w, { gpu: x.gpu, month: x.month, positionIds: live.map((p) => p.id), maxPrice: price2(ask.price) });
  await x.L.txs(st, r.txs);
  const w1 = await x.c.getWallet(x.user);
  const want = live.reduce((a, p) => a + (p.q * s.terms.cap) / U - p.paid, 0n);
  x.L.check(st, `the series pays the owner q x C - paid = $${toNumber6(want)}; the buy-back costs at most the shown ask $${price2(ask.price)} plus 1%`, r.result.paid === toNumber6(want) && r.result.spent <= toNumber6(buyBackMax(q, parseDollars(price2(ask.price)))) && near(w1.balance - w0.balance, r.result.paid - r.result.spent), { result: r.result, want, usd: [w0.balance, w1.balance] });
  const after = await Promise.all(live.map((p) => positionAt(x, s.terms.series, p.id)));
  x.L.check(st, "the short position is closed (deleted on chain) and gone from the wallet", after.every((p) => /^0x0{40}$/i.test(p.owner)) && !w1.positions.some((p) => live.some((y) => p.positionId === String(y.id) && p.series === l(s.terms.series))), after);
  await idx(x, st, r.txs.at(-1)!.block, "the position is CLOSED_WITH_TOKEN and the router flow is CLOSE_SHORT", async () => {
    const rows = await x.c.gql!.query<{ Position: { status: string }[] }>(`query($p: [String!]!) { Position(where: {id: {_in: $p}}) { status } }`, { p: live.map((y) => `${l(s.terms.series)}-${y.id}`) });
    const flows = await flowsOf(x, s.terms.series);
    return { ok: rows.Position.length === live.length && rows.Position.every((y) => y.status === "CLOSED_WITH_TOKEN") && flows.some((f) => l(f.txHash) === l(r.hash) && f.flow === "CLOSE_SHORT"), detail: rows };
  });
}

async function stepDaily(x: Ctx): Promise<void> {
  const st = "daily";
  const ask = await waitSide(x, "asks", 50);
  const s = await x.c.seriesAt(x.gpu, x.month);
  const w0 = await x.c.getWallet(x.user);
  x.budget.take(st, parseDollars(SIZES.daily));
  const r = await openLongDaily(x.c, x.w, { gpu: x.gpu, month: x.month, dollars: SIZES.daily, parts: 1, maxPrice: price2(ask.price) });
  await x.L.txs(st, r.txs);
  const w1 = await x.c.getWallet(x.user);
  const opened = await openedIn(x, r.hash);
  const o = opened[0];
  const pos = w1.positions.find((p) => p.kind === "position" && p.positionId === String(o?.id));
  x.L.check(st, `bought at the shown ask $${price2(ask.price)} or better (within 1%) and opened one daily long position`, opened.length === 1 && !!pos && pos.side === "long" && pos.daily && pos.payee === l(x.user) && r.result.avgPrice <= ask.price * 1.01 + 1e-6 && r.result.restTokens < 0.0002, { result: r.result, pos });
  if (o) {
    const ks = await kSAt(x, s.terms.series, r.txs.at(-1)!.block, o.k);
    const want = ks ? owedLong(o.q, BigInt(s.terms.n), ks.k, ks.S, s.terms.floor) : null;
    x.L.check(st, `paid at once q (S + (N - k) F) / N at k ${o.k} = $${want === null ? "?" : toNumber6(want)} (the floor for every day left, the applied days' values)`, want !== null && o.paidNow === want && pos !== undefined && near(pos.paid, toNumber6(want)), { paidNow: o.paidNow, want, k: o.k, at: ks });
  }
  x.L.check(st, "the wallet's tUSD moved by the payment less the spend", near(w1.balance - w0.balance, r.result.paidNow - r.result.spent), { usd: [w0.balance, w1.balance], result: r.result });
  await idx(x, st, r.txs.at(-1)!.block, "the position is OPEN (long, daily) and counts in the month's open interest", async () => {
    const rows = await x.c.gql!.query<{ Position: { status: string; daily: boolean; side: string }[] }>(`query($p: String!) { Position(where: {id: {_eq: $p}}) { status daily side } }`, { p: `${l(s.terms.series)}-${o?.id}` });
    const ser = (await x.c.getSeries(x.gpu)).find((y) => y.month === x.month);
    return { ok: rows.Position[0]?.status === "OPEN" && rows.Position[0]?.daily === true && rows.Position[0]?.side === "LONG" && (ser?.openInterest ?? 0) >= toNumber6(o?.q ?? 0n), detail: { rows, openInterest: ser?.openInterest } };
  });
}

async function stepLimit(x: Ctx, pr: Progress): Promise<void> {
  const st = "limit";
  const s = (await x.c.seriesAt(x.gpu, x.month)) as SeriesLive & { market: Address };
  let orderId: string | null = null;
  if (pr.orders.length === 0) {
    const b = await bookNow(x);
    if (!b.asks[0] || !b.bids[0]) throw new Error("the book is not on both sides");
    const v: MarketView = { month: x.month, symbol: s.terms.symbol, floor: s.terms.floor, cap: s.terms.cap, n: s.terms.n, k: s.k, S: s.S, ask: parseDollars(price2(b.asks[0].price)), bid: parseDollars(price2(b.bids[0].price)) };
    const price = limitPriceOf(v);
    const w0 = await x.c.getWallet(x.user);
    x.budget.take(st, ceilU(hoursU(SIZES.limit) * price, U));
    const r = await placeLimit(x.c, x.w, { gpu: x.gpu, month: x.month, side: "long", price: price2(toNumber6(price)), gpuHours: SIZES.limit });
    await x.L.txs(st, r.txs);
    orderId = r.result.orderId;
    const bk = await bookNow(x);
    const dep = toNumber6(ceilU(hoursU(SIZES.limit) * price, U));
    x.L.check(st, `a post-only bid of ${SIZES.limit} GPU-hours at $${toNumber6(price)} (under the best bid ${b.bids[0].price}, over the band's bottom) rests on the book; the deposit is ${SIZES.limit} x the price ($${dep})`, near(r.result.deposited, Math.max(0, dep - w0.marginBalance)) && bk.bids.some((y) => near(y.price, toNumber6(price)) && y.size >= Number(SIZES.limit)) && orderId !== "", { result: r.result, bids: bk.bids });
    const oo = (await x.c.openOrdersResult(x.user)).orders.filter((y) => l(y.market) === l(s.market));
    x.L.check(st, `openOrders lists it (id ${orderId}, long, $${toNumber6(price)}, ${SIZES.limit} GPU-hours)`, oo.some((y) => y.id === orderId && y.side === "long" && near(y.price, toNumber6(price)) && near(y.q, Number(SIZES.limit))), oo);
    await idx(x, st, r.txs.at(-1)!.block, "openOrders reads it from the indexer (placedAt set)", async () => {
      const res = await x.c.openOrdersResult(x.user);
      const y = res.orders.find((z) => z.id === orderId && l(z.market) === l(s.market));
      return { ok: res.source === "indexer" && !!y && y.placedAt !== "", detail: { source: res.source, order: y } };
    });
  } else x.L.note(st, `found on chain: order(s) ${pr.orders.join(", ")} of this run on ${s.terms.symbol}'s book; finishing the step`);
  // cancel whatever of the user's still rests on this book
  const resting = (await x.c.openOrders(x.user)).filter((y) => l(y.market) === l(s.market));
  if (resting.length > 0) {
    const r = await cancelLimit(x.c, x.w, { gpu: x.gpu, month: x.month, orderIds: resting.map((y) => y.id) });
    await x.L.txs(st, r.txs);
    const left = (await x.c.openOrders(x.user)).filter((y) => l(y.market) === l(s.market));
    x.L.check(st, `cancelled ${r.result.cancelled.join(", ")}: no order of the user's rests on the book`, left.length === 0 && r.result.cancelled.length === resting.length, { result: r.result, left });
    await idx(x, st, r.txs.at(-1)!.block, "the order is CANCELED", async () => {
      const rows = await x.c.gql!.query<{ BookOrder: { orderId: string; status: string }[] }>(`query($i: [String!]!) { BookOrder(where: {id: {_in: $i}}) { orderId status } }`, { i: resting.map((y) => `${l(s.market)}-${y.id}`) });
      return { ok: rows.BookOrder.length === resting.length && rows.BookOrder.every((y) => y.status === "CANCELED"), detail: rows };
    });
  } else if (orderId !== null) x.L.check(st, "the bid was still resting to cancel", false, "it filled or was cancelled before the cancel");
  // withdraw the margin: the deposit, and any token a fill left there
  const wm = await x.c.getWallet(x.user);
  if (wm.marginBalance > 0) {
    const r = await withdrawMargin(x.c, x.w, { asset: "dollar" });
    await x.L.txs(st, r.txs);
    const w2 = await x.c.getWallet(x.user);
    x.L.check(st, `withdrew $${r.result.amount} from Kuru's margin account: margin 0, the wallet up by it`, w2.marginBalance === 0 && near(w2.balance - wm.balance, r.result.amount), { margin: w2.marginBalance, usd: [wm.balance, w2.balance] });
  }
  const tok = wm.positions.find((p) => p.kind === "tokens" && p.series === l(s.terms.series));
  if (tok && tok.inMargin > 0) {
    const r = await withdrawMargin(x.c, x.w, { asset: { gpu: x.gpu, month: x.month } });
    await x.L.txs(st, r.txs);
    x.L.note(st, `a fill left ${tok.inMargin} GPU-hours in the margin account: withdrawn`);
  }
}

/** Waits for the next final demo day after the daily position opened, then claims (claimDaily). The payer claims
 *  daily positions too, so whoever moves first pays it: the check is the position's paid total either way. */
async function stepClaim(x: Ctx, pr: Progress): Promise<void> {
  const st = "claim";
  const s = await x.c.seriesAt(x.gpu, x.month);
  const daily = pr.flows.filter((f) => f.flow === "OPEN_LONG_DAILY");
  const opened = (await Promise.all(daily.map((f) => openedIn(x, f.txHash)))).flat();
  const ids = opened.map((o) => o.id);
  if (ids.length === 0) throw new Error("no daily position of this run's to claim");
  const t0 = Date.now();
  const since = await x.pub.getBlockNumber();
  const ck = await x.c.clocks();
  let said = 0;
  let paidBy: "user" | "payer" | null = null;
  let claimTx: TxSummary | null = null;
  for (;;) {
    checkStop();
    const pos = await Promise.all(ids.map((id) => positionAt(x, s.terms.series, id)));
    const grown = opened.some((o, i) => pos[i]!.paid > o.paidNow || /^0x0{40}$/i.test(pos[i]!.owner));
    if (grown) {
      paidBy = "payer";
      break;
    }
    const cl = (await x.c.mc(ids.map((id) => ({ address: s.terms.series, abi: abi.agateSeriesAbi as Abi, functionName: "claimable", args: [id] })))).map((y) => (y.ok ? BigInt(y.value as bigint) : 0n));
    if (cl.some((y) => y > 0n)) {
      try {
        const r = await claimDaily(x.c, x.w);
        await x.L.txs(st, r.txs);
        claimTx = r.txs.find((t) => t.events.some((e) => e.name === "Claimed" && ids.includes(BigInt(e.args.id as bigint)))) ?? null;
        paidBy = claimTx ? "user" : "payer";
        break;
      } catch (e) {
        if (e instanceof WriteError && e.stage === "check" && e.txs.length === 0 && e.message.includes("nothing to claim")) {
          paidBy = "payer"; // claimable went to 0 between the read and the claim: someone else claimed
          break;
        }
        throw e;
      }
    }
    if (Date.now() - t0 > x.o.claimWaitMin * 60_000) throw new Error(`no demo day turned final for ${x.o.claimWaitMin} minutes (--claim-wait-min): the session's writers or attester may be down`);
    if (Date.now() - said >= 180_000) {
      const now = await x.c.chainTime();
      const [k] = (await x.pub.readContract({ address: s.terms.series, abi: abi.agateSeriesAbi as Abi, functionName: "previewSync" })) as readonly [number, bigint];
      const day = s.terms.startDay + Number(k);
      const end = s.terms.startTs + BigInt(Number(k) + 1) * BigInt(s.terms.day);
      x.log(`  waiting for the next final demo day: ${k} of ${s.terms.n} days of ${s.terms.symbol} applied; day ${day} ends ${new Date(Number(end) * 1000).toISOString()}, final about ${new Date(Number(end + BigInt(ck.closeGrace + ck.tPend)) * 1000).toISOString()} (chain time ${new Date(Number(now) * 1000).toISOString()})`);
      said = Date.now();
    }
    await sleep(x.fastPoll ? 2_000 : 5_000);
  }
  // the exact amount, whoever claimed: paidTotal = q (S + (N - k) F) / N at the claim's k
  const claims = (await claimsOf(x, s.terms.series, ids, since > 200n ? since - 200n : 0n)).filter((y) => !claimTx || l(y.txHash) === l(claimTx.hash));
  const firstPer = opened.map((o) => claims.filter((y) => y.id === o.id).sort((a, b) => Number(a.block - b.block))[0]);
  const checks = await Promise.all(opened.map(async (o, i) => {
    const c0 = firstPer[i];
    if (!c0) return { id: o.id, ok: false, why: "no Claimed event found" };
    const ks = await kSAt(x, s.terms.series, c0.block, c0.k);
    const want = ks ? owedLong(o.q, BigInt(s.terms.n), ks.k, ks.S, s.terms.floor) : null;
    return { id: o.id, ok: want !== null && c0.paidTotal === want && c0.k > o.k, paidTotal: c0.paidTotal, want, kOpen: o.k, kClaim: c0.k, by: c0.by, tx: c0.txHash };
  }));
  x.L.check(st, `${paidBy === "user" ? "the user's claimDaily" : "the payer's claim (it moved first)"} paid each daily position to q (S + (N - k) F) / N at the newly final day, exactly`, checks.every((y) => y.ok), checks);
  if (paidBy === "payer") x.L.note(st, "the payer app claimed the position before this run did (it claims every daily position after each final day): checked the amount it paid");
  await idx(x, st, (claimTx?.block ?? (await x.pub.getBlockNumber())), "the claim is a Claim row of the position", async () => {
    const rows = await x.c.gql!.query<{ Claim: { position_id: string; paidTotal: string }[] }>(`query($p: [String!]!) { Claim(where: {position_id: {_in: $p}}) { position_id paidTotal } }`, { p: ids.map((i) => `${l(s.terms.series)}-${i}`) });
    return { ok: ids.every((i) => rows.Claim.some((y) => y.position_id === `${l(s.terms.series)}-${i}`)), detail: rows };
  });
}

/** Waits for the month's end (every day applied); on a fork with --time-travel, writes the rest of the month's days
 *  first (the kit's days.ts, as the index's writer and attester, impersonated). Then the final claims. */
async function stepMonthEnd(x: Ctx, pr: Progress): Promise<void> {
  const st = "month-end";
  const s0 = await x.c.seriesAt(x.gpu, x.month);
  const lastDay = s0.terms.startDay + s0.terms.n - 1;
  const ck = await x.c.clocks();
  if (x.o.timeTravel && s0.k < s0.terms.n) {
    const { writeDays } = await import("./world.ts");
    x.log(`  --time-travel (fork only): writing the demo index's days up to ${lastDay} with the kit's days.ts`);
    const d = writeDays({ rpc: x.o.rpc, index: x.c.index, toDay: lastDay, logDir: null });
    x.L.note(st, `time travel on the fork: days.ts wrote ${d.transactions} transactions, chain time ${d.chainTime}`);
  }
  const t0 = Date.now();
  let said = 0;
  const endTs = s0.terms.startTs + BigInt(s0.terms.n) * BigInt(s0.terms.day);
  for (;;) {
    checkStop();
    const [k] = (await x.pub.readContract({ address: s0.terms.series, abi: abi.agateSeriesAbi as Abi, functionName: "previewSync" })) as readonly [number, bigint];
    if (Number(k) >= s0.terms.n) break;
    const now = await x.c.chainTime();
    if (now > endTs + BigInt(4 * ck.day + ck.tPend) && Date.now() - t0 > 3_600_000) throw new Error(`the month ended at ${new Date(Number(endTs) * 1000).toISOString()} and only ${k} of ${s0.terms.n} days are final`);
    if (Date.now() - said >= 300_000) {
      x.log(`  waiting for the month's end: ${k} of ${s0.terms.n} days of ${s0.terms.symbol} final; the last day ends ${new Date(Number(endTs) * 1000).toISOString()}, final about ${new Date(Number(endTs + BigInt(ck.closeGrace + ck.tPend)) * 1000).toISOString()} (chain time ${new Date(Number(now) * 1000).toISOString()})`);
      said = Date.now();
    }
    await sleep(30_000);
  }
  const ser = (await x.c.getSeries(x.gpu)).find((y) => y.month === x.month);
  const s = await x.c.seriesAt(x.gpu, x.month);
  x.L.check(st, `${s.terms.symbol} settled: every day applied (k ${s.k} of ${s.terms.n})`, ser?.phase === "settled" && s.k === s.terms.n, { phase: ser?.phase, k: s.k, S: s.S });
  // the final claims of this run's daily positions: by the user, or by the payer's final sweep if it moved first
  const daily = pr.flows.filter((f) => f.flow === "OPEN_LONG_DAILY");
  const opened = (await Promise.all(daily.map((f) => openedIn(x, f.txHash)))).flat();
  const before = await Promise.all(opened.map((o) => positionAt(x, s.terms.series, o.id)));
  const open = opened.filter((_, i) => !/^0x0{40}$/i.test(before[i]!.owner));
  let claimTx: TxSummary | null = null;
  if (open.length > 0) {
    try {
      const r = await claimDaily(x.c, x.w);
      await x.L.txs(st, r.txs);
      claimTx = r.txs.find((t) => t.events.some((e) => e.name === "PositionClosed")) ?? null;
    } catch (e) {
      if (!(e instanceof WriteError && e.stage === "check" && e.txs.length === 0 && e.message.includes("nothing to claim"))) throw e;
      x.L.note(st, "nothing was claimable: the payer's final sweep closed the positions first");
    }
  } else x.L.note(st, "the daily positions were closed before this step (the payer's final sweep)");
  const after = await Promise.all(opened.map((o) => positionAt(x, s.terms.series, o.id)));
  // every claim of these positions since the factory's start (the indexer's rows, the chain's logs above them)
  const claims = await claimsOf(x, s.terms.series, opened.map((o) => o.id), x.startBlock);
  const finals = opened.map((o) => {
    const last = claims.filter((y) => y.id === o.id).sort((a, b) => Number(b.block - a.block))[0];
    const want = owedLong(o.q, BigInt(s.terms.n), BigInt(s.terms.n), s.S, s.terms.floor);
    return { id: o.id, ok: !!last && last.k === BigInt(s.terms.n) && last.paidTotal === want, paidTotal: last?.paidTotal, want, by: last?.by, tx: last?.txHash };
  });
  x.L.check(st, "each daily position's final claim brings its total to q S / N exactly, and closes it (deleted on chain)", finals.every((y) => y.ok) && after.every((p) => /^0x0{40}$/i.test(p.owner)), { finals, owners: after.map((p) => p.owner) });
  await idx(x, st, claimTx?.block ?? (await x.pub.getBlockNumber()), "the positions are CLOSED_FINAL", async () => {
    const rows = await x.c.gql!.query<{ Position: { id: string; status: string }[] }>(`query($p: [String!]!) { Position(where: {id: {_in: $p}}) { id status } }`, { p: opened.map((o) => `${l(s.terms.series)}-${o.id}`) });
    return { ok: rows.Position.length === opened.length && rows.Position.every((y) => y.status === "CLOSED_FINAL"), detail: rows };
  });
}

/** After the month: what is left in the wallet: tokens in Kuru's margin withdrawn, pairs redeemed (C each), the rest
 *  settled (tokens at S / N, a short balance at C - S / N). */
async function stepSettle(x: Ctx): Promise<void> {
  const st = "settle";
  const s = await x.c.seriesAt(x.gpu, x.month);
  let w = await x.c.getWallet(x.user);
  const mine = () => w.positions.filter((p) => p.series === l(s.terms.series));
  const tok = mine().find((p) => p.kind === "tokens");
  if (tok && tok.inMargin > 0) {
    const r = await withdrawMargin(x.c, x.w, { asset: { gpu: x.gpu, month: x.month } });
    await x.L.txs(st, r.txs);
    w = await x.c.getWallet(x.user);
  }
  const t = mine().find((p) => p.kind === "tokens")?.q ?? 0;
  const sh = mine().find((p) => p.kind === "shortBalance")?.q ?? 0;
  const pairs = Math.min(t, sh);
  if (pairs > 0) {
    const r = await redeem(x.c, x.w, { gpu: x.gpu, month: x.month, gpuHours: pairs.toFixed(4) });
    await x.L.txs(st, r.txs);
    x.L.check(st, `redeemed ${pairs} pairs for $${toNumber6(s.terms.cap)} each`, near(r.result.paid, toNumber6((hoursU(pairs.toFixed(4)) * s.terms.cap) / U)), r.result);
  }
  const w0 = await x.c.getWallet(x.user);
  const tq = w0.positions.find((p) => p.series === l(s.terms.series) && p.kind === "tokens")?.q ?? 0;
  const sq = w0.positions.find((p) => p.series === l(s.terms.series) && p.kind === "shortBalance")?.q ?? 0;
  if (tq > 0 || sq > 0) {
    const r = await settle(x.c, x.w, { gpu: x.gpu, month: x.month });
    await x.L.txs(st, r.txs);
    const n = BigInt(s.terms.n);
    const wantL = (hoursU(tq.toFixed(6)) * s.S) / (n * U);
    const wantS = (hoursU(sq.toFixed(6)) * (n * s.terms.cap - s.S)) / (n * U);
    const w1 = await x.c.getWallet(x.user);
    x.L.check(st, `settled ${tq} GPU-hours at S / N ($${toNumber6(s.S / n)}) and ${sq} short at C - S / N, exactly`, r.result.long === toNumber6(wantL) && r.result.short === toNumber6(wantS) && near(w1.balance - w0.balance, r.result.paid), { result: r.result, wantL, wantS });
    await idx(x, st, r.txs.at(-1)!.block, "the settle is a Settle row of the user", async () => {
      const rows = await x.c.gql!.query<{ Settle: { txHash: string | null }[] }>(`query($a: String!, $s: String!) { Settle(where: {holder_id: {_eq: $a}, series_id: {_eq: $s}}) { txHash } }`, { a: l(x.user), s: l(s.terms.series) });
      return { ok: rows.Settle.some((y) => l(y.txHash ?? "") === l(r.hash)), detail: rows };
    });
  }
  const wE = await x.c.getWallet(x.user);
  x.L.check(st, `the wallet holds nothing of ${s.terms.symbol} any more (no tokens, short balance or position)`, !wE.positions.some((p) => p.series === l(s.terms.series)), wE.positions.filter((p) => p.series === l(s.terms.series)));
}

/** The journey: each step looked up on chain first, skipped when done, run when not. */
export async function journey(o: TestnetOptions, p: Preflight, L: Ledger, log: (s: string) => void): Promise<void> {
  const w = createWalletClient({ account: p.account, chain: p.c.chain, transport: p.transport });
  const x: Ctx = { o, p, c: p.c, pub: p.pub, w, user: p.user, gpu: o.gpu, month: p.month, L, budget: new Budget(o.maxDollars), log, startBlock: o.fromBlock ?? BigInt(p.f.startBlock), fastPoll: p.fork };
  const say = (s: string) => log(`\n== ${s}`);

  say(`reads: the market as the app first sees it (${o.gpu} ${p.month} on the ${o.factory} factory)`);
  const ms = await x.c.getMarkets();
  const m = ms.find((y) => y.gpu === o.gpu)!;
  // getMarket holds this month and next; a month already over (a run that resumes after it) is in getSeries
  const ser = m.series.find((y) => y.month === p.month) ?? (await x.c.getSeries(o.gpu)).find((y) => y.month === p.month);
  L.check("reads", "six GPUs; B300, A100 and L40S are price only", ms.length === 6 && ms.filter((y) => !y.tradable).map((y) => y.gpu).join() === "B300,A100,L40S");
  L.check("reads", `${o.gpu} has a final index price ($${m.price} for ${m.priceDate}) from ${m.liveCount} of ${m.panelSize} clouds`, m.priceDate !== null && m.price > 0 && m.liveCount > 0 && m.liveCount <= m.panelSize, { price: m.price, priceDate: m.priceDate });
  const bk = await bookNow(x);
  if (p.view.settled) {
    L.check("reads", `${ser?.symbol} is settled (every day applied, S $${ser?.S}): only the final claims and the settle are left`, !!ser && ser.phase === "settled" && ser.k === ser.n, ser);
  } else {
    L.check("reads", `${ser?.symbol} is ${ser?.phase} with a band ($${ser?.floor} to $${ser?.cap}) and a two-sided quote (bid ${ser?.quote?.bid}, ask ${ser?.quote?.ask})`, !!ser && (ser.phase === "paying" || ser.phase === "trading") && ser.floor > 0 && ser.floor < ser.cap && !!ser.quote && ser.quote.bid > 0 && ser.quote.bid < ser.quote.ask && (o.factory !== "demo" || ser.symbol.startsWith("d")), ser);
    L.check("reads", `the book: ${bk.asks.length} asks rising, ${bk.bids.length} bids falling, every size above 0`, bk.asks.length > 0 && bk.bids.length > 0 && bk.asks.every((y, i) => i === 0 || y.price > bk.asks[i - 1]!.price) && bk.bids.every((y, i) => i === 0 || y.price < bk.bids[i - 1]!.price) && [...bk.asks, ...bk.bids].every((y) => y.size > 0), bk);
  }
  L.check("reads", `the next index price is expected after now (${m.nextUpdateAt})`, Date.parse(m.nextUpdateAt) > Number(await x.c.chainTime()) * 1000 - 1000, m.nextUpdateAt);

  let pr = await readProgress(x);
  log(`found on chain for ${x.user} on ${pr.s.terms.symbol}: flows ${pr.flows.map((f) => f.flow).join(", ") || "none"}; orders ${pr.orders.length}; tokens ${pr.tokens?.q ?? 0}; open shorts ${pr.shorts.length}; daily longs ${pr.dailies.length}; resting ${pr.resting.length}; margin $${pr.marginUsd}; canDrip ${pr.canDrip}`);
  const settled = () => pr.s.k >= pr.s.terms.n;
  const finished = () => settled() && pr.dailies.length === 0 && pr.shorts.length === 0 && !pr.tokens && !pr.shortBal && has(pr, "OPEN_LONG_DAILY");
  const isDone: Record<StepName, () => boolean> = {
    // the drip comes first: a journey with any flow on this month is past it (a rerun after the drip period does not
    // drip again)
    drip: () => !pr.canDrip || pr.flows.length > 0,
    buy: () => has(pr, "OPEN_LONG"),
    sell: () => has(pr, "CLOSE_LONG"),
    "short-open": () => has(pr, "OPEN_SHORT"),
    "short-close": () => has(pr, "CLOSE_SHORT"),
    daily: () => has(pr, "OPEN_LONG_DAILY"),
    limit: () => pr.orders.length > 0 && pr.resting.length === 0 && pr.marginUsd === 0,
    claim: () => false, // decided inside the step, from the daily position's paid total against what it was paid at open
    // the month's end and the settle are done once nothing of the journey is left in the wallet after the month
    "month-end": () => finished(),
    settle: () => finished(),
  };
  const run: Record<StepName, () => Promise<void>> = {
    drip: () => stepDrip(x),
    buy: () => stepBuy(x),
    sell: () => stepSell(x),
    "short-open": () => stepShortOpen(x),
    "short-close": () => stepShortClose(x, pr),
    daily: () => stepDaily(x),
    limit: () => stepLimit(x, pr),
    claim: () => stepClaimIfDue(x, pr),
    "month-end": () => stepMonthEnd(x, pr),
    settle: () => stepSettle(x),
  };
  const trading: StepName[] = ["buy", "sell", "short-open", "short-close", "daily", "limit"];
  for (const [i, st] of STEPS.entries()) {
    checkStop();
    say(st);
    if (isDone[st]()) {
      L.check(st, `already done (found on chain): skipped`, true);
    } else if (trading.includes(st) && settled()) {
      L.check(st, `the month settled before this step ran: not run`, false);
    } else {
      const mon = await x.pub.getBalance({ address: x.user });
      if (mon < o.minMonWei) throw new GateError(`refused: ${fmtMon(mon)} MON is under the floor --min-mon ${fmtMon(o.minMonWei)}: stopped before ${st}; top the wallet up and run again (the run resumes here); nothing was sent for this step`);
      const left = journeyGas(i) * p.gasPrice;
      if (mon < o.minMonWei + left) log(`  MON ${fmtMon(mon)}: the rest of the journey may need up to ${fmtMon(left)} above the floor`);
      await run[st]();
      // the flows and orders this step made are what the next steps look up
      pr = await readProgress(x);
    }
    if (o.stopAfter === st) throw new StopRequested(`stopped after ${st} as asked (--stop-after): run the same command again to continue`);
  }
}

/** The claim step, skipped when a claim already paid the daily position (by this run before, or by the payer). */
async function stepClaimIfDue(x: Ctx, pr: Progress): Promise<void> {
  const daily = pr.flows.filter((f) => f.flow === "OPEN_LONG_DAILY");
  const opened = (await Promise.all(daily.map((f) => openedIn(x, f.txHash)))).flat();
  const s = await x.c.seriesAt(x.gpu, x.month);
  const pos = await Promise.all(opened.map((o) => positionAt(x, s.terms.series, o.id)));
  if (opened.length > 0 && opened.every((o, i) => pos[i]!.paid > o.paidNow || /^0x0{40}$/i.test(pos[i]!.owner))) {
    x.L.check("claim", "already done (found on chain: the daily position was paid for a final day since it opened): skipped", true);
    return;
  }
  await stepClaim(x, pr);
}

// ------------------------------------------------------------------ the runner

/** The testnet mode, start to end; returns the exit code (0 all checks passed, 1 a check failed or the run stopped on
 *  an error, 2 refused by a gate, 3 stopped on request). */
export async function runTestnet(argv: string[], env: Record<string, string | undefined> = process.env, deps: Deps = {}): Promise<number> {
  // every line goes out through redact(): no run of 64 hex digits but this run's transaction hashes
  const print = deps.log ?? ((s: string) => console.log(s));
  const log = (s: string) => print(redact(s));
  let o: TestnetOptions;
  try {
    o = parseTestnetArgs(argv, env);
  } catch (e) {
    log(e instanceof GateError ? e.message : `refused: the arguments cannot be read (${(e as Error).message}); nothing was read or sent`);
    return 2;
  }
  stopFlag = null;
  const startedAt = new Date().toISOString();
  let L = new Ledger(log, null);
  let p: Preflight | null = null;
  let code = 1;
  let stopped: string | null = null;
  let locked = false;
  try {
    try {
      p = await preflight(o, env, deps, log);
      L = new Ledger(log, p.pub);
      await journey(o, p, L, log);
      code = L.failed().length === 0 ? 0 : 1;
    } catch (e) {
      if (e instanceof GateError) {
        log(`\n${e.message}`);
        locked = e instanceof LockHeld;
        code = 2;
      } else if (e instanceof StopRequested) {
        stopped = e.message;
        log(`\n${e.message}`);
        code = L.failed().length === 0 ? 3 : 1;
      } else {
        // a transaction this run sent and lost track of is shown by its hash, to look it up
        if (e instanceof WriteError) knownHash(e.hash);
        log(`\nSTOPPED: ${(e as Error).stack ?? e}`);
        L.check("run", "the run completed", false, (e as Error).message);
        if (e instanceof WriteError && e.txs.length) await L.txs("run", e.txs).catch(() => undefined);
        code = 1;
      }
    }
    if (L.rows.length || L.checks.length) {
      log(`\n${L.table()}`);
      const failed = L.failed();
      log(`\n${L.checks.length - failed.length} of ${L.checks.length} checks passed${failed.length ? `; failed: ${failed.map((c) => `${c.step}: ${c.name}`).join(" | ")}` : ""}`);
    }
    let mon1: bigint | null = null;
    let usd1: bigint | null = null;
    if (p) {
      mon1 = await p.pub.getBalance({ address: p.user }).catch(() => null);
      usd1 = (await p.pub.readContract({ address: p.deployments.dollar as Address, abi: abi.agateDollarAbi as Abi, functionName: "balanceOf", args: [p.user] }).catch(() => null)) as bigint | null;
      if (mon1 !== null && usd1 !== null) log(`user ${p.user}: ${fmtMon(mon1)} MON (${fmtMon(mon1 - p.mon0)} this run), ${fmtUsd(usd1)} tUSD (${usd1 >= p.usd0 ? "+" : "-"}${fmtUsd(usd1 >= p.usd0 ? usd1 - p.usd0 : p.usd0 - usd1)} this run)`);
    }
    if (o.report && locked) log(`the report ${o.report} is left as it is: it belongs to the run that holds the lock`);
    else if (o.report) {
      // the report passes redact() whole, as every line does
      try {
        writeFileSync(o.report, redact(big({ mode: "testnet", rpc: redactUrl(o.rpc), fork: p?.fork ?? null, factory: o.factory, factoryAddress: p?.f.factory ?? null, gpu: o.gpu, month: p?.month ?? null, user: p?.user ?? null, startedAt, endedAt: new Date().toISOString(), code, stopped, plan: p?.plan ?? null, mon: { start: p?.mon0 ?? null, end: mon1 }, usd: { start: p?.usd0 ?? null, end: usd1 }, rows: L.rows, checks: L.checks, notes: L.notes, table: L.table() })));
        log(`report: ${o.report}`);
      } catch (e) {
        log(`the report ${o.report} could not be written (${(e as Error).message})`);
      }
    }
  } finally {
    p?.release();
  }
  return code;
}
