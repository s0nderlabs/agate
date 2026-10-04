// BOTS-SPEC 2.1, 2.2, 2.5: the start of a bot process. In this order: the key moves into memory (holdKey; a dry run
// needs none), the RPC endpoints are read and the scrubber installed (no URL is ever printed), one process per role
// (takeLock), the shared alert sink (unscoped: a bot serves several indexes), the RPC pool on the expected chain, and
// the deployments file, read fail closed against the pool's chain id. The key comes from AGATE_KEY_CMD, run here by
// the process itself (audit M-K1): a key exported by a run script stays readable in the process's exec-time
// environment (`ps -wwE`) for its whole life, whatever holdKey deletes. The key variable itself (AGATE_MM_KEY /
// AGATE_PAYER_KEY) still works for tests and the fork e2e, which use throwaway keys.
// Oct 4: with send: endpoints in the list, the sender's own transactions go there first (rt.send, @agate/watcher's
// SendRoute), counted by the process's Alchemy meter (rt.meter: <home>/rpc-meter/<UTC date>/<role>-market.json).
import { join } from "node:path";
import type { Address } from "viem";
import { childEnv, type RpcEndpoints, sendUrls } from "@agate/report/env";
import type { RpcMeter } from "@agate/report/meter";
import { addressOfEnvKey, AlertSink, holdKey, keyLockPath, meterFor, readEndpoints, RpcPool, SendLock, SendRoute, takeLock, wallHome } from "@agate/watcher";
import { loadDeployments } from "./deployments.ts";
import { LimitTable } from "./limits.ts";
import { ViemReads } from "./reads.ts";
import type { Deployments } from "./types.ts";

export class StartError extends Error {}

export const KEY_CMD = "AGATE_KEY_CMD";
export const KEY_CMD_TIMEOUT_MS = 30_000;

/** Runs AGATE_KEY_CMD (with PATH and HOME only, as the RPC list command) and returns the key it printed. Errors name
 *  the variable, never the output. */
export function runKeyCommand(cmd: string, timeoutMs: number = KEY_CMD_TIMEOUT_MS): string {
  if (cmd.trim() === "") throw new StartError(`${KEY_CMD} is empty`);
  const r = Bun.spawnSync(["/bin/sh", "-c", cmd], { env: childEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  if (r.exitedDueToTimeout) throw new StartError(`${KEY_CMD} timed out after ${Math.ceil(timeoutMs / 1000)} s`);
  if (!r.success) throw new StartError(`${KEY_CMD} failed (exit ${r.exitCode ?? r.signalCode ?? "?"})`);
  const key = r.stdout.toString().trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new StartError(`${KEY_CMD} did not print a 32-byte hex key`);
  return key;
}

export interface RuntimeOptions {
  role: string;
  /** AGATE_PAYER_KEY / AGATE_MM_KEY */
  keyVar: string;
  /** AGATE_PAYER_ADDRESS / AGATE_MM_ADDRESS: the address of a dry run without a key */
  addressVar: string;
  now: () => number;
  env?: Record<string, string | undefined>;
  /** false: do not wrap the console (tests) */
  console?: boolean;
  marginAccount?: "required" | "optional";
  /** tests: no process lock */
  noLock?: boolean;
}

export interface Runtime {
  role: string;
  dryRun: boolean;
  /** the key variable when a key is held (a dry run may have none) */
  keyVar: string | null;
  from: Address;
  home: string;
  dir: string;
  lockFd: number | null;
  alerts: AlertSink;
  pool: RpcPool;
  endpoints: RpcEndpoints;
  deployments: Deployments;
  reads: ViemReads;
  limits: LimitTable;
  maxFeeGwei: number;
  sendLock: SendLock;
  /** Oct 4: the send route when the list has send: endpoints */
  send?: SendRoute;
  /** Oct 4: the Alchemy meter when the process has send endpoints or a websocket */
  meter?: RpcMeter;
}

/** BOTS-SPEC 2.1 with audit M-K1: the key into this process's memory (holdKey), from AGATE_KEY_CMD run here, or from
 *  the key variable (tests and the fork e2e, throwaway keys); a dry run may have neither (then the address variable).
 *  AGATE_KEY_CMD is deleted from env after use. Errors name variables, never values. */
export function takeKey(o: Pick<RuntimeOptions, "keyVar" | "addressVar">, env: Record<string, string | undefined>, run: (cmd: string) => string = runKeyCommand): { keyVar: string | null; from: Address } {
  const dryRun = env.AGATE_DRY_RUN === "1";
  const keyCmd = env[KEY_CMD];
  delete env[KEY_CMD];
  if (keyCmd !== undefined && keyCmd !== "" && env[o.keyVar] !== undefined && env[o.keyVar] !== "") throw new StartError(`set one of ${KEY_CMD} and ${o.keyVar}`);
  if (keyCmd !== undefined && keyCmd !== "") {
    // the key reaches only this process's memory: never an exported variable, never the exec-time environment
    process.env[o.keyVar] = run(keyCmd);
    holdKey(o.keyVar); // deletes it from process.env at once
    return { keyVar: o.keyVar, from: addressOfEnvKey(o.keyVar) };
  }
  if (env[o.keyVar] !== undefined && env[o.keyVar] !== "") {
    holdKey(o.keyVar); // throws naming the variable only; deletes it from the environment
    return { keyVar: o.keyVar, from: addressOfEnvKey(o.keyVar) };
  }
  if (dryRun) {
    const a = env[o.addressVar];
    if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new StartError(`a dry run without ${o.keyVar} needs ${o.addressVar} (the address to simulate from)`);
    return { keyVar: null, from: a as Address };
  }
  throw new StartError(`neither ${KEY_CMD} nor ${o.keyVar} is set, and AGATE_DRY_RUN is not 1`);
}

export async function bootstrap(o: RuntimeOptions): Promise<Runtime> {
  const env = o.env ?? process.env;
  const dryRun = env.AGATE_DRY_RUN === "1";
  const { keyVar, from } = takeKey(o, env);
  const endpoints = readEndpoints(env, o.console === false ? { console: false } : {});
  const home = wallHome();
  const dir = join(home, "market", o.role);
  const lockFd = o.noLock ? null : takeLock(join(dir, `${o.role}.lock`));
  const alerts = new AlertSink(join(home, "alerts", "alerts.jsonl"), { now: o.now, role: o.role, ...(env.AGATE_NOTIFY_CMD ? { notifyCmd: env.AGATE_NOTIFY_CMD } : {}) });
  const pool = await RpcPool.create({
    urls: endpoints.http,
    ...(env.AGATE_CHAIN_ID ? { expectChainId: Number(env.AGATE_CHAIN_ID) } : {}),
    timeoutMs: 10_000,
    staleS: 30,
    alerts,
    role: o.role,
    now: o.now,
  });
  const dpath = env.AGATE_DEPLOYMENTS;
  if (!dpath) throw new StartError("AGATE_DEPLOYMENTS is not set (contracts/deployments/<chainId>.json or a copy of it)");
  const deployments = loadDeployments(dpath, { chainId: pool.chainId, ...(o.marginAccount ? { marginAccount: o.marginAccount } : {}) });
  const reads = new ViemReads({ pool });
  const limits = LimitTable.fromEnv(env);
  const fee = env.AGATE_MAX_FEE_GWEI ? Number(env.AGATE_MAX_FEE_GWEI) : 200;
  if (!Number.isFinite(fee) || fee <= 0) throw new StartError("AGATE_MAX_FEE_GWEI is not a positive number");
  const sendLock = new SendLock(keyLockPath(home, from), 30_000);
  const meter = meterFor({ home, role: o.role, scope: "market", endpoints, alerts, env });
  meter?.start();
  const send = sendUrls(endpoints).length > 0 ? await SendRoute.create(pool, { urls: sendUrls(endpoints), role: o.role, timeoutMs: 10_000, alerts, ...(meter ? { meter } : {}), log: (event, data) => console.log(JSON.stringify({ t: o.now(), role: o.role, event, ...data })) }) : undefined;
  return { role: o.role, dryRun, keyVar, from, home, dir, lockFd, alerts, pool, endpoints, deployments, reads, limits, maxFeeGwei: fee, sendLock, ...(send ? { send } : {}), ...(meter ? { meter } : {}) };
}
