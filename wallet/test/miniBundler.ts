// A tiny in-process ERC-4337 "bundler" for the anvil fork only. It answers the bundler RPC methods the ZeroDev
// kernel client calls and executes each user operation by calling EntryPoint 0.7 handleOps from an anvil test
// account. No paymaster: the smart account pays its own prefund (ZeroDev's paymaster cannot sign for a fork).
// Everything else (eth_call, eth_getCode, ...) is forwarded to the fork RPC.
import {
  type Address,
  type Hash,
  type Hex,
  type LocalAccount,
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  http,
  toHex,
} from "viem";
import {
  entryPoint07Abi,
  entryPoint07Address,
  formatUserOperation,
  getUserOperationHash,
  toPackedUserOperation,
} from "viem/account-abstraction";
import { monadTestnet } from "../src/chain.ts";

export function miniBundler(forkRpc: string, executor: LocalAccount) {
  const wallet = createWalletClient({ account: executor, chain: monadTestnet, transport: http(forkRpc) });
  const opTx = new Map<Hash, Hash>();
  const forward = async (method: string, params: unknown) => {
    const res = await fetch(forkRpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
    });
    const j = (await res.json()) as { result?: unknown; error?: { message: string; data?: unknown } };
    if (j.error) throw Object.assign(new Error(j.error.message), { data: j.error.data });
    return j.result;
  };
  const stats = { sent: 0 };

  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const p = (params ?? []) as unknown[];
      switch (method) {
        case "eth_supportedEntryPoints":
          return [entryPoint07Address];
        case "eth_estimateUserOperationGas":
          // Fixed, generous limits; the fork does not bill the declared limit the way Monad does.
          return {
            preVerificationGas: toHex(100_000),
            verificationGasLimit: toHex(8_000_000),
            callGasLimit: toHex(1_000_000),
            paymasterVerificationGasLimit: toHex(0),
            paymasterPostOpGasLimit: toHex(0),
          };
        case "zd_getUserOperationGasPrice":
        case "pimlico_getUserOperationGasPrice": {
          const gp = BigInt((await forward("eth_gasPrice", [])) as string);
          const tier = { maxFeePerGas: toHex(gp * 2n), maxPriorityFeePerGas: toHex(gp) };
          return { slow: tier, standard: tier, fast: tier };
        }
        case "eth_sendUserOperation": {
          const userOp = formatUserOperation(p[0] as never);
          const hash = getUserOperationHash({
            userOperation: userOp,
            entryPointAddress: entryPoint07Address,
            entryPointVersion: "0.7",
            chainId: monadTestnet.id,
          });
          const call = {
            address: entryPoint07Address,
            abi: entryPoint07Abi,
            functionName: "handleOps",
            args: [[toPackedUserOperation(userOp)], executor.address],
          } as const;
          // a refusal at validation surfaces as FailedOp(index, "AA2x ...") from a dry run, with its reason
          try {
            await createPublicClient({ chain: monadTestnet, transport: http(forkRpc) }).simulateContract({ ...call, account: executor });
          } catch (e) {
            const err = e as { shortMessage?: string; metaMessages?: string[] };
            throw new Error(`handleOps refused: ${err.shortMessage ?? ""} ${(err.metaMessages ?? []).join(" ")}`.trim());
          }
          const tx = await wallet.writeContract({ ...call, gas: 20_000_000n });
          opTx.set(hash, tx);
          stats.sent++;
          return hash;
        }
        case "eth_getUserOperationReceipt": {
          const tx = opTx.get(p[0] as Hash);
          if (!tx) return null;
          const receipt = (await forward("eth_getTransactionReceipt", [tx])) as {
            status: Hex;
            from: Address;
            logs: { address: Address; topics: [Hex, ...Hex[]]; data: Hex }[];
          } | null;
          if (!receipt) return null;
          if (receipt.status !== "0x1") throw new Error(`handleOps reverted in tx ${tx}`);
          for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== entryPoint07Address.toLowerCase()) continue;
            try {
              const ev = decodeEventLog({ abi: entryPoint07Abi, data: log.data, topics: log.topics });
              if (ev.eventName !== "UserOperationEvent" || ev.args.userOpHash !== p[0]) continue;
              return {
                userOpHash: ev.args.userOpHash,
                entryPoint: entryPoint07Address,
                sender: ev.args.sender,
                nonce: toHex(ev.args.nonce),
                paymaster: ev.args.paymaster,
                actualGasCost: toHex(ev.args.actualGasCost),
                actualGasUsed: toHex(ev.args.actualGasUsed),
                success: ev.args.success,
                reason: "",
                logs: receipt.logs,
                receipt,
              };
            } catch {}
          }
          throw new Error(`no UserOperationEvent for ${p[0]} in ${tx}`);
        }
        default:
          return forward(method, params);
      }
    },
  });
  return { transport, stats };
}
