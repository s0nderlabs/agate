// BOTS-SPEC 4.8, the payer's fork test (gated: AGATE_PAYER_FORK=1, or `bun run test:fork`): an anvil-safe fork of
// Monad testnet (https://testnet-rpc.monad.xyz, read only), fresh keys only (Anvil's default accounts are EIP-7702
// sweepers there), Kuru V1's real Router and MarginAccount, a MockIndex on the demo clock (600-second days, day
// 20,727 = 2026-10-01), our dollar, factory and router deployed with viem from the Foundry artifacts, and the payer
// started as a child process (`bun run src/main.ts run`) exactly as launchd would, over two loopback URL spellings.
//   1. the payer lists October and November for H100 and H200 and creates their Kuru V1 markets on Kuru's Router
//   2. daily positions opened through our router on the real Kuru book are claimed as demo days become final,
//      each payee paid exactly claimable(); a daily = false position untouched
//   3. the month turns: the sweep pays and closes the October positions, and December is listed with its market
// No transaction ever reaches a public network: every RPC URL the payer gets is loopback (checked).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { type Chain, freeGb, haveAnvil, read, startChain, tx } from "../anvil/chain.ts";
import {
  agateDollarAbi,
  agateRouterAbi,
  agateSeriesAbi,
  balanceOf,
  buildMarket,
  claimable,
  DEC,
  EPOCH_DAY,
  finalAt,
  fund,
  H100,
  H200,
  type MarketWorld,
  MAX,
  marketOf,
  mintDollars,
  NOPERMIT,
  NOV,
  OCT,
  position,
  putDay,
  seriesOf,
  U,
} from "../anvil/market.ts";

const RUN = process.env.AGATE_PAYER_FORK === "1" && haveAnvil;
const UPSTREAM = "https://testnet-rpc.monad.xyz";
const KURU_ROUTER: Address = "0x7EFbE105Ca7415dE98F96622173458ac1c054630";
const MARGIN: Address = "0xd029C2D98ff85D8F64799017fE00a59B1159CE02";
const marginAbi = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [{ name: "_user", type: "address" }, { name: "_token", type: "address" }, { name: "_amount", type: "uint256" }], outputs: [] },
] as const satisfies Abi;
const bookAbi = [
  { type: "function", name: "addSellOrder", stateMutability: "nonpayable", inputs: [{ name: "_price", type: "uint32" }, { name: "_size", type: "uint96" }, { name: "_postOnly", type: "bool" }], outputs: [] },
  { type: "function", name: "addBuyOrder", stateMutability: "nonpayable", inputs: [{ name: "_price", type: "uint32" }, { name: "size", type: "uint96" }, { name: "_postOnly", type: "bool" }], outputs: [] },
] as const satisfies Abi;

const DEPLOYER = generatePrivateKey();
const PAYER_KEY = generatePrivateKey();
const PAYER = privateKeyToAccount(PAYER_KEY).address;
const TODAY = EPOCH_DAY + 26; // the fork starts on demo Oct 27

let c: Chain;
let w: MarketWorld;
let dir: string;
let child: Bun.Subprocess | null = null;
let forkBlock = 0n;

async function until<T>(what: string, f: () => Promise<T | null | undefined | false>, ms = 180_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as T;
    if (child && child.exitCode !== null) throw new Error(`${what}: the payer exited (${child.exitCode}): ${tail()}`);
    if (Date.now() > end) throw new Error(`${what}: timed out; payer output: ${tail()}`);
    await Bun.sleep(250);
  }
}
const tail = () => (existsSync(join(dir, "payer.out")) ? readFileSync(join(dir, "payer.out"), "utf8").split("\n").slice(-12).join("\n") : "") + (existsSync(join(dir, "payer.err")) ? readFileSync(join(dir, "payer.err"), "utf8").slice(-800) : "");

describe.skipIf(!RUN)("payer on an anvil-safe fork of Monad testnet (demo clock)", () => {
  beforeAll(async () => {
    console.log(`df -h /: ${freeGb()} GB free`);
    dir = mkdtempSync(join(tmpdir(), "agate-payer-fork-"));
    c = await startChain(["--fork-url", UPSTREAM]);
    forkBlock = await c.pub.getBlockNumber({ cacheTime: 0 });
    console.log(`fork block ${forkBlock}, chain ${c.chainId}`);
    expect(c.chainId).toBe(10143);
    expect((await c.pub.getCode({ address: KURU_ROUTER }))?.length ?? 0).toBeGreaterThan(2);
    for (const k of [DEPLOYER, PAYER_KEY]) {
      const a = privateKeyToAccount(k).address;
      expect((await c.pub.getCode({ address: a })) ?? "0x").toBe("0x"); // fresh: no EIP-7702 code
      await c.call("anvil_setBalance", [a, `0x${(100_000n * 10n ** 18n).toString(16)}`]);
    }
    const t0 = await c.time();
    w = await buildMarket(c, { deployer: DEPLOYER, epochTs: t0 - BigInt(TODAY - EPOCH_DAY) * 600n - 50n, dir, kuruRouter: KURU_ROUTER, marginAccount: MARGIN });
    for (let d = EPOCH_DAY; d < TODAY; d++) for (const [g, v] of [[H100, 3_600_000n], [H200, 4_200_000n]] as const) await putDay(w, g, d, v);
    const urls = `${c.rpc},${c.rpc2}`;
    for (const u of urls.split(",")) expect(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(u)).toBe(true); // loopback only
    writeFileSync(join(dir, "payer.json"), JSON.stringify({ tickS: 1 }));
    child = Bun.spawn(["bun", "run", "src/main.ts", "run"], {
      cwd: join(import.meta.dir, "../.."),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/", AGATE_PAYER_KEY: PAYER_KEY, AGATE_RPC_URLS: urls, AGATE_CHAIN_ID: "10143", AGATE_DEPLOYMENTS: w.depFile, AGATE_WALL_HOME: join(dir, "home"), AGATE_PAYER_CONFIG: join(dir, "payer.json") },
      stdout: Bun.file(join(dir, "payer.out")),
      stderr: Bun.file(join(dir, "payer.err")),
    });
  }, 900_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      const t = setTimeout(() => child?.kill(9), 15_000);
      await child.exited;
      clearTimeout(t);
    }
    const text = tail() + (existsSync(join(dir, "payer.out")) ? readFileSync(join(dir, "payer.out"), "utf8") : "");
    await c?.stop();
    console.log(`fork block ${forkBlock}; df -h /: ${freeGb()} GB free after`);
    expect(text.toLowerCase()).not.toContain(PAYER_KEY.slice(2).toLowerCase());
    expect(text).not.toContain(UPSTREAM);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const daily: { id: bigint; payee: Address }[] = [];
  const lazy: { id: bigint; payee: Address }[] = [];

  test("1. October and November are listed for H100 and H200, with their Kuru V1 markets on Kuru's real Router", async () => {
    for (const g of [H100, H200])
      for (const m of [OCT, NOV]) {
        const s = await until(`series ${m}`, async () => {
          const a = await seriesOf(w, g, m);
          return a !== "0x0000000000000000000000000000000000000000" ? a : null;
        });
        const mk = await until(`market of ${s}`, async () => {
          const x = await marketOf(w, s);
          return x.venue === 1 ? x : null;
        });
        expect((await c.pub.getCode({ address: mk.market }))?.length ?? 0).toBeGreaterThan(2);
      }
  }, 600_000);

  test("2. daily positions opened through the router on the real Kuru book are claimed as demo days become final", async () => {
    const oct = await seriesOf(w, H100, OCT);
    const token = await read<Address>(c, oct, agateSeriesAbi as Abi, "token");
    const { market } = await marketOf(w, oct);
    const user = async () => {
      const k = generatePrivateKey();
      const a = privateKeyToAccount(k).address;
      await fund(w, a);
      await mintDollars(w, a, 1_000_000n * U);
      return { k, a };
    };
    // a maker resting both sides from Kuru's MarginAccount
    const M = await user();
    await tx(c, M.k, w.dollar, agateDollarAbi as Abi, "approve", [oct, MAX]);
    await tx(c, M.k, oct, agateSeriesAbi as Abi, "mint", [5_000n * U, M.a]);
    await tx(c, M.k, token, agateDollarAbi as Abi, "approve", [MARGIN, MAX]);
    await tx(c, M.k, w.dollar, agateDollarAbi as Abi, "approve", [MARGIN, MAX]);
    await tx(c, M.k, MARGIN, marginAbi, "deposit", [M.a, token, 5_000n * U]);
    await tx(c, M.k, MARGIN, marginAbi, "deposit", [M.a, w.dollar, 50_000n * U]);
    await tx(c, M.k, market, bookAbi, "addSellOrder", [3_640_000, 20_000_000n, false]);
    await tx(c, M.k, market, bookAbi, "addBuyOrder", [3_600_000, 20_000_000n, false]);
    const flow = async (fn: "openLongDaily" | "openShort", args: (payee: Address) => readonly unknown[], into: { id: bigint; payee: Address }[], parts: number) => {
      const u = await user();
      await tx(c, u.k, w.dollar, agateDollarAbi as Abi, "approve", [w.router, MAX]);
      const payee = privateKeyToAccount(generatePrivateKey()).address;
      await tx(c, u.k, w.router, agateRouterAbi as Abi, fn, args(payee));
      const next = (await read<readonly unknown[]>(c, oct, agateSeriesAbi as Abi, "state"))[6] as bigint;
      for (let id = next - BigInt(parts); id < next; id++) into.push({ id, payee });
    };
    await flow("openLongDaily", (p) => [oct, 728n * U, 199n * U, 2n, p, NOPERMIT], daily, 2); // 200 tokens at 3.64, two positions
    await flow("openShort", (p) => [oct, 200n * U, 1n, 2n, p, true, NOPERMIT], daily, 2); // 200 tokens sold at 3.60, two positions
    await flow("openShort", (p) => [oct, 100n * U, 1n, 1n, p, false, NOPERMIT], lazy, 1); // daily = false
    for (const x of [...daily, ...lazy]) expect((await position(w, oct, x.id)).owner).not.toBe("0x0000000000000000000000000000000000000000");
    for (const day of [TODAY, TODAY + 1]) {
      for (const [g, v] of [[H100, 3_700_000n], [H200, 4_100_000n]] as const) await putDay(w, g, day, v);
      await c.warp(finalAt(w, day) + 1n);
      await c.mine(3);
      const want = new Map<string, bigint>();
      for (const x of daily) want.set(x.payee, (want.get(x.payee) ?? 0n) + (await claimable(w, oct, x.id))!);
      const before = new Map<string, bigint>();
      for (const x of [...daily, ...lazy]) before.set(x.payee, await balanceOf(w, w.dollar, x.payee));
      const lazyPaid = (await position(w, oct, lazy[0]!.id)).paid;
      await until(`claims of day ${day}`, async () => {
        for (const x of daily) if ((await claimable(w, oct, x.id)) !== 0n) return false;
        return true;
      });
      for (const [p, v] of want) {
        expect(v).toBeGreaterThan(0n);
        expect((await balanceOf(w, w.dollar, p as Address)) - before.get(p)!).toBe(v);
      }
      expect((await position(w, oct, lazy[0]!.id)).paid).toBe(lazyPaid);
      expect(await balanceOf(w, w.dollar, lazy[0]!.payee)).toBe(before.get(lazy[0]!.payee)!);
    }
  }, 900_000);

  test("3. the month turns: the sweep pays and closes the October positions, and December is listed with its market", async () => {
    const oct = await seriesOf(w, H100, OCT);
    for (let day = TODAY + 2; day <= EPOCH_DAY + 30; day++) for (const [g, v] of [[H100, 3_700_000n], [H200, 4_100_000n]] as const) await putDay(w, g, day, v);
    await c.warp(finalAt(w, EPOCH_DAY + 30) + 1n); // demo Nov 1: November is the current month
    await c.mine(3);
    const all = [...daily, ...lazy];
    const want = new Map<string, bigint>();
    for (const x of all) want.set(x.payee, (want.get(x.payee) ?? 0n) + (await claimable(w, oct, x.id))!);
    const before = new Map<string, bigint>();
    for (const x of all) before.set(x.payee, await balanceOf(w, w.dollar, x.payee));
    await until("the sweep", async () => {
      for (const x of all) if ((await position(w, oct, x.id)).owner !== "0x0000000000000000000000000000000000000000") return false;
      return true;
    });
    for (const [p, v] of want) expect((await balanceOf(w, w.dollar, p as Address)) - before.get(p)!).toBe(v);
    for (const g of [H100, H200]) {
      const dec = await until(`December ${g.slice(0, 10)}`, async () => {
        const a = await seriesOf(w, g, DEC);
        return a !== "0x0000000000000000000000000000000000000000" ? a : null;
      });
      await until(`December's market ${g.slice(0, 10)}`, async () => (await marketOf(w, dec)).venue === 1);
    }
  }, 900_000);
});

void ({} as Hex);
