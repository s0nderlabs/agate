// The index as a writer sees it. IndexChain is what the writer core needs; indexChain() is the real one: reads
// through the RPC pool (failover), sends through the key's TxSender (13.4).
import { agateIndexAbi } from "@agate/report/abi";
import type { Address, Clocks, GpuConfig, Hex, Readings } from "@agate/report/types";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { KeyLock } from "./lock.ts";
import type { AlertFn, RpcPool } from "./rpc.ts";
import { type SenderTiming, type SendResult, type Shape, type TxJournal, type TxMeta, TxSender } from "./sender.ts";

export type { SendResult, TxMeta } from "./sender.ts";
export { errText } from "./sender.ts";

export interface IndexChain {
  readonly index: Address;
  readonly writer: Address;
  blockTime(): Promise<number>;
  clocks(): Promise<Clocks>;
  gpu(gpuId: Hex): Promise<GpuConfig>;
  head(gpuId: Hex): Promise<number>;
  readings(gpuId: Hex, day: number, writer: Address): Promise<Readings>;
  writers(): Promise<readonly [Address, Address]>;
  isSuspended(writer: Address): Promise<boolean>;
  isVoided(gpuId: Hex, day: number, writer: Address): Promise<boolean>;
  postReport(report: Hex, meta: TxMeta, waitUntilMs?: number): Promise<SendResult>;
  closeDay(gpuId: Hex, meta: TxMeta, waitUntilMs?: number): Promise<SendResult>;
  /** Tags carried by a transaction sent and not mined yet: never repost those. */
  inFlight(): ReadonlySet<string>;
  /** Once per tick: drives the transaction in flight and the RPC pool's head check; returns the head's time. */
  poll(nowS: number): Promise<number | undefined>;
  /** At start and on wake: the nonce from the chain and the transaction journal reconciled. */
  resync(): Promise<void>;
  /** Runs another program that sends with this key (the CRE CLI) while no transaction of ours is in flight. */
  exclusive<T>(fn: () => Promise<T>, untilMs: number): Promise<T | undefined>;
  /** Takes over an unmined transaction another program sent with this key. */
  adopt(hash: Hex, meta: TxMeta): Promise<boolean>;
}

export interface IndexChainOptions {
  pool: RpcPool;
  index: Address;
  /** Read from the environment by the caller at startup; never logged, never written. */
  privateKey: Hex;
  journal: TxJournal;
  timing: SenderTiming;
  alert?: AlertFn;
  measured?: Partial<Record<Shape, bigint>>;
  maxFeeWei?: bigint;
  /** <home>/keys/<address>.lock: one sender per key across processes. */
  keyLockPath?: string;
  nowS?: () => number;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  say?: (event: string, data?: Record<string, unknown>) => void;
  callTag?: "pending" | "latest";
}

export function indexChain(o: IndexChainOptions): IndexChain & { sender: TxSender } {
  const account = privateKeyToAccount(o.privateKey);
  const keyLock = o.keyLockPath ? new KeyLock(o.keyLockPath, o.timing.lockWaitMs) : undefined;
  const sender = new TxSender({
    pool: o.pool,
    account,
    index: o.index,
    journal: o.journal,
    timing: o.timing,
    ...(o.alert ? { alert: o.alert } : {}),
    ...(o.measured ? { measured: o.measured } : {}),
    ...(o.maxFeeWei !== undefined ? { maxFeeWei: o.maxFeeWei } : {}),
    ...(keyLock ? { keyLock } : {}),
    ...(o.nowS ? { nowS: o.nowS } : {}),
    ...(o.nowMs ? { nowMs: o.nowMs } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...(o.say ? { say: o.say } : {}),
    ...(o.callTag ? { callTag: o.callTag } : {}),
  });

  async function read<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    const data = encodeFunctionData({ abi: agateIndexAbi, functionName, args } as never);
    const res = (await o.pool.request("eth_call", [{ to: o.index, data }, "latest"])) as Hex;
    return decodeFunctionResult({ abi: agateIndexAbi, functionName, data: res } as never) as T;
  }

  const send = (functionName: "postReport" | "closeDay", arg: Hex, meta: TxMeta, waitUntilMs?: number) =>
    sender.send({
      to: o.index,
      data: encodeFunctionData({ abi: agateIndexAbi, functionName, args: [arg] }),
      shape: functionName,
      meta,
      ...(waitUntilMs !== undefined ? { waitUntilMs } : {}),
    });

  return {
    sender,
    index: o.index,
    writer: account.address,
    blockTime: async () => {
      const b = (await o.pool.request("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
      return Number(BigInt(b.timestamp));
    },
    clocks: () => read<Clocks>("clocks"),
    gpu: (g) => read<GpuConfig>("gpu", [g]),
    head: async (g) => Number(await read<number>("head", [g])),
    readings: (g, d, w) => read<Readings>("readings", [g, d, w]),
    writers: () => read<readonly [Address, Address]>("writers"),
    isSuspended: (w) => read<boolean>("isSuspended", [w]),
    isVoided: (g, d, w) => read<boolean>("isVoided", [g, d, w]),
    postReport: (r, meta, until) => send("postReport", r, meta, until),
    closeDay: (g, meta, until) => send("closeDay", g, meta, until),
    inFlight: () => sender.inFlight(),
    poll: async (nowS) => {
      await sender.poll();
      return o.pool.checkHead(nowS);
    },
    resync: async () => {
      await sender.reconcile();
    },
    exclusive: (fn, until) => sender.exclusive(fn, until),
    adopt: (hash, meta) => sender.adopt(hash, meta),
  };
}
