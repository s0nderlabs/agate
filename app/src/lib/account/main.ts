// The person's accounts on Monad (wallet spec 2.4, 2.7), browser only: the main account (Kernel v3.1, index 0) and the
// AI pockets (index 1, 2, ...), all owned by the main embedded wallet and sent through ZeroDev with the fee sponsored.
// Never Dynamic's own ZeroDev provider (Kernel v3.3 in 7702 mode: another address). Sends run one at a time per
// account (the nonce), across tabs too, and the signer reports "signing" while Dynamic signs.
import type { Address } from "viem";
import type { UserOperationReceipt } from "viem/account-abstraction";
import { getAgate } from "@/lib/data/agate";
import { getDynamic, getWalletLib, ZERODEV_RPC, type WalletLib } from "./dynamic";
import type { OnStep, PlanCall } from "./types";

type KernelClient = ReturnType<WalletLib["accountClient"]>;

/** The main account's address for an embedded wallet, without anyone signing. */
export async function mainAddressOf(owner: string, index = 0): Promise<string> {
  const [agate, w] = await Promise.all([getAgate(), getWalletLib()]);
  return w.kernelAddress(agate.pub, owner as Address, BigInt(index));
}

// the step callback of the send in flight: the signer calls it when Dynamic starts signing
let onSigning: (() => void) | null = null;
const clients = new Map<string, Promise<KernelClient>>();

/** The sending client of `owner`'s account at `index`, built on first use and kept until sign out. */
function kernelClient(owner: string, index: number): Promise<KernelClient> {
  const key = `${owner.toLowerCase()}:${index}`;
  let c = clients.get(key);
  if (!c) {
    c = (async () => {
      const [{ lib, client }, agate, w] = await Promise.all([getDynamic(), getAgate(), getWalletLib()]);
      const ws = lib.wallets(client);
      if (!ws || ws.main.address.toLowerCase() !== owner.toLowerCase()) throw new Error("UserNotAuthenticatedError: sign in again");
      const signer = await lib.walletSigner(client, ws.main);
      const signing = {
        ...signer,
        signMessage: async (a: Parameters<typeof signer.signMessage>[0]) => {
          onSigning?.();
          return signer.signMessage(a);
        },
        signTypedData: async (a: Parameters<typeof signer.signTypedData>[0]) => {
          onSigning?.();
          return signer.signTypedData(a as never);
        },
      } as typeof signer;
      const account = await w.kernelAccount(agate.pub, signing, BigInt(index));
      return w.accountClient(account, agate.pub, w.zerodev(ZERODEV_RPC));
    })();
    clients.set(key, c);
    c.catch(() => clients.delete(key));
  }
  return c;
}

/** Sign out: the clients belong to the person who signed them. */
export function forgetClients() {
  clients.clear();
}

// one send at a time in this tab; navigator.locks keeps two tabs of the same account apart (AA25, the nonce)
let queue: Promise<unknown> = Promise.resolve();

/** Sends `calls` as ONE sponsored user operation from `owner`'s account at `index` and waits for its receipt.
 *  onStep: "signing" while Dynamic signs, "sending" with the operation's hash once the bundler has it. */
export function sendCalls(owner: string, index: number, address: string, calls: readonly PlanCall[], onStep?: OnStep): Promise<UserOperationReceipt> {
  const run = async () => {
    const kc = await kernelClient(owner, index);
    onSigning = () => onStep?.("signing");
    try {
      const hash = await kc.sendUserOperation({ calls: calls.map((c) => ({ to: c.to as Address, value: c.value, data: c.data as `0x${string}` })) });
      onSigning = null;
      onStep?.("sending", hash);
      return await kc.waitForUserOperationReceipt({ hash, timeout: 120_000 });
    } finally {
      onSigning = null;
    }
  };
  const locked = (): Promise<UserOperationReceipt> =>
    typeof navigator !== "undefined" && navigator.locks ? (navigator.locks.request(`agate-send-${address.toLowerCase()}`, run) as unknown as Promise<UserOperationReceipt>) : run();
  const p = queue.then(locked, locked);
  queue = p.catch(() => {});
  return p;
}
