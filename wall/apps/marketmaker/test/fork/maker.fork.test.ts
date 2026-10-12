// BOTS-SPEC 3.12 fork tests: the maker on Kuru V1's real deployed book, on an anvil-safe fork of Monad testnet
// (scripts/fork-test.ts starts and stops it). Skipped without MONAD_FORK_URL; refuses a non-loopback URL so no
// transaction can reach a public network. Deploys from the Foundry artifacts with viem (AgateDollar, MockIndex with
// final records, AgateFactory over Kuru V1's real Router), lists next month, creates its Kuru V1 market, funds a fresh
// maker key, and runs one lifecycle: first quote, quiet tick, a router openLong filling the maker's ask, the refill,
// a fair move, a stranger's ask inside the next bid, kill and unkill, wind-down, settle. Then the CLI in dry run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Abi,
  type Address,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  erc20Abi,
  type Hex,
  http,
  keccak256,
  parseEther,
  type PublicClient,
  toBytes,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AlertSink, RpcPool } from "@agate/watcher";
import { agateDollarAbi, agateFactoryAbi, agateRouterAbi, agateSeriesAbi, Budget, decodeL2Book, type Deployments, kuruMarginAccountAbi, kuruOrderBookAbi, type L2Book, LimitTable, MarketSender, ViemReads } from "@agate/market";
import { parseConfig } from "../../src/config.ts";
import { MarketMaker } from "../../src/mm.ts";

const RPC = process.env.MONAD_FORK_URL ?? "";
const KURU_ROUTER = "0x7EFbE105Ca7415dE98F96622173458ac1c054630" as Address;
const MA = "0xd029C2D98ff85D8F64799017fE00a59B1159CE02" as Address;
const H100 = keccak256(toBytes("H100-SXM/on-demand-list/neocloud/v1"));
const U = 1_000_000n;
const T = 10_000n; // Kuru size units per token
const DAY = 86_400;
const T_PEND = 21_600;
const REF = 3_600_000;
const NOPERMIT = { value: 0n, deadline: 0n, v: 0, r: `0x${"00".repeat(32)}` as Hex, s: `0x${"00".repeat(32)}` as Hex };
const KEY_ENV = "AGATE_TEST_FORK_MM_KEY";

const loopback = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(RPC);
if (RPC && !loopback) throw new Error("MONAD_FORK_URL must be a loopback anvil fork (no public network may receive a transaction)");

const chain = defineChain({ id: 10143, name: "monad-testnet-fork", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC || "http://127.0.0.1:1"] } } });

function artifact(name: string, file = `${name}.sol`): { abi: Abi; bytecode: Hex } {
  const out = process.env.AGATE_FORGE_OUT ?? join(homedir(), ".agate-build", "p1", "out");
  const j = JSON.parse(readFileSync(join(out, file, `${name}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: j.abi, bytecode: j.bytecode.object };
}

/** DateLib on the production clock (epochTs = epochDay = 0): month = year * 12 + (month - 1). */
function monthOfDay(day: number): number {
  const d = new Date(day * DAY * 1000);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}
function firstDayOf(m: number): number {
  return Date.UTC(Math.floor(m / 12), m % 12, 1) / 86_400_000;
}
function daysIn(m: number): number {
  return firstDayOf(m + 1) - firstDayOf(m);
}

describe.skipIf(!RPC)("the maker on Kuru V1 (fork)", () => {
  let pub: PublicClient;
  let dir = "";
  const keys = { deployer: generatePrivateKey(), maker: generatePrivateKey(), user: generatePrivateKey(), stranger: generatePrivateKey() };
  const acct = (k: Hex) => privateKeyToAccount(k);
  const who = { deployer: acct(keys.deployer).address, maker: acct(keys.maker).address, user: acct(keys.user).address, stranger: acct(keys.stranger).address };
  let index: Address;
  let dollar: Address;
  let factory: Address;
  let router: Address;
  let series: Address;
  let token: Address;
  let market: Address;
  let month = 0;
  let startDay = 0;
  let n = 0;
  let mm: MarketMaker;
  let sender: MarketSender;
  let deployments: Deployments;
  const clock = { ms: 1_000_000 };
  let forkBlock = 0n;

  async function send(k: Hex, to: Address, abi: Abi, functionName: string, args: unknown[]): Promise<{ status: string; logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[] }> {
    const w = createWalletClient({ account: acct(k), chain, transport: http(RPC) });
    const hash = await w.writeContract({ address: to, abi, functionName, args, chain } as never);
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${functionName} reverted`);
    return rc as never;
  }
  async function deploy(k: Hex, name: string, args: unknown[], file?: string): Promise<Address> {
    const a = artifact(name, file);
    const w = createWalletClient({ account: acct(k), chain, transport: http(RPC) });
    const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, chain } as never);
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success" || !rc.contractAddress) throw new Error(`deploy ${name} failed`);
    return rc.contractAddress;
  }
  const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) => pub.readContract({ address, abi, functionName, args }) as Promise<T>;
  async function book(): Promise<L2Book> {
    return decodeL2Book(await read<Hex>(market, kuruOrderBookAbi as Abi, "getL2Book"));
  }
  async function now(): Promise<number> {
    return Number((await pub.getBlock({ blockTag: "latest" })).timestamp);
  }
  async function warp(t: number): Promise<void> {
    await pub.request({ method: "evm_setNextBlockTimestamp" as never, params: [toHex(t)] as never });
    await pub.request({ method: "evm_mine" as never, params: [] as never });
  }
  async function tick() {
    clock.ms += 60_000;
    return mm.tick();
  }
  const nonce = () => pub.getTransactionCount({ address: who.maker, blockTag: "latest" });
  const pairs = (b: L2Book) => ({ bids: b.bids.map(([p, s]) => [Number(p), Number(s / T)]), asks: b.asks.map(([p, s]) => [Number(p), Number(s / T)]) });

  beforeAll(async () => {
    pub = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
    expect(await pub.getChainId()).toBe(10143);
    forkBlock = await pub.getBlockNumber();
    console.log(`fork block ${forkBlock}, fork time ${await now()}`);
    expect((await pub.getCode({ address: KURU_ROUTER }))?.length ?? 0).toBeGreaterThan(2);
    expect((await pub.getCode({ address: MA }))?.length ?? 0).toBeGreaterThan(2);
    for (const a of Object.values(who)) {
      expect((await pub.getCode({ address: a })) ?? "0x").toBe("0x"); // fresh keys only: no EIP-7702 sweeper
      await pub.request({ method: "anvil_setBalance" as never, params: [a, toHex(parseEther("100000"))] as never });
    }
    dir = mkdtempSync(join(tmpdir(), "agate-mm-fork-"));

    // the index: production clock, final records at 3.60 from five days before this month to the end of the next
    index = await deploy(keys.deployer, "MockIndex", [DAY, 0n, 0], "MockIndex.sol");
    await send(keys.deployer, index, artifact("MockIndex").abi, "register", [H100, keccak256(toBytes("recipe/H100"))]);
    const today = Math.floor((await now()) / DAY);
    const cur = monthOfDay(today);
    month = cur + 1;
    startDay = firstDayOf(month);
    n = daysIn(month);
    for (let d = firstDayOf(cur) - 5; d < startDay + n; d++) {
      await send(keys.deployer, index, artifact("MockIndex").abi, "put", [H100, d, REF, BigInt((d + 1) * DAY + T_PEND), 1, 5, false, false]);
    }
    // the dollar, the factory over Kuru V1's real Router, next month listed and its market created
    dollar = await deploy(keys.deployer, "AgateDollar", [who.deployer, 10_000n * U, 86_400n]);
    factory = await deploy(keys.deployer, "AgateFactory", [index, dollar, KURU_ROUTER, [H100], ["H100"], who.deployer, "demo", 0n, 0n]);
    router = await read<Address>(factory, agateFactoryAbi as Abi, "router");
    await send(keys.deployer, factory, agateFactoryAbi as Abi, "list", [H100, month]);
    series = await read<Address>(factory, agateFactoryAbi as Abi, "seriesOf", [H100, month]);
    token = await read<Address>(series, agateSeriesAbi as Abi, "token");
    await send(keys.deployer, factory, agateFactoryAbi as Abi, "createMarket", [series]);
    const [m, venue] = await read<readonly [Address, number]>(factory, agateFactoryAbi as Abi, "marketOf", [series]);
    expect(venue).toBe(1);
    market = m;
    expect(await read<boolean>(factory, agateFactoryAbi as Abi, "routerCanUse", [series])).toBe(true);
    // the maker's float: the documented one-time mint by the dollar's minter (never the deployer key in the bot)
    await send(keys.deployer, dollar, agateDollarAbi as Abi, "mint", [who.maker, 10_000_000n * U]);
    await send(keys.deployer, dollar, agateDollarAbi as Abi, "mint", [who.user, 100_000n * U]);
    await send(keys.deployer, dollar, agateDollarAbi as Abi, "mint", [who.stranger, 100_000n * U]);
    deployments = {
      chainId: 10143,
      dollar,
      kuru: { router: KURU_ROUTER, marginAccount: MA },
      factories: { demo: { name: "demo", index, dollar, tag: "demo", factory, router, tPend: T_PEND, startBlock: forkBlock } },
    };
    writeFileSync(join(dir, "deployments.json"), JSON.stringify({ ...deployments, factories: { demo: { ...deployments.factories.demo, startBlock: Number(forkBlock) } } }));

    // the maker, in process, over the real chain wiring
    process.env[KEY_ENV] = keys.maker;
    const pool = await RpcPool.create({ urls: [RPC, RPC.replace("127.0.0.1", "localhost")], expectChainId: 10143, timeoutMs: 60_000, staleS: 10 ** 9, role: "marketmaker", now: () => Math.floor(Date.now() / 1000) });
    const config = parseConfig(JSON.stringify({ factories: ["demo"], runUntil: "2027-06-30T00:00:00Z" }));
    const alerts = new AlertSink(join(dir, "alerts.jsonl"), { now: () => Math.floor(Date.now() / 1000), print: false });
    const budget = new Budget({ dir, role: "marketmaker", keepWei: config.keepWei, lowBalanceWei: config.lowBalanceWei, runUntil: config.runUntil, lowCode: "MM_KEY_LOW", spentCode: "MM_BUDGET_SPENT", address: who.maker, headStartS: config.headStartS });
    let maker!: MarketMaker;
    sender = new MarketSender({ pool, keyEnv: KEY_ENV, role: "marketmaker", limits: LimitTable.fromEnv(), alerts, now: () => Math.floor(Date.now() / 1000), pollMs: 50, guard: { canSpend: (c, safety) => maker.canSpend(c, safety), record: (c, safety) => maker.record(c, safety) } });
    const log = (event: string, data: Record<string, unknown>) => {
      if (event === "send_failed" || event === "ladder_refused" || event === "reconciled") console.log(JSON.stringify({ event, ...data }, (_k, v) => (typeof v === "bigint" ? `${v}` : v)));
    };
    maker = new MarketMaker({ reads: new ViemReads({ pool }), sender, deployments, config, dir, alerts, budget, nowMs: () => clock.ms, log });
    mm = maker;
  });

  afterAll(() => {
    delete process.env[KEY_ENV];
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (sender) {
      console.log("gas of the maker's shapes on the fork (Ethereum prices; limit = min(CAP, 1.2 x estimate)):");
      for (const s of sender.sent) console.log(`  ${s.shape.padEnd(18)} ${s.label.padEnd(44)} limit ${s.gasLimit} used ${s.gasUsed}`);
    }
  });

  test("first quote: two-sided resting orders on the real book at the expected prices and sizes", async () => {
    const rep = await tick();
    expect(rep.sends.every((s) => s.ok)).toBe(true);
    const b = await book();
    expect(pairs(b)).toEqual({
      bids: [
        [3_560_000, 1_000],
        [3_550_000, 2_000],
        [3_540_000, 4_000],
      ],
      asks: [
        [3_640_000, 1_000],
        [3_650_000, 2_000],
        [3_660_000, 4_000],
      ],
    });
    // s_orders and the price-point heads agree with the maker's state; the ids came from OrderCreated in the receipt
    const mine = mm.state.orders[market.toLowerCase()]!;
    expect(mine.length).toBe(6);
    for (const o of mine) {
      const s = await read<readonly [Address, bigint, number, number, number, number, number, boolean]>(market, kuruOrderBookAbi as Abi, "s_orders", [Number(o.id)]);
      expect(s[0].toLowerCase()).toBe(who.maker.toLowerCase());
      expect(s[1]).toBe(o.remaining);
      expect(BigInt(s[5])).toBe(o.price);
      expect(s[7]).toBe(o.isBuy);
      const [head] = await read<readonly [number, number]>(market, kuruOrderBookAbi as Abi, o.isBuy ? "s_buyPricePoints" : "s_sellPricePoints", [o.price]);
      expect(BigInt(head)).toBe(o.id);
    }
    expect(BigInt(await read<number>(market, kuruOrderBookAbi as Abi, "s_orderIdCounter"))).toBe(6n);
    expect(await read<bigint>(series, agateSeriesAbi as Abi, "shortOf", [who.maker])).toBe(7_000n * U);
    expect(await read<bigint>(MA, kuruMarginAccountAbi as Abi, "getBalance", [who.maker, token])).toBe(0n);
    expect(await read<bigint>(MA, kuruMarginAccountAbi as Abi, "getBalance", [who.maker, dollar])).toBe(100_000n * U);
  });

  test("the CLI in dry run: starts on the fork, simulates and estimates, sends nothing, prints no key", async () => {
    const home = join(dir, "dry-home");
    const dryAddr = privateKeyToAccount(generatePrivateKey()).address;
    await send(keys.deployer, dollar, agateDollarAbi as Abi, "mint", [dryAddr, 1_000_000n * U]); // something to plan with
    const n0 = await pub.getTransactionCount({ address: dryAddr });
    const p = Bun.spawn(["bun", "run", "src/main.ts", "run"], {
      cwd: join(import.meta.dir, "..", ".."),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AGATE_DRY_RUN: "1", AGATE_MM_ADDRESS: dryAddr, AGATE_RPC_URLS: `${RPC},${RPC.replace("127.0.0.1", "localhost")}`, AGATE_CHAIN_ID: "10143", AGATE_DEPLOYMENTS: join(dir, "deployments.json"), AGATE_MM_CONFIG: "", AGATE_WALL_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const outText = new Response(p.stdout).text();
    const errText = new Response(p.stderr).text();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !existsSync(join(home, "market", "marketmaker", "heartbeat.json"))) await Bun.sleep(250);
    p.kill("SIGTERM");
    await p.exited;
    const out = await outText;
    const err = await errText;
    expect(existsSync(join(home, "market", "marketmaker", "heartbeat.json"))).toBe(true);
    expect(out).toContain('"event":"started"');
    expect(out).toContain('"event":"dry_run"');
    expect(await pub.getTransactionCount({ address: dryAddr })).toBe(n0);
    for (const text of [out, err]) for (const k of Object.values(keys)) expect(text.toLowerCase()).not.toContain(k.slice(2).toLowerCase());
  });

  test("an unchanged world sends nothing", async () => {
    const before = await nonce();
    await tick();
    await tick();
    expect(await nonce()).toBe(before);
  });

  test("a router openLong fills against the maker's ask; past half the top ask it is refilled", async () => {
    await send(keys.user, dollar, erc20Abi as Abi, "approve", [router, 2n ** 256n - 1n]);
    const t0 = await read<bigint>(token, erc20Abi as Abi, "balanceOf", [who.user]);
    const rc = await send(keys.user, router, agateRouterAbi as Abi, "openLong", [series, 364_000_000n, 99n * U, NOPERMIT]);
    expect((await read<bigint>(token, erc20Abi as Abi, "balanceOf", [who.user])) - t0).toBe(100n * U); // 100 tokens at 3.64
    const trades = rc.logs
      .filter((l) => l.address.toLowerCase() === market.toLowerCase())
      .map((l) => {
        try {
          return decodeEventLog({ abi: kuruOrderBookAbi, data: l.data, topics: l.topics as [Hex] });
        } catch {
          return null;
        }
      })
      .filter((e) => e?.eventName === "Trade");
    expect(trades.length).toBe(1);
    const tr = trades[0]!.args as { makerAddress: Address; price: bigint; filledSize: bigint; updatedSize: bigint };
    expect(tr.makerAddress.toLowerCase()).toBe(who.maker.toLowerCase());
    expect(tr.price).toBe(3_640_000n * 10n ** 12n);
    expect(tr.filledSize).toBe(100n * T);
    expect(tr.updatedSize).toBe(900n * T);
    let before = await nonce();
    await tick(); // 90 % left: no requote
    expect(await nonce()).toBe(before);
    await send(keys.user, router, agateRouterAbi as Abi, "openLong", [series, 2_000_000_000n, 549n * U, NOPERMIT]);
    const b = await book();
    expect(b.asks[0]![1]).toBeLessThan(500n * T);
    before = await nonce();
    const rep = await tick();
    expect(rep.decisions[0]!.d).toMatchObject({ act: "requote", cond: 4 });
    expect(await nonce()).toBeGreaterThan(before);
    expect(pairs(await book()).asks[0]).toEqual([3_640_000, 1_000]);
  });

  test("a fair move of 10 cents moves the whole ladder in one batch", async () => {
    const today = Math.floor((await now()) / DAY);
    await send(keys.deployer, index, artifact("MockIndex").abi, "put", [H100, today - 1, 3_700_000, BigInt(await now()), 1, 5, false, false]);
    const before = await nonce();
    await tick();
    expect(await nonce()).toBe(before + 1);
    expect(pairs(await book())).toEqual({
      bids: [
        [3_660_000, 1_000],
        [3_650_000, 2_000],
        [3_640_000, 4_000],
      ],
      asks: [
        [3_740_000, 1_000],
        [3_750_000, 2_000],
        [3_760_000, 4_000],
      ],
    });
  });

  test("a stranger's ask inside the next bid: the maker lowers its bid and never reverts", async () => {
    // the stranger mints pairs and rests 100 tokens at 3.72 (between the maker's 3.66 bid and 3.74 ask)
    await send(keys.stranger, dollar, erc20Abi as Abi, "approve", [series, 2n ** 256n - 1n]);
    await send(keys.stranger, series, agateSeriesAbi as Abi, "mint", [100n * U, who.stranger]);
    await send(keys.stranger, token, erc20Abi as Abi, "approve", [MA, 2n ** 256n - 1n]);
    await send(keys.stranger, MA, kuruMarginAccountAbi as Abi, "deposit", [who.stranger, token, 100n * U]);
    await send(keys.stranger, market, kuruOrderBookAbi as Abi, "addSellOrder", [3_720_000, 100n * T, true]);
    const today = Math.floor((await now()) / DAY);
    await send(keys.deployer, index, artifact("MockIndex").abi, "put", [H100, today - 1, 3_800_000, BigInt(await now()), 1, 5, false, false]);
    const rep = await tick();
    expect(rep.sends.filter((s) => s.shape === "kuru.batchUpdate").every((s) => s.ok)).toBe(true);
    const b = pairs(await book());
    expect(b.bids).toEqual([[3_710_000, 1_000]]); // 3.76, 3.75, 3.74 all clamp to 3.71: one kept
    expect(b.asks).toEqual([
      [3_720_000, 100],
      [3_840_000, 1_000],
      [3_850_000, 2_000],
      [3_860_000, 4_000],
    ]);
  });

  test("kill cancels every maker order within one tick and places nothing; unkill requotes", async () => {
    const ids = mm.state.orders[market.toLowerCase()]!.map((o) => o.id);
    writeFileSync(mm.killPath(), "fork test");
    await tick();
    expect(pairs(await book())).toEqual({ bids: [], asks: [[3_720_000, 100]] });
    for (const id of ids) {
      const s = await read<readonly [Address, bigint, number, number, number, number, number, boolean]>(market, kuruOrderBookAbi as Abi, "s_orders", [Number(id)]);
      expect(s[5]).toBe(0); // deleted: cancelled
    }
    const before = await nonce();
    await tick();
    expect(await nonce()).toBe(before);
    rmSync(mm.killPath());
    await tick();
    expect(pairs(await book()).bids).toEqual([[3_710_000, 1_000]]);
  });

  test("wind-down before the month ends, then settle after the last day: the maker holds nothing", async () => {
    const endTs = (startDay + n) * DAY;
    await warp(endTs - 1_000); // past stopAt = end - 3,600
    await tick();
    expect(pairs(await book())).toEqual({ bids: [], asks: [[3_720_000, 100]] });
    expect(await read<bigint>(MA, kuruMarginAccountAbi as Abi, "getBalance", [who.maker, token])).toBe(0n);
    const tw = await read<bigint>(token, erc20Abi as Abi, "balanceOf", [who.maker]);
    const sh = await read<bigint>(series, agateSeriesAbi as Abi, "shortOf", [who.maker]);
    // pairs redeemed: only the net position of the fills is left (sold 100 + 549.4505 tokens: 6,494,505 size units)
    expect(tw).toBe(0n);
    expect(sh).toBe(6_494_505n * 100n);
    await warp(endTs + T_PEND + 10);
    const [k] = await read<readonly [number, bigint]>(series, agateSeriesAbi as Abi, "previewSync");
    expect(k).toBe(n);
    const d0 = await read<bigint>(dollar, erc20Abi as Abi, "balanceOf", [who.maker]);
    await tick();
    expect(await read<bigint>(token, erc20Abi as Abi, "balanceOf", [who.maker])).toBe(0n);
    expect(await read<bigint>(series, agateSeriesAbi as Abi, "shortOf", [who.maker])).toBe(0n);
    expect(await read<bigint>(dollar, erc20Abi as Abi, "balanceOf", [who.maker])).toBeGreaterThan(d0);
    expect(Object.keys(mm.state.series)).toEqual([]);
    expect(existsSync(join(dir, "quotes.jsonl"))).toBe(true);
  });

});
