// BOTS-SPEC 4.8, local-anvil tests (anvil-safe, no fork): the market deployed from the Foundry artifacts (AgateDollar,
// MockIndex on the demo clock, AgateFactory over MockKuruRouter), records and time driven by the test, the payer
// running in process (and once as a child process) over the real RpcPool, MarketSender, ViemReads and scanner:
//   1. a dry run sends nothing; the lister waits on NotReady and lists the moment the anchors are final;
//      createMarket follows; a restarted lister and a second lister send nothing
//   2. positions opened directly and through the router; after each final day one sync, then claimMany batches of
//      at most 50 paying exactly claimable() to each payee; daily = false and sub-cent positions untouched
//   3. the final sweep closes the right positions and leaves the dust; the month turns and the next month is listed
//   4. a kill -9 of the payer between a send and its receipt, then a restart that pays nobody twice
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildApp, type PayerApp } from "../../src/app.ts";
import { parseConfig } from "../../src/config.ts";
import { bootstrap } from "@agate/market";
import { type Chain, freeGb, haveAnvil, read, startChain, tx } from "./chain.ts";
import {
  agateDollarAbi,
  agateRouterAbi,
  agateSeriesAbi,
  balanceOf,
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
  streamOut,
  U,
  buildMarket,
} from "./market.ts";

const DEPLOYER: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil #0: a local chain only
const PAYER_KEY = generatePrivateKey();
const PAYER = privateKeyToAccount(PAYER_KEY).address;
const LIMITS = JSON.stringify({ "factory.createMarket": 1_950_000 }); // MockKuruRouter's deployProxy measured 1,892,754
const now = () => Math.floor(Date.now() / 1000);

let c: Chain;
let w: MarketWorld;
let dir: string;
let home: string;
const logs: { event: string; data: Record<string, unknown> }[] = [];

async function app(o: { key?: Hex; keyVar?: string; dryRun?: boolean; home?: string; config?: object } = {}): Promise<PayerApp> {
  const keyVar = o.keyVar ?? "AGATE_PAYER_KEY";
  process.env.AGATE_RPC_URLS = `${c.rpc},${c.rpc2}`;
  process.env.AGATE_CHAIN_ID = String(c.chainId);
  process.env.AGATE_DEPLOYMENTS = w.depFile;
  process.env.AGATE_WALL_HOME = o.home ?? home;
  process.env.AGATE_MARKET_GAS_LIMITS = LIMITS;
  delete process.env.AGATE_DRY_RUN;
  if (o.dryRun) {
    process.env.AGATE_DRY_RUN = "1";
    process.env.AGATE_PAYER_ADDRESS = PAYER;
  } else process.env[keyVar] = o.key ?? PAYER_KEY;
  const rt = await bootstrap({ role: "payer", keyVar, addressVar: "AGATE_PAYER_ADDRESS", now, console: false, noLock: true, marginAccount: "optional" });
  delete process.env.AGATE_DRY_RUN;
  return buildApp(rt, parseConfig({ tickS: 1, ...(o.config ?? {}) }), { now, log: (event, data) => logs.push({ event, data }), pollMs: 20 });
}

const nonce = (a: Address) => c.pub.getTransactionCount({ address: a, blockTag: "latest" });
/** The scanner reads to `finalized` (2 blocks behind latest with --slots-in-an-epoch 1). */
const settle = () => c.mine(3);
const since = (n: number) => logs.slice(n);

describe.skipIf(!haveAnvil)("payer and lister on a local anvil (anvil-safe)", () => {
  beforeAll(async () => {
    console.log(`df -h /: ${freeGb()} GB free`);
    dir = mkdtempSync(join(tmpdir(), "agate-payer-anvil-"));
    home = join(dir, "home");
    c = await startChain(["--chain-id", "31337"]);
    const t0 = await c.time();
    w = await buildMarket(c, { deployer: DEPLOYER, epochTs: t0 - 50n, dir });
    await fund(w, PAYER);
  }, 300_000);

  afterAll(async () => {
    await c?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true }); // this test's own temp dir only
    console.log(`df -h /: ${freeGb()} GB free after`);
  });

  test("1. dry run sends nothing; NotReady waits; the lister lists the moment the anchors are final; createMarket follows; a second lister does nothing", async () => {
    const a = await app();
    let r = await a.tick();
    expect(r.lister!.waiting.length).toBe(4);
    expect(await nonce(PAYER)).toBe(0);
    for (const [g, v] of [[H100, 3_600_000n], [H200, 4_200_000n]] as const) await putDay(w, g, EPOCH_DAY, v);
    await c.warp(w.epochTs + 700n); // the day ended, its record not final yet (final at + 960)
    r = await a.tick();
    expect(r.lister!.waiting.length).toBe(4);
    expect(await nonce(PAYER)).toBe(0);
    await c.warp(finalAt(w, EPOCH_DAY) + 1n);
    const mark = logs.length;
    const dry = await app({ dryRun: true });
    await dry.tick();
    expect(since(mark).filter((l) => l.event === "dry_run" && l.data.shape === "factory.list").length).toBe(4);
    expect(await nonce(PAYER)).toBe(0);
    expect(await seriesOf(w, H100, OCT)).toBe("0x0000000000000000000000000000000000000000");
    r = await a.tick();
    expect(r.lister!.listed).toEqual(["demo H100 2026-10", "demo H100 2026-11", "demo H200 2026-10", "demo H200 2026-11"]);
    expect(r.lister!.created.length).toBe(4);
    expect(await nonce(PAYER)).toBe(8);
    for (const g of [H100, H200])
      for (const m of [OCT, NOV]) {
        const s = await seriesOf(w, g, m);
        expect(s).not.toBe("0x0000000000000000000000000000000000000000");
        expect((await marketOf(w, s)).venue).toBe(1);
      }
    // a restarted lister and a second lister (another key, another home) send nothing
    await (await app()).tick();
    expect(await nonce(PAYER)).toBe(8);
    const k2 = generatePrivateKey();
    const a2 = privateKeyToAccount(k2).address;
    await fund(w, a2);
    await (await app({ key: k2, keyVar: "AGATE_PAYER_KEY2", home: join(dir, "home2") })).tick();
    expect(await nonce(a2)).toBe(0);
  }, 300_000);

  const ids: { id: bigint; payee: Address; kind: "daily" | "lazy" | "dust" }[] = [];

  test("2. daily positions (direct and through the router) are claimed after each final day: one sync, then batches of 50, 50, 26; each payee gets exactly claimable()", async () => {
    const oct = await seriesOf(w, H100, OCT);
    const token = await read<Address>(c, oct, agateSeriesAbi as Abi, "token");
    const { market } = await marketOf(w, oct);
    const key = () => generatePrivateKey();
    const user = async () => {
      const k = key();
      const a = privateKeyToAccount(k).address;
      await fund(w, a);
      await mintDollars(w, a, 1_000_000n * U);
      await tx(c, k, w.dollar, agateDollarAbi as Abi, "approve", [oct, MAX]);
      return { k, a };
    };
    const payee = () => privateKeyToAccount(key()).address;
    // direct: a long and a short (daily), a long with daily = false, a one-LOT long (under a cent a day)
    const A = await user();
    await tx(c, A.k, oct, agateSeriesAbi as Abi, "mint", [2_000n * U, A.a]);
    for (const [side, q, daily, kind] of [[0, 720n * U, true, "daily"], [1, 720n * U, true, "daily"], [0, 100n * U, false, "lazy"], [0, 100n, true, "dust"]] as const) {
      const p = payee();
      ids.push({ id: await streamOut(w, A.k, oct, side, q, p, daily), payee: p, kind });
    }
    // through the router on the mock Kuru book: a maker's ask and bid, a renter's openLongDaily and an owner's openShort
    const M = await user();
    await tx(c, M.k, oct, agateSeriesAbi as Abi, "mint", [5_000n * U, M.a]);
    await tx(c, M.k, token, agateDollarAbi as Abi, "approve", [market, MAX]);
    await tx(c, M.k, w.dollar, agateDollarAbi as Abi, "approve", [market, MAX]);
    await tx(c, M.k, market, w.bookAbi, "addSellOrder", [3_640_000, 10_000_000n, false]);
    await tx(c, M.k, market, w.bookAbi, "addBuyOrder", [3_600_000, 10_000_000n, false]);
    const E = await user();
    await tx(c, E.k, w.dollar, agateDollarAbi as Abi, "approve", [w.router, MAX]);
    const pe = payee();
    const rcE = await tx(c, E.k, w.router, agateRouterAbi as Abi, "openLongDaily", [oct, 364n * U, 99n * U, 2n, pe, NOPERMIT]);
    const F = await user();
    await tx(c, F.k, w.dollar, agateDollarAbi as Abi, "approve", [w.router, MAX]);
    const pf = payee();
    await tx(c, F.k, w.router, agateRouterAbi as Abi, "openShort", [oct, 100n * U, 1n, 2n, pf, true, NOPERMIT]);
    void rcE;
    const next = (await read<readonly unknown[]>(c, oct, agateSeriesAbi as Abi, "state"))[6] as bigint;
    for (let id = next - 4n; id < next; id++) ids.push({ id, payee: (await position(w, oct, id)).payee, kind: "daily" });
    // 120 more daily positions of two tokens, one payee each
    const G = await user();
    await tx(c, G.k, oct, agateSeriesAbi as Abi, "mint", [240n * U, G.a]);
    for (let i = 0; i < 120; i++) {
      const p = payee();
      ids.push({ id: await streamOut(w, G.k, oct, 0, 2n * U, p, true), payee: p, kind: "daily" });
    }
    expect(ids.filter((x) => x.kind === "daily").length).toBe(126);
    const a = await app();
    for (const day of [EPOCH_DAY + 1, EPOCH_DAY + 2]) {
      for (const [g, v] of [[H100, 3_600_000n], [H200, 4_200_000n]] as const) await putDay(w, g, day, v);
      await c.warp(finalAt(w, day) + 1n);
      await settle();
      const want = new Map<string, bigint>();
      const before = new Map<string, bigint>();
      const paidBefore = new Map<bigint, bigint>();
      for (const x of ids) {
        before.set(x.payee, await balanceOf(w, w.dollar, x.payee));
        paidBefore.set(x.id, (await position(w, oct, x.id)).paid);
        if (x.kind === "daily") want.set(x.payee, (want.get(x.payee) ?? 0n) + (await claimable(w, oct, x.id))!);
      }
      const mark = logs.length;
      const n0 = await nonce(PAYER);
      await a.tick();
      const claimed = since(mark).filter((l) => l.event === "claimed");
      expect(claimed.map((l) => l.data.ids)).toEqual([50, 50, 26]);
      expect(claimed.every((l) => l.data.c === 0)).toBe(true);
      const mined = since(mark).filter((l) => l.event === "mined").map((l) => l.data.shape);
      expect(mined).toEqual(["series.sync", "series.claimMany", "series.claimMany", "series.claimMany"]);
      expect(await nonce(PAYER)).toBe(n0 + 4);
      for (const [p, v] of want) expect((await balanceOf(w, w.dollar, p as Address)) - before.get(p)!).toBe(v);
      for (const x of ids) {
        if (x.kind === "daily") expect(await claimable(w, oct, x.id)).toBe(0n);
        else {
          expect((await position(w, oct, x.id)).paid).toBe(paidBefore.get(x.id)!);
          expect(await balanceOf(w, w.dollar, x.payee)).toBe(before.get(x.payee)!);
        }
      }
      // the same day again: nothing
      await a.tick();
      expect(await nonce(PAYER)).toBe(n0 + 4);
    }
  }, 600_000);

  test("3. after the last day: the sweep closes every position with claimable >= $0.01 or q >= 1 token and leaves the dust; the month turns and December is listed", async () => {
    const oct = await seriesOf(w, H100, OCT);
    for (let day = EPOCH_DAY + 3; day <= EPOCH_DAY + 30; day++) for (const [g, v] of [[H100, 3_700_000n], [H200, 4_100_000n]] as const) await putDay(w, g, day, v);
    await c.warp(finalAt(w, EPOCH_DAY + 30) + 1n); // inside Nov 1 (day 20,758): currentMonth is November
    await settle();
    const want = new Map<bigint, bigint>();
    const bal = new Map<string, bigint>();
    for (const x of ids) {
      want.set(x.id, (await claimable(w, oct, x.id))!);
      bal.set(x.payee, await balanceOf(w, w.dollar, x.payee));
    }
    const mark = logs.length;
    const a = await app();
    const r = await a.tick();
    expect(r.lister!.listed).toEqual(["demo H100 2026-12", "demo H200 2026-12"]);
    expect(r.lister!.created.length).toBe(2);
    expect((await marketOf(w, await seriesOf(w, H100, DEC))).venue).toBe(1);
    const sync = since(mark).find((l) => l.event === "mined" && l.data.shape === "series.sync");
    expect(sync).toBeDefined();
    const gotPaid = new Map<string, bigint>();
    for (const x of ids) gotPaid.set(x.payee, (gotPaid.get(x.payee) ?? 0n) + (x.kind === "dust" ? 0n : want.get(x.id)!));
    for (const x of ids) {
      const p = await position(w, oct, x.id);
      if (x.kind === "dust") {
        expect(p.owner).not.toBe("0x0000000000000000000000000000000000000000");
        const cl = (await claimable(w, oct, x.id))!;
        expect(cl > 0n && cl < 10_000n).toBe(true);
      } else expect(p.owner).toBe("0x0000000000000000000000000000000000000000");
    }
    for (const [p, v] of gotPaid) expect((await balanceOf(w, w.dollar, p as Address)) - bal.get(p)!).toBe(v);
    const st = JSON.parse(readFileSync(join(home, "market/payer/state.json"), "utf8"));
    expect(st.series[oct.toLowerCase()].sweepDone).toBe(true);
    const n = await nonce(PAYER);
    await a.tick();
    expect(await nonce(PAYER)).toBe(n);
  }, 600_000);

  test("4. kill -9 between a claimMany send and its receipt, then a restart: nobody is paid twice", async () => {
    const nov = await seriesOf(w, H100, NOV);
    const k = generatePrivateKey();
    const me = privateKeyToAccount(k).address;
    await fund(w, me);
    await mintDollars(w, me, 100_000n * U);
    await tx(c, k, w.dollar, agateDollarAbi as Abi, "approve", [nov, MAX]);
    await tx(c, k, nov, agateSeriesAbi as Abi, "mint", [1_000n * U, me]);
    const mine: { id: bigint; payee: Address }[] = [];
    for (let i = 0; i < 5; i++) {
      const p = privateKeyToAccount(generatePrivateKey()).address;
      mine.push({ id: await streamOut(w, k, nov, i % 2 === 0 ? 0 : 1, BigInt(100 + i) * U, p, true), payee: p });
    }
    const nov1 = EPOCH_DAY + 31;
    for (const [g, v] of [[H100, 3_800_000n], [H200, 4_000_000n]] as const) await putDay(w, g, nov1, v);
    await c.warp(finalAt(w, nov1) + 1n);
    await tx(c, k, nov, agateSeriesAbi as Abi, "sync", [1n]); // a stranger's sync: the payer's first send is the claim
    await settle();
    const want = await Promise.all(mine.map(async (x) => (await claimable(w, nov, x.id))!));
    const bal0 = await Promise.all(mine.map((x) => balanceOf(w, w.dollar, x.payee)));
    const n0 = await nonce(PAYER);
    const cfg = join(dir, "payer.json");
    writeFileSync(cfg, JSON.stringify({ tickS: 1 }));
    await c.call("evm_setAutomine", [false]);
    const out = join(dir, "child.out");
    const child = Bun.spawn(["bun", "run", "src/main.ts", "run"], {
      cwd: join(import.meta.dir, "../.."),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/", AGATE_PAYER_KEY: PAYER_KEY, AGATE_RPC_URLS: `${c.rpc},${c.rpc2}`, AGATE_CHAIN_ID: String(c.chainId), AGATE_DEPLOYMENTS: w.depFile, AGATE_WALL_HOME: home, AGATE_PAYER_CONFIG: cfg, AGATE_MARKET_GAS_LIMITS: LIMITS },
      stdout: Bun.file(out),
      stderr: Bun.file(`${out}.err`),
    });
    let pending = 0;
    const until = Date.now() + 90_000;
    while (Date.now() < until) {
      const pool = (await c.call("txpool_content")) as { pending: Record<string, Record<string, unknown>> };
      pending = Object.keys(pool.pending).filter((a) => a.toLowerCase() === PAYER.toLowerCase()).length;
      if (pending > 0 || child.exitCode !== null) break;
      await Bun.sleep(100);
    }
    child.kill(9);
    await child.exited;
    expect(pending).toBe(1);
    await c.call("evm_mine", []); // the claimMany lands after its sender died
    await c.call("evm_setAutomine", [true]);
    await settle();
    expect(await nonce(PAYER)).toBe(n0 + 1);
    const bal1 = await Promise.all(mine.map((x) => balanceOf(w, w.dollar, x.payee)));
    mine.forEach((_, i) => expect(bal1[i]! - bal0[i]!).toBe(want[i]!));
    // restart: the state never recorded the round; the scan or the simulation's total shows it was paid
    const a = await app();
    await a.tick();
    await a.tick();
    expect(await nonce(PAYER)).toBe(n0 + 1);
    const bal2 = await Promise.all(mine.map((x) => balanceOf(w, w.dollar, x.payee)));
    expect(bal2).toEqual(bal1);
    // nothing the child wrote carries the key
    const text = readFileSync(out, "utf8") + (existsSync(`${out}.err`) ? readFileSync(`${out}.err`, "utf8") : "");
    expect(text.toLowerCase()).not.toContain(PAYER_KEY.slice(2).toLowerCase());
    expect(text).toContain('"event":"start"');
  }, 300_000);
});
