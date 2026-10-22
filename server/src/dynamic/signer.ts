// Signing as a user's delegated wallet (the Assistant): Dynamic holds one share, we hold the delegated share, and
// Dynamic co-signs only after asking our Transaction Review endpoint. Every user operation is registered as an
// intent first and carries Dynamic's SignMessageContext.evmUserOperation, so Review (and Dynamic's policy engine, the
// day it supports Monad) sees the calls and not a bare hash.
import { createDelegatedEvmWalletClient, delegatedSignMessage, delegatedSignTypedData, type DelegatedEvmWalletClient } from "@dynamic-labs-wallet/node-evm";
import { randomUUID } from "node:crypto";
import { type Address, type Hex, type LocalAccount, toHex } from "viem";
import { toAccount } from "viem/accounts";
import { entryPoint07Address, formatUserOperationRequest, getUserOperationHash, type UserOperationReceipt } from "viem/account-abstraction";
import type { AccountClient, Call } from "@agate/wallet";
import { config, requireSecret } from "../config.ts";
import type { IntentKind, Store } from "../store.ts";

export type SignContext = { current?: Record<string, unknown> };

let client: DelegatedEvmWalletClient | undefined;
export function delegatedClient(): DelegatedEvmWalletClient {
  // errorLogging off: from 1.1.47 the SDK otherwise ships every error (wallet id, cause chain) to Dynamic's log intake
  client ??= createDelegatedEvmWalletClient({ environmentId: config.environmentId, apiKey: requireSecret("DYNAMIC_API_KEY", "api.env"), errorLogging: false });
  return client;
}

/** Dynamic's MPC signing fails transiently now and then (3 of 19 on Oct 4, after ~22 s): retry, but only while the
 *  intent Transaction Review checks is still alive. */
async function withRetry<T>(what: string, deadline: number, f: () => Promise<T>, onRetry?: (n: number, e: Error) => void): Promise<T> {
  let last: Error | undefined;
  for (let n = 0; n < 3 && Date.now() < deadline; n++) {
    try {
      return await f();
    } catch (e) {
      last = e as Error;
      if (/denied|review|policy/i.test(last.message)) throw last; // a refusal is an answer, not a glitch
      onRetry?.(n + 1, last);
    }
  }
  throw new Error(`${what}: ${last?.message ?? "deadline passed"}`);
}

/** The delegated wallet as a viem account. `ctx.current`, when set, travels with each message signature. */
export function delegatedAccount(store: Store, walletId: string, ctx: SignContext, deadline: () => number, log?: (e: Record<string, unknown>) => void): LocalAccount {
  const del = store.delegation(walletId);
  if (!del || del.status !== "active") throw new Error(`no active delegation for wallet ${walletId}`);
  const creds = () => {
    const m = store.materials(walletId);
    if (!m) throw new Error(`delegation materials for ${walletId} are gone (revoked)`);
    return { walletId, walletApiKey: m.walletApiKey, keyShare: m.keyShare as never };
  };
  const retried = (n: number, e: Error) => log?.({ event: "sign.retry", walletId, attempt: n, error: e.message.slice(0, 160) });
  return toAccount({
    address: del.address,
    async signMessage({ message }) {
      return (await withRetry("delegated signMessage", deadline(), () => delegatedSignMessage(delegatedClient(), { ...creds(), message: message as never, context: ctx.current as never }), retried)) as Hex;
    },
    async signTypedData(typedData) {
      return (await withRetry("delegated signTypedData", deadline(), () => delegatedSignTypedData(delegatedClient(), { ...creds(), typedData: typedData as never }), retried)) as Hex;
    },
    async signTransaction() {
      throw new Error("the Assistant signs user operations only");
    },
  });
}

const OP_FIELDS = [
  "sender",
  "nonce",
  "factory",
  "factoryData",
  "callData",
  "callGasLimit",
  "verificationGasLimit",
  "preVerificationGas",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "paymaster",
  "paymasterVerificationGasLimit",
  "paymasterPostOpGasLimit",
  "paymasterData",
] as const;

export type SendResult = { intentId: string; userOpHash: Hex; receipt: UserOperationReceipt; ms: { prepare: number; sign: number; land: number } };

/** The bundler accepted the operation but its receipt did not come back in time: it may still land, so callers count
 *  it as sent and never send it again. */
export class NotLandedYet extends Error {
  constructor(
    readonly userOpHash: Hex,
    cause: unknown,
  ) {
    super(`sent as ${userOpHash} but not seen landing yet: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = "NotLandedYet";
  }
}

/** Prepare -> register the intent -> sign with context -> submit -> wait. `account` must be the client's account and
 *  sign through `ctx` (a pocket session account over delegatedAccount, or a Kernel owned by it). */
export async function sendWithIntent(p: {
  store: Store;
  client: AccountClient;
  ctx: SignContext;
  walletId: string;
  kind: IntentKind;
  calls: Call[];
  grantId?: string | null;
  /** test hook: what Transaction Review is shown, instead of the real operation */
  contextOverride?: (op: Record<string, unknown>) => Record<string, unknown>;
}): Promise<SendResult> {
  const t0 = Date.now();
  const prepared = (await p.client.prepareUserOperation({ calls: p.calls })) as Record<string, unknown> & { sender: Address; callData: Hex };
  const hash = getUserOperationHash({ userOperation: prepared as never, entryPointAddress: entryPoint07Address, entryPointVersion: "0.7", chainId: config.chainId });
  const intentId = randomUUID();
  const now = Date.now();
  p.store.putIntent({ id: intentId, kind: p.kind, walletId: p.walletId, account: prepared.sender, hash, callData: prepared.callData, grantId: p.grantId ?? null, createdAt: now, expiresAt: now + config.intentTtlMs });
  const operation = Object.fromEntries(OP_FIELDS.filter((k) => prepared[k] !== undefined).map((k) => [k, typeof prepared[k] === "bigint" ? toHex(prepared[k] as bigint) : prepared[k]]));
  const evmUserOperation = { chainId: config.chainId, entryPoint: entryPoint07Address, sender: prepared.sender, callData: prepared.callData, operation };
  p.ctx.current = { evmUserOperation: p.contextOverride ? p.contextOverride(evmUserOperation) : evmUserOperation };
  const t1 = Date.now();
  let signature: Hex;
  try {
    signature = await (p.client.account as unknown as { signUserOperation(op: unknown): Promise<Hex> }).signUserOperation(prepared);
  } finally {
    p.ctx.current = undefined;
  }
  const t2 = Date.now();
  const userOpHash = (await p.client.request({ method: "eth_sendUserOperation", params: [formatUserOperationRequest({ ...(prepared as object), signature } as never), entryPoint07Address] } as never)) as Hex;
  let receipt: UserOperationReceipt;
  try {
    receipt = await p.client.waitForUserOperationReceipt({ hash: userOpHash, timeout: 120_000 });
  } catch (e) {
    throw new NotLandedYet(userOpHash, e);
  }
  p.store.dropIntent(intentId);
  return { intentId, userOpHash, receipt, ms: { prepare: t1 - t0, sign: t2 - t1, land: Date.now() - t2 } };
}
