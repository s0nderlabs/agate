// Adversarial fork cross-check (run by hand from client/: bun run test/adversarial/fork-crosscheck.ts). Starts its own
// fork world through the e2e's World.start (e2e/world.ts: an anvil-safe fork of Monad testnet, the live deployment,
// the maker's float; e2e/indexer.ts: an isolated Envio indexer under this run's own names and free ports, removing at
// start only the containers of runs whose process is gone, so a run beside this one, or beside the e2e, is never
// touched), the lister and the maker on rehearsal keys, then compares every Market and Series field the client returns
// with the contracts' own views and events, for all six GPUs, through four index states:
//   1. Oct 4 final (the kit's days.ts)
//   2. Oct 5 closed with distinct H100 cloud prices and NOT countersigned (a pending record that needs a sign)
//   3. Oct 5 countersigned and final
//   4. Oct 6 carried (no readings, carryDay after its grace) for every GPU
// Sends transactions only to the loopback fork (assertFork); stops everything it started.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Abi, createPublicClient, encodeAbiParameters, encodeFunctionData, type Hex, http, parseAbi, parseAbiItem } from "viem";
import { agateFactoryAbi, agateIndexAbi, agateSeriesAbi, agateTokenAbi, kuruOrderBookAbi } from "../../src/abi.ts";
import { decodeL2Book } from "../../src/book.ts";
import { cent, createAgateClient } from "../../src/client.ts";
import { PANELS, TESTNET_DEPLOYMENTS } from "../../src/static.ts";
import type { Market } from "../../src/types.ts";
import { dateOfDay, iso, toNumber6 } from "../../src/units.ts";
import { assertFork } from "../../e2e/fork.ts";
import { World } from "../../e2e/world.ts";

const PRICE: Record<string, number> = { H100: 3_990_000, H200: 4_780_000, B200: 6_990_000, B300: 8_710_000, A100: 2_700_000, L40S: 1_560_000 };
// Oct 5's H100 clouds, distinct (Verda, Nebius, Lambda, CoreWeave, Civo; the reserve posts 0): median 3.80
const H100_OCT5 = [3_500_000, 4_200_000, 3_800_000, 5_000_000, 3_100_000, 0];
const OCT4 = 20730;
const OCT5 = 20731;
const OCT6 = 20732;
const W = parseAbi(["function postReport(bytes)", "function closeDay(bytes32)", "function attest(bytes32,uint32,address,bytes32)", "function carryDay(bytes32)"]);
const RECORD_SLOTS = parseAbiItem("event RecordSlots(bytes32 indexed gpuId, uint32 indexed day, address indexed source, bytes32 digest, uint32[] p, uint8[] kinds, uint8[] counts, (uint32 e, uint8 miss, bool inMedian, bool wasIn)[] post)");

const results: { name: string; ok: boolean; detail?: unknown }[] = [];
const big = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
function check(name: string, ok: boolean, detail?: unknown): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${ok ? "" : `  ${big(detail)}`}`);
}

// ---------------------------------------------------------------- the world (World.start, with its isolated indexer)
const state = mkdtempSync(join(tmpdir(), "agate-client-xcheck-"));
let world: World;
try {
  world = await World.start({ state, indexer: true, log: (x) => console.log(x) });
} catch (e) {
  rmSync(state, { recursive: true, force: true });
  throw e;
}
const indexer = world.indexer!;
const GQL = indexer.url;
const rpc = world.fork.rpc;
const pub = createPublicClient({ transport: http(rpc) });
const f = TESTNET_DEPLOYMENTS.factories.real!;
const IX = f.index as Hex;
const A = agateIndexAbi as Abi;
const rd = <T>(address: Hex, abi: Abi, functionName: string, args: unknown[] = []) => pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
const now = () => world.fork.time();
const warp = (t: bigint) => world.fork.warp(t);
const indexed = async () => {
  await indexer.waitFor(await world.fork.block(), undefined, (x) => console.log(x));
};

/** The truth for one GPU on one final day, from the contracts: the record, each slot's value the index used (the
 *  RecordSlots event: FRESH = p, HELD = post.e), the slot states. */
async function truth(gpuId: Hex, day: number) {
  const [exists, isFinal, rec] = await rd<readonly [boolean, boolean, { value: number; status: number; finalAt: bigint; postedAt: bigint; source: Hex }]>(IX, A, "record", [gpuId, day]);
  // only the fork's own blocks (every record here is closed on the fork)
  const logs = await pub.getLogs({ address: IX, event: RECORD_SLOTS, args: { gpuId, day }, fromBlock: BigInt(world.fork.forkBlock + 1), toBlock: "latest" });
  const last = logs.at(-1);
  const used = last ? (last.args.kinds as readonly number[]).map((k, i) => (k === 1 ? (last.args.p as readonly number[])[i]! : k === 2 ? (last.args.post as readonly { e: number }[])[i]!.e : null)) : null;
  return { exists, isFinal, rec, used, kinds: last ? (last.args.kinds as readonly number[]) : null };
}

async function crossMarkets(label: string, day: number, expectPrice?: Record<string, number>): Promise<Market[]> {
  console.log(`\n== ${label}`);
  const c = createAgateClient({ rpcUrl: rpc, graphqlUrl: GQL });
  const ms = await c.getMarkets();
  const ck = await rd<{ tPend: number; closeGrace: number; day: number; minReadings: number }>(IX, A, "clocks");
  for (const m of ms) {
    const p = PANELS.find((x) => x.gpu === m.gpu)!;
    const gpuId = p.gpuId as Hex;
    const t = await truth(gpuId, day);
    const g = await rd<{ nSlots: number; head: number }>(IX, A, "gpu", [gpuId]);
    const states = await Promise.all(p.slots.map((_, i) => rd<{ e: number; inMedian: boolean }>(IX, A, "slotState", [gpuId, i])));
    check(`${label} ${m.gpu}: price = record(${dateOfDay(day)}).value, priceDate, updatedAt = finalAt`, t.isFinal && m.price === toNumber6(BigInt(t.rec.value)) && m.priceDate === dateOfDay(day) && m.updatedAt === iso(t.rec.finalAt) && (!expectPrice || m.price === expectPrice[m.gpu]), { client: { price: m.price, priceDate: m.priceDate, updatedAt: m.updatedAt }, chain: { isFinal: t.isFinal, value: t.rec.value, finalAt: t.rec.finalAt } });
    check(`${label} ${m.gpu}: panelSize = nSlots, liveCount = slots in the median`, m.panelSize === Number(g.nSlots) && m.liveCount === states.filter((s) => s.inMedian).length, { client: [m.liveCount, m.panelSize], chain: [states.filter((s) => s.inMedian).length, g.nSlots] });
    check(`${label} ${m.gpu}: panel families in slot order from launch.json; reserve flags`, m.panel.map((x) => x.family).join() === p.slots.map((s) => s.family).join() && m.panel.every((x, i) => x.reserve === !p.slots[i]!.liveAtStart), m.panel);
    if (t.used) {
      // each in-median slot's price must be the value the index used; sources live flags = inMedian
      const bad = m.panel.map((x, i) => ({ fam: x.family, client: x.price, used: t.used![i] === null ? null : toNumber6(BigInt(t.used![i]!)), live: x.live, inMedian: states[i]!.inMedian })).filter((x) => x.inMedian && x.client !== x.used);
      check(`${label} ${m.gpu}: each live cloud's price is the value the index used for it (RecordSlots)`, bad.length === 0, bad);
      const srcLive = m.sources.filter((s) => s.live).map((s) => s.family).sort().join();
      check(`${label} ${m.gpu}: sources' live flags are the median's members`, srcLive === p.slots.filter((_, i) => states[i]!.inMedian).map((s) => s.family).sort().join(), m.sources);
    } else {
      check(`${label} ${m.gpu}: no RecordSlots for a carried day; sources are held values of the median's members`, m.sources.filter((s) => s.live).length === states.filter((s) => s.inMedian).length && m.sources.every((s) => s.price > 0), m.sources);
    }
    // the next price: the day after, from its record or the clock
    const next = await rd<readonly [boolean, boolean, { finalAt: bigint; postedAt: bigint }]>(IX, A, "record", [gpuId, day + 1]);
    const t0 = await now();
    const nextStart = await rd<bigint>(IX, A, "dayStart", [day + 2]);
    const want = next[0] ? (next[2].finalAt !== 0n ? next[2].finalAt : next[2].postedAt + BigInt(ck.tPend) > t0 ? next[2].postedAt + BigInt(ck.tPend) : t0) : (nextStart + BigInt(ck.closeGrace) > t0 ? nextStart + BigInt(ck.closeGrace) : t0) + BigInt(ck.tPend);
    check(`${label} ${m.gpu}: nextUpdateAt from the next record or the clock`, Math.abs(Date.parse(m.nextUpdateAt) - Number(want) * 1000) <= 2000, { client: m.nextUpdateAt, want: iso(want), nextExists: next[0] });
    // the series of the market GPUs against the series' own views and the Kuru book
    for (const s of m.series) {
      if (s.phase === "upcoming") continue;
      const sa = s.address as Hex;
      const terms = await rd<{ floor: number; cap: number; n: number; startTs: bigint; day: number }>(sa, agateSeriesAbi as Abi, "terms");
      const [k, S] = await rd<readonly [number, bigint]>(sa, agateSeriesAbi as Abi, "previewSync");
      const supply = await rd<bigint>(s.token as Hex, agateTokenAbi as Abi, "totalSupply");
      const st = await rd<readonly unknown[]>(sa, agateSeriesAbi as Abi, "state");
      let qLong = 0n;
      for (let id = 1n; id < BigInt(st[6] as bigint); id++) {
        const pos = await rd<{ owner: string; side: number; q: bigint }>(sa, agateSeriesAbi as Abi, "position", [id]);
        if (pos.owner !== "0x0000000000000000000000000000000000000000" && Number(pos.side) === 0) qLong += BigInt(pos.q);
      }
      check(`${label} ${s.symbol}: floor, cap, n, k, S, closesAt from the series' views`, s.floor === toNumber6(BigInt(terms.floor)) && s.cap === toNumber6(BigInt(terms.cap)) && s.n === Number(terms.n) && s.k === Number(k) && s.S === toNumber6(BigInt(S)) && s.closesAt === iso(BigInt(terms.startTs) + BigInt(terms.n) * BigInt(terms.day)), { client: s, chain: { terms, k, S } });
      check(`${label} ${s.symbol}: openInterest = token supply + open long positions' q (chain scan)`, s.openInterest === toNumber6(supply + qLong), { client: s.openInterest, chain: toNumber6(supply + qLong) });
      const [mk] = await rd<readonly [Hex, number]>(f.factory as Hex, agateFactoryAbi as Abi, "marketOf", [sa]);
      const raw = decodeL2Book(await rd<Hex>(mk, kuruOrderBookAbi as Abi, "getL2Book"));
      const bid = raw.bids[0]?.[0] ?? 0n;
      const ask = raw.asks[0]?.[0] ?? 0n;
      check(`${label} ${s.symbol}: quote bid/ask = getL2Book's top`, s.quote?.bid === toNumber6(bid) && s.quote?.ask === toNumber6(ask), { client: s.quote, chain: { bid, ask } });
    }
  }
  return ms;
}

async function postDay(day: number, values: (gpu: string, nSlots: number, mask: number) => number[]): Promise<void> {
  const [primary] = await rd<readonly [Hex, Hex]>(IX, A, "writers");
  const ck = await rd<{ slice: number; slices: number; chainSelector: bigint }>(IX, A, "clocks");
  const start = await rd<bigint>(IX, A, "dayStart", [day]);
  const deploy = (await Bun.file(join(import.meta.dir, "../../../wall/packages/sources/panels/launch.json")).json()) as { deploy: { gpu: string; gpuId: Hex; family: number[]; liveAtStartMask: number }[] };
  await world.fork.call("anvil_impersonateAccount", [primary]);
  for (let h = 0; h < ck.slices; h++) {
    const readAt = start + BigInt(h * ck.slice + 25);
    await warp(readAt);
    const entries = deploy.deploy.map((g) => ({ gpuId: g.gpuId, dayId: day, slice: h, readAt, values: values(g.gpu, g.family.length, g.liveAtStartMask) }));
    const report = encodeAbiParameters(
      [{ type: "uint8" }, { type: "uint64" }, { type: "address" }, { type: "tuple[]", components: [{ name: "gpuId", type: "bytes32" }, { name: "dayId", type: "uint32" }, { name: "slice", type: "uint8" }, { name: "readAt", type: "uint64" }, { name: "values", type: "uint32[]" }] }],
      [1, ck.chainSelector, IX, entries],
    );
    await world.fork.sendAs(primary!, IX, encodeFunctionData({ abi: W, functionName: "postReport", args: [report] }), 30_000_000n);
  }
}

let code = 1;
try {
  await assertFork(rpc);
  // ---------------------------------------------------------------- 1. Oct 4 final
  const d1 = await world.days(OCT4, IX);
  console.log(`days.ts to ${dateOfDay(OCT4)}: ${d1.transactions} transactions, chain time ${d1.chainTime}`);
  world.startBots();
  for (let i = 0; i < 300; i++) {
    const c = createAgateClient({ rpcUrl: rpc, graphqlUrl: null });
    const ok = await Promise.all((["H100", "H200", "B200"] as const).map((g) => c.book(g, "2026-11").then((b) => b.bids.length >= 3 && b.asks.length >= 3).catch(() => false)));
    if (ok.every(Boolean)) break;
    const dead = world.botAlive();
    if (dead) throw new Error(dead);
    await Bun.sleep(1000);
  }
  await indexed();
  await crossMarkets("Oct 4 final", OCT4);

  // ---------------------------------------------------------------- 2. Oct 5 closed with distinct H100 prices, not signed
  await postDay(OCT5, (gpu, n, mask) => (gpu === "H100" ? H100_OCT5.slice(0, n) : Array.from({ length: n }, (_, i) => ((mask >> i) & 1 ? PRICE[gpu]! : 0))));
  const ck = await rd<{ day: number; closeGrace: number; tPend: number }>(IX, A, "clocks");
  const s5 = await rd<bigint>(IX, A, "dayStart", [OCT5]);
  await warp(s5 + BigInt(ck.day + ck.closeGrace));
  const [primary] = await rd<readonly [Hex, Hex]>(IX, A, "writers");
  const attester = await rd<Hex>(IX, A, "attester");
  await world.fork.call("anvil_impersonateAccount", [attester]);
  for (const p of PANELS) {
    await world.fork.sendAs(primary!, IX, encodeFunctionData({ abi: W, functionName: "closeDay", args: [p.gpuId as Hex] }), 5_000_000n);
    if (p.gpu === "H100") continue;
    const [, fin, rec] = await rd<readonly [boolean, boolean, { needsSign: boolean; finalAt: bigint; source: Hex; digest: Hex }]>(IX, A, "record", [p.gpuId, OCT5]);
    if (!fin && rec.needsSign && rec.finalAt === 0n) await world.fork.sendAs(attester, IX, encodeFunctionData({ abi: W, functionName: "attest", args: [p.gpuId as Hex, OCT5, rec.source, rec.digest] }), 5_000_000n);
  }
  await warp((await now()) + 60n);
  await indexed();
  {
    console.log("\n== Oct 5 closed, H100 pending (needs a sign, not countersigned)");
    const c = createAgateClient({ rpcUrl: rpc, graphqlUrl: GQL });
    const m = await c.getMarket("H100");
    const [, fin, rec] = await rd<readonly [boolean, boolean, { needsSign: boolean; finalAt: bigint; postedAt: bigint }]>(IX, A, "record", [PANELS[0]!.gpuId, OCT5]);
    check("pending H100: the record exists, needs a sign, is not final", !fin && rec.needsSign && rec.finalAt === 0n, rec);
    check("pending H100: price stays Oct 4's; history ends at Oct 4", m.price === 3.99 && m.priceDate === dateOfDay(OCT4) && m.history.at(-1)?.date === dateOfDay(OCT4), { price: m.price, priceDate: m.priceDate, last: m.history.at(-1) });
    const t0 = await now();
    const want = rec.postedAt + BigInt(ck.tPend) > t0 ? rec.postedAt + BigInt(ck.tPend) : t0;
    check("pending H100: nextUpdateAt = max(postedAt + T_PEND, now)", Math.abs(Date.parse(m.nextUpdateAt) - Number(want) * 1000) <= 2000 && m.nextCloseAt === iso(rec.postedAt), { nextUpdateAt: m.nextUpdateAt, want: iso(want), nextCloseAt: m.nextCloseAt });
    check("pending H100: sources and liveCount still describe Oct 4 (slotState returns base while a record is pending)", m.liveCount === 5 && m.sources.filter((s) => s.live).length === 5, m.sources);
    // the countersign after T_PEND: final at once
    await warp(rec.postedAt + BigInt(ck.tPend) + 30n);
    const [, , r2] = await rd<readonly [boolean, boolean, { source: Hex; digest: Hex }]>(IX, A, "record", [PANELS[0]!.gpuId, OCT5]);
    await world.fork.sendAs(attester, IX, encodeFunctionData({ abi: W, functionName: "attest", args: [PANELS[0]!.gpuId as Hex, OCT5, r2.source, r2.digest] }), 5_000_000n);
    await warp((await now()) + 5n);
    await indexed();
  }

  // ---------------------------------------------------------------- 3. Oct 5 final with distinct prices
  const ms3 = await crossMarkets("Oct 5 final", OCT5);
  const h3 = ms3.find((m) => m.gpu === "H100")!;
  check("Oct 5 H100: $3.80 (median of 3.10, 3.50, 3.80, 4.20, 5.00), prevPrice $3.99, two final days", h3.price === 3.8 && h3.prevPrice === 3.99 && h3.history.length === 2 && h3.history.every((d) => d.status === "final"), { price: h3.price, prev: h3.prevPrice, history: h3.history });
  check("Oct 5 H100: each cloud's own price, in slot order", big(h3.panel.map((p) => p.price)) === big([3.5, 4.2, 3.8, 5, 3.1, null]), h3.panel);
  const tk3 = await createAgateClient({ rpcUrl: rpc, graphqlUrl: GQL }).ticker();
  const t3 = tk3.find((t) => t.label === "H100");
  check("Oct 5 ticker: H100 change = (3.80 - 3.99) / 3.99 = -4.76 %", t3?.change === -4.76, t3);

  // ---------------------------------------------------------------- 4. Oct 6 carried (no readings)
  const s7 = await rd<bigint>(IX, A, "dayStart", [OCT6 + 1]);
  await warp(s7 + BigInt(ck.day) + 60n);
  const anyone = "0x00000000000000000000000000000000000c0ffe";
  await world.fork.setBalance(anyone, 10n);
  await world.fork.call("anvil_impersonateAccount", [anyone]);
  for (const p of PANELS) await world.fork.sendAs(anyone, IX, encodeFunctionData({ abi: W, functionName: "carryDay", args: [p.gpuId as Hex] }), 5_000_000n);
  await warp((await now()) + 5n);
  await indexed();
  const ms4 = await crossMarkets("Oct 6 carried", OCT6);
  const h4 = ms4.find((m) => m.gpu === "H100")!;
  check("Oct 6 H100: carried, $3.80, the history's last day is 'carried'", h4.price === 3.8 && h4.priceDate === dateOfDay(OCT6) && h4.history.at(-1)?.status === "carried" && h4.history.length === 3, h4.history);
  const chainOnly = await createAgateClient({ rpcUrl: rpc, graphqlUrl: null }).getMarket("H100");
  check("Oct 6 H100 without the indexer: the same history from chain records", big(chainOnly.history) === big(h4.history), { chain: chainOnly.history, indexer: h4.history });
  check("cent() matches the index's rounding on a mean of readings", cent(3_994_999n) === 3_990_000n);
  code = results.every((r) => r.ok) ? 0 : 1;
} catch (e) {
  console.log(`STOPPED: ${(e as Error).stack ?? e}`);
  check("run", false, (e as Error).message);
} finally {
  const ps = world.pids();
  const names: string[] = [indexer.names.pg, indexer.names.hasura];
  await world.stop();
  rmSync(state, { recursive: true, force: true });
  const alive = ps.filter((p) => Bun.spawnSync(["kill", "-0", String(p)], { stderr: "ignore" }).success);
  const left = Bun.spawnSync(["podman", "ps", "-a", "--format", "{{.Names}}"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().split("\n").filter((n) => names.includes(n)).join(" ");
  console.log(`cleanup: pids alive [${alive.join(" ")}], containers [${left}]`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} cross-checks passed${failed.length ? `; failed:\n${failed.map((r) => `  - ${r.name}`).join("\n")}` : ""}`);
process.exit(code);
