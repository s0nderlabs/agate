// A private local anvil with the real AgateIndex (the contracts' forge build, its libraries linked here the way forge
// links them), Anvil's default test accounts, and a clock the harness owns: anvil's block time is frozen
// (timestamp interval 0) and only moves when warp() moves it. Local chain only, never a public network.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { agateIndexAbi } from "@agate/report/abi";
import type { Address, Hex } from "@agate/report/types";
import type { Panel } from "@agate/sources/types";
import { type Abi, createPublicClient, createWalletClient, defineChain, http, type PublicClient, toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { spawnAnvil } from "../../scripts/anvil.ts";

const MNEMONIC = "test test test test test test test test test test test junk"; // Anvil's public test mnemonic

/** Anvil default account i (local chain only): 0 owner, 1 primary, 2 standby, 3 attester, 4 guardian, 5 keeper, 6 kick. */
export function anvilKey(i: number): Hex {
  const pk = mnemonicToAccount(MNEMONIC, { addressIndex: i }).getHdKey().privateKey;
  if (!pk) throw new Error("no key");
  return toHex(pk);
}
export const ROLE = { owner: 0, primary: 1, standby: 2, attester: 3, guardian: 4, keeper: 5, kick: 6 } as const;
export const ADDR = Array.from({ length: 8 }, (_, i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }).address) as Address[];
export const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const SELECTOR = 2183018362218727504n;

export const ROOT = resolve(import.meta.dir, "../../..");
const OUT = join(ROOT, "contracts/out");
export const PANELS_FILE = join(ROOT, "wall/packages/sources/panels/default.json");
export const haveAnvil = (): boolean => Boolean(Bun.which("anvil") && existsSync(join(OUT, "AgateIndex.sol/AgateIndex.json")));

export interface Profile {
  name: "FAST" | "DEMO" | "TEST" | "PRODUCTION";
  day: number;
  slices: number;
  minReadings: number;
  qMin: number;
  demoLabel: boolean;
  signAll: boolean;
}
export const PROFILES: Record<Profile["name"], Profile> = {
  FAST: { name: "FAST", day: 24, slices: 2, minReadings: 1, qMin: 1, demoLabel: true, signAll: true },
  DEMO: { name: "DEMO", day: 600, slices: 4, minReadings: 2, qMin: 1, demoLabel: true, signAll: false },
  TEST: { name: "TEST", day: 2_400, slices: 12, minReadings: 6, qMin: 1, demoLabel: true, signAll: false },
  PRODUCTION: { name: "PRODUCTION", day: 86_400, slices: 24, minReadings: 12, qMin: 1, demoLabel: true, signAll: false },
};

export interface Anvil {
  rpc: string;
  port: number;
  chainId: number;
  pub: PublicClient;
  stop(): void;
  /** Moves block time to t (strictly forward) and mines one block there; time then stays frozen at t. */
  warp(t: number): Promise<number>;
  time(): Promise<number>;
  rpcCall(method: string, params: unknown[]): Promise<unknown>;
}

export async function startAnvil(startTs: number): Promise<Anvil> {
  const { proc, port, rpc } = await spawnAnvil(["--code-size-limit", "131072", "--silent", "--timestamp", String(startTs)]);
  const call = async (method: string, params: unknown[]) => {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = (await r.json()) as { result?: unknown; error?: { message: string } };
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };
  const chainId = Number(BigInt((await call("eth_chainId", [])) as string));
  await call("anvil_setBlockTimestampInterval", [0]);
  const chain = defineChain({ id: chainId, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const pub = createPublicClient({ chain, transport: http(rpc, { retryCount: 0 }), cacheTime: 0 }) as PublicClient;
  let last = 0;
  const a: Anvil = {
    rpc,
    port,
    chainId,
    pub,
    stop: () => proc.kill(),
    rpcCall: call,
    async time() {
      return Number((await pub.getBlock()).timestamp);
    },
    async warp(t) {
      if (last === 0) last = await a.time();
      const at = Math.max(t, last + 1);
      await call("evm_setNextBlockTimestamp", [at]);
      await call("evm_mine", []);
      last = at;
      return at;
    },
  };
  await a.warp(startTs);
  return a;
}

export function walletFor(a: Anvil, i: number) {
  const chain = defineChain({ id: a.chainId, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [a.rpc] } } });
  return createWalletClient({ account: mnemonicToAccount(MNEMONIC, { addressIndex: i }), chain, transport: http(a.rpc, { retryCount: 0 }) });
}

async function artifact(file: string, name: string): Promise<{ abi: Abi; bytecode: Hex; links: Record<string, Record<string, { start: number; length: number }[]>> }> {
  const j = await Bun.file(join(OUT, file, `${name}.json`)).json();
  return { abi: j.abi, bytecode: j.bytecode.object, links: j.bytecode.linkReferences ?? {} };
}

async function deployRaw(a: Anvil, abi: Abi, bytecode: Hex, args: readonly unknown[] = []): Promise<Address> {
  const w = walletFor(a, ROLE.owner);
  const hash = await w.deployContract({ abi, bytecode, args, account: w.account, chain: w.chain } as never);
  const rc = await a.pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success" || !rc.contractAddress) throw new Error(`deploy failed: ${hash}`);
  return rc.contractAddress;
}

async function linkedIndex(a: Anvil): Promise<{ abi: Abi; bytecode: Hex }> {
  const ix = await artifact("AgateIndex.sol", "AgateIndex");
  let code = ix.bytecode.slice(2);
  for (const libs of Object.values(ix.links)) {
    for (const [lib, refs] of Object.entries(libs)) {
      const l = await artifact(`${lib}.sol`, lib);
      if (Object.keys(l.links).length) throw new Error(`${lib} needs linking itself`);
      const addr = (await deployRaw(a, l.abi, l.bytecode)).slice(2).toLowerCase();
      for (const r of refs) code = code.slice(0, r.start * 2) + addr + code.slice(r.start * 2 + r.length * 2);
    }
  }
  if (code.includes("__$")) throw new Error("unlinked library left in AgateIndex");
  return { abi: ix.abi, bytecode: `0x${code}` };
}

export interface GpuReg {
  gpu: string;
  /** default: the panel tool's liveAtStartMask */
  liveAtStartMask?: number;
}

export interface Deployed {
  index: Address;
  forwarder: Address;
  epochTs: number;
  epochDay: number;
  firstDay: number;
  fromBlock: bigint;
  panels: Panel[];
}

interface PanelFile {
  panels: Panel[];
  deploy: { gpu: string; gpuId: Hex; recipeHash: Hex; family: number[]; famQ: number[]; liveAtStartMask: number }[];
}

export async function send(a: Anvil, from: number, functionName: string, args: readonly unknown[], to: Address): Promise<void> {
  const w = walletFor(a, from);
  const hash = await w.writeContract({ address: to, abi: agateIndexAbi, functionName, args, account: w.account, chain: w.chain } as never);
  const rc = await a.pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`${functionName} reverted`);
}

/** Deploys the index (writer mode TX_ORIGIN through a MockForwarder, like the deploy script's local configs) and
 *  registers the GPUs of the panel file. epochTs defaults to the current block second minus 5 (the deploy script's
 *  epochFromBlock); PRODUCTION uses epochTs 0, epochDay 0. */
export async function deployIndex(a: Anvil, p: Profile, o: { epochTs?: number; epochDay: number; firstDay?: number; gpus: GpuReg[]; panelsFile?: string }): Promise<Deployed> {
  const fromBlock = await a.pub.getBlockNumber();
  const mf = await artifact("MockForwarder.sol", "MockForwarder");
  const fwd = await deployRaw(a, mf.abi, mf.bytecode);
  const epochTs = o.epochTs ?? (await a.time()) - 5;
  const init = {
    day: p.day,
    slices: p.slices,
    minReadings: p.minReadings,
    qMin: p.qMin,
    demoLabel: p.demoLabel,
    signAll: p.signAll,
    epochTs: BigInt(epochTs),
    epochDay: o.epochDay,
    chainSelector: SELECTOR,
    owner: ADDR[ROLE.owner]!,
    writers: [ADDR[ROLE.primary]!, ADDR[ROLE.standby]!],
    attester: ADDR[ROLE.attester]!,
    guardians: [ADDR[ROLE.guardian]!, ZERO],
    forwarder: fwd,
    writerMode: 0,
  };
  const ix = await linkedIndex(a);
  const index = await deployRaw(a, ix.abi, ix.bytecode, [init]);
  const today = o.epochDay + Math.floor(((await a.time()) - epochTs) / p.day);
  const firstDay = o.firstDay ?? today;
  const file = (await Bun.file(o.panelsFile ?? PANELS_FILE).json()) as PanelFile;
  const panels: Panel[] = [];
  for (const g of o.gpus) {
    const d = file.deploy.find((x) => x.gpu === g.gpu);
    if (!d) throw new Error(`no panel for ${g.gpu}`);
    await send(a, ROLE.owner, "registerGpu", [d.gpuId, d.recipeHash, d.family, d.famQ, firstDay, g.liveAtStartMask ?? d.liveAtStartMask], index);
    panels.push(file.panels.find((x) => x.gpuId === d.gpuId)!);
  }
  return { index, forwarder: fwd, epochTs, epochDay: o.epochDay, firstDay, fromBlock, panels };
}

export interface Action {
  kind: number;
  slot: number;
  addr: Address;
  gpuId: Hex;
  day: number;
  mode: number;
}
export const ActionKind = { WRITER: 0, ATTESTER: 1, GUARDIAN: 2, FORWARDER: 3, LIVE_FROM: 4, LIVE_UNTIL: 5, OWNER: 6 } as const;

export const queueAction = (a: Anvil, index: Address, act: Action) => send(a, ROLE.owner, "queue", [act], index);
export const executeAction = (a: Anvil, index: Address, act: Action) => send(a, ROLE.owner, "execute", [act], index);
export const LAUNCH_PANELS_FILE = join(ROOT, "wall/packages/sources/panels/launch.json");

/** A reader (4.15): the page a slot fetches and the parser version that reads it. */
export interface ReaderArg {
  url: string;
  parserVersion: string;
}

/** eth_call as `from`: null when it would succeed, else the custom error's name (or the revert text). */
export async function simulate(a: Anvil, from: number, functionName: string, args: readonly unknown[], to: Address): Promise<string | null> {
  try {
    await a.pub.simulateContract({ address: to, abi: agateIndexAbi, functionName, args, account: ADDR[from]! } as never);
    return null;
  } catch (e) {
    const err = e as { walk?: (f: (x: unknown) => boolean) => unknown; shortMessage?: string; message?: string };
    const inner = err.walk?.((x) => typeof (x as { data?: { errorName?: string } }).data?.errorName === "string") as { data?: { errorName?: string } } | undefined;
    return inner?.data?.errorName ?? err.shortMessage ?? err.message ?? String(e);
  }
}

export async function read<T>(a: Anvil, index: Address, functionName: string, args: readonly unknown[]): Promise<T> {
  return (await a.pub.readContract({ address: index, abi: agateIndexAbi, functionName, args } as never)) as T;
}
