// Transactions per BUILD-SPEC 4.14 and 13.4: eth_call at `pending` first (never send what it says reverts); gas
// limit min(CAP, ceil(1.5 * max(estimate, MEASURED))), CAP = 2 * MEASURED, GAS_CAP when 1.5 * estimate > CAP
// (provisional until builder A publishes MEASURED: MEASURED = estimate, CAP = 3 * estimate); fees from the RPC capped by
// AGATE_MAX_FEE_GWEI; one sender per key, sends sequential; nonce from `pending` at start, after a wake and after any
// error, else a local counter; rebroadcast unchanged after max(3 blocks, 30 s), replace with the same nonce and +25%
// fees after max(120 s, slice / 4), NONCE_STUCK after three replacements; "nonce too low" resolved by receipt.
// The key is read from its environment variable at the moment of signing and dropped right after.
import { type Abi, type Address, encodeFunctionData, type Hex, decodeErrorResult, BaseError, type PublicClient, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agateIndexAbi } from "@agate/report/abi";
import { AlertCode } from "@agate/report/types";
import type { AlertSink } from "../alerts.ts";
import { isRevert, RpcDown, type RpcPool, short } from "./rpc.ts";
import type { CallName, Sender, SendResult } from "./types.ts";

export class KeyMissing extends Error {}

/** Reads a 32-byte hex key from the environment at call time. Never logged, never stored by this module. */
export function readKey(envName: string): Hex {
  const v = process.env[envName];
  if (!v || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new KeyMissing(`${envName} is not set to a 32-byte hex key`);
  return v as Hex;
}

/** The address of the key in envName, without keeping the key. */
export function addressOfEnvKey(envName: string): Address {
  return privateKeyToAccount(readKey(envName)).address;
}

export interface SenderOptions {
  pool: RpcPool;
  to: Address;
  keyEnv: string;
  role: string;
  alerts?: AlertSink;
  abi?: Abi;
  /** builder A's published worst case per call shape (4.14); absent = provisional */
  measured?: Partial<Record<CallName | string, bigint>>;
  maxFeeGwei?: number;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  rebroadcastS?: number; // default max(30, 3 blocks)
  replaceS?: number; // default max(120, slice / 4)
  maxReplacements?: number;
  /** how long to keep waiting after the last replacement before giving up on this send */
  giveUpS?: number;
}

const appSendError = (e: unknown) => {
  const m = `${(e as Error)?.message ?? e}`.toLowerCase();
  return (
    isRevert(e) ||
    m.includes("nonce too low") ||
    m.includes("already known") ||
    m.includes("known transaction") ||
    m.includes("underpriced") ||
    m.includes("insufficient funds") ||
    m.includes("nonce too high")
  );
};

export function revertText(e: unknown, abi: Abi = agateIndexAbi as Abi): string {
  if (e instanceof BaseError) {
    const data = (e.walk((x) => typeof (x as { data?: unknown }).data === "string") as { data?: Hex } | null)?.data;
    if (data && data.length >= 10) {
      try {
        const d = decodeErrorResult({ abi, data });
        return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`;
      } catch {
        // unknown selector
      }
    }
    return e.shortMessage;
  }
  return short(e);
}

export class TxSender implements Sender {
  readonly from: Address;
  private nonce: number | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  readonly log: string[] = [];

  constructor(readonly o: SenderOptions) {
    this.from = addressOfEnvKey(o.keyEnv);
  }

  /** After a wake: the next send re-reads the pending nonce. */
  resetNonce(): void {
    this.nonce = null;
  }

  private sleep(ms: number) {
    return this.o.sleep ? this.o.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  private data(fn: string, args: readonly unknown[]): Hex {
    return encodeFunctionData({ abi: (this.o.abi ?? agateIndexAbi) as Abi, functionName: fn, args: args as unknown[] });
  }

  async simulate(fn: CallName | string, args: readonly unknown[]): Promise<{ ok: boolean; error?: string }> {
    const data = this.data(fn, args);
    try {
      await this.o.pool.call((c) => c.call({ account: this.from, to: this.o.to, data, blockTag: "pending" }));
      return { ok: true };
    } catch (e) {
      if (e instanceof RpcDown) return { ok: false, error: e.message };
      return { ok: false, error: revertText(e, this.o.abi) };
    }
  }

  send(fn: CallName | string, args: readonly unknown[]): Promise<SendResult> {
    const run = this.queue.then(() => this.sendNow(fn, args));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const f = await this.o.pool.call((c) => c.estimateFeesPerGas());
    let maxFee = f.maxFeePerGas ?? 0n;
    let prio = f.maxPriorityFeePerGas ?? 0n;
    if (this.o.maxFeeGwei !== undefined) {
      const cap = BigInt(Math.floor(this.o.maxFeeGwei * 1e9));
      if (maxFee > cap) maxFee = cap;
      if (prio > maxFee) prio = maxFee;
    }
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: prio };
  }

  private async sign(tx: { nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; data: Hex }): Promise<Hex> {
    const account = privateKeyToAccount(readKey(this.o.keyEnv));
    if (account.address.toLowerCase() !== this.from.toLowerCase()) throw new KeyMissing(`${this.o.keyEnv} changed while running`);
    return account.signTransaction({ chainId: this.o.pool.chainId, type: "eip1559", to: this.o.to, value: 0n, ...tx });
  }

  private async broadcast(raw: Hex, every = false): Promise<"ok" | "nonce-low" | "known"> {
    const send = async (c: PublicClient) => {
      try {
        await c.request({ method: "eth_sendRawTransaction", params: [raw] });
        return "ok" as const;
      } catch (e) {
        const m = `${(e as Error)?.message ?? e}`.toLowerCase();
        if (m.includes("nonce too low")) return "nonce-low" as const;
        if (m.includes("already known") || m.includes("known transaction")) return "known" as const;
        throw e;
      }
    };
    if (every) {
      const rs = await Promise.allSettled(this.o.pool.clients().map(send));
      const okv = rs.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<"ok" | "nonce-low" | "known"> | undefined;
      if (okv) return okv.value;
      throw (rs[0] as PromiseRejectedResult).reason;
    }
    return this.o.pool.call(send, appSendError);
  }

  private async receipt(hash: Hex) {
    try {
      return await this.o.pool.call((c) => c.getTransactionReceipt({ hash }), (e) => `${(e as Error)?.name}`.includes("TransactionReceiptNotFound") || `${(e as Error)?.message}`.includes("could not be found"));
    } catch (e) {
      if (e instanceof RpcDown) throw e;
      return null;
    }
  }

  private async sendNow(fn: CallName | string, args: readonly unknown[], retry = 0): Promise<SendResult> {
    const data = this.data(fn, args);
    const sim = await this.simulate(fn, args);
    if (!sim.ok) return { ok: false, sent: false, error: sim.error ?? "reverts" };
    let estimate: bigint;
    try {
      estimate = await this.o.pool.call((c) => c.estimateGas({ account: this.from, to: this.o.to, data }));
    } catch (e) {
      return { ok: false, sent: false, error: `estimate: ${revertText(e, this.o.abi)}` };
    }
    const measured = this.o.measured?.[fn];
    const M = measured ?? estimate;
    const cap = measured !== undefined ? 2n * measured : 3n * estimate;
    const need = (3n * (estimate > M ? estimate : M) + 1n) / 2n;
    if ((3n * estimate + 1n) / 2n > cap) {
      this.o.alerts?.raise({ code: AlertCode.GAS_CAP, severity: "action", message: `${this.o.role}: ${fn} needs ${(3n * estimate + 1n) / 2n} gas, cap ${cap} (MEASURED ${measured}); not sent` });
      return { ok: false, sent: false, error: "GAS_CAP" };
    }
    const gas = need < cap ? need : cap;
    if (measured === undefined) this.log.push(`provisional gas for ${fn}: ${gas} (estimate ${estimate})`);
    let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    try {
      if (this.nonce === null) this.nonce = await this.o.pool.call((c) => c.getTransactionCount({ address: this.from, blockTag: "pending" }));
      fees = await this.fees();
    } catch (e) {
      this.nonce = null;
      return { ok: false, sent: false, error: short(e) };
    }
    const nonce = this.nonce;
    const hashes: Hex[] = [];
    let raw: Hex;
    try {
      raw = await this.sign({ nonce, gas, ...fees, data });
    } catch (e) {
      return { ok: false, sent: false, error: e instanceof KeyMissing ? e.message : short(e) };
    }
    hashes.push(keccak256(raw));
    try {
      const r = await this.broadcast(raw);
      if (r === "nonce-low") {
        // a transaction with this nonce landed: ours if a URL took it before a failover, else re-read and retry
        const rc = await this.receipt(hashes[0]!).catch(() => null);
        if (rc) {
          this.nonce = nonce + 1;
          return rc.status === "success" ? { ok: true, sent: true, txHash: hashes[0]!, gasLimit: gas } : { ok: false, sent: true, txHash: hashes[0]!, gasLimit: gas, error: "reverted onchain" };
        }
        this.nonce = null;
        if (retry < 2) return this.sendNow(fn, args, retry + 1);
        return { ok: false, sent: false, error: "nonce too low" };
      }
    } catch (e) {
      this.nonce = null;
      return { ok: false, sent: false, error: short(e) };
    }
    this.nonce = nonce + 1;
    this.log.push(`sent ${fn} nonce ${nonce} gas ${gas} ${hashes[0]}`);
    const t0 = this.o.now();
    let lastAct = t0;
    let replacements = 0;
    let rebroadcasted = false;
    const reb = this.o.rebroadcastS ?? 30;
    const rep = this.o.replaceS ?? 120;
    const maxRep = this.o.maxReplacements ?? 3;
    for (;;) {
      for (const h of hashes) {
        let rc: Awaited<ReturnType<TxSender["receipt"]>>;
        try {
          rc = await this.receipt(h);
        } catch {
          rc = null; // every URL down: keep waiting; held sends resume when a URL returns
        }
        if (rc) {
          const ok = rc.status === "success";
          this.log.push(`mined ${fn} ${h} ${rc.status}`);
          return ok ? { ok, sent: true, txHash: h, gasLimit: gas } : { ok, sent: true, txHash: h, gasLimit: gas, error: "reverted onchain" };
        }
      }
      const now = this.o.now();
      if (!rebroadcasted && now - lastAct >= reb) {
        rebroadcasted = true;
        try {
          await this.broadcast(raw, true);
          this.log.push(`rebroadcast ${keccak256(raw)}`);
        } catch {
          // the replacement path below still runs
        }
      }
      if (now - lastAct >= rep) {
        if (replacements >= maxRep) {
          this.o.alerts?.raise({ code: AlertCode.NONCE_STUCK, severity: "action", message: `${this.o.role}: ${fn} nonce ${nonce} unmined after ${replacements} replacements (${hashes.join(", ")})` });
          if (now - lastAct >= rep + (this.o.giveUpS ?? rep)) {
            this.nonce = null;
            return { ok: false, sent: true, txHash: hashes[hashes.length - 1]!, gasLimit: gas, error: "NONCE_STUCK" };
          }
        } else {
          fees = { maxFeePerGas: (fees.maxFeePerGas * 125n + 99n) / 100n, maxPriorityFeePerGas: (fees.maxPriorityFeePerGas * 125n + 99n) / 100n };
          if (this.o.maxFeeGwei !== undefined) {
            const capFee = BigInt(Math.floor(this.o.maxFeeGwei * 1e9));
            if (fees.maxFeePerGas > capFee) fees.maxFeePerGas = capFee;
            if (fees.maxPriorityFeePerGas > fees.maxFeePerGas) fees.maxPriorityFeePerGas = fees.maxFeePerGas;
          }
          try {
            raw = await this.sign({ nonce, gas, ...fees, data });
            const r = await this.broadcast(raw);
            if (r === "nonce-low") {
              // an earlier version of ours landed: the receipt loop finds it
              this.log.push(`replacement refused, nonce ${nonce} already used`);
            } else {
              hashes.push(keccak256(raw));
              this.log.push(`replaced nonce ${nonce} -> ${keccak256(raw)}`);
            }
          } catch (e) {
            this.log.push(`replacement failed: ${short(e)}`);
          }
          replacements++;
          lastAct = now;
          rebroadcasted = false;
        }
      }
      await this.sleep(this.o.pollMs ?? 1000);
    }
  }
}

export function measuredFromEnv(env: Record<string, string | undefined>): Partial<Record<string, bigint>> {
  const out: Partial<Record<string, bigint>> = {};
  if (env.AGATE_GAS_MEASURED) {
    const j = JSON.parse(env.AGATE_GAS_MEASURED) as Record<string, number | string>;
    for (const [k, v] of Object.entries(j)) out[k] = BigInt(v);
  }
  return out;
}
