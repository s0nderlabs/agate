// A transaction signer backed by a Dynamic server wallet (TSS-MPC, 2-of-2 with Dynamic), so a bot holds no raw key.
// It ONLY signs: MarketSender keeps the nonce, the gas, the fees and the broadcast (its send route, meter and
// rebroadcast are untouched). Dynamic's server-wallet SDK needs Node's native addons, so each signature runs in a
// short Node worker (server/scripts/sw-node.mjs) over pipes: the API token and our key shares travel only on its
// stdin, never in an environment, an argument or a log. A signature that fails or times out throws, so the sender
// returns sent:false and does not use the nonce.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Address, getAddress, type Hex, parseTransaction, recoverTransactionAddress, type TransactionSerializableEIP1559 } from "viem";
import { childEnv } from "@agate/report/env";

export interface TxSigner {
  address: Address;
  /** the serialized, signed eip1559 transaction, not sent */
  signTransaction(tx: TransactionSerializableEIP1559): Promise<Hex>;
}

/** The signer did not answer, or answered with something that is not this transaction signed by this address. */
export class SignerDown extends Error {
  override name = "SignerDown";
}

/** What `server/scripts/payer-wallet.ts export` writes (mode 600): our half of the wallet, useless without Dynamic's. */
export interface DynamicWalletFile {
  environmentId: string;
  walletId: string;
  address: Address;
  walletMetadata: Record<string, unknown>;
  externalServerKeyShares: unknown[];
}

/** Reads the wallet file, refusing one that group or others can read. Errors name the file, never its contents. */
export function readWalletFile(path: string): DynamicWalletFile {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new SignerDown(`no Dynamic wallet file at ${path}`);
  }
  if ((mode & 0o077) !== 0) throw new SignerDown(`${path} must be readable by its owner only (chmod 600)`);
  let w: DynamicWalletFile;
  try {
    w = JSON.parse(readFileSync(path, "utf8")) as DynamicWalletFile;
  } catch {
    throw new SignerDown(`${path} is not a Dynamic wallet file`);
  }
  if (!w.environmentId || !w.walletId || !/^0x[0-9a-fA-F]{40}$/.test(String(w.address)) || !w.walletMetadata || !Array.isArray(w.externalServerKeyShares)) throw new SignerDown(`${path} is not a complete Dynamic wallet file`);
  return { ...w, address: getAddress(w.address) };
}

/** The worker the server already uses for its own server wallets (repo checkout layout). */
export const DEFAULT_WORKER = join(import.meta.dir, "../../../../server/scripts/sw-node.mjs");

const enc = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? { __bigint: x.toString() } : x));

/** Runs one worker request: the request goes on stdin, the answer comes on stdout. Kills it at the timeout. */
async function runWorker(worker: string, req: Record<string, unknown>, timeoutMs: number): Promise<string> {
  const p = Bun.spawn(["node", worker], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: childEnv() });
  p.stdin.write(enc(req));
  await p.stdin.end();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill();
  }, timeoutMs);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  if (timedOut) throw new SignerDown(`Dynamic signer timed out after ${Math.ceil(timeoutMs / 1000)} s`);
  // the worker's stderr is the SDK's error text; keep its last lines, short, with the token and any bearer header
  // blanked (an HTTP error dump can carry the request's auth header, and this text reaches alerts)
  if (code !== 0) {
    const token = String(req.apiKey ?? "");
    const tail = err.split("\n").filter(Boolean).slice(-2).join(" | ");
    const safe = (token ? tail.split(token).join("<token>") : tail).replace(/Bearer\s+[^\s"',}]+/gi, "Bearer <redacted>");
    throw new SignerDown(`Dynamic signer failed (exit ${code}): ${safe.slice(0, 300)}`);
  }
  return out;
}

export interface DynamicSignerOptions {
  wallet: DynamicWalletFile;
  /** the Dynamic API token, held in memory only */
  token: string;
  worker?: string;
  /** default 15 s (measured 4.9 to 6.5 s a signature on Oct 5), half the send lock's 30 s floor */
  timeoutMs?: number;
  /** tests: replaces the Node worker */
  run?: (req: Record<string, unknown>, timeoutMs: number) => Promise<string>;
}

export function dynamicSigner(o: DynamicSignerOptions): TxSigner {
  const timeoutMs = o.timeoutMs ?? 15_000;
  const run = o.run ?? ((req, t) => runWorker(o.worker ?? DEFAULT_WORKER, req, t));
  const address = o.wallet.address;
  return {
    address,
    async signTransaction(tx) {
      const context = { evmTransaction: { chainId: tx.chainId, to: tx.to, data: tx.data ?? "0x", value: `0x${(tx.value ?? 0n).toString(16)}` } };
      const out = await run({ op: "signTransaction", environmentId: o.wallet.environmentId, apiKey: o.token, walletMetadata: o.wallet.walletMetadata, externalServerKeyShares: o.wallet.externalServerKeyShares, transaction: tx, context }, timeoutMs);
      let signed: Hex;
      try {
        signed = (JSON.parse(out) as { signed: Hex }).signed;
      } catch {
        throw new SignerDown("Dynamic signer answered with something that is not JSON");
      }
      if (typeof signed !== "string" || !signed.startsWith("0x")) throw new SignerDown("Dynamic signer returned no signed transaction");
      // never broadcast what we did not ask for: the same transaction, signed by this wallet
      let back: ReturnType<typeof parseTransaction>;
      let by: Address;
      try {
        back = parseTransaction(signed);
        by = await recoverTransactionAddress({ serializedTransaction: signed as never });
      } catch {
        throw new SignerDown("Dynamic signer returned an unreadable transaction");
      }
      const same =
        back.type === "eip1559" &&
        back.chainId === tx.chainId &&
        back.nonce === tx.nonce &&
        back.gas === tx.gas &&
        back.maxFeePerGas === tx.maxFeePerGas &&
        back.maxPriorityFeePerGas === tx.maxPriorityFeePerGas &&
        (back.to ?? "").toLowerCase() === (tx.to ?? "").toLowerCase() &&
        (back.value ?? 0n) === (tx.value ?? 0n) &&
        (back.data ?? "0x").toLowerCase() === (tx.data ?? "0x").toLowerCase();
      if (!same) throw new SignerDown("Dynamic signer returned a different transaction than the one asked for");
      if (by.toLowerCase() !== address.toLowerCase()) throw new SignerDown(`Dynamic signer signed as ${by}, not ${address}`);
      return signed;
    },
  };
}
