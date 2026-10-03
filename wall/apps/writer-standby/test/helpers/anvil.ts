// A private anvil with the real AgateIndex (builder A's forge build, its four libraries linked here), the real
// panels (wall/packages/sources/panels/default.json) and Anvil's default test accounts. Local chain only.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { agateIndexAbi } from "@agate/report/abi";
import type { Address, Hex } from "@agate/report/types";
import type { Panel } from "@agate/sources/types";
import {
  type Abi,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  type PublicClient,
  type TestClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { spawnAnvil } from "../../../../scripts/anvil.ts";

// Anvil's default accounts: 0 owner, 1 primary, 2 standby, 3 attester, 4 guardian, 5 keeper / stranger.
export const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // anvil #4 (was a non-default key until recheck r1, I1)
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
] as const;
export const ADDR = KEYS.map((k) => privateKeyToAccount(k).address) as Address[];
export const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const SELECTOR = 2183018362218727504n;

export const ROOT = resolve(import.meta.dir, "../../../../..");
// AGATE_CONTRACTS_OUT: a builder's own forge output (FOUNDRY_OUT), e.g. to run these tests on a contract not yet in contracts/out
const OUT = process.env.AGATE_CONTRACTS_OUT || join(ROOT, "contracts/out");
export const PANELS_FILE = join(ROOT, "wall/packages/sources/panels/default.json");
export const LAUNCH_PANELS_FILE = join(ROOT, "wall/packages/sources/panels/launch.json");
export const haveAnvil = Boolean(Bun.which("anvil") && existsSync(join(OUT, "AgateIndex.sol/AgateIndex.json")));

export interface Profile {
  day: number;
  slices: number;
  minReadings: number;
  qMin: number;
  demoLabel: boolean;
  signAll: boolean;
  epochDay: number;
}
/** BUILD-SPEC 2.2 TEST: a 2,400-second day of 12 slices on Oct 1 2026. */
export const TEST_PROFILE: Profile = { day: 2_400, slices: 12, minReadings: 6, qMin: 1, demoLabel: true, signAll: false, epochDay: 20_727 };

export interface Anvil {
  rpc: string;
  port: number;
  chainId: number;
  pub: PublicClient;
  test: TestClient;
  wallet(i: number): WalletClient;
  stop(): void;
}

export async function startAnvil(o: { chainId?: number; args?: string[] } = {}): Promise<Anvil> {
  const { proc, port, rpc } = await spawnAnvil(["--code-size-limit", "131072", "--silent", ...(o.chainId ? ["--chain-id", String(o.chainId)] : []), ...(o.args ?? [])]);
  const chainId = await createPublicClient({ transport: http(rpc, { retryCount: 0 }) }).getChainId();
  const chain = defineChain({ id: chainId, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const transport = http(rpc, { retryCount: 0 });
  return {
    rpc,
    port,
    chainId,
    pub: createPublicClient({ chain, transport }) as PublicClient,
    test: createTestClient({ chain, mode: "anvil", transport }) as unknown as TestClient,
    wallet: (i) => createWalletClient({ account: privateKeyToAccount(KEYS[i]!), chain, transport }),
    stop: () => proc.kill(),
  };
}

async function artifact(file: string, name: string): Promise<{ abi: Abi; bytecode: Hex; links: Record<string, Record<string, { start: number; length: number }[]>> }> {
  const j = await Bun.file(join(OUT, file, `${name}.json`)).json();
  return { abi: j.abi, bytecode: j.bytecode.object, links: j.bytecode.linkReferences ?? {} };
}

async function deploy(a: Anvil, abi: Abi, bytecode: Hex, args: readonly unknown[] = []): Promise<Address> {
  const w = a.wallet(0);
  const hash = await w.deployContract({ abi, bytecode, args, account: w.account!, chain: w.chain } as never);
  const rc = await a.pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success" || !rc.contractAddress) throw new Error(`deploy failed: ${hash}`);
  return rc.contractAddress;
}

/** Deploys the four logic libraries and links them into AgateIndex's creation code (what forge does itself). */
export async function linkedIndex(a: Anvil): Promise<{ abi: Abi; bytecode: Hex }> {
  const ix = await artifact("AgateIndex.sol", "AgateIndex");
  let code = ix.bytecode.slice(2);
  for (const [, libs] of Object.entries(ix.links)) {
    for (const [lib, refs] of Object.entries(libs)) {
      const l = await artifact(`${lib}.sol`, lib);
      if (Object.keys(l.links).length) throw new Error(`${lib} needs linking itself`);
      const addr = (await deploy(a, l.abi, l.bytecode)).slice(2).toLowerCase();
      for (const r of refs) code = code.slice(0, r.start * 2) + addr + code.slice(r.start * 2 + r.length * 2);
    }
  }
  if (code.includes("__$")) throw new Error("unlinked library left in AgateIndex");
  return { abi: ix.abi, bytecode: `0x${code}` };
}

export interface Deployed {
  index: Address;
  forwarder: Address;
  epochTs: number;
  panels: Panel[];
}

export interface DeployOptions {
  profile?: Profile;
  /** Default: a fresh MockForwarder (test/mocks), like the deploy script's deployMockForwarder. */
  forwarder?: Address;
  writerMode?: 0 | 1;
  writers?: [Address, Address];
  epochTs?: number;
  /** Panels to register (default: every panel of default.json). */
  gpus?: string[];
  /** The panel file to register from (default panels/default.json; panels/launch.json for the launch panel). */
  panelsFile?: string;
}

export async function deployIndex(a: Anvil, o: DeployOptions = {}): Promise<Deployed> {
  const p = o.profile ?? TEST_PROFILE;
  const mf = await artifact("MockForwarder.sol", "MockForwarder");
  const fwd = o.forwarder ?? (await deploy(a, mf.abi, mf.bytecode));
  const epochTs = o.epochTs ?? Number((await a.pub.getBlock()).timestamp) - 5;
  const init = {
    day: p.day,
    slices: p.slices,
    minReadings: p.minReadings,
    qMin: p.qMin,
    demoLabel: p.demoLabel,
    signAll: p.signAll,
    epochTs: BigInt(epochTs),
    epochDay: p.epochDay,
    chainSelector: SELECTOR,
    owner: ADDR[0]!,
    writers: o.writers ?? [ADDR[1]!, ADDR[2]!],
    attester: ADDR[3]!,
    guardians: [ADDR[4]!, ZERO],
    forwarder: fwd,
    writerMode: o.writerMode ?? 0,
  };
  const ix = await linkedIndex(a);
  const index = await deploy(a, ix.abi, ix.bytecode, [init]);
  const file = await Bun.file(o.panelsFile ?? PANELS_FILE).json();
  const panels: Panel[] = [];
  for (const d of file.deploy as { gpu: string; gpuId: Hex; recipeHash: Hex; family: number[]; famQ: number[]; liveAtStartMask: number }[]) {
    if (o.gpus && !o.gpus.includes(d.gpu)) continue;
    const w = a.wallet(0);
    const hash = await w.writeContract({
      address: index,
      abi: agateIndexAbi,
      functionName: "registerGpu",
      args: [d.gpuId, d.recipeHash, d.family, d.famQ, p.epochDay, d.liveAtStartMask],
      account: w.account!,
      chain: w.chain,
    });
    const rc = await a.pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`registerGpu ${d.gpu} failed`);
    panels.push((file.panels as Panel[]).find((x) => x.gpuId === d.gpuId)!);
  }
  return { index, forwarder: fwd, epochTs, panels };
}

/** Moves anvil to t (never backwards) and mines one block there. */
export async function warp(a: Anvil, t: number): Promise<number> {
  const cur = Number((await a.pub.getBlock()).timestamp);
  const at = Math.max(t, cur + 1);
  await a.test.setNextBlockTimestamp({ timestamp: BigInt(at) });
  await a.test.mine({ blocks: 1 });
  return at;
}

export const MOCK_FORWARDER_ABI = [
  {
    type: "function",
    name: "forward",
    stateMutability: "nonpayable",
    inputs: [
      { name: "receiver", type: "address" },
      { name: "metadata", type: "bytes" },
      { name: "report", type: "bytes" },
    ],
    outputs: [{ name: "ok", type: "bool" }],
  },
] as const;
