// agate's own Dynamic server wallets (live test 5; the payer moves onto one once the wallet packages land).
//   bun run scripts/server-wallet.ts create <label>     make a TWO_OF_TWO MPC wallet; our shares sealed in the store
//   bun run scripts/server-wallet.ts sign <label> [n]   sign n EIP-1559 txs for 10143 (not sent), recover, time them
//   bun run scripts/server-wallet.ts send <label>       sign + broadcast one 0-value self-transfer (needs MON on it)
// Prints addresses, ids and timings only; never a key share.
import { createPublicClient, defineChain, type Hex, http, recoverTransactionAddress, type TransactionSerializable } from "viem";
import { config } from "../src/config.ts";
import { createServerWallet, serverSignTransaction } from "../src/dynamic/serverWallet.ts";
import { Store } from "../src/store.ts";

const [cmd, label = "payer", nArg] = process.argv.slice(2);
const store = new Store();
const chain = defineChain({ id: config.chainId, name: "Monad Testnet", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } });
const pc = createPublicClient({ chain, transport: http(config.rpcUrl) });

if (cmd === "create") {
  console.log(JSON.stringify(await createServerWallet(store, label)));
} else if (cmd === "sign" || cmd === "send") {
  const w = store.serverWallet(label);
  if (!w) throw new Error(`no server wallet ${label}`);
  const n = cmd === "send" ? 1 : Number(nArg ?? 5);
  const fees = await pc.estimateFeesPerGas();
  const nonce = await pc.getTransactionCount({ address: w.address });
  for (let i = 0; i < n; i++) {
    const tx: TransactionSerializable = { chainId: config.chainId, type: "eip1559", to: w.address, value: 0n, data: "0x", gas: 21_000n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, nonce: nonce + i };
    const t0 = performance.now();
    const { signed, ms } = await serverSignTransaction(store, label, tx);
    const from = await recoverTransactionAddress({ serializedTransaction: signed as never });
    const line: Record<string, unknown> = { i, mpcMs: ms, totalMs: Math.round(performance.now() - t0), recoversTo: from.toLowerCase() === w.address.toLowerCase() };
    if (cmd === "send") {
      const hash = await pc.sendRawTransaction({ serializedTransaction: signed as Hex });
      const rc = await pc.waitForTransactionReceipt({ hash, timeout: 60_000 });
      Object.assign(line, { hash, status: rc.status, block: Number(rc.blockNumber) });
    }
    console.log(JSON.stringify(line));
  }
} else {
  console.log("usage: create <label> | sign <label> [n] | send <label>");
}
process.exit(0);
