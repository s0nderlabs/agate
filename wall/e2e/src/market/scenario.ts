// The market's fork e2e (BOTS-SPEC 6, the integration run): one anvil-safe fork of Monad testnet, the
// demo index and the market deployed by the repo's forge scripts, demo days posted, closed and countersigned on the
// real AgateIndex, the lister and payer and the market maker run as child processes exactly as launchd runs them,
// users trading through the router on Kuru V1's real books, then every log of the run replayed through the indexer
// (indexer/test/fork) and every entity compared with the chain's own views. Covered here: E1 to E5, E8 (kill and
// unkill), E9, E10, E12, E13, E15, E16, E17, E18, E20, and the audit's M-H1 (the pending guard on the real
// AgateIndex and Kuru book) and M-K1 (the payer's key from AGATE_KEY_CMD, absent from its process environment). Not covered (unit tests and the bots' own fork tests do):
// E6, E7, E8's loss limit, E11, E14, E19.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Abi, type Address, decodeEventLog, type Hex, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { agateDollarAbi, agateFactoryAbi, agateIndexAbi, agateRouterAbi, agateSeriesAbi, agateTokenAbi, kuruOrderBookAbi } from "../../../packages/market/src/index.ts";
import { freePort } from "../../../scripts/anvil.ts";
import { deserialize } from "../../../apps/marketmaker/src/state.ts";
import { Bot, until } from "./bots.ts";
import { exportLogs, readTruth } from "./capture.ts";
import {
  anvilTmpKb,
  type DayValues,
  DEC,
  deployWorld,
  DeploymentsGuard,
  dfLine,
  Fork,
  freeGb,
  GPU,
  type GpuName,
  GPUS,
  INDEX_GPUS,
  IndexDays,
  isLoopback,
  MARGIN,
  MAX,
  MIN_FREE_GB,
  NOPERMIT,
  NOV,
  OCT,
  OCT1,
  ownRunDir,
  ROLE,
  ROOT,
  type SecretProxy,
  startSecretProxy,
  U,
  ZERO,
} from "./fork.ts";
import { Report } from "./report.ts";
import { activeOf, allOrders, book, CENT, claimableOf, expectedLadder, fairOf, marginOf, opened, type Pos, position, preview, shapeOf, type SentTx, type Terms, terms, TICK, txsFrom, UNITS } from "./views.ts";

export interface RunOptions {
  /** where the indexer's fork fixture goes (default indexer/test/fork/fixtures) */
  fixtureDir?: string;
  /** run the indexer's fork replay at the end (default true) */
  replay?: boolean;
  /** keep the scratch dir (default: removed) */
  keep?: boolean;
  log?: (s: string) => void;
}

const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const j = (x: unknown) => JSON.stringify(x, big);

/** The index's demo values (u) per 1-based day of the run (1 = Oct 1, 32 = Nov 1). */
function values(i: number): DayValues {
  const H100 = i === 1 ? 3_600_000n : i < 7 ? 3_700_000n : i < 20 ? 3_800_000n : 3_750_000n;
  return { H100, H200: 4_200_000n, B200: i < 15 ? 5_000_000n : 4_900_000n };
}

export async function runMarketFork(o: RunOptions = {}): Promise<Report> {
  const say = o.log ?? ((s: string) => console.log(s));
  const rep = new Report(say);
  const scratch = mkdtempSync(join(tmpdir(), "agate-market-fork-"));
  rep.num("disk before (df -h /)", dfLine());
  const tmpBefore = anvilTmpKb();
  rep.num("~/.foundry/anvil/tmp KB before", tmpBefore);
  if (freeGb() < MIN_FREE_GB) throw new Error(`only ${freeGb()} GB free (floor ${MIN_FREE_GB} GB): not starting anvil`);
  const guard = new DeploymentsGuard(scratch);
  let fork: Fork | null = null;
  const proxies: SecretProxy[] = [];
  const bots: Bot[] = [];
  const cliOut: string[] = [];
  const secretsAll: string[] = [];
  const keysAll: Hex[] = [];
  try {
    // ---------------------------------------------------------------- the fork and the world (E1)
    rep.step("fork of Monad testnet through anvil-safe");
    fork = await Fork.start();
    const f = fork;
    rep.num("fork block", f.forkBlock);
    rep.num("fork time", f.forkTime);
    rep.num("anvil-safe run dir", f.runDir ?? "none found");
    rep.step("DeployIndex (fork-demo.json), DeployMarket (market-fork.json), verify()");
    const w = await deployWorld(f, scratch);
    const depFile = join(scratch, "deployments.json");
    writeFileSync(depFile, w.deploymentsText);
    guard.restore(); // the repo's deployments files are back as they were; the bots read the scratch copy
    const dep = JSON.parse(w.deploymentsText) as { chainId: number; dollar: Address; kuru: { router: Address; marginAccount: Address }; factories: Record<string, { index: Address; factory: Address; router: Address; dollar: Address; tPend: number; startBlock: number; tag: string }> };
    const demo = dep.factories.demo!;
    const codeOk = async (a: Address) => ((await f.pub.getCode({ address: a })) ?? "0x").length > 2;
    rep.check("E1", "deployments file verified: chain 10143, demo factory over the demo index, Kuru V1's router and margin account, every address with code", dep.chainId === 10143 && demo.index.toLowerCase() === w.index.toLowerCase() && dep.kuru.router.toLowerCase() === "0x7efbe105ca7415de98f96622173458ac1c054630" && dep.kuru.marginAccount.toLowerCase() === MARGIN.toLowerCase() && (await codeOk(demo.factory)) && (await codeOk(demo.router)) && (await codeOk(dep.dollar)) && demo.tPend === 210, { index: w.index, factory: demo.factory, router: demo.router, dollar: dep.dollar, tPend: demo.tPend, startBlock: demo.startBlock });
    const days = await IndexDays.create(f, w.index, w.t0);
    rep.num("demo clock", { day: days.clocks.day, slice: days.clocks.slice, tPend: days.clocks.tPend, closeGrace: days.clocks.closeGrace, t0: w.t0 });

    // ---------------------------------------------------------------- keys, MON, tUSD
    const gpk = () => {
      const k = generatePrivateKey();
      keysAll.push(k);
      return k;
    };
    const K = { maker: gpk(), payer: gpk(), R: gpk(), O: gpk(), L: gpk(), D: gpk(), B1: gpk(), B2: gpk(), B3: gpk(), B4: gpk(), dryMaker: gpk(), dryPayer: gpk() };
    const A = Object.fromEntries(Object.entries(K).map(([n, k]) => [n, privateKeyToAccount(k).address])) as Record<keyof typeof K, Address>;
    const fresh = () => privateKeyToAccount(generatePrivateKey()).address;
    const P = { R2: fresh(), R3: fresh(), O2: fresh(), O3: fresh(), L2: fresh(), D2: fresh(), D3: fresh(), Bp1: fresh(), Bp2: fresh(), Bp3: fresh(), Bp4: fresh() };
    for (const n of ["maker", "payer", "R", "O", "L", "D", "B1", "B2", "B3", "B4"] as const) await f.fund(A[n]);
    const mintT = (to: Address, amt: bigint) => f.txAs(ROLE.deployer, dep.dollar, agateDollarAbi as Abi, "mint", [to, amt]);
    await mintT(A.maker, 10_000_000n * U); // the documented one-time float mint by the dollar's minter
    for (const n of ["R", "O", "L", "D", "B1", "B2", "B3", "B4"] as const) await mintT(A[n], 1_000_000n * U);
    await mintT(A.dryMaker, 1_000_000n * U);

    // ---------------------------------------------------------------- RPC URLs: a dead one first, two secret-path proxies
    const secret = () => toHex(crypto.getRandomValues(new Uint8Array(20))).slice(2);
    const sA = secret();
    const sB = secret();
    const sDead = secret();
    secretsAll.push(sA, sB, sDead);
    proxies.push(startSecretProxy(f.rpc, "127.0.0.1", sA), startSecretProxy(f.rpc, "localhost", sB));
    const urls = [`http://127.0.0.1:${freePort()}/v2/${sDead}`, proxies[0]!.url, proxies[1]!.url];
    if (!urls.every(isLoopback)) throw new Error("a bot URL is not loopback: refused");
    rep.num("bot RPC URLs", urls.map((u) => u.replace(/\/v2\/.*/, "/v2/<secret>")));
    const mmCfg = { factories: ["demo"], tickS: 1, minRequoteS: 2, runUntil: "2027-01-31T00:00:00Z" };
    const payerCfg = { tickS: 1, runUntil: "2027-01-31T00:00:00Z" };
    // the payer takes its key as launchd's run script now has it: AGATE_KEY_CMD run by the process itself (audit M-K1)
    mkdirSync(join(scratch, "keys"), { recursive: true, mode: 0o700 });
    const payerKeyFile = join(scratch, "keys", "payer.key");
    writeFileSync(payerKeyFile, `${K.payer}\n`, { mode: 0o600 });
    const payer = new Bot("payer", scratch, { keyCmd: `cat ${payerKeyFile}`, urls, deployments: depFile, config: payerCfg, home: join(scratch, "payer-home") });
    const maker = new Bot("marketmaker", scratch, { key: K.maker, urls, deployments: depFile, config: mmCfg, home: join(scratch, "mm-home") });
    bots.push(payer, maker);
    const cli = async (b: Bot, args: string[]) => {
      const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/", AGATE_RPC_URLS: urls.join(","), AGATE_CHAIN_ID: "10143", AGATE_DEPLOYMENTS: depFile, AGATE_WALL_HOME: b.env.home, AGATE_MM_CONFIG: join(scratch, "marketmaker.config.json"), AGATE_MM_KEY: K.maker };
      // async: the RPC proxies live in this process, so a blocking spawn would stall the running bots
      const p = Bun.spawn(["bun", "run", "src/main.ts", ...args], { cwd: b.cwd, env, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      const text = `${out}\n${err}`;
      cliOut.push(text);
      return { code, text };
    };

    // E1: a wrong chain id and a deployments file of another chain are refused
    for (const [what, env] of [
      ["AGATE_CHAIN_ID 1", { chainId: "1", deployments: depFile }],
      ["a deployments file for chain 1", { chainId: "10143", deployments: join(scratch, "deployments-chain1.json") }],
    ] as const) {
      writeFileSync(join(scratch, "deployments-chain1.json"), w.deploymentsText.replace(/"chainId":\s*10143/, '"chainId": 1'));
      const b = new Bot("payer", scratch, { key: K.payer, urls, deployments: env.deployments, chainId: env.chainId, config: payerCfg, home: join(scratch, "refuse-home") }, `payer-refuse-${env.chainId}`);
      bots.push(b);
      b.start();
      const code = await Promise.race([b.proc!.exited, Bun.sleep(60_000).then(() => null)]);
      if (code === null) await b.stop("SIGKILL");
      rep.check("E1", `the payer refuses ${what}`, code !== null && code !== 0 && (await f.nonce(A.payer)) === 0, { exit: code, said: b.text().trim().split("\n").slice(-1)[0] });
    }

    // ---------------------------------------------------------------- Oct 1 and the lister's windows (E2)
    rep.step("Oct 1 readings posted (H100 3.60, H200 4.20, B200 5.00); the lister starts before any anchor is final");
    for (let h = 0; h < 4; h++) await days.postSlice(OCT1, h, values(1));
    payer.start();
    await until("three payer ticks", async () => payer.events().filter((e) => e.event === "tick").length >= 3, [payer], 120_000);
    const waitingTicks = payer.events().filter((e) => e.event === "tick");
    rep.check("E2", "before the anchors are final the lister waits (6 months NotReady) and sends nothing", waitingTicks.every((e) => e.waiting === 6) && (await f.nonce(A.payer)) === 0, { ticks: waitingTicks.length, waiting: waitingTicks.map((e) => e.waiting) });
    {
      // audit M-K1: the payer ran AGATE_KEY_CMD itself, so its exec-time environment (what `ps -wwE` shows any process
      // of this user) holds no key; it signs as the key's address (checked by every later payer transaction)
      const ps = Bun.spawnSync(["ps", "-wwE", "-o", "command=", "-p", String(payer.proc!.pid)]).stdout.toString();
      const started = payer.events().find((e) => e.event === "start");
      rep.check("M-K1", "the payer took its key from AGATE_KEY_CMD: no key in its process environment (ps -wwE), the key's address in its start line", ps.includes("src/main.ts") && !ps.toLowerCase().includes(K.payer.slice(2).toLowerCase()) && String(started?.from ?? "").toLowerCase() === A.payer.toLowerCase(), { psRead: ps.includes("src/main.ts"), from: started?.from });
    }
    rep.check("E17", "the dead first URL was failed over (RPC_FAILOVER raised) and the payer works", payer.alerts().some((a) => a.code === "RPC_FAILOVER"), payer.alerts().filter((a) => a.code === "RPC_FAILOVER").map((a) => a.message).slice(0, 1));

    // positions the harness opened, and the payer's checks after each final day
    const positions: Pos[] = [];
    const series: Record<string, Address> = {};
    const markets: Record<string, Address> = {};
    const T: Record<string, Terms> = {};
    const key = (g: GpuName, m: number) => `${g}-${m}`;
    const balanceOf = (a: Address) => f.read<bigint>(dep.dollar, agateDollarAbi as Abi, "balanceOf", [a]);

    interface Snap {
      block: bigint;
      cands: { p: Pos; claimable: bigint }[];
      others: { p: Pos; paid: bigint }[];
      bal: Map<string, bigint>;
      sweep: Set<string>;
    }
    /** The day is final at finalAt: freeze the payer, warp there, read what each position may claim, unfreeze. */
    const snapAt = async (finalAt: bigint, frozen: Bot | null): Promise<Snap> => {
      frozen?.pause();
      await f.warp(finalAt);
      await f.mine(3); // the payer scans to `finalized` (latest - 2 with one slot per epoch)
      const s: Snap = { block: await f.block(), cands: [], others: [], bal: new Map(), sweep: new Set() };
      for (const ser of new Set(positions.map((p) => p.series))) {
        const pv = await preview(f, ser);
        const t = T[ser.toLowerCase()]!;
        if (pv.k === t.n) s.sweep.add(ser.toLowerCase());
      }
      for (const p of positions) {
        const pos = await position(f, p);
        if (pos.owner === ZERO) continue;
        const c = (await claimableOf(f, p))!;
        const sweep = s.sweep.has(p.series.toLowerCase());
        const isCand = sweep ? c >= CENT || (p.q >= U && c > 0n) : pos.daily && c >= CENT;
        if (isCand) s.cands.push({ p, claimable: c });
        else s.others.push({ p, paid: pos.paid });
        if (!s.bal.has(p.payee)) s.bal.set(p.payee, await balanceOf(p.payee));
      }
      frozen?.resume();
      return s;
    };
    /** Waits for the payer's round, then checks every payee was paid exactly its claimable and nothing else moved. */
    const settleClaims = async (s: Snap, what: string, id = "E10") => {
      if (s.cands.length > 0) {
        await until(`${what}: the payer's claims`, async () => {
          for (const c of s.cands) {
            const pos = await position(f, c.p);
            if (pos.owner !== ZERO && ((await claimableOf(f, c.p)) ?? 0n) !== 0n) return false;
          }
          return true;
        }, [payer, maker], 180_000);
      } else await Bun.sleep(2_500);
      const want = new Map<string, bigint>();
      for (const c of s.cands) want.set(c.p.payee, (want.get(c.p.payee) ?? 0n) + c.claimable);
      let bad = 0;
      const deltas: Record<string, string> = {};
      for (const [payee, before] of s.bal) {
        const d = (await balanceOf(payee as Address)) - before;
        deltas[payee] = d.toString();
        if (d !== (want.get(payee) ?? 0n)) bad++;
      }
      let moved = 0;
      for (const x of s.others) {
        const pos = await position(f, x.p);
        if (pos.owner === ZERO || pos.paid !== x.paid) moved++;
      }
      const txs = await txsFrom(f, A.payer, s.block + 1n);
      const claims = txs.filter((t) => t.fn === "claimMany");
      const syncs = txs.filter((t) => t.fn === "sync");
      const perSeries = new Map<string, number>();
      for (const t of syncs) perSeries.set(t.to.toLowerCase(), (perSeries.get(t.to.toLowerCase()) ?? 0) + 1);
      const sizes = claims.map((t) => (t.args[0] as unknown[]).length);
      const ok = bad === 0 && moved === 0 && txs.every((t) => t.ok) && sizes.every((n) => n <= 50) && [...perSeries.values()].every((n) => n <= 1) && (s.cands.length === 0 || sizes.reduce((a, b) => a + b, 0) >= s.cands.length);
      rep.check(id, `${what}: ${s.cands.length} positions paid exactly claimable() to their payees (${s.cands.length === 0 ? "none due" : `${claims.length} claimMany of ${sizes.join("/")} ids, ${syncs.length} sync`}); ${s.others.length} others untouched`, ok, bad || moved ? { bad, moved, deltas } : { paidU: [...want.values()].reduce((a, b) => a + b, 0n) });
      return { claims, syncs, sizes };
    };
    type Settled = Awaited<ReturnType<typeof settleClaims>>;

    let closedDay = 0; // the newest day closed
    /** Day d: slice 0, close d - 1 (countersigned when needed), slices 1 and 2, d - 1 final (payer checked), slice 3. */
    const runDay = async (d: number, after?: (s: Snap, r: Settled | null) => Promise<void>, frozen: Bot | null = payer, check = true, whilePending?: () => Promise<void>) => {
      const i = d - OCT1 + 1;
      await days.postSlice(d, 0, values(i));
      const finalAt = await days.close(d - 1);
      closedDay = d - 1;
      if (whilePending) await whilePending(); // day d - 1 is closed: its record is public and not final yet
      await days.postSlice(d, 1, values(i));
      await days.postSlice(d, 2, values(i));
      if (finalAt >= days.readAt(d, 3)) throw new Error(`day ${d - 1} is final only at ${finalAt}, after slice 3 of day ${d}`);
      const s = await snapAt(finalAt, frozen);
      const r = check ? await settleClaims(s, `day ${d - 1 - OCT1 + 1} final`) : null;
      if (after) await after(s, r);
      await days.postSlice(d, 3, values(i));
    };

    // ---------------------------------------------------------------- Oct 1 final: listing (E2), first quotes (E3)
    rep.step("Oct 1 closed, countersigned and final: the lister lists and creates the markets");
    const finalBlockOf = { listing: 0n };
    await runDay(OCT1 + 1, async (s) => {
      finalBlockOf.listing = s.block;
      const t0 = Date.now();
      await until("6 series listed with their Kuru V1 markets", async () => {
        for (const g of GPUS)
          for (const m of [OCT, NOV]) {
            const a = await f.read<Address>(demo.factory, agateFactoryAbi as Abi, "seriesOf", [GPU[g], m]);
            if (a === ZERO) return false;
            const [mk, venue] = await f.read<readonly [Address, number]>(demo.factory, agateFactoryAbi as Abi, "marketOf", [a]);
            if (venue !== 1) return false;
            series[key(g, m)] = a;
            markets[key(g, m)] = mk;
          }
        return true;
      }, [payer], 180_000);
      const ms = Date.now() - t0;
      const ticksAfter = payer.events().filter((e) => e.event === "tick" && Number(e.listed ?? 0) + Number(e.created ?? 0) > 0).length;
      const n0 = await f.nonce(A.payer);
      rep.check("E2", "Oct and Nov of H100, H200, B200 listed and their 6 Kuru V1 markets created (12 payer transactions)", n0 === 12, { payerNonce: n0, wallMs: ms, ticksThatSent: ticksAfter });
      // wall spec 18: the index prices six GPUs, the market keeps three; the price-only ones are final too, and unlisted
      const factoryGpus = (await f.read<readonly Hex[]>(demo.factory, agateFactoryAbi as Abi, "gpuIds")).map((x) => x.toLowerCase());
      const regd: Record<string, number> = {};
      const unlisted: Record<string, boolean> = {};
      for (const g of INDEX_GPUS) {
        regd[g.gpu] = Number((await f.read<{ nSlots: number }>(w.index, agateIndexAbi as Abi, "gpu", [g.gpuId])).nSlots);
        if (factoryGpus.includes(g.gpuId.toLowerCase())) continue;
        const [, isFinal] = await days.recordOf(g.gpuId, OCT1);
        let none = isFinal;
        for (const m of [OCT, NOV]) if ((await f.read<Address>(demo.factory, agateFactoryAbi as Abi, "seriesOf", [g.gpuId, m])) !== ZERO) none = false;
        unlisted[g.gpu] = none;
      }
      const sixThree = INDEX_GPUS.length === 6 && Object.values(regd).every((n) => n > 0) && factoryGpus.length === 3 && j(factoryGpus) === j(GPUS.map((g) => GPU[g].toLowerCase())) && Object.keys(unlisted).length === 3 && Object.values(unlisted).every(Boolean);
      rep.check("E2", "the index registers six GPUs (fork-demo.json) and the factory three: B300, A100 and L40S have final Oct 1 records and no series", sixThree, { slots: regd, factoryGpus: factoryGpus.length, finalAndUnlisted: unlisted });
      for (const k of Object.keys(series)) T[series[k]!.toLowerCase()] = await terms(f, series[k]!);
      rep.num("series", Object.fromEntries(Object.entries(series).map(([k, a]) => [k, { series: a, market: markets[k], F: T[a.toLowerCase()]!.floor, C: T[a.toLowerCase()]!.cap }])));
      await payer.stop();
      const ticksBefore = payer.events().filter((e) => e.event === "tick").length;
      payer.start();
      await until("three ticks of the restarted payer", async () => payer.events().filter((e) => e.event === "tick").length >= ticksBefore + 3, [payer], 120_000);
      rep.check("E2", "a restarted lister sends nothing", (await f.nonce(A.payer)) === n0, { payerNonce: await f.nonce(A.payer) });

      rep.step("the market maker starts: first quotes on the 6 real Kuru books");
      maker.start();
      const ladders = new Map<string, { bids: [bigint, bigint][]; asks: [bigint, bigint][]; fair: bigint }>();
      await until("6 books quoted as the default ladder", async () => {
        for (const k of Object.keys(markets)) {
          const t = T[series[k]!.toLowerCase()]!;
          const fair = await fairOf(f, w.index, t);
          if (fair === null) return false;
          const want = expectedLadder(fair, t.floor, t.cap);
          const b = await book(f, markets[k]!);
          if (j(b.bids) !== j(want.bids) || j(b.asks) !== j(want.asks)) return false;
          ladders.set(k, { ...want, fair });
        }
        return true;
      }, [maker, payer], 240_000);
      let inv = true;
      for (const [k, l] of ladders) {
        const t = T[series[k]!.toLowerCase()]!;
        for (const [p] of [...l.bids, ...l.asks]) if (p % TICK !== 0n || p < t.floor || p > t.cap) inv = false;
        if (!(l.bids[0]![0] < l.fair && l.fair < l.asks[0]![0])) inv = false;
      }
      rep.check("E3", "6 books two-sided at the harness's own fair value: on the tick, inside [F, C], bid < fair < ask, sizes 1,000 / 2,000 / 4,000", inv, Object.fromEntries([...ladders].map(([k, l]) => [k, { fair: l.fair, bid: l.bids[0]![0], ask: l.asks[0]![0] }])));
      // s_orders agree with the maker's state
      const st = deserialize(readFileSync(join(maker.dir, "state.json"), "utf8"));
      let agree = st !== null;
      for (const k of Object.keys(markets)) {
        const chain = activeOf(await allOrders(f, markets[k]!), A.maker);
        const mine = st?.orders[markets[k]!.toLowerCase()] ?? [];
        const a = chain.map((x) => `${x.id}:${x.price}:${x.remaining}:${x.isBuy}`).sort();
        const b = mine.map((x) => `${x.id}:${x.price}:${x.remaining}:${x.isBuy}`).sort();
        if (j(a) !== j(b) || a.length !== 6) agree = false;
      }
      rep.check("E3", "s_orders (Kuru's own status rule) and getL2Book agree with the maker's state.json, 6 orders per book", agree);
      // the maker quotes only the factory's books: none for a GPU the index prices and the factory does not list
      const books = new Set(Object.values(markets).map((m) => m.toLowerCase()));
      const quoted = Object.entries(st?.orders ?? {}).filter(([, os]) => os.length > 0).map(([m]) => m.toLowerCase());
      rep.check("E3", "the maker quotes only the factory's 6 books (three GPUs), never a price-only GPU of the six-GPU index", st !== null && quoted.length === 6 && quoted.every((m) => books.has(m)), { quotedBooks: quoted.length });
    });

    // ---------------------------------------------------------------- Oct 2: a fair move (E4)
    rep.step("Oct 2 (H100 3.70): the pending record guards the asks at once (M-H1), then exactly one batchUpdate per moved book once final");
    const guardPending = async () => {
      // audit M-H1: while Oct 2 is closed but not final, its 3.70 is public; every H100 ask must rest above the fair
      // that value gives, before the record is final (fair itself stays on Oct 1's final 3.60)
      const rows: Record<string, unknown> = {};
      await until("the H100 asks above the pending value's fair", async () => {
        for (const k of [key("H100", OCT), key("H100", NOV)]) {
          const t = T[series[k]!.toLowerCase()]!;
          const { k: kk, S } = await preview(f, t.series);
          const x = 3_700_000n < t.floor ? t.floor : 3_700_000n > t.cap ? t.cap : 3_700_000n;
          const pendingFair = (S + BigInt(t.n - kk) * x) / BigInt(t.n);
          const b = await book(f, markets[k]!);
          rows[k] = { pendingFair, asks: b.asks.map((a) => a[0]) };
          if (b.asks.length === 0 || !b.asks.every((a) => a[0] > pendingFair)) return false;
        }
        return true;
      }, [maker], 120_000);
      const [, finalNow] = await f.read<readonly [boolean, boolean, unknown]>(w.index, agateIndexAbi as Abi, "record", [GPU.H100, OCT1 + 1]);
      rep.check("M-H1", "while Oct 2 (3.70) is closed but not final, every H100 ask of the maker rests above the fair it gives", !finalNow, rows);
    };
    await runDay(OCT1 + 2, async (s) => {
      const moved = [markets[key("H100", OCT)]!.toLowerCase(), markets[key("H100", NOV)]!.toLowerCase()];
      await until("the H100 books requoted", async () => {
        for (const k of [key("H100", OCT), key("H100", NOV)]) {
          const t = T[series[k]!.toLowerCase()]!;
          const want = expectedLadder((await fairOf(f, w.index, t))!, t.floor, t.cap);
          const b = await book(f, markets[k]!);
          if (j(b.bids) !== j(want.bids) || j(b.asks) !== j(want.asks)) return false;
        }
        return true;
      }, [maker], 120_000);
      await Bun.sleep(5_000); // five more maker ticks: nothing else may be sent
      const txs = await txsFrom(f, A.maker, s.block + 1n);
      const bu = txs.filter((t) => t.fn === "batchUpdate");
      const per = moved.map((m) => bu.filter((t) => t.to.toLowerCase() === m).length);
      rep.check("E4", "a final day 10 cents higher: exactly one batchUpdate per moved book (Oct and Nov H100), none on the 4 others", per.every((n) => n === 1) && bu.length === 2 && txs.every((t) => t.ok), { batchUpdates: bu.length, perMovedBook: per, otherTxs: txs.filter((t) => t.fn !== "batchUpdate").map((t) => t.fn) });
    }, payer, true, guardPending);

    rep.step("Oct 3 (unchanged): the maker sends nothing");
    await runDay(OCT1 + 3, async (s) => {
      await Bun.sleep(5_000);
      const txs = await txsFrom(f, A.maker, s.block + 1n);
      rep.check("E4", "an unchanged final day: no maker transaction", txs.length === 0, { makerTxs: txs.map((t) => t.fn) });
    });

    // ---------------------------------------------------------------- users trade through the router (E5, brief)
    rep.step("users on Kuru V1 through the router: openLong, openLongDaily, openShort daily, a direct streamOut, dust, 120 more daily positions");
    const oct100 = series[key("H100", OCT)]!;
    const oct200 = series[key("H200", OCT)]!;
    const nov100 = series[key("H100", NOV)]!;
    const mOct100 = markets[key("H100", OCT)]!;
    const tOct100 = T[oct100.toLowerCase()]!;
    for (const n of ["R", "O", "L", "D", "B1", "B2", "B3", "B4"] as const) await f.tx(K[n], dep.dollar, agateDollarAbi as Abi, "approve", [demo.router, MAX]);
    const tokenBal = (tok: Address, a: Address) => f.read<bigint>(tok, agateTokenAbi as Abi, "balanceOf", [a]);
    const makerTrades = async (fromBlock: bigint) => {
      const logs = (await f.call("eth_getLogs", [{ fromBlock: toHex(fromBlock), toBlock: "latest", address: mOct100 }])) as { topics: Hex[]; data: Hex }[];
      let sold = 0n;
      let bought = 0n;
      for (const l of logs) {
        try {
          const d = decodeEventLog({ abi: kuruOrderBookAbi as Abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
          if (d.eventName !== "Trade") continue;
          const a = d.args as unknown as { makerAddress: Address; isBuy: boolean; filledSize: bigint };
          if (a.makerAddress.toLowerCase() !== A.maker.toLowerCase()) continue;
          if (a.isBuy) sold += a.filledSize * 100n;
          else bought += a.filledSize * 100n;
        } catch {
          // not a Kuru event
        }
      }
      return { sold, bought };
    };
    const b0 = await f.block();
    const r1 = await f.tx(K.R, demo.router, agateRouterAbi as Abi, "openLong", [oct100, 400n * U, 100n * U, NOPERMIT]);
    const bk1 = await book(f, mOct100);
    const r2 = await f.tx(K.R, demo.router, agateRouterAbi as Abi, "openLongDaily", [oct100, 3_000n * U, 780n * U, 8n, P.R2, NOPERMIT]);
    positions.push(...opened(r2.logs, "R openLongDaily x8"));
    const bk2 = await book(f, mOct100);
    rep.num("Oct H100 top ask after openLong / openLongDaily (size units)", { afterOpenLong: bk1.asks[0], afterDaily: bk2.asks[0] });
    const flowGas: Record<string, string> = { openLong: r1.gasUsed.toString(), "openLongDaily x8": r2.gasUsed.toString() };
    const topAsk = bk1.asks[0]!; // the fills do not move fair: the refill rests at the same price
    await until("the maker refills its top ask", async () => {
      const b = await book(f, mOct100);
      return b.asks[0]?.[0] === topAsk[0] && b.asks[0]?.[1] === 1_000n * UNITS;
    }, [maker], 120_000);
    const refillTxs = (await txsFrom(f, A.maker, b0 + 1n)).map((t) => t.fn);
    // inventory: E = T - Sh = tokens bought by the maker's bids minus tokens sold from its asks
    const inv = async () => {
      const orders = activeOf(await allOrders(f, mOct100), A.maker);
      const tw = await tokenBal(tOct100.token, A.maker);
      const tm = await marginOf(f, A.maker, tOct100.token);
      const tr = orders.filter((x) => !x.isBuy).reduce((a, x) => a + x.remaining * 100n, 0n);
      const sh = await f.read<bigint>(oct100, agateSeriesAbi as Abi, "shortOf", [A.maker]);
      return tw + tm + tr - sh;
    };
    const tr1 = await makerTrades(f.forkBlock + 1n);
    const e1 = await inv();
    // what the second fill left of the maker's top ask, from the receipt (the maker may refill before any read)
    let leftAfter = -1n;
    for (const l of r2.logs) {
      try {
        const d = decodeEventLog({ abi: kuruOrderBookAbi as Abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        const a = d.args as unknown as { makerAddress: Address; updatedSize: bigint };
        if (d.eventName === "Trade" && a.makerAddress.toLowerCase() === A.maker.toLowerCase()) leftAfter = a.updatedSize;
      } catch {
        // not a Kuru event
      }
    }
    rep.check("E5", "the router fills lift the maker's top ask; within ticks it is refilled to 1,000 tokens at the same price (minting and depositing as needed); inventory E equals the harness's count from Trade events", e1 === tr1.bought - tr1.sold && leftAfter >= 0n && leftAfter < 500n * UNITS, { E: e1, fromTrades: tr1.bought - tr1.sold, topAskLeftUnits: leftAfter, makerTxsSince: refillTxs });
    const o1 = await f.tx(K.O, demo.router, agateRouterAbi as Abi, "openShort", [oct100, 400n * U, 1n, 8n, P.O2, true, NOPERMIT]);
    positions.push(...opened(o1.logs, "O openShort daily x8"));
    const o2 = await f.tx(K.O, demo.router, agateRouterAbi as Abi, "openShort", [oct200, 200n * U, 1n, 4n, P.O3, true, NOPERMIT]);
    positions.push(...opened(o2.logs, "O openShort H200 daily x4"));
    const l1 = await f.tx(K.L, demo.router, agateRouterAbi as Abi, "openShort", [oct100, 100n * U, 1n, 1n, P.L2, false, NOPERMIT]);
    positions.push(...opened(l1.logs, "L openShort daily=false"));
    await f.tx(K.D, demo.router, agateRouterAbi as Abi, "openLong", [oct100, 40n * U, 10n * U, NOPERMIT]);
    const d1 = await f.tx(K.D, oct100, agateSeriesAbi as Abi, "streamOut", [0, 5n * U, A.D, P.D2, A.D, true]);
    positions.push(...opened(d1.logs, "D streamOut direct"));
    const d2 = await f.tx(K.D, oct100, agateSeriesAbi as Abi, "streamOut", [0, 100n, A.D, P.D3, A.D, true]);
    positions.push(...opened(d2.logs, "D streamOut dust (one LOT)"));
    for (const [n, p] of [["B1", P.Bp1], ["B2", P.Bp2], ["B3", P.Bp3], ["B4", P.Bp4]] as const) {
      const r = await f.tx(K[n], demo.router, agateRouterAbi as Abi, "openLongDaily", [oct100, 250n * U, 60n * U, 30n, p, NOPERMIT]);
      positions.push(...opened(r.logs, `${n} openLongDaily x30`));
      if (n === "B1") flowGas["openLongDaily x30"] = r.gasUsed.toString();
    }
    const rn = await f.tx(K.R, demo.router, agateRouterAbi as Abi, "openLongDaily", [nov100, 760n * U, 190n * U, 2n, P.R3, NOPERMIT]);
    positions.push(...opened(rn.logs, "R openLongDaily Nov x2"));
    flowGas["openShort x8"] = o1.gasUsed.toString();
    flowGas["openShort x1 daily=false"] = l1.gasUsed.toString();
    flowGas["streamOut direct"] = d1.gasUsed.toString();
    rep.num("router and series flows, gas used", flowGas);
    rep.num("positions opened", { total: positions.length, byLabel: Object.fromEntries([...new Set(positions.map((p) => p.label))].map((l) => [l, positions.filter((p) => p.label === l).length])) });
    rep.check("brief", "a renter's openLong and openLongDaily, an owner's openShort daily through the router on Kuru V1's real book", positions.length === 8 + 8 + 4 + 1 + 1 + 1 + 120 + 2 && opened(r2.logs, "").every((p) => p.daily && p.owner.toLowerCase() === A.R.toLowerCase()) && opened(o1.logs, "").every((p) => p.side === 1 && p.daily && p.owner.toLowerCase() === A.O.toLowerCase()), { positions: positions.length });

    // ---------------------------------------------------------------- Oct 4 final: the first daily claims (E10)
    rep.step("Oct 4 final: one sync, then claimMany in batches of at most 50");
    await runDay(OCT1 + 4, async (s, r) => {
      // settleClaims checked every payee; here the shape of the round on the Oct H100 series
      const on = (t: SentTx) => t.to.toLowerCase() === oct100.toLowerCase();
      const sizes = r!.claims.filter(on).map((t) => (t.args[0] as unknown[]).length);
      const syncs = r!.syncs.filter(on).length;
      const cands = s.cands.filter((c) => c.p.series.toLowerCase() === oct100.toLowerCase()).length;
      rep.check("E10", "Oct H100: one sync, then its daily positions claimed in batches of at most 50 (137 positions: 50 / 50 / 37); daily = false and sub-cent positions untouched", syncs === 1 && j(sizes) === j([50, 50, 37]) && cands === 137, { syncs, sizes, candidates: cands });
    });

    rep.step("Oct 5 final; then the owner closes two short positions through the router (closeShort)");
    await runDay(OCT1 + 5);
    {
      const mine = positions.filter((p) => p.label === "O openShort daily x8").slice(0, 2);
      const before = await Promise.all(mine.map((p) => position(f, p)));
      const C = tOct100.cap;
      const want = mine.reduce((a, p, i) => a + (p.q * C) / U - before[i]!.paid, 0n);
      const dO = await balanceOf(A.O);
      const tO = await tokenBal(tOct100.token, A.O);
      const rc = await f.tx(K.O, demo.router, agateRouterAbi as Abi, "closeShort", [oct100, mine.map((p) => p.id), 450n * U, NOPERMIT]);
      const found: { dollarsIn: bigint; dollarsOut: bigint; refund: bigint; tokensOut: bigint }[] = [];
      for (const l of rc.logs) {
        try {
          const d = decodeEventLog({ abi: agateRouterAbi as Abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
          if (d.eventName === "Routed") found.push(d.args as unknown as { dollarsIn: bigint; dollarsOut: bigint; refund: bigint; tokensOut: bigint });
        } catch {
          // not the router's
        }
      }
      const routed = found[0] ?? null;
      const paid = routed ? routed.dollarsOut - routed.refund : -1n;
      const gone = (await Promise.all(mine.map((p) => position(f, p)))).every((p) => p.owner === ZERO);
      const dDelta = (await balanceOf(A.O)) - dO;
      const tDelta = (await tokenBal(tOct100.token, A.O)) - tO;
      rep.check("brief", "closeShort: both positions deleted, the owner paid q C / U - paid for each, surplus tokens and the unused quote returned", routed !== null && gone && paid === want && dDelta === routed.dollarsOut - routed.dollarsIn && tDelta === routed.tokensOut, { paid, want, dollarDelta: dDelta, surplusTokens: routed?.tokensOut, refund: routed?.refund, gasUsed: rc.gasUsed });
      flowGas.closeShort = rc.gasUsed.toString();
    }

    // ---------------------------------------------------------------- kill and unkill through the CLI (E8)
    rep.step("Oct 6 final; kill and unkill through the maker's CLI");
    await runDay(OCT1 + 6, async () => {
      const k = await cli(maker, ["kill", "e2e"]);
      await until("every maker order cancelled", async () => {
        for (const m of Object.values(markets)) if (activeOf(await allOrders(f, m), A.maker).length > 0) return false;
        return true;
      }, [maker], 60_000);
      const n1 = await f.nonce(A.maker);
      await Bun.sleep(4_000);
      const n2 = await f.nonce(A.maker);
      const killed = maker.alerts().some((a) => a.code === "MM_KILLED");
      const u = await cli(maker, ["unkill"]);
      await until("the books requoted after unkill", async () => {
        for (const m of Object.values(markets)) {
          const b = await book(f, m);
          if (b.bids.length === 0 || b.asks.length === 0) return false;
        }
        return true;
      }, [maker], 120_000);
      rep.check("E8", "kill (CLI) cancels every maker order within ticks, MM_KILLED raised, nothing placed while killed; unkill (CLI) requotes every book", k.code === 0 && u.code === 0 && n2 === n1 && killed, { killCli: k.code, unkillCli: u.code, nonceWhileKilled: [n1, n2] });
    });

    // ---------------------------------------------------------------- a maker restart (E9)
    rep.step("Oct 7: SIGKILL the maker mid-refill, restart; then restart with state.json deleted");
    {
      const bE9 = await f.block();
      // a buy that takes more than half of the top ask makes the maker refill at its next tick; kill it right then
      const top = (await book(f, mOct100)).asks[0]!;
      await f.tx(K.B1, demo.router, agateRouterAbi as Abi, "openLong", [oct100, ((top[1] * 6n) / 10n / UNITS) * top[0] + 1n * U, 1n * U, NOPERMIT]);
      await Bun.sleep(700);
      await maker.stop("SIGKILL");
      maker.start();
      await until("the restarted maker refilled the Oct H100 top ask; every book two-sided", async () => {
        const want = expectedLadder((await fairOf(f, w.index, tOct100))!, tOct100.floor, tOct100.cap);
        if (j((await book(f, mOct100)).asks.slice(0, 1)) !== j(want.asks.slice(0, 1))) return false;
        for (const m of Object.values(markets)) {
          const b = await book(f, m);
          if (b.bids.length === 0 || b.asks.length === 0) return false;
        }
        return true;
      }, [maker], 120_000);
      await Bun.sleep(3_000);
      const one = async () => {
        let ok = true;
        const detail: Record<string, number> = {};
        for (const [k, m] of Object.entries(markets)) {
          const act = activeOf(await allOrders(f, m), A.maker);
          detail[k] = act.length;
          const prices = act.map((x) => `${x.isBuy}:${x.price}`);
          if (new Set(prices).size !== prices.length || act.filter((x) => x.isBuy).length > 3 || act.filter((x) => !x.isBuy).length > 3) ok = false;
        }
        return { ok, detail };
      };
      const after1 = await one();
      const reverted1 = (await txsFrom(f, A.maker, bE9 + 1n)).filter((t) => !t.ok).length;
      rep.check("E9", "after a SIGKILL mid-refill and a restart: one ladder per book (no duplicate price, at most 3 a side), no reverted maker transaction", after1.ok && reverted1 === 0, { activePerBook: after1.detail, reverted: reverted1 });
      await maker.stop();
      rmSync(join(maker.dir, "state.json"), { force: true });
      const chainSet = new Map<string, number>();
      for (const m of Object.values(markets)) chainSet.set(m.toLowerCase(), activeOf(await allOrders(f, m), A.maker).length);
      const rebuiltBefore = maker.events().filter((e) => e.event === "rebuilt").length;
      const bE9b = await f.block();
      maker.start();
      await until("the rebuilt state written", async () => existsSync(join(maker.dir, "state.json")) && maker.events().some((e) => e.event === "rebuilt"), [maker], 120_000);
      await Bun.sleep(3_000);
      const st = deserialize(readFileSync(join(maker.dir, "state.json"), "utf8"));
      let same = st !== null;
      const after2: Record<string, number> = {};
      for (const m of Object.values(markets)) {
        const now = activeOf(await allOrders(f, m), A.maker).map((x) => String(x.id)).sort();
        const mine = (st?.orders[m.toLowerCase()] ?? []).map((x) => String(x.id)).sort();
        after2[m] = now.length;
        if (j(now) !== j(mine)) same = false;
      }
      // the scan at start found, per book, exactly the orders that rested when the maker stopped
      const rebuilt = maker.events().filter((e) => e.event === "rebuilt").slice(rebuiltBefore);
      const found = Object.fromEntries(rebuilt.map((e) => [String(e.market).toLowerCase(), Number(e.active)]));
      for (const [m, n] of chainSet) if (found[m] !== n) same = false;
      const reverted2 = (await txsFrom(f, A.maker, bE9b + 1n)).filter((t) => !t.ok).length;
      rep.check("E9", "with state.json deleted the full id scan recovers exactly the active set (per book), state.json then equals the chain; nothing duplicated or reverted", same && reverted2 === 0 && (await one()).ok, { scanFound: found, restingAtStop: Object.fromEntries(chainSet), activeNow: after2, reverted: reverted2 });
    }

    // ---------------------------------------------------------------- the rest of October
    rep.step("Oct 7 to Oct 31: a day at a time, the payer checked after each final day");
    for (let d = OCT1 + 7; d <= OCT1 + 30; d++) await runDay(d);
    // E13: before the last day ends the maker winds the October books down
    const endTs = days.start(OCT1 + 31);
    rep.step("Oct 31 ends in 50 s: the maker winds the October books down");
    await f.warp(endTs - 50n);
    await f.mine(1);
    const octKeys = GPUS.map((g) => key(g, OCT));
    await until("October books wound down", async () => {
      for (const k of octKeys) {
        const t = T[series[k]!.toLowerCase()]!;
        if (activeOf(await allOrders(f, markets[k]!), A.maker).length > 0) return false;
        const tm = await marginOf(f, A.maker, t.token);
        const tw = await tokenBal(t.token, A.maker);
        const sh = await f.read<bigint>(series[k]!, agateSeriesAbi as Abi, "shortOf", [A.maker]);
        if (tm !== 0n || (tw >= 100n && sh >= 100n)) return false;
      }
      return true;
    }, [maker], 120_000);
    rep.check("E13", "before October's last day ends: the maker's October orders are gone, its tokens withdrawn from the margin account, its pairs redeemed", true);

    // ---------------------------------------------------------------- Nov 1: October final, the sweep (E12), settle (E13), December (brief)
    rep.step("Nov 1: October's last day final: the sweep, the maker's settle, December listed");
    await runDay(OCT1 + 31, async (s) => {
      const left = positions.filter((p) => p.series.toLowerCase() !== nov100.toLowerCase());
      const open = [];
      for (const p of left) if ((await position(f, p)).owner !== ZERO) open.push(p.label);
      rep.check("E12", "the final sweep paid and deleted every October position with claimable >= $0.01 or q >= 1 token (daily = false included) and left only the dust", j(open) === j(["D streamOut dust (one LOT)"]) && s.sweep.size === 2, { stillOpen: open });
      await until("the maker settled October", async () => {
        for (const k of octKeys) {
          const t = T[series[k]!.toLowerCase()]!;
          if ((await tokenBal(t.token, A.maker)) !== 0n || (await f.read<bigint>(series[k]!, agateSeriesAbi as Abi, "shortOf", [A.maker])) !== 0n) return false;
        }
        return true;
      }, [maker], 120_000);
      rep.check("E13", "after k == N the maker settled: it holds no October token and no October short", maker.alerts().some((a) => a.code === "MM_SETTLED"), { settledAlerts: maker.alerts().filter((a) => a.code === "MM_SETTLED").length });
      await until("December listed with its markets", async () => {
        for (const g of GPUS) {
          const a = await f.read<Address>(demo.factory, agateFactoryAbi as Abi, "seriesOf", [GPU[g], DEC]);
          if (a === ZERO) return false;
          const [mk, venue] = await f.read<readonly [Address, number]>(demo.factory, agateFactoryAbi as Abi, "marketOf", [a]);
          if (venue !== 1) return false;
          series[key(g, DEC)] = a;
          markets[key(g, DEC)] = mk;
          T[a.toLowerCase()] = await terms(f, a);
        }
        return true;
      }, [payer], 180_000);
      rep.check("brief", "December (RULE band from Oct 27 to 31) listed for the three GPUs and its Kuru V1 markets created by the lister", true, Object.fromEntries(GPUS.map((g) => [g, { F: T[series[key(g, DEC)]!.toLowerCase()]!.floor, C: T[series[key(g, DEC)]!.toLowerCase()]!.cap }])));
      const nd = [...GPUS.map((g) => key(g, NOV)), ...GPUS.map((g) => key(g, DEC))];
      await until("the maker quotes November and December", async () => {
        for (const k of nd) {
          const b = await book(f, markets[k]!);
          if (b.bids.length === 0 || b.asks.length === 0) return false;
        }
        return true;
      }, [maker], 180_000);
      rep.check("E3", "after the month turns the maker quotes the open months (Nov and Dec, 6 books)", true);
    });
    rep.step("Nov 2: Nov 1 final, the November daily positions claimed");
    await runDay(OCT1 + 32);

    // ---------------------------------------------------------------- dry runs (E20)
    rep.step("dry runs: both bots without a key, while Nov 2 turns final");
    await payer.stop();
    {
      const d = OCT1 + 33;
      const i = d - OCT1 + 1;
      await days.postSlice(d, 0, values(i));
      const finalAt = await days.close(d - 1);
      await days.postSlice(d, 1, values(i));
      await days.postSlice(d, 2, values(i));
      const s = await snapAt(finalAt, null);
      const n0 = { payer: await f.nonce(A.dryPayer), maker: await f.nonce(A.dryMaker), realPayer: await f.nonce(A.payer) };
      const dryP = new Bot("payer", scratch, { address: A.dryPayer, urls, deployments: depFile, config: payerCfg, home: join(scratch, "dry-payer-home") }, "payer-dry");
      const dryM = new Bot("marketmaker", scratch, { address: A.dryMaker, urls, deployments: depFile, config: mmCfg, home: join(scratch, "dry-mm-home") }, "marketmaker-dry");
      bots.push(dryP, dryM);
      dryP.start();
      dryM.start();
      await until("both dry runs simulated and estimated a send", async () => dryP.events().some((e) => e.event === "dry_run" && (e.shape === "series.sync" || e.shape === "series.claimMany")) && dryM.events().some((e) => e.event === "dry_run"), [dryP, dryM], 180_000);
      await dryP.stop();
      await dryM.stop();
      const n1 = { payer: await f.nonce(A.dryPayer), maker: await f.nonce(A.dryMaker), realPayer: await f.nonce(A.payer) };
      let unpaid = true;
      for (const c of s.cands) if (((await claimableOf(f, c.p)) ?? 0n) !== c.claimable) unpaid = false;
      rep.check("E20", "both bots with AGATE_DRY_RUN=1 and no key simulate and estimate (dry_run logged) and no nonce moves; nothing was claimed", j(n0) === j(n1) && unpaid && s.cands.length > 0, { nonces: n1, dryRunEvents: { payer: dryP.events().filter((e) => e.event === "dry_run").length, maker: dryM.events().filter((e) => e.event === "dry_run").length }, candidates: s.cands.length });
      payer.start();
      await settleClaims(s, "Nov 2 final, after the dry run (the real payer restarted)");
      await days.postSlice(d, 3, values(i));
    }

    // ---------------------------------------------------------------- the indexer's fork replay (E15)
    rep.step("export every log of the run and the chain's truth; replay through the indexer");
    await maker.stop();
    await payer.stop();
    await f.mine(1);
    const logs = await exportLogs(f, f.forkBlock + 1n);
    const truth = await readTruth(f, logs, { index: w.index, dollar: dep.dollar, factory: demo.factory });
    rep.num("exported logs", { logs: logs.length, firstBlock: logs[0]?.blockNumber, lastBlock: truth.block, series: Object.keys(truth.series).length, orders: Object.keys(truth.orders).length, fixes: Object.keys(truth.fixes).length });
    const fixtureDir = o.fixtureDir ?? join(ROOT, "indexer", "test", "fork", "fixtures");
    mkdirSync(fixtureDir, { recursive: true });
    const depOut = { chainId: dep.chainId, dollar: dep.dollar.toLowerCase(), kuru: { router: dep.kuru.router.toLowerCase(), marginAccount: dep.kuru.marginAccount.toLowerCase() }, factories: { demo: { index: demo.index.toLowerCase(), dollar: demo.dollar.toLowerCase(), tag: demo.tag, factory: demo.factory.toLowerCase(), router: demo.router.toLowerCase(), tPend: demo.tPend, startBlock: demo.startBlock } } };
    writeFileSync(join(fixtureDir, "fork-deployments.json"), `${JSON.stringify(depOut, null, 2)}\n`);
    writeFileSync(join(fixtureDir, "fork-lifecycle.json"), `${JSON.stringify({ note: "BOTS-SPEC 5.7 item 5; written by wall/e2e (the market fork e2e)", forkBlock: Number(f.forkBlock), indexStart: Number(w.indexBlock), maker: A.maker.toLowerCase(), payer: A.payer.toLowerCase(), payees: Object.values(P).map((x) => x.toLowerCase()), logs, truth })}\n`);
    if (o.replay !== false) {
      const r = Bun.spawnSync(["bun", "run", "test/fork/run.ts", "--fixture-dir", fixtureDir], { cwd: join(ROOT, "indexer"), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
      const out = `${r.stdout.toString()}\n${r.stderr.toString()}`;
      writeFileSync(join(scratch, "indexer-replay.log"), out);
      const summary = out.split("\n").filter((l) => /Tests? |passed|failed|✓|×|FAIL/.test(l)).slice(-12).join(" | ");
      rep.check("E15", "every log of the run replayed through the indexer's handlers (Envio simulate): balances, positions, payouts, fixes, orders and price points equal the chain's views", r.exitCode === 0, summary);
      rep.num("indexer replay output (tail)", out.split("\n").slice(-25).join("\n"));
    }

    // ---------------------------------------------------------------- gas (E16), leaks (E17, E18)
    rep.step("gas of every shape the bots sent; secrets and keys in every output");
    for (const [name, who] of [["marketmaker", A.maker], ["payer", A.payer]] as const) {
      const txs: SentTx[] = await txsFrom(f, who, f.forkBlock + 1n);
      for (const t of txs) {
        const s = shapeOf(t, { dollar: dep.dollar, margin: MARGIN });
        rep.gas.push({ bot: name, shape: s.shape, detail: s.detail, gasLimit: t.gas.toString(), gasUsed: t.gasUsed.toString(), tx: t.hash });
      }
      rep.num(`${name} transactions`, { total: txs.length, reverted: txs.filter((t) => !t.ok).length });
      rep.check("E16", `${name}: every transaction it sent succeeded (no revert, which on Monad costs the whole limit)`, txs.every((t) => t.ok), { sent: txs.length });
    }
    const texts: { where: string; text: string }[] = [];
    for (const b of bots) {
      texts.push({ where: `${b.tag} stdout/stderr`, text: b.text() });
      for (const p of b.homeFiles()) texts.push({ where: p, text: readFileSync(p, "utf8") });
    }
    cliOut.forEach((t, i) => texts.push({ where: `cli ${i}`, text: t }));
    const leakedUrl = texts.filter((x) => secretsAll.some((s) => x.text.includes(s))).map((x) => x.where);
    rep.check("E17", "no secret URL path in any stdout, stderr or file the bots wrote (the scrubber)", leakedUrl.length === 0, { filesAndStreams: texts.length, leaked: leakedUrl });
    const leakedKey = texts.filter((x) => keysAll.some((k) => x.text.toLowerCase().includes(k.slice(2).toLowerCase()))).map((x) => x.where);
    rep.check("E18", "no private key of the run (hex, with or without 0x) in any stdout, stderr or file", leakedKey.length === 0, { leaked: leakedKey });
    rep.num("index days", { posted: days.posted, closed: days.closed, attested: days.attested, lastClosed: closedDay });
    rep.num("chain time at the end", await f.time());
    rep.num("last block", await f.block());
    return rep;
  } catch (e) {
    rep.check("run", "the run completed", false, e instanceof Error ? e.message : String(e));
    return rep;
  } finally {
    for (const b of bots) await b.stop().catch(() => null);
    for (const p of proxies) p.stop();
    const wrapper = fork?.wrapperPid ?? 0;
    if (fork) await fork.stop();
    guard.restore();
    await Bun.sleep(1_000);
    const left = wrapper ? ownRunDir(wrapper) : null;
    rep.num("disk after (df -h /)", dfLine());
    rep.num("~/.foundry/anvil/tmp KB after", anvilTmpKb());
    const anvilAlive = fork?.anvilPid ? Bun.spawnSync(["kill", "-0", String(fork.anvilPid)], { stderr: "ignore" }).exitCode === 0 : false;
    rep.check("house", "no anvil and no anvil-safe run dir of this run left; ~/.foundry/anvil/tmp did not grow; the repo's deployments files as they were", left === null && !anvilAlive && anvilTmpKb() <= tmpBefore && !existsSync(join(ROOT, "contracts/deployments/fork-10143.json.pending")), { runDir: left, anvilAlive });
    writeFileSync(join(scratch, "report.json"), rep.json());
    if (!o.keep) rmSync(scratch, { recursive: true, force: true });
    else say(`scratch kept: ${scratch}`);
  }
}
