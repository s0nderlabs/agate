// The market's fork world (BOTS-SPEC 6): one anvil-safe fork of Monad testnet, a clock the harness owns (anvil's
// timestamp interval 0: block time moves only by warp()), every role a fresh address (Anvil's default accounts are
// EIP-7702 sweepers on Monad), the index and the market deployed by the repo's own forge scripts exactly as
// contracts/script/rehearse-market.sh does, and RPC proxies with a secret path in front of the fork so the bots' URL
// scrubber has something to hide. No transaction can reach a public network: the fork is loopback and every URL a
// bot gets is checked to be loopback.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type Abi,
  type Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  http,
  type PublicClient,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { spawnAnvil } from "../../../scripts/anvil.ts";
import { agateIndexAbi } from "../../../packages/market/src/index.ts";

export const ROOT = resolve(import.meta.dir, "../../../..");
export const CONTRACTS = join(ROOT, "contracts");
export const UPSTREAM = "https://testnet-rpc.monad.xyz";
export const OUT = process.env.AGATE_FORGE_OUT ?? join(homedir(), ".agate-build", "integrate-bots", "out");
export const CACHE = process.env.AGATE_FORGE_CACHE ?? join(homedir(), ".agate-build", "integrate-bots", "cache");
export const DEPLOYMENTS = join(CONTRACTS, "deployments", "fork-10143.json");
export const ANVIL_ROOT = process.env.AGATE_ANVIL_ROOT ?? join(homedir(), ".cache", "agate-anvil");
export const MIN_FREE_GB = Number(process.env.AGATE_ANVIL_MIN_FREE_GB ?? 30);

// fork-demo.json and market-fork.json: fresh role addresses (keccak256 of a label); no key exists for any of them
export const ROLE = {
  owner: "0x3E8F5a1021e0e0da13fC93fa0788fFf75E112F16",
  primary: "0xb2aC5cd5058220A88E59130fFCc1fff7d89d20D8",
  attester: "0x406A4ef9602F9D527Ea9A748EE26aC2343a7Ea39",
  deployer: "0xAd207bd58C60899A88ca302aD897D14517a80B1c", // the dollar's minter and the market admin
} as const satisfies Record<string, Address>;
export const KURU_ROUTER: Address = "0x7EFbE105Ca7415dE98F96622173458ac1c054630";
export const MARGIN: Address = "0xd029C2D98ff85D8F64799017fE00a59B1159CE02";
export const GPU = {
  H100: "0x12aa97fa8c2e1cc1914a2e4d86b36c7b36fdccec7c4caacb5f202ccc6d9be955",
  H200: "0xf7b3c4797305bd1433be196119ae5d6df4a433cffbf8d02c22048cc3a487b30d",
  B200: "0x0a5bf357b491308f9e8b00f22d9d58b1c984046be5b4a94a21a59038b996dd27",
} as const satisfies Record<string, Hex>;
export type GpuName = keyof typeof GPU;
export const GPUS: GpuName[] = ["H100", "H200", "B200"];
/** live slots per GPU in fork-demo.json (H100 five of five, H200 and B200 three of four) */
const SLOTS: Record<GpuName, { n: number; live: number }> = { H100: { n: 5, live: 5 }, H200: { n: 4, live: 3 }, B200: { n: 4, live: 3 } };
export const SELECTOR = 2183018362218727504n;
export const OCT1 = 20_727;
export const NOV1 = 20_758;
export const OCT = 2026 * 12 + 9;
export const NOV = OCT + 1;
export const DEC = OCT + 2;
export const U = 1_000_000n;
export const MAX = 2n ** 256n - 1n;
export const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const NOPERMIT = { value: 0n, deadline: 0n, v: 0, r: `0x${"00".repeat(32)}` as Hex, s: `0x${"00".repeat(32)}` as Hex };

/** `df -h /` (house rule): the free GB of the root volume. */
export function freeGb(): number {
  const r = Bun.spawnSync(["df", "-Pk", "/"], { stdout: "pipe" });
  const line = r.stdout.toString().trim().split("\n")[1] ?? "";
  return Math.floor(Number(line.split(/\s+/)[3] ?? 0) / 1_048_576);
}
export function dfLine(): string {
  return Bun.spawnSync(["df", "-h", "/"], { stdout: "pipe" }).stdout.toString().trim().split("\n")[1] ?? "";
}
export function anvilTmpKb(): number {
  const r = Bun.spawnSync(["du", "-sk", join(homedir(), ".foundry", "anvil", "tmp")], { stdout: "pipe", stderr: "ignore" });
  return Number(r.stdout.toString().split(/\s+/)[0] ?? 0) || 0;
}
/** The anvil-safe run dir whose wrapper has pid `pid` (anvil-safe writes it there). */
export function ownRunDir(pid: number): string | null {
  if (!existsSync(ANVIL_ROOT)) return null;
  for (const d of Array.from(new Bun.Glob("run.*").scanSync({ cwd: ANVIL_ROOT, onlyFiles: false }))) {
    try {
      if (readFileSync(join(ANVIL_ROOT, d, "wrapper.pid"), "utf8").trim() === String(pid)) return join(ANVIL_ROOT, d);
    } catch {
      // not a run dir of ours
    }
  }
  return null;
}

export function artifact(name: string, file = `${name}.sol`): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(join(OUT, file, `${name}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: j.abi, bytecode: j.bytecode.object };
}

export const isLoopback = (u: string) => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/.*)?$/.test(u);

/** An RPC URL with a secret path in front of the fork: only that path is served (404 elsewhere). */
export interface SecretProxy {
  url: string;
  secret: string;
  calls: number;
  stop(): void;
}
export function startSecretProxy(target: string, host: "127.0.0.1" | "localhost", secret: string): SecretProxy {
  const p: SecretProxy = { url: "", secret, calls: 0, stop: () => {} };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== `/v2/${secret}`) return new Response("not found", { status: 404 });
      p.calls++;
      const r = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: await req.text() });
      return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
    },
  });
  p.url = `http://${host}:${server.port}/v2/${secret}`;
  p.stop = () => server.stop(true);
  return p;
}

export interface TxOut {
  hash: Hex;
  block: bigint;
  gasUsed: bigint;
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[];
}

export class Fork {
  readonly chain;
  readonly pub: PublicClient;
  private constructor(
    readonly rpc: string,
    readonly port: number,
    readonly proc: Bun.Subprocess,
    readonly wrapperPid: number,
    readonly runDir: string | null,
    readonly forkBlock: bigint,
    readonly forkTime: bigint,
    readonly anvilPid: number | null,
  ) {
    this.chain = defineChain({ id: 10143, name: "monad-testnet-fork", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
    this.pub = createPublicClient({ chain: this.chain, transport: http(rpc, { retryCount: 0, timeout: 120_000 }), cacheTime: 0 }) as PublicClient;
  }

  static async start(): Promise<Fork> {
    const gb = freeGb();
    if (gb < MIN_FREE_GB) throw new Error(`only ${gb} GB free (floor ${MIN_FREE_GB} GB): not starting anvil`);
    const a = await spawnAnvil(["--fork-url", UPSTREAM, "--code-size-limit", "131072", "--silent", "--slots-in-an-epoch", "1"], { timeoutMs: 180_000 });
    const call = rpcCaller(a.rpc);
    const chainId = Number(BigInt((await call("eth_chainId")) as string));
    if (chainId !== 10143) throw new Error(`the fork answers chain ${chainId}, not 10143`);
    await call("anvil_setBlockTimestampInterval", [0]);
    const b = (await call("eth_getBlockByNumber", ["latest", false])) as { number: Hex; timestamp: Hex };
    const runDir = ownRunDir(a.proc.pid);
    let anvilPid: number | null = null;
    try {
      anvilPid = runDir ? Number(readFileSync(join(runDir, "anvil.pid"), "utf8").trim()) || null : null;
    } catch {
      anvilPid = null;
    }
    return new Fork(a.rpc, a.port, a.proc, a.proc.pid, runDir, BigInt(b.number), BigInt(b.timestamp), anvilPid);
  }

  call(method: string, params: unknown[] = []): Promise<unknown> {
    return rpcCaller(this.rpc)(method, params);
  }
  async time(): Promise<bigint> {
    return (await this.pub.getBlock({ blockTag: "latest" })).timestamp;
  }
  async block(): Promise<bigint> {
    return this.pub.getBlockNumber({ cacheTime: 0 });
  }
  /** Block time to t (strictly forward) with an empty block; it then stays at t until the next warp. */
  async warp(t: bigint): Promise<bigint> {
    const cur = await this.time();
    const at = t > cur ? t : cur;
    if (at > cur) await this.call("evm_setNextBlockTimestamp", [Number(at)]);
    await this.call("evm_mine");
    return at;
  }
  async mine(n = 1): Promise<void> {
    for (let i = 0; i < n; i++) await this.call("evm_mine");
  }
  async fund(a: Address, mon = 100_000n): Promise<void> {
    const code = await this.pub.getCode({ address: a });
    if (code && code !== "0x") throw new Error(`${a} has code on the fork (an EIP-7702 account?): refused`);
    await this.call("anvil_setBalance", [a, toHex(mon * 10n ** 18n)]);
  }
  async impersonate(a: Address): Promise<void> {
    await this.fund(a);
    await this.call("anvil_impersonateAccount", [a]);
  }
  read<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.pub.readContract({ address, abi, functionName, args: args as unknown[] }) as Promise<T>;
  }

  private async land(hash: Hex, what: string): Promise<TxOut> {
    const rc = await this.pub.waitForTransactionReceipt({ hash, pollingInterval: 50, timeout: 120_000 });
    if (rc.status !== "success") throw new Error(`${what} reverted (${hash})`);
    return { hash, block: rc.blockNumber, gasUsed: rc.gasUsed, logs: rc.logs as never };
  }
  /** A transaction from a fresh key (a user, never a bot: the bots sign their own). */
  async tx(key: Hex, to: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], gas = 12_000_000n): Promise<TxOut> {
    const w = createWalletClient({ account: privateKeyToAccount(key), chain: this.chain, transport: http(this.rpc) });
    const data = encodeFunctionData({ abi, functionName, args: args as unknown[] });
    const hash = await w.sendTransaction({ to, data, gas, account: w.account!, chain: this.chain });
    return this.land(hash, functionName);
  }
  /** A transaction from an impersonated role address (no key exists for it). */
  async txAs(from: Address, to: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], gas = 12_000_000n): Promise<TxOut> {
    const data = encodeFunctionData({ abi, functionName, args: args as unknown[] });
    const hash = (await this.call("eth_sendTransaction", [{ from, to, data, gas: toHex(gas) }])) as Hex;
    return this.land(hash, functionName);
  }
  async nonce(a: Address): Promise<number> {
    return this.pub.getTransactionCount({ address: a, blockTag: "latest" });
  }

  async stop(): Promise<void> {
    this.proc.kill();
    await this.proc.exited;
  }
}

function rpcCaller(rpc: string) {
  return async (method: string, params: unknown[] = []): Promise<unknown> => {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = (await r.json()) as { result?: unknown; error?: { message: string } };
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };
}

// ------------------------------------------------------------------ deploy through the repo's forge scripts

export interface Deployed {
  index: Address;
  t0: bigint; // dayStart(OCT1)
  dollar: Address;
  factory: Address;
  router: Address;
  deploymentsText: string;
  startBlock: bigint;
  indexBlock: bigint;
}

/** contracts/deployments/fork-10143.json and its pending twin, put back as they were when the run ends. */
export class DeploymentsGuard {
  private saved = new Map<string, string | null>();
  constructor(private readonly scratch: string) {
    for (const f of [DEPLOYMENTS, `${DEPLOYMENTS}.pending`]) {
      if (existsSync(f)) {
        const copy = join(scratch, `${f.split("/").pop()}.before`);
        copyFileSync(f, copy);
        this.saved.set(f, copy);
      } else this.saved.set(f, null);
    }
  }
  restore(): void {
    for (const [f, copy] of this.saved) {
      if (copy && existsSync(copy)) copyFileSync(copy, f);
      else rmSync(f, { force: true });
    }
  }
}

function forge(args: string[], env: Record<string, string>, log: string): string {
  const r = Bun.spawnSync(["forge", ...args], { cwd: CONTRACTS, env: { ...process.env, FOUNDRY_OUT: OUT, FOUNDRY_CACHE_PATH: CACHE, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1", ...env }, stdout: "pipe", stderr: "pipe" });
  const out = `${r.stdout.toString()}\n${r.stderr.toString()}`;
  Bun.write(log, out);
  if (r.exitCode !== 0) throw new Error(`forge ${args.slice(0, 2).join(" ")} failed (exit ${r.exitCode}); see ${log}`);
  return out;
}

export async function deployWorld(f: Fork, scratch: string): Promise<Deployed> {
  for (const a of Object.values(ROLE)) await f.impersonate(a);
  const broadcast = join(scratch, "broadcast");
  mkdirSync(broadcast, { recursive: true });
  const common = (sender: Address) => ["--rpc-url", f.rpc, "--broadcast", "--slow", "--non-interactive", "--unlocked", "--sender", sender, "--no-storage-caching"];
  const b0 = await f.block();
  const outIx = forge(["script", "script/DeployIndex.s.sol", ...common(ROLE.owner)], { AGATE_CONFIG: "fork-demo", FOUNDRY_BROADCAST: broadcast }, join(scratch, "deploy-index.log"));
  const index = (outIx.match(/AgateIndex (0x[0-9a-fA-F]{40})/g) ?? []).pop()?.split(" ")[1] as Address | undefined;
  if (!index || (await f.pub.getCode({ address: index })) === undefined) throw new Error("DeployIndex printed no AgateIndex with code");
  const t0 = await f.read<bigint>(index, agateIndexAbi as Abi, "dayStart", [OCT1]);
  forge(["script", "script/DeployMarket.s.sol", ...common(ROLE.deployer)], { AGATE_MARKET_CONFIG: "fork", AGATE_INDEX_demo: index, FOUNDRY_BROADCAST: broadcast }, join(scratch, "deploy-market.log"));
  forge(["script", "script/DeployMarket.s.sol", "--sig", "verify()", "--rpc-url", f.rpc, "--no-storage-caching"], { AGATE_MARKET_CONFIG: "fork", FOUNDRY_BROADCAST: broadcast }, join(scratch, "verify-market.log"));
  if (existsSync(`${DEPLOYMENTS}.pending`)) throw new Error("verify() left the pending deployments file");
  const text = readFileSync(DEPLOYMENTS, "utf8");
  const d = JSON.parse(text) as { dollar: Address; factories: { demo: { factory: Address; router: Address; startBlock: number } } };
  return { index, t0, dollar: d.dollar, factory: d.factories.demo.factory, router: d.factories.demo.router, deploymentsText: text, startBlock: BigInt(d.factories.demo.startBlock), indexBlock: b0 + 1n };
}

// ------------------------------------------------------------------ the demo index's days, through the direct path

export interface DayValues {
  H100: bigint;
  H200: bigint;
  B200: bigint;
}

export interface Clocks {
  day: bigint;
  slice: bigint;
  tPend: bigint;
  closeGrace: bigint;
}

/** Posts, closes and countersigns demo days on the real AgateIndex as the fresh primary writer and attester. */
export class IndexDays {
  posted = 0;
  attested = 0;
  closed = 0;
  constructor(
    readonly f: Fork,
    readonly index: Address,
    readonly clocks: Clocks,
    readonly t0: bigint,
  ) {}

  static async create(f: Fork, index: Address, t0: bigint): Promise<IndexDays> {
    const c = await f.read<{ day: number; slice: number; tPend: number; closeGrace: number }>(index, agateIndexAbi as Abi, "clocks");
    return new IndexDays(f, index, { day: BigInt(c.day), slice: BigInt(c.slice), tPend: BigInt(c.tPend), closeGrace: BigInt(c.closeGrace) }, t0);
  }

  start(d: number): bigint {
    return this.t0 + BigInt(d - OCT1) * this.clocks.day;
  }
  readAt(d: number, h: number): bigint {
    return this.start(d) + BigInt(h) * this.clocks.slice + 25n;
  }
  closeAt(d: number): bigint {
    return this.start(d + 1) + this.clocks.closeGrace;
  }

  /** One slice of day d for the three GPUs, posted at its read second (the block lands there). */
  async postSlice(d: number, h: number, v: DayValues): Promise<TxOut> {
    const t = this.readAt(d, h);
    await this.f.warp(t);
    const entries = GPUS.map((g) => ({ gpuId: GPU[g], dayId: d, slice: h, readAt: t, values: Array.from({ length: SLOTS[g].n }, (_, i) => (i < SLOTS[g].live ? Number(v[g]) : 0)) }));
    const report = encodeAbiParameters(
      [{ type: "uint8" }, { type: "uint64" }, { type: "address" }, { type: "tuple[]", components: [{ name: "gpuId", type: "bytes32" }, { name: "dayId", type: "uint32" }, { name: "slice", type: "uint8" }, { name: "readAt", type: "uint64" }, { name: "values", type: "uint32[]" }] }],
      [1, SELECTOR, this.index, entries],
    );
    this.posted++;
    return this.f.txAs(ROLE.primary, this.index, agateIndexAbi as Abi, "postReport", [report]);
  }

  /** Closes day d for every GPU at its close second and countersigns each record that needs it; returns the second
   *  at which the last of them is final. */
  async close(d: number): Promise<bigint> {
    await this.f.warp(this.closeAt(d));
    let finalAt = 0n;
    for (const g of GPUS) {
      const head = await this.f.read<number>(this.index, agateIndexAbi as Abi, "head", [GPU[g]]);
      if (head !== d) throw new Error(`${g}: head is ${head}, expected ${d}`);
      await this.f.txAs(ROLE.primary, this.index, agateIndexAbi as Abi, "closeDay", [GPU[g]]);
      this.closed++;
      let [, , rec] = await this.record(g, d);
      if (rec.needsSign && rec.finalAt === 0n) {
        await this.f.txAs(ROLE.attester, this.index, agateIndexAbi as Abi, "attest", [GPU[g], d, rec.source, rec.digest]);
        this.attested++;
        [, , rec] = await this.record(g, d);
      }
      if (rec.finalAt === 0n) throw new Error(`${g} day ${d}: no finalAt after close and attest`);
      if (rec.finalAt > finalAt) finalAt = rec.finalAt;
    }
    return finalAt;
  }

  record(g: GpuName, d: number) {
    return this.f.read<readonly [boolean, boolean, { value: number; status: number; needsSign: boolean; source: Address; digest: Hex; finalAt: bigint; postedAt: bigint }]>(this.index, agateIndexAbi as Abi, "record", [GPU[g], d]);
  }
}
