// agate's own Dynamic server wallets (TSS-MPC, 2-of-2 with Dynamic), e.g. the payer. Dynamic's server-wallet SDK
// needs Node's native addons (its key generation hangs under bun), so each MPC operation runs in a short Node
// worker (scripts/sw-node.mjs) over stdin/stdout pipes; our key shares stay sealed in the store and are never logged.
import { join } from "node:path";
import type { Address, Hex, LocalAccount, SignableMessage, TransactionSerializable } from "viem";
import { toAccount } from "viem/accounts";
import { config, requireSecret } from "../config.ts";
import type { Store } from "../store.ts";

type Materials = { walletMetadata: { walletId?: string; accountAddress?: string } & Record<string, unknown>; externalServerKeyShares: unknown[] };

const WORKER = join(import.meta.dir, "../../scripts/sw-node.mjs");
const enc = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? { __bigint: x.toString() } : x));

async function worker<T>(req: Record<string, unknown>, timeoutMs = 120_000): Promise<T & { ms: number }> {
  const p = Bun.spawn(["node", WORKER], { cwd: join(import.meta.dir, "../.."), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  p.stdin.write(enc({ ...req, environmentId: config.environmentId, apiKey: requireSecret("DYNAMIC_API_KEY", "api.env") }));
  await p.stdin.end();
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`server-wallet worker failed (${code}): ${err.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 400)}`);
  return JSON.parse(out) as T & { ms: number };
}

export async function createServerWallet(store: Store, label: string): Promise<{ walletId: string; address: Address; ms: number }> {
  if (store.serverWallet(label)) throw new Error(`server wallet ${label} exists`);
  const r = await worker<Materials>({ op: "create" });
  const walletId = String(r.walletMetadata.walletId);
  const address = r.walletMetadata.accountAddress as Address;
  store.putServerWallet(label, walletId, address, { walletMetadata: r.walletMetadata, externalServerKeyShares: r.externalServerKeyShares });
  return { walletId, address, ms: r.ms };
}

/** Signs a transaction with a server wallet; `context` carries the transaction for Transaction Review and, once
 *  Dynamic supports Monad, its policy engine. Returns the signed serialized transaction (not sent). */
export async function serverSignTransaction(store: Store, label: string, tx: TransactionSerializable): Promise<{ signed: Hex; ms: number }> {
  const w = store.serverWallet(label);
  if (!w) throw new Error(`no server wallet ${label}`);
  const m = w.materials as Materials;
  const context = { evmTransaction: { chainId: tx.chainId, to: tx.to, data: tx.data ?? "0x", value: `0x${(tx.value ?? 0n).toString(16)}` } };
  return worker<{ signed: Hex }>({ op: "signTransaction", walletMetadata: m.walletMetadata, externalServerKeyShares: m.externalServerKeyShares, transaction: tx, context });
}

/** Signs a message (EIP-191) with a server wallet; a smart account's user operation hash goes in as { raw }. */
export async function serverSignMessage(store: Store, label: string, message: SignableMessage): Promise<{ signature: Hex; ms: number }> {
  const w = store.serverWallet(label);
  if (!w) throw new Error(`no server wallet ${label}`);
  const m = w.materials as Materials;
  const evmMessage = typeof message === "string" ? message : typeof message.raw === "string" ? message.raw : `0x${Buffer.from(message.raw).toString("hex")}`;
  const raw = typeof message === "string" ? message : { raw: evmMessage };
  return worker<{ signature: Hex }>({ op: "signMessage", walletMetadata: m.walletMetadata, externalServerKeyShares: m.externalServerKeyShares, message: raw, context: { evmMessage } });
}

/** A server wallet as a viem account (it signs messages; transactions go through serverSignTransaction). */
export function serverWalletAccount(store: Store, label: string, log?: (e: Record<string, unknown>) => void): LocalAccount {
  const w = store.serverWallet(label);
  if (!w) throw new Error(`no server wallet ${label}`);
  return toAccount({
    address: w.address as Address,
    async signMessage({ message }) {
      const r = await serverSignMessage(store, label, message);
      log?.({ event: "server_wallet.signed", label, ms: r.ms });
      return r.signature;
    },
    async signTypedData() {
      throw new Error("this server wallet signs messages only");
    },
    async signTransaction() {
      throw new Error("use serverSignTransaction for raw transactions");
    },
  });
}
