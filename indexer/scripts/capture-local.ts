// bun run capture: the local replay fixture (BOTS-SPEC 5.7 item 4). Starts a local anvil through the wall's
// anvil-safe wrapper (chain id 10143, no fork, no public network), deploys from the Foundry artifacts (AgateDollar,
// MockIndex, MockKuruRouter, three AgateFactory: demo, real, pilot), runs a scripted month on the demo factory
// (list, createMarket, faucet drips, mints, redeems, every router flow on MockKuruOrderBook, direct positions,
// payout and operator changes, daily claims and syncs, a claim of 0, closes, unstreams, the final claims and
// settles) and writes:
//   test/fixtures/local-lifecycle.json   every raw log in order and the truth read by views at the last block
//   test/fixtures/deployments.test.json  the world's deployments file (MS 10.3 shape)
//   config.yaml, src/lib/deployments.generated.ts   regenerated from it (gen:config)
// Rerun by hand when the contracts change; then bun run codegen and bun run test. Anvil's default accounts are fine
// here: the chain is local, never a fork of Monad (where they are EIP-7702 sweepers).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Abi,
  type Address,
  type Hex,
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  http,
  maxUint256,
  zeroAddress,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { spawnAnvil } from "../../wall/scripts/anvil.ts";
import { forgeOut } from "./abis.ts";
import { parseDeployments, renderConfig } from "./config-gen.ts";

const ROOT = join(import.meta.dirname, "..");
const FIX = join(ROOT, "test/fixtures");
const OUT = forgeOut();

function artifact(rel: string): { abi: Abi; bytecode: Hex } {
  const a = JSON.parse(readFileSync(join(OUT, rel), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: a.abi, bytecode: a.bytecode.object };
}
const A = {
  dollar: artifact("AgateDollar.sol/AgateDollar.json"),
  index: artifact("MockIndex.sol/MockIndex.json"),
  kuruRouter: artifact("MockKuruRouter.sol/MockKuruRouter.json"),
  book: artifact("MockKuruOrderBook.sol/MockKuruOrderBook.json"),
  factory: artifact("AgateFactory.sol/AgateFactory.json"),
  series: artifact("AgateSeries.sol/AgateSeries.json"),
  token: artifact("AgateToken.sol/AgateToken.json"),
  router: artifact("AgateRouter.sol/AgateRouter.json"),
};
const DECODE_ABI = [...A.factory.abi, ...A.series.abi, ...A.token.abi, ...A.dollar.abi, ...A.router.abi, ...A.book.abi, ...A.kuruRouter.abi] as Abi;

// ------------------------------------------------------------------ calendar (MS 2)
function daysFromCivil(y0: number, m: number, d: number): number {
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  return era * 146_097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719_468;
}
const month = (y: number, m: number) => y * 12 + (m - 1);

const U = 1_000_000n;
const DEMO_DAY = 600; // a demo index day in seconds; tPend 210 (MS 8.6 DEMO)
const DEMO_TPEND = 210;
const REAL_TPEND = 21_600;
const T0 = daysFromCivil(2026, 9, 21) * 86_400 + 36_000; // Sep 21 2026 10:00 UTC
const E = daysFromCivil(2026, 9, 20); // the demo clock's epoch day: dayId(T0) = Sep 20
const OCT = month(2026, 10);
const NOV = month(2026, 11);
const OCT1 = daysFromCivil(2026, 10, 1);
const NOV1 = daysFromCivil(2026, 11, 1);
const demoStart = (d: number) => T0 + (d - E) * DEMO_DAY;
const H100 = "0x12aa97fa8c2e1cc1914a2e4d86b36c7b36fdccec7c4caacb5f202ccc6d9be955" as Hex; // the wall's gpuIds (MS 10.3)
const H200 = "0xf7b3c4797305bd1433be196119ae5d6df4a433cffbf8d02c22048cc3a487b30d" as Hex;
const RECIPE = `0x${"ab".repeat(32)}` as Hex;
const PERMIT0 = { value: 0n, deadline: 0n, v: 0, r: `0x${"00".repeat(32)}` as Hex, s: `0x${"00".repeat(32)}` as Hex };

// ------------------------------------------------------------------ disk and chain
function freeGb(): number {
  const line = execFileSync("df", ["-Pk", "/"]).toString().trim().split("\n")[1]!;
  return Math.floor(Number(line.split(/\s+/)[3]) / 1_048_576);
}
const gb = freeGb();
if (gb < 30) throw new Error(`only ${gb} GB free: refusing to start anvil (floor 30 GB)`);
console.log(`df -h /: ${gb} GB free`);

const anvil = await spawnAnvil(["--chain-id", "10143", "--code-size-limit", "131072", "--gas-limit", "300000000", "--timestamp", String(T0 - 5_000)]);
const chain = defineChain({
  id: 10143,
  name: "local",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [anvil.rpc] } },
});
const pub = createPublicClient({ chain, transport: http(anvil.rpc) });
const test = createTestClient({ chain, mode: "anvil", transport: http(anvil.rpc) });
const MNEMONIC = "test test test test test test test test test test test junk"; // anvil's public test mnemonic
const acct = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
const wallet = (i: number) => createWalletClient({ chain, account: acct(i), transport: http(anvil.rpc) });
const W = { deployer: wallet(0), maker: wallet(1), alice: wallet(2), bob: wallet(3), carol: wallet(4), dave: wallet(5), payer: wallet(6) };
type Who = keyof typeof W;
const addrOf = (w: Who): Address => W[w].account.address;

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
  timestamp: number;
  from: string;
}
const logs: RawLog[] = [];
let now = T0 - 4_000;

/** Warps chain time to t with an empty block, so simulations and estimates at latest already see t. */
async function at(t: number): Promise<void> {
  if (t <= now + 1) return;
  now = t;
  await test.setNextBlockTimestamp({ timestamp: BigInt(now) });
  await test.mine({ blocks: 1 });
}
/** The next transaction lands one second after the newest block. */
async function next(): Promise<void> {
  now += 1;
  await test.setNextBlockTimestamp({ timestamp: BigInt(now) });
}

async function collect(hash: Hex): Promise<void> {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`transaction ${hash} reverted`);
  const b = await pub.getBlock({ blockNumber: r.blockNumber });
  for (const l of r.logs) {
    logs.push({
      address: l.address.toLowerCase(),
      topics: l.topics,
      data: l.data,
      blockNumber: Number(l.blockNumber),
      logIndex: l.logIndex,
      transactionHash: l.transactionHash,
      timestamp: Number(b.timestamp),
      from: r.from.toLowerCase(),
    });
  }
}

async function deploy(who: Who, a: { abi: Abi; bytecode: Hex }, args: readonly unknown[], t = now + 1): Promise<{ address: Address; block: number }> {
  await at(t);
  await next();
  const hash = await W[who].deployContract({ abi: a.abi, bytecode: a.bytecode, args, gas: 30_000_000n });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (!r.contractAddress) throw new Error("deploy failed");
  await collect(hash);
  return { address: r.contractAddress, block: Number(r.blockNumber) };
}

async function send(who: Who, address: Address, abi: Abi, functionName: string, args: readonly unknown[], t = now + 1): Promise<RawLog[]> {
  await at(t);
  await next();
  const before = logs.length;
  const { request } = await pub.simulateContract({ account: W[who].account, address, abi, functionName, args });
  await collect(await W[who].writeContract({ ...request, gas: 30_000_000n })); // no estimate: sync's gas rule (MS 4.6)
  return logs.slice(before);
}

function decoded(ls: RawLog[], name: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const l of ls) {
    try {
      const d = decodeEventLog({ abi: DECODE_ABI, data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] });
      if (d.eventName === name) out.push(d.args as unknown as Record<string, unknown>);
    } catch {
      // not ours
    }
  }
  return out;
}
const ids = (ls: RawLog[]) => decoded(ls, "PositionOpened").map((a) => a.id as bigint);

// ------------------------------------------------------------------ the world
try {
  const deployer = addrOf("deployer");
  await at(T0 - 3_000);
  const dollar = (await deploy("deployer", A.dollar, [deployer, 10_000n * U, 86_400n])).address;
  const pilotDollar = (await deploy("deployer", A.dollar, [deployer, 10_000n * U, 86_400n])).address; // stands in for Kuru's USDC
  const demoIndex = (await deploy("deployer", A.index, [DEMO_DAY, BigInt(T0), E])).address;
  const realIndex = (await deploy("deployer", A.index, [86_400, 0n, 0])).address;
  const kuruRouter = (await deploy("deployer", A.kuruRouter, [])).address;
  const gpus = [H100, H200, `0x0a5bf357b491308f9e8b00f22d9d58b1c984046be5b4a94a21a59038b996dd27` as Hex];
  const labels = ["H100", "H200", "B200"];
  const demo = await deploy("deployer", A.factory, [demoIndex, dollar, kuruRouter, gpus, labels, deployer, "demo", 0n, 0n]);
  const real = await deploy("deployer", A.factory, [realIndex, dollar, kuruRouter, gpus, labels, deployer, "", 0n, 0n]);
  const pilot = await deploy("deployer", A.factory, [realIndex, pilotDollar, zeroAddress, gpus, labels, deployer, "pilot", 0n, 0n]);
  const routerOf = async (f: Address) => (await pub.readContract({ address: f, abi: A.factory.abi, functionName: "router" })) as Address;
  const R = { demo: await routerOf(demo.address), real: await routerOf(real.address), pilot: await routerOf(pilot.address) };

  // index records: the demo clock's Sep 20 and the real calendar's Sep 20, both final at once
  const put = async (index: Address, gpu: Hex, day: number, value: bigint, finalAt: number, status = 1, late = false, t = now + 1) =>
    send("deployer", index, A.index.abi, "put", [gpu, day, Number(value), BigInt(finalAt), status, 5, late, false], t);
  for (const g of [H100, H200]) {
    await send("deployer", demoIndex, A.index.abi, "register", [g, RECIPE]);
    await send("deployer", realIndex, A.index.abi, "register", [g, RECIPE]);
  }
  await put(demoIndex, H100, E, 2_000_000n, T0 - 2_000);
  await put(demoIndex, H200, E, 3_000_000n, T0 - 2_000);
  await put(realIndex, H100, E, 2_000_000n, T0 - 2_000);

  // listings: demo October (SEEDED), real October, pilot October with an OTHER market
  await at(T0 + 10);
  const seriesOf = async (f: Address, g: Hex, m: number) =>
    (await pub.readContract({ address: f, abi: A.factory.abi, functionName: "seriesOf", args: [g, m] })) as Address;
  await send("payer", demo.address, A.factory.abi, "list", [H100, OCT]);
  await send("payer", demo.address, A.factory.abi, "list", [H200, OCT]);
  await send("payer", real.address, A.factory.abi, "list", [H100, OCT]);
  await send("payer", pilot.address, A.factory.abi, "list", [H100, OCT]);
  const oct = await seriesOf(demo.address, H100, OCT);
  const oct200 = await seriesOf(demo.address, H200, OCT);
  const realOct = await seriesOf(real.address, H100, OCT);
  const pilotOct = await seriesOf(pilot.address, H100, OCT);
  for (const s of [oct, oct200, realOct]) await send("payer", s === realOct ? real.address : demo.address, A.factory.abi, "createMarket", [s]);
  await send("deployer", pilot.address, A.factory.abi, "attachMarket", [pilotOct, kuruRouter, 2]); // OTHER: any address with code
  const marketOf = async (f: Address, s: Address) =>
    ((await pub.readContract({ address: f, abi: A.factory.abi, functionName: "marketOf", args: [s] })) as [Address, number])[0];
  const tokenOf = async (s: Address) => (await pub.readContract({ address: s, abi: A.series.abi, functionName: "token" })) as Address;
  const octMarket = await marketOf(demo.address, oct);
  const oct200Market = await marketOf(demo.address, oct200);
  const octToken = await tokenOf(oct);
  const oct200Token = await tokenOf(oct200);

  // money: faucet drips, the maker's float, approvals
  for (const w of ["alice", "bob", "carol", "dave"] as const) await send(w, dollar, A.dollar.abi, "drip", []);
  await send("deployer", dollar, A.dollar.abi, "mint", [addrOf("maker"), 1_000_000n * U]);
  for (const w of ["maker", "alice", "bob", "carol", "dave"] as const) {
    await send(w, dollar, A.dollar.abi, "approve", [R.demo, maxUint256]);
    await send(w, dollar, A.dollar.abi, "approve", [oct, maxUint256]);
    await send(w, dollar, A.dollar.abi, "approve", [oct200, maxUint256]);
    await send(w, octToken, A.token.abi, "approve", [R.demo, maxUint256]);
  }
  for (const [m, tok] of [[octMarket, octToken], [oct200Market, oct200Token]] as const) {
    await send("maker", dollar, A.dollar.abi, "approve", [m, maxUint256]);
    await send("maker", tok, A.token.abi, "approve", [m, maxUint256]);
  }

  // the maker's pairs and two-sided book (prices in u per token, sizes in Kuru units of 0.0001 token)
  const units = (tokens: number) => BigInt(tokens) * 10_000n;
  const quote = async (market: Address, asks: [number, number][], bids: [number, number][]) => {
    for (const [p, n] of asks) await send("maker", market, A.book.abi, "addSellOrder", [p, units(n), true]);
    for (const [p, n] of bids) await send("maker", market, A.book.abi, "addBuyOrder", [p, units(n), true]);
  };
  await send("maker", oct, A.series.abi, "mint", [20_000n * U, addrOf("maker")]);
  await quote(octMarket, [[2_050_000, 2_000], [2_100_000, 2_000], [2_200_000, 4_000]], [[1_950_000, 2_000], [1_900_000, 2_000], [1_800_000, 4_000]]);
  await send("maker", oct200, A.series.abi, "mint", [5_000n * U, addrOf("maker")]);
  await quote(oct200Market, [[3_050_000, 1_000]], [[2_950_000, 1_000]]);

  // users, before the month starts (k = 0)
  await send("alice", R.demo, A.router.abi, "openLong", [oct, 500n * U, 1n, PERMIT0]);
  const bobIds = ids(await send("bob", R.demo, A.router.abi, "openLongDaily", [oct, 600n * U, 1n, 4n, addrOf("bob"), PERMIT0]));
  const carolIds = ids(await send("carol", R.demo, A.router.abi, "openShort", [oct, 400n * U, 1n, 4n, addrOf("carol"), true, PERMIT0]));
  await send("dave", oct, A.series.abi, "mint", [100n * U, addrOf("dave")]);
  const [daveLong] = ids(await send("dave", oct, A.series.abi, "streamOut", [0, 40n * U, addrOf("dave"), addrOf("alice"), addrOf("dave"), true]));
  const [daveShort] = ids(await send("dave", oct, A.series.abi, "streamOut", [1, 40n * U, addrOf("dave"), addrOf("dave"), addrOf("dave"), false]));
  const [daveLong2] = ids(await send("dave", oct, A.series.abi, "streamOut", [0, 10n * U, addrOf("dave"), addrOf("dave"), addrOf("dave"), true]));
  await send("dave", oct, A.series.abi, "setPayout", [daveLong, addrOf("bob"), true]);
  await send("dave", oct, A.series.abi, "setOperator", [daveShort, addrOf("carol")]);
  await send("alice", octToken, A.token.abi, "transfer", [addrOf("dave"), 10n * U]);
  await send("dave", R.demo, A.router.abi, "openLong", [oct200, 100n * U, 1n, PERMIT0]);

  // the demo clock: Sep 21 to 30 records (anchors for November), then October
  const value = (d: number) => {
    const i = d - OCT1;
    if (i === 6) return 900_000n; // below the floor
    if (i === 13) return 4_500_000n; // above the cap
    return 2_000_000n + BigInt(((i * 37) % 9) - 4) * 10_000n;
  };
  for (let d = E + 1; d < OCT1; d++) {
    await put(demoIndex, H100, d, 2_000_000n, demoStart(d + 1) + DEMO_TPEND, 1, false, demoStart(d + 1) + 5);
    await put(demoIndex, H200, d, 3_000_000n, demoStart(d + 1) + DEMO_TPEND, 1, false);
  }
  await at(demoStart(OCT1) + 300);
  await send("payer", demo.address, A.factory.abi, "list", [H100, NOV]);
  await send("payer", demo.address, A.factory.abi, "list", [H200, NOV]);
  const nov = await seriesOf(demo.address, H100, NOV);
  await send("payer", demo.address, A.factory.abi, "createMarket", [nov]);
  const novMarket = await marketOf(demo.address, nov);
  const novToken = await tokenOf(nov);
  await send("maker", dollar, A.dollar.abi, "approve", [nov, maxUint256]);
  await send("maker", dollar, A.dollar.abi, "approve", [novMarket, maxUint256]);
  await send("maker", novToken, A.token.abi, "approve", [novMarket, maxUint256]);
  await send("maker", nov, A.series.abi, "mint", [3_000n * U, addrOf("maker")]);
  await quote(novMarket, [[2_150_000, 1_000]], [[2_000_000, 1_000]]);
  await send("alice", R.demo, A.router.abi, "openLong", [nov, 200n * U, 1n, PERMIT0]);

  const daily = new Set<bigint>([...bobIds, ...carolIds, daveLong!, daveLong2!]);
  const open = new Set<bigint>([...bobIds, ...carolIds, daveLong!, daveShort!, daveLong2!]);
  for (let d = OCT1; d < NOV1; d++) {
    const end = demoStart(d + 1);
    const i = d - OCT1;
    await put(demoIndex, H100, d, value(d), end + DEMO_TPEND, i === 20 ? 4 : 1, i === 3, end + 5); // day 21 CARRIED, day 4 late
    await put(demoIndex, H200, d, 3_000_000n, end + DEMO_TPEND, 1, false);
    await at(end + DEMO_TPEND + 1);
    if (i === 2) await send("dave", oct, A.series.abi, "sync", [1n]); // a stranger's sync
    if (i % 3 === 1) await send("payer", oct, A.series.abi, "claimMany", [[...daily].filter((x) => open.has(x))]);
    if (i === 4) await send("alice", R.demo, A.router.abi, "closeLong", [oct, 100n * U, 1n, PERMIT0]);
    if (i === 7) {
      await send("carol", R.demo, A.router.abi, "closeShort", [oct, carolIds.slice(0, 2), 500n * U, PERMIT0]);
      for (const x of carolIds.slice(0, 2)) open.delete(x);
    }
    if (i === 9) {
      await send("bob", R.demo, A.router.abi, "closeLongDaily", [oct, bobIds.slice(0, 1), 1n, PERMIT0]);
      open.delete(bobIds[0]!);
    }
    if (i === 11) {
      await send("dave", oct, A.series.abi, "unstream", [daveLong2, addrOf("dave")]);
      open.delete(daveLong2!);
    }
    if (i === 13) {
      await send("dave", oct, A.series.abi, "closeWithToken", [daveShort, addrOf("dave")]);
      open.delete(daveShort!);
    }
    if (i === 14) {
      await send("bob", oct, A.series.abi, "claim", [bobIds[1]]);
      await send("bob", oct, A.series.abi, "claim", [bobIds[1]]); // a claim of 0
    }
    if (i === 15) await quote(octMarket, [[2_050_000, 1_000]], [[1_950_000, 1_000]]); // the maker refills
    if (i === 19) await send("dave", oct, A.series.abi, "redeem", [20n * U, addrOf("dave")]);
    if (i === 22) await send("carol", R.demo, A.router.abi, "openLong", [oct200, 50n * U, 1n, PERMIT0]);
    if (i === 25) await send("payer", dollar, A.dollar.abi, "drip", []); // a drip mid-month
  }

  // after the month: the final claims close every open position, then settles
  await at(demoStart(NOV1) + DEMO_TPEND + 5);
  await send("payer", oct, A.series.abi, "claimMany", [[...open]]);
  const bal = async (tok: Address, w: Who) => (await pub.readContract({ address: tok, abi: A.token.abi, functionName: "balanceOf", args: [addrOf(w)] })) as bigint;
  const shortOf = async (s: Address, w: Who) => (await pub.readContract({ address: s, abi: A.series.abi, functionName: "shortOf", args: [addrOf(w)] })) as bigint;
  await send("alice", oct, A.series.abi, "settle", [0, await bal(octToken, "alice"), addrOf("alice")]);
  await send("maker", oct, A.series.abi, "settle", [0, 1_000n * U, addrOf("maker")]);
  await send("maker", oct, A.series.abi, "settle", [1, 5_000n * U, addrOf("maker")]);
  await send("dave", oct, A.series.abi, "settle", [1, await shortOf(oct, "dave"), addrOf("dave")]);

  // ------------------------------------------------------------------ truth at the last block
  const block = Number(await pub.getBlockNumber());
  const series = [oct, oct200, nov, realOct, pilotOct, await seriesOf(demo.address, H200, NOV)];
  const accounts = new Set<string>();
  for (const l of logs) {
    try {
      const d = decodeEventLog({ abi: DECODE_ABI, data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] });
      for (const v of Object.values(d.args as unknown as Record<string, unknown>)) {
        if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && v !== zeroAddress) accounts.add(v.toLowerCase());
      }
    } catch {
      // not ours
    }
  }
  const s = (x: bigint | number) => x.toString();
  const truth: Record<string, unknown> = { block, series: {} as Record<string, unknown>, dollar: {} as Record<string, string> };
  for (const ser of series) {
    const st = (await pub.readContract({ address: ser, abi: A.series.abi, functionName: "state" })) as readonly [number, bigint, number, boolean, boolean, bigint, bigint, bigint];
    const token = await tokenOf(ser);
    const supply = (await pub.readContract({ address: token, abi: A.token.abi, functionName: "totalSupply" })) as bigint;
    const shorts: Record<string, string> = {};
    const balances: Record<string, string> = {};
    for (const a of accounts) {
      const sh = (await pub.readContract({ address: ser, abi: A.series.abi, functionName: "shortOf", args: [a as Address] })) as bigint;
      if (sh !== 0n) shorts[a] = s(sh);
      const b = (await pub.readContract({ address: token, abi: A.token.abi, functionName: "balanceOf", args: [a as Address] })) as bigint;
      if (b !== 0n) balances[a] = s(b);
    }
    const positions: Record<string, unknown> = {};
    for (let id = 1n; id < st[6]; id++) {
      const p = (await pub.readContract({ address: ser, abi: A.series.abi, functionName: "position", args: [id] })) as {
        owner: Address;
        payee: Address;
        operator: Address;
        side: number;
        q: bigint;
        paid: bigint;
        daily: boolean;
      };
      positions[s(id)] = { open: p.owner !== zeroAddress, owner: p.owner.toLowerCase(), payee: p.payee.toLowerCase(), operator: p.operator.toLowerCase(), side: p.side, q: s(p.q), paid: s(p.paid), daily: p.daily };
    }
    (truth.series as Record<string, unknown>)[ser.toLowerCase()] = {
      k: st[0],
      sum: s(st[1]),
      ledger: s(st[5]),
      nextId: s(st[6]),
      shortSupply: s(st[7]),
      token: token.toLowerCase(),
      tokenSupply: s(supply),
      shorts,
      balances,
      positions,
    };
  }
  for (const a of accounts) {
    const b = (await pub.readContract({ address: dollar, abi: A.dollar.abi, functionName: "balanceOf", args: [a as Address] })) as bigint;
    if (b !== 0n) (truth.dollar as Record<string, string>)[a] = s(b);
  }
  truth.markets = {
    [oct.toLowerCase()]: octMarket.toLowerCase(),
    [oct200.toLowerCase()]: oct200Market.toLowerCase(),
    [nov.toLowerCase()]: novMarket.toLowerCase(),
    [realOct.toLowerCase()]: (await marketOf(real.address, realOct)).toLowerCase(),
    [pilotOct.toLowerCase()]: (await marketOf(pilot.address, pilotOct)).toLowerCase(),
  };

  const deployments = {
    chainId: 10143,
    dollar: dollar.toLowerCase(),
    kuru: { router: kuruRouter.toLowerCase(), marginAccount: zeroAddress },
    factories: {
      demo: { index: demoIndex.toLowerCase(), dollar: dollar.toLowerCase(), tag: "demo", factory: demo.address.toLowerCase(), router: R.demo.toLowerCase(), tPend: DEMO_TPEND, startBlock: demo.block },
      real: { index: realIndex.toLowerCase(), dollar: dollar.toLowerCase(), tag: "", factory: real.address.toLowerCase(), router: R.real.toLowerCase(), tPend: REAL_TPEND, startBlock: real.block },
      pilot: { index: realIndex.toLowerCase(), dollar: pilotDollar.toLowerCase(), tag: "pilot", factory: pilot.address.toLowerCase(), router: R.pilot.toLowerCase(), tPend: REAL_TPEND, startBlock: pilot.block },
    },
  };
  writeFileSync(join(FIX, "deployments.test.json"), `${JSON.stringify(deployments, null, 2)}\n`);
  writeFileSync(join(FIX, "local-lifecycle.json"), `${JSON.stringify({ note: "BOTS-SPEC 5.7 item 4; written by scripts/capture-local.ts", logs, truth }, null, 1)}\n`);
  const { yaml, ts } = renderConfig(parseDeployments(deployments), { source: "test/fixtures/deployments.test.json" });
  writeFileSync(join(ROOT, "config.yaml"), yaml);
  writeFileSync(join(ROOT, "src/lib/deployments.generated.ts"), ts);
  console.log(`captured ${logs.length} logs up to block ${block}; truth for ${series.length} series and ${accounts.size} accounts`);
} finally {
  anvil.proc.kill();
  await anvil.proc.exited;
  console.log(`anvil stopped; df -h /: ${freeGb()} GB free`);
}
