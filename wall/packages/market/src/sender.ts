// BOTS-SPEC 2.3: one MarketSender per key per process, multi-target, with MS 9.1's gas policy (Monad bills the gas
// LIMIT, and a revert costs the whole limit):
//   1. simulate with eth_call at `latest` from the sender's address; a revert is never sent
//   2. estimate with eth_estimateGas at `latest`
//   3. gasLimit = min(CAP, ceil(1.2 x estimate)), CAP = 1.5 x (LIMIT(shape, c, n) + 21,000 + calldataGas); above CAP:
//      not sent, GAS_CAP (action)
//   4. fees from estimateFeesPerGas, maxFeePerGas capped by AGATE_MAX_FEE_GWEI (default 200)
//   5. nonce, the per-key SendLock, rebroadcast and replace exactly as the wall's TxSender (copied, not imported: its
//      simulate runs at `pending` and its gas rule is the wall's)
//   6. the result carries costWei = gasLimit x effectiveGasPrice and the receipt's logs
//   7. AGATE_DRY_RUN=1: steps 1 to 4 run and are logged; nothing is signed
// A spend guard (the MON budget of 2.6) is asked before signing (not in a dry run) and told every receipt's cost.
import { type Abi, type Address, BaseError, decodeErrorResult, decodeFunctionResult, encodeFunctionData, type Hex, keccak256, type Log, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { alertId, readKey, RpcDown, type RpcPool, type SendLock, type AlertSink } from "@agate/watcher";
import { capFor, type LimitTable } from "./limits.ts";
import { kuruMarginAccountAbi, kuruOrderBookAbi } from "./kuru-abi.ts";
import type { Sender, SendResult, SendSpec, SimResult } from "./types.ts";

export class KeyMissing extends Error {}

export interface SpendGuard {
  /** May a transaction that can cost up to costMaxWei be signed now? */
  canSpend(costMaxWei: bigint, safety: boolean): { ok: true } | { ok: false; why: string };
  /** A receipt's cost (gasLimit x effectiveGasPrice). */
  record(costWei: bigint, safety: boolean): void;
}

/** What a send would do now, before any signature: the simulation, the estimate and the gas and fee figures. */
export interface Plan {
  ok: boolean;
  result?: unknown;
  error?: string;
  data?: Hex;
  estimate?: bigint;
  cap?: bigint;
  gasLimit?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  costMaxWei?: bigint;
}

/** A sender the payer can ask what a send would cost before it sends (BOTS-SPEC 4.5). */
export interface PlanningSender extends Sender {
  plan(s: SendSpec): Promise<Plan>;
  fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
}

export interface MarketSenderOptions {
  pool: RpcPool;
  role: string;
  /** the variable holding the signing key (holdKey moved it into memory); absent only in a dry run */
  keyEnv?: string;
  /** the sender's address when there is no key (a dry run) */
  from?: Address;
  dryRun?: boolean;
  limits: LimitTable;
  alerts?: AlertSink;
  maxFeeGwei?: number;
  guard?: SpendGuard;
  lock?: SendLock;
  /** seconds, the local clock (rebroadcast and replacement timing only) */
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  rebroadcastS?: number;
  replaceS?: number;
  maxReplacements?: number;
  giveUpS?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

const GENERIC_ERRORS: Abi = [
  { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] },
  { type: "error", name: "Panic", inputs: [{ name: "code", type: "uint256" }] },
];

/** The decoded name and arguments of a revert, from the target's ABI plus Kuru's errors; else viem's short message. */
export function revertReason(e: unknown, abi: Abi): string {
  if (e instanceof BaseError) {
    const named = e.walk((x) => typeof (x as { data?: { errorName?: unknown } }).data === "object" && typeof (x as { data?: { errorName?: unknown } }).data?.errorName === "string") as { data?: { errorName: string; args?: readonly unknown[] } } | null;
    if (named?.data) return `${named.data.errorName}(${(named.data.args ?? []).map(String).join(", ")})`;
    const raw = (e.walk((x) => typeof (x as { data?: unknown }).data === "string") as { data?: Hex } | null)?.data;
    if (raw && raw.length >= 10) {
      try {
        const d = decodeErrorResult({ abi: [...abi, ...kuruOrderBookAbi, ...kuruMarginAccountAbi, ...GENERIC_ERRORS] as Abi, data: raw });
        return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`;
      } catch {
        return `revert ${raw.slice(0, 10)}`;
      }
    }
    return e.shortMessage;
  }
  return e instanceof Error ? e.message.split("\n")[0]! : String(e);
}

/** The GAS_CAP alert's key: role, shape and target (lowercase), so only the same bot's same call clears it. */
export function gasCapKey(role: string, shape: string, to: string): string {
  return `${role}:${shape}:${to}`.toLowerCase();
}

/** The error name alone: "NotReady(...)" -> "NotReady". */
export function errorName(text: string | undefined): string {
  return (text ?? "").replace(/^estimate: /, "").replace(/\(.*$/s, "").trim();
}

function shortErr(e: unknown): string {
  if (e instanceof BaseError) return e.shortMessage;
  return e instanceof Error ? e.message.split("\n")[0]! : String(e);
}

/** The error text of a broadcast whose outcome is unknown (SendResult sent: true, ok: false). */
export const BROADCAST_UNCONFIRMED = "BROADCAST_UNCONFIRMED";
/** The error text of a send whose receipt has a revert status: the only sent: true failure that is the chain's refusal
 *  (BROADCAST_UNCONFIRMED and NONCE_STUCK are sends whose outcome is not known yet). */
export const REVERTED_ONCHAIN = "reverted onchain";

const sendAppError = (e: unknown) => {
  const m = `${(e as Error)?.message ?? e}`.toLowerCase();
  return m.includes("revert") || m.includes("nonce too low") || m.includes("already known") || m.includes("known transaction") || m.includes("underpriced") || m.includes("insufficient funds") || m.includes("nonce too high");
};

/** One landed send, for gas tables (the maker's fork test prints them); the newest SENT_KEEP are kept. */
export interface SentRecord {
  label: string;
  shape: string;
  gasLimit: bigint;
  gasUsed?: bigint;
  costWei: bigint;
  txHash: Hex;
  ok: boolean;
}
export const SENT_KEEP = 1_000;

export class MarketSender implements PlanningSender {
  readonly from: Address;
  private nonce: number | null = null;
  /** the local counter kept across a soft refresh (refreshNonce) */
  private nonceFloor: number | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  readonly log: string[] = [];
  readonly sent: SentRecord[] = [];

  constructor(readonly o: MarketSenderOptions) {
    if (o.keyEnv) {
      this.from = privateKeyToAccount(readKey(o.keyEnv)).address;
      if (o.from && o.from.toLowerCase() !== this.from.toLowerCase()) throw new KeyMissing(`${o.keyEnv} is not the key of the configured address`);
    } else if (o.dryRun && o.from) {
      this.from = o.from;
    } else {
      throw new KeyMissing("no signing key (and not a dry run with an address)");
    }
  }

  /** After an error: the next send reads the nonce at `pending` and takes it as it is (it may be lower than the local
   *  counter when a transaction was dropped). */
  resetNonce(): void {
    this.hardResetNonce();
  }

  private hardResetNonce(): void {
    this.nonce = null;
    this.nonceFloor = null;
  }

  /** After a websocket wake (BOTS-SPEC 2.3 step 5; audit P-L3): the nonce is read again at `pending`, but never below
   *  the local counter, because Monad's `pending` can lag `latest` by a few blocks right after our own transaction
   *  (MS Appendix C) and a stale read would fail "nonce too low" and drop the send. Every send before this one waited
   *  for its receipt, so the local counter is never ahead of the chain. */
  refreshNonce(): void {
    if (this.nonce !== null) this.nonceFloor = this.nonce;
    this.nonce = null;
  }

  private say(event: string, data: Record<string, unknown>): void {
    this.o.log?.(event, data);
  }

  private sleep(ms: number): Promise<void> {
    return this.o.sleep ? this.o.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  private encode(s: SendSpec): Hex {
    return encodeFunctionData({ abi: s.abi, functionName: s.functionName, args: s.args as unknown[] });
  }

  /** Step 1 alone. A revert is {ok: false}; no answer from any URL throws RpcDown. */
  async simulate(s: SendSpec): Promise<SimResult> {
    const data = this.encode(s);
    try {
      const r = await this.o.pool.call((c) => c.call({ account: this.from, to: s.to, data, blockTag: "latest" }));
      let result: unknown;
      try {
        result = r.data ? decodeFunctionResult({ abi: s.abi, functionName: s.functionName, data: r.data }) : undefined;
      } catch {
        result = undefined;
      }
      return { ok: true, result };
    } catch (e) {
      if (e instanceof RpcDown) throw e;
      return { ok: false, error: revertReason(e, s.abi) };
    }
  }

  /** Step 4: the fees a send would use now (maxFeePerGas capped by AGATE_MAX_FEE_GWEI, default 200). */
  async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const f = await this.o.pool.call((c) => c.estimateFeesPerGas());
    let maxFee = f.maxFeePerGas ?? 0n;
    let prio = f.maxPriorityFeePerGas ?? 0n;
    const cap = BigInt(Math.floor((this.o.maxFeeGwei ?? 200) * 1e9));
    if (maxFee > cap) maxFee = cap;
    if (prio > maxFee) prio = maxFee;
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: prio };
  }

  /** Steps 1 to 4: what a send would do now. RpcDown propagates. */
  async plan(s: SendSpec): Promise<Plan> {
    const data = this.encode(s);
    const sim = await this.simulate(s);
    if (!sim.ok) return { ok: false, data, ...(sim.error !== undefined ? { error: sim.error } : {}) };
    let estimate: bigint;
    try {
      estimate = await this.o.pool.call((c) => c.estimateGas({ account: this.from, to: s.to, data, blockTag: "latest" }));
    } catch (e) {
      if (e instanceof RpcDown) throw e;
      return { ok: false, data, result: sim.result, error: `estimate: ${revertReason(e, s.abi)}` };
    }
    const cap = capFor(this.o.limits, s.shape, data, { ...(s.c !== undefined ? { c: s.c } : {}), ...(s.n !== undefined ? { n: s.n } : {}), ...(s.adds !== undefined ? { adds: s.adds } : {}), ...(s.cancels !== undefined ? { cancels: s.cancels } : {}) });
    const want = (estimate * 6n + 4n) / 5n; // ceil(1.2 x estimate)
    // one GAS_CAP per (role, shape, target): the maker's sends never clear the payer's alert on a shared series, and a
    // claimMany that fits never clears a stuck settle (review finding, Oct 3)
    const key = gasCapKey(this.o.role, s.shape, s.to);
    if (want > cap) {
      const detail = { shape: s.shape, c: s.c ?? 0, n: s.n ?? 1, want: want.toString(), cap: cap.toString() };
      // a caller that splits on GAS_CAP (halved batches, sync chunks) is not stuck yet: a log line, not an action
      // alert that its next, smaller call would clear in the same breath (and notify again every tick)
      if (s.splitsOnCap) this.say("gas_cap_split", { label: s.label, ...detail });
      else this.o.alerts?.raise({ code: "GAS_CAP", severity: "action", key, message: `${this.o.role}: ${s.shape} (c ${s.c ?? 0}, n ${s.n ?? 1}) to ${s.to} needs ${want} gas (1.2 x estimate ${estimate}), cap ${cap}; not sent`, data: detail });
      return { ok: false, data, result: sim.result, estimate, cap, error: "GAS_CAP" };
    }
    const capId = alertId({ code: "GAS_CAP", key });
    this.o.alerts?.clearWhere((a) => a.id === capId);
    const gasLimit = want < cap ? want : cap;
    const f = await this.fees();
    return { ok: true, data, result: sim.result, estimate, cap, gasLimit, ...f, costMaxWei: gasLimit * f.maxFeePerGas };
  }

  send(s: SendSpec): Promise<SendResult> {
    const run = this.queue.then(() => this.flight(s));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async flight(s: SendSpec): Promise<SendResult> {
    const lock = this.o.lock;
    if (!lock || this.o.dryRun) return this.sendNow(s);
    const got = await lock.acquire({ role: this.o.role });
    if (!got) {
      this.say("send_lock_busy", { shape: s.shape });
      return { ok: false, sent: false, error: "key busy: another process holds the send lock" };
    }
    if (got.otherHolder) this.hardResetNonce(); // another process sent with this key: its nonces are not ours to floor
    try {
      return await this.sendNow(s);
    } finally {
      lock.release();
    }
  }

  private async receipt(hash: Hex) {
    try {
      return await this.o.pool.call((c) => c.getTransactionReceipt({ hash }), (e) => `${(e as Error)?.name}`.includes("TransactionReceiptNotFound") || `${(e as Error)?.message}`.includes("could not be found"));
    } catch (e) {
      if (e instanceof RpcDown) throw e;
      return null;
    }
  }

  private async sign(s: SendSpec, tx: { nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; data: Hex }): Promise<Hex> {
    if (!this.o.keyEnv) throw new KeyMissing("no signing key");
    const account = privateKeyToAccount(readKey(this.o.keyEnv));
    if (account.address.toLowerCase() !== this.from.toLowerCase()) throw new KeyMissing(`${this.o.keyEnv} changed while running`);
    return account.signTransaction({ chainId: this.o.pool.chainId, type: "eip1559", to: s.to, value: 0n, ...tx });
  }

  private async broadcast(raw: Hex, every = false): Promise<"ok" | "nonce-low" | "known"> {
    const one = async (c: PublicClient) => {
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
      const rs = await Promise.allSettled(this.o.pool.clients().map(one));
      const okv = rs.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<"ok" | "nonce-low" | "known"> | undefined;
      if (okv) return okv.value;
      throw (rs[0] as PromiseRejectedResult).reason;
    }
    return this.o.pool.call(one, sendAppError);
  }

  private landed(s: SendSpec, hash: Hex, gas: bigint, rc: { status: string; effectiveGasPrice?: bigint; gasUsed?: bigint; logs: readonly Log[] }): SendResult {
    const costWei = gas * (rc.effectiveGasPrice ?? 0n);
    this.o.guard?.record(costWei, s.safety === true);
    const ok = rc.status === "success";
    this.sent.push({ label: s.label ?? s.functionName, shape: s.shape, gasLimit: gas, ...(rc.gasUsed !== undefined ? { gasUsed: rc.gasUsed } : {}), costWei, txHash: hash, ok });
    if (this.sent.length > SENT_KEEP) this.sent.splice(0, this.sent.length - SENT_KEEP);
    this.say(ok ? "mined" : "reverted_onchain", { shape: s.shape, label: s.label, tx: hash, gasLimit: gas.toString(), ...(rc.gasUsed !== undefined ? { gasUsed: rc.gasUsed.toString() } : {}), costWei: costWei.toString() });
    return { ok, sent: true, txHash: hash, gasLimit: gas, costWei, logs: rc.logs, ...(ok ? {} : { error: REVERTED_ONCHAIN }) };
  }

  private async sendNow(s: SendSpec, retry = 0): Promise<SendResult> {
    let p: Plan;
    try {
      p = await this.plan(s);
    } catch (e) {
      return { ok: false, sent: false, error: shortErr(e) };
    }
    if (!p.ok) {
      this.say("send_refused", { shape: s.shape, label: s.label, error: p.error });
      return { ok: false, sent: false, ...(p.gasLimit !== undefined ? { gasLimit: p.gasLimit } : {}), error: p.error ?? "refused" };
    }
    const gas = p.gasLimit!;
    // a dry run stops before the spend guard: steps 1 to 4 are logged whatever the key holds, and asking the budget
    // would have its side effects (the day's alert) for a send that never happens
    if (this.o.dryRun) {
      this.say("dry_run", { shape: s.shape, label: s.label, to: s.to, fn: s.functionName, c: s.c ?? 0, n: s.n ?? 1, estimate: p.estimate!.toString(), gasLimit: gas.toString(), cap: p.cap!.toString(), costMaxWei: p.costMaxWei!.toString() });
      return { ok: false, sent: false, gasLimit: gas, error: "DRY_RUN" };
    }
    const g = this.o.guard?.canSpend(p.costMaxWei!, s.safety === true);
    if (g && !g.ok) {
      this.say("send_over_budget", { shape: s.shape, label: s.label, why: g.why, costMaxWei: p.costMaxWei!.toString() });
      return { ok: false, sent: false, gasLimit: gas, error: g.why };
    }
    let fees = { maxFeePerGas: p.maxFeePerGas!, maxPriorityFeePerGas: p.maxPriorityFeePerGas! };
    const data = p.data!;
    try {
      if (this.nonce === null) {
        const fetched = await this.o.pool.call((c) => c.getTransactionCount({ address: this.from, blockTag: "pending" }));
        this.nonce = this.nonceFloor !== null && this.nonceFloor > fetched ? this.nonceFloor : fetched;
        this.nonceFloor = null;
      }
    } catch (e) {
      this.nonce = null; // a soft refresh keeps its floor for the next read
      return { ok: false, sent: false, error: shortErr(e) };
    }
    const nonce = this.nonce;
    const hashes: Hex[] = [];
    let raw: Hex;
    try {
      raw = await this.sign(s, { nonce, gas, ...fees, data });
    } catch (e) {
      return { ok: false, sent: false, error: e instanceof KeyMissing ? e.message : shortErr(e) };
    }
    hashes.push(keccak256(raw));
    try {
      const r = await this.broadcast(raw);
      if (r === "nonce-low") {
        const rc = await this.receipt(hashes[0]!).catch(() => null);
        if (rc) {
          this.nonce = nonce + 1;
          return this.landed(s, hashes[0]!, gas, rc);
        }
        this.hardResetNonce();
        if (retry < 2) return this.sendNow(s, retry + 1);
        return { ok: false, sent: false, error: "nonce too low" };
      }
    } catch (e) {
      this.hardResetNonce();
      // only a node's own refusal (underpriced, insufficient funds, nonce too high, a revert) proves the transaction
      // went nowhere; a timeout or every URL failing after the request left may hide a node that took it, so the
      // outcome is unknown and the result says sent (audit M-M3): the caller keeps what it needs to find it
      if (!(e instanceof RpcDown) && sendAppError(e)) return { ok: false, sent: false, error: shortErr(e) };
      this.say("broadcast_unconfirmed", { shape: s.shape, label: s.label, nonce, tx: hashes[0], error: shortErr(e) });
      return { ok: false, sent: true, txHash: hashes[0]!, gasLimit: gas, error: `${BROADCAST_UNCONFIRMED}: ${shortErr(e)}` };
    }
    this.nonce = nonce + 1;
    this.say("sent", { shape: s.shape, label: s.label, nonce, gasLimit: gas.toString(), tx: hashes[0] });
    const t0 = this.o.now();
    let lastAct = t0;
    let replacements = 0;
    let rebroadcasted = false;
    const reb = this.o.rebroadcastS ?? 30;
    const rep = this.o.replaceS ?? 120;
    const maxRep = this.o.maxReplacements ?? 3;
    for (;;) {
      for (const h of hashes) {
        let rc: Awaited<ReturnType<MarketSender["receipt"]>>;
        try {
          rc = await this.receipt(h);
        } catch {
          rc = null; // every URL down: keep waiting
        }
        if (rc) return this.landed(s, h, gas, rc);
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
          this.o.alerts?.raise({ code: "NONCE_STUCK", severity: "action", key: s.to, message: `${this.o.role}: ${s.shape} nonce ${nonce} unmined after ${replacements} replacements (${hashes.join(", ")})` });
          if (now - lastAct >= rep + (this.o.giveUpS ?? rep)) {
            this.hardResetNonce();
            return { ok: false, sent: true, txHash: hashes[hashes.length - 1]!, gasLimit: gas, error: "NONCE_STUCK" };
          }
        } else {
          const next = { maxFeePerGas: (fees.maxFeePerGas * 125n + 99n) / 100n, maxPriorityFeePerGas: (fees.maxPriorityFeePerGas * 125n + 99n) / 100n };
          const capFee = BigInt(Math.floor((this.o.maxFeeGwei ?? 200) * 1e9));
          if (next.maxFeePerGas > capFee) next.maxFeePerGas = capFee;
          if (next.maxPriorityFeePerGas > next.maxFeePerGas) next.maxPriorityFeePerGas = next.maxFeePerGas;
          // the replacement's higher fee is a new costMax: the floor is asked again (as a safety send: only the floor,
          // never the day's pacing, which the first plan already passed; one of the two lands, not both). Refused: the
          // one in flight keeps waiting at its fee, and NONCE_STUCK follows if it never lands (review finding, Oct 3)
          const g = this.o.guard?.canSpend(gas * next.maxFeePerGas, true);
          if (g && !g.ok) {
            this.log.push(`replacement held: ${g.why}`);
            this.say("replacement_held", { shape: s.shape, label: s.label, nonce, why: g.why, costMaxWei: (gas * next.maxFeePerGas).toString() });
          } else {
            fees = next;
            try {
              raw = await this.sign(s, { nonce, gas, ...fees, data });
              const r = await this.broadcast(raw);
              if (r === "nonce-low") this.log.push(`replacement refused, nonce ${nonce} already used`);
              else {
                hashes.push(keccak256(raw));
                this.log.push(`replaced nonce ${nonce} -> ${keccak256(raw)}`);
              }
            } catch (e) {
              this.log.push(`replacement failed: ${shortErr(e)}`);
            }
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
