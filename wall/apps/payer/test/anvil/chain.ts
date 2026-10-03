// Local chains for the payer's tests: a local anvil or an anvil fork of Monad testnet, always through anvil-safe
// (wall/scripts/anvil.ts), after a free-disk check; the market contracts from a Foundry build of contracts/ (or
// a separate FOUNDRY_OUT); a clock the test owns (anvil's timestamp interval 0: time moves only by warp()).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Abi, type Address, createPublicClient, createWalletClient, defineChain, encodeFunctionData, type Hex, http, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { spawnAnvil } from "../../../../scripts/anvil.ts";

export const OUT = process.env.AGATE_FORGE_OUT ?? (existsSync(join(homedir(), ".agate-build/payer/out/MockKuruRouter.sol")) ? join(homedir(), ".agate-build/payer/out") : join(import.meta.dir, "../../../../../contracts/out"));
const NEEDED = ["AgateFactory", "AgateDollar", "AgateSeries", "AgateRouter", "MockIndex", "MockKuruRouter", "MockKuruOrderBook"];
export const haveArtifacts = NEEDED.every((c) => existsSync(join(OUT, `${c}.sol/${c}.json`)));
export const haveAnvil = Boolean(Bun.which("anvil")) && haveArtifacts;
export const MIN_FREE_GB = Number(process.env.AGATE_ANVIL_MIN_FREE_GB ?? 30);

/** `df -h /` first (house rule): the free GB of the root volume. */
export function freeGb(): number {
  const r = Bun.spawnSync(["df", "-Pk", "/"], { stdout: "pipe" });
  const line = r.stdout.toString().trim().split("\n")[1] ?? "";
  return Math.floor(Number(line.split(/\s+/)[3] ?? 0) / 1_048_576);
}

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}
export async function artifact(name: string): Promise<Artifact> {
  const j = await Bun.file(join(OUT, `${name}.sol/${name}.json`)).json();
  return { abi: j.abi, bytecode: j.bytecode.object };
}

export interface Chain {
  rpc: string;
  rpc2: string;
  chainId: number;
  pub: PublicClient;
  proc: Bun.Subprocess;
  call(method: string, params?: unknown[]): Promise<unknown>;
  wallet(key: Hex): WalletClient;
  time(): Promise<bigint>;
  warp(t: bigint): Promise<bigint>;
  mine(n?: number): Promise<void>;
  stop(): Promise<void>;
}

export async function startChain(args: string[] = []): Promise<Chain> {
  const gb = freeGb();
  if (gb < MIN_FREE_GB) throw new Error(`only ${gb} GB free (floor ${MIN_FREE_GB} GB): not starting anvil`);
  const { proc, port, rpc } = await spawnAnvil(["--code-size-limit", "131072", "--silent", "--slots-in-an-epoch", "1", ...args], { timeoutMs: 180_000 });
  const call = async (method: string, params: unknown[] = []) => {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = (await r.json()) as { result?: unknown; error?: { message: string } };
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };
  const chainId = Number(BigInt((await call("eth_chainId")) as string));
  await call("anvil_setBlockTimestampInterval", [0]);
  const chain = defineChain({ id: chainId, name: "anvil", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const transport = http(rpc, { retryCount: 0, timeout: 120_000 });
  const pub = createPublicClient({ chain, transport, cacheTime: 0 }) as PublicClient;
  const c: Chain = {
    rpc,
    rpc2: `http://localhost:${port}`,
    chainId,
    pub,
    proc,
    call,
    wallet: (key) => createWalletClient({ account: privateKeyToAccount(key), chain, transport }),
    async time() {
      return (await pub.getBlock({ blockTag: "latest" })).timestamp;
    },
    async warp(t) {
      const cur = await c.time();
      const at = t > cur ? t : cur + 1n;
      await call("evm_setNextBlockTimestamp", [Number(at)]);
      await call("evm_mine", []);
      return at;
    },
    async mine(n = 1) {
      for (let i = 0; i < n; i++) await call("evm_mine", []);
    },
    async stop() {
      proc.kill();
      await proc.exited;
    },
  };
  return c;
}

/** A transaction from `key`, waited for; throws when it reverts. */
export async function tx(c: Chain, key: Hex, to: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<{ hash: Hex; logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[] }> {
  const w = c.wallet(key);
  const data = encodeFunctionData({ abi, functionName, args: args as unknown[] });
  const hash = await w.sendTransaction({ to, data, account: w.account!, chain: w.chain, gas: 15_000_000n });
  const rc = await c.pub.waitForTransactionReceipt({ hash, pollingInterval: 50, timeout: 120_000 });
  if (rc.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
  return { hash, logs: rc.logs as never };
}

export async function deploy(c: Chain, key: Hex, a: Artifact, args: readonly unknown[] = []): Promise<Address> {
  const w = c.wallet(key);
  const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: w.account!, chain: w.chain, gas: 25_000_000n } as never);
  const rc = await c.pub.waitForTransactionReceipt({ hash, pollingInterval: 50, timeout: 120_000 });
  if (rc.status !== "success" || !rc.contractAddress) throw new Error(`deploy failed: ${hash}`);
  return rc.contractAddress;
}

export async function read<T>(c: Chain, to: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
  return (await c.pub.readContract({ address: to, abi, functionName, args: args as unknown[] })) as T;
}
