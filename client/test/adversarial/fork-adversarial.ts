// Adversarial checks of the write path on a local anvil fork of Monad testnet (the live deployment, the e2e's own
// World: index days written on the fork, the lister and the market maker with the kit's public rehearsal keys, no
// indexer). Run from client/:  bun run test/adversarial/fork-adversarial.ts [--report <file.json>]
//
// What it probes (each prints pass/FAIL and a detail line; FAIL = the client did something unsafe or wrong):
//   A  closeLongDaily, which the journey never sends, on the maker's live book
//   B  a post-only limit order that would cross: what lands before the order's own simulation refuses it
//   D  the book moving between the approval and the main transaction: what is left behind
//   C  a buy after the book moved: the price paid against the ask the app showed and against the cap
//   E  closeShort and sellLong against a book outside the band (above the cap, below the floor)
// Sends transactions only to the loopback fork (assertFork); anvil's well-known test keys 2 and 3, fork only.
import { writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Abi, type Address, createWalletClient, encodeFunctionData, type Hex, http, parseAbi, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agateDollarAbi, agateTokenAbi, kuruMarginAccountAbi, kuruOrderBookAbi } from "../../src/abi.ts";
import {
  type AgateClient,
  buyLong,
  closeLongDaily,
  closeShort,
  createAgateClient,
  drip,
  mintPairs,
  openLongDaily,
  openShort,
  placeLimit,
  send,
  sellLong,
  toNumber6,
  type TxSummary,
  WriteError,
} from "../../src/index.ts";
import { anvilTmp, assertFork, dfLine, rpcCall } from "../../e2e/fork.ts";
import { DEPLOYMENTS_FILE, World } from "../../e2e/world.ts";

const USER_KEY: Hex = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // anvil account 2
const ATTACKER_KEY: Hex = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"; // anvil account 3
const GPU = "H100" as const;
const MONTH = "2026-11";
const args = process.argv.slice(2);
const reportPath = (() => {
  const i = args.indexOf("--report");
  return i >= 0 ? args[i + 1] : undefined;
})();

const big = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const checks: { id: string; name: string; ok: boolean; detail: unknown }[] = [];
const check = (id: string, name: string, ok: boolean, detail: unknown) => {
  checks.push({ id, name, ok, detail });
  console.log(`  ${ok ? "pass" : "FAIL"}  [${id}] ${name}\n        ${big(detail)}`);
};
const say = (s: string) => console.log(s);

/** The chain's head, uncached (viem's getBlockNumber caches for its polling interval). */
async function headOf(rpc: string): Promise<bigint> {
  return BigInt((await rpcCall(rpc, "eth_blockNumber")) as string);
}
/** Transactions `from` sent in blocks after `sinceBlock`, by selector (approve 0x095ea7b3, mint 0x94bf804d, ...). */
async function landed(rpc: string, from: Address, sinceBlock: bigint): Promise<{ hash: string; to: string; fn: string }[]> {
  const head = await headOf(rpc);
  const out: { hash: string; to: string; fn: string }[] = [];
  for (let b = sinceBlock + 1n; b <= head; b++) {
    const blk = (await rpcCall(rpc, "eth_getBlockByNumber", [`0x${b.toString(16)}`, true])) as { transactions: { hash: string; from: string; to: string | null; input: string }[] };
    for (const t of blk.transactions) if (t.from.toLowerCase() === from.toLowerCase()) out.push({ hash: t.hash, to: (t.to ?? "").toLowerCase(), fn: t.input.slice(0, 10) });
  }
  return out;
}
void ({} as AgateClient);

async function main(): Promise<number> {
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), diskBefore: dfLine(), anvilTmpBefore: anvilTmp() };
  say(`disk before: ${report.diskBefore}; ~/.foundry/anvil/tmp ${report.anvilTmpBefore}`);
  const state = mkdtempSync(join(tmpdir(), "agate-client-adv-"));
  let world: World | null = null;
  let pids: number[] = [];
  let port = "";
  try {
    world = await World.start({ state, indexer: false, log: say });
    const w = world;
    const rpc = w.fork.rpc;
    await assertFork(rpc);
    report.forkBlock = w.fork.forkBlock;
    const dep = (await Bun.file(DEPLOYMENTS_FILE).json()) as { dollar: string; factories: { real: { index: string } } };
    const d1 = await w.days(20730, dep.factories.real.index);
    say(`days.ts: ${d1.transactions} transactions`);
    w.startBots();
    const c = createAgateClient({ rpcUrl: rpc, graphqlUrl: null });
    for (let i = 0; ; i++) {
      try {
        const b = await c.book(GPU, MONTH);
        if (b.asks.length >= 3 && b.bids.length >= 3) break;
      } catch {
        // not listed yet
      }
      const dead = w.botAlive();
      if (dead) throw new Error(dead);
      if (i > 300) throw new Error("the November book is not quoted");
      await Bun.sleep(1000);
    }
    say(`book quoted: ${big(await c.book(GPU, MONTH))}`);

    const ua = privateKeyToAccount(USER_KEY);
    const aa = privateKeyToAccount(ATTACKER_KEY);
    for (const a of [ua.address, aa.address]) {
      await rpcCall(rpc, "anvil_setCode", [a, "0x"]);
      await rpcCall(rpc, "anvil_setBalance", [a, `0x${(100n * 10n ** 18n).toString(16)}`]);
    }
    const uw: WalletClient = createWalletClient({ account: ua, chain: c.chain, transport: http(rpc) });
    const aw: WalletClient = createWalletClient({ account: aa, chain: c.chain, transport: http(rpc) });
    await drip(c, uw);
    // the attacker's float: minted by the dollar's minter, impersonated on the fork (as World mints the maker's)
    const minter = `0x${((await rpcCall(rpc, "eth_call", [{ to: dep.dollar, data: encodeFunctionData({ abi: parseAbi(["function minter() view returns (address)"]), functionName: "minter" }) }, "latest"])) as string).slice(-40)}`;
    await w.fork.sendAs(minter, dep.dollar, encodeFunctionData({ abi: parseAbi(["function mint(address,uint256)"]), functionName: "mint", args: [aa.address, 300_000n * 1_000_000n] }));

    const s0 = await c.seriesAt(GPU, MONTH);
    const market = s0.market as Address;
    const token = s0.terms.token;
    const MA = c.marginAccount;
    const bal = async (who: Address) => toNumber6((await c.pub.readContract({ address: c.dollar, abi: agateDollarAbi as Abi, functionName: "balanceOf", args: [who] })) as bigint);
    const allowance = async (who: Address, spender: Address, tok: Address = c.dollar) => (await c.pub.readContract({ address: tok, abi: agateTokenAbi as Abi, functionName: "allowance", args: [who, spender] })) as bigint;
    const marginOf = async (who: Address, tok: Address) => (await c.pub.readContract({ address: MA, abi: kuruMarginAccountAbi as Abi, functionName: "getBalance", args: [who, tok] })) as bigint;

    // ------------------------------------------------------------ A: closeLongDaily (never sent by the journey)
    say("\n== A: openLongDaily $500 in 1 part, then closeLongDaily");
    {
      const b0 = await bal(ua.address);
      const o = await openLongDaily(c, uw, { gpu: GPU, month: MONTH, dollars: "500", parts: 1 });
      const id = o.result.positionIds[0]!;
      const b1 = await bal(ua.address);
      let res: unknown;
      let err = "";
      try {
        const r = await closeLongDaily(c, uw, { gpu: GPU, month: MONTH, positionIds: [id] });
        res = { result: r.result, txs: r.txs.map((t) => ({ label: t.label, gasLimit: t.gasLimit, gasUsed: t.gasUsed })) };
      } catch (e) {
        err = (e as Error).message;
      }
      const b2 = await bal(ua.address);
      const left = await allowance(ua.address, c.router);
      const pos = (await c.getWallet(ua.address)).positions.filter((p) => p.kind === "position");
      check("A", "closeLongDaily closes a pay-me-daily long: position gone, no router allowance left", err === "" && pos.length === 0 && left === 0n, { open: o.result, close: res, err, dollars: { before: b0, afterOpen: b1, afterClose: b2 }, routerAllowanceLeft: left.toString(), positionsLeft: pos.length });
    }

    // ------------------------------------------------------------ B: post-only orders that would cross
    say("\n== B: post-only limit orders priced to cross the book");
    for (const side of ["long", "short"] as const) {
      const bk = await c.book(GPU, MONTH);
      const price = side === "long" ? bk.asks[0]!.price.toFixed(2) : bk.bids[0]!.price.toFixed(2);
      const from = await headOf(rpc);
      const u0 = await bal(ua.address);
      const sh0 = (await c.pub.readContract({ address: s0.terms.series, abi: [{ name: "shortOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const, functionName: "shortOf", args: [ua.address] })) as bigint;
      let err: WriteError | Error | null = null;
      try {
        await placeLimit(c, uw, { gpu: GPU, month: MONTH, side, price, gpuHours: "10", ...(side === "short" ? { mint: true } : {}) });
      } catch (e) {
        err = e as Error;
      }
      const sent = await landed(rpc, ua.address, from);
      const u1 = await bal(ua.address);
      const sh1 = (await c.pub.readContract({ address: s0.terms.series, abi: [{ name: "shortOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const, functionName: "shortOf", args: [ua.address] })) as bigint;
      const mDollar = await marginOf(ua.address, c.dollar);
      const mToken = await marginOf(ua.address, token);
      const errInfo = err ? { name: err.name, stage: (err as WriteError).stage, reason: (err as WriteError).reason, message: err.message, carriesTxs: "txs" in err } : null;
      check(`B-${side}`, `a ${side} post-only order at ${price} (crossing) is refused before anything is sent`, sent.length === 0, { refused: errInfo, transactionsLanded: sent, tUSD: { before: u0, after: u1 }, shortBalance: { before: toNumber6(sh0), after: toNumber6(sh1) }, kuruMargin: { tUSD: toNumber6(mDollar), tokens: toNumber6(mToken) } });
    }

    // what the app's reads show after B (chain only, no indexer)
    {
      const wb = await c.getWallet(ua.address);
      const oo = await c.openOrders(ua.address);
      const mp = (await c.pub.readContract({ address: market, abi: kuruOrderBookAbi as Abi, functionName: "getMarketParams" })) as readonly unknown[];
      check("B-reads", "after B the wallet shows what B left in Kuru's margin account and the short balance; no open order", oo.length === 0, { marginBalance: wb.marginBalance, positions: wb.positions.map((p) => ({ kind: p.kind, side: p.side, q: p.q, inMargin: p.inMargin })), openOrders: oo, kuruMarketParams: { pricePrecision: String(mp[0]), sizePrecision: String(mp[1]), tickSize: String(mp[6]), minSize: String(mp[7]), maxSize: String(mp[8]), takerFeeBps: String(mp[9]), makerFeeBps: String(mp[10]) } });
    }

    // positions for E: a short and some tokens, while the maker still quotes
    const sh = await openShort(c, uw, { gpu: GPU, month: MONTH, gpuHours: "24", parts: 1 });
    const shortId = sh.result.positionIds[0]!;
    await buyLong(c, uw, { gpu: GPU, month: MONTH, dollars: "200" });

    // ------------------------------------------------------------ the maker stops; the book the app last showed
    say("\n== the maker stops (its resting orders stay); the app shows this book");
    const mm = w.bots.find((b) => b.name === "marketmaker")!;
    mm.proc.kill("SIGTERM");
    await mm.proc.exited;
    await Bun.sleep(1500);
    const shown = await c.book(GPU, MONTH);
    say(`shown: ${big(shown)}`);
    const shownAsk = shown.asks[0]!.price;
    const s1 = await c.seriesAt(GPU, MONTH);
    const cap = toNumber6(s1.terms.cap);
    const floor = toNumber6(s1.terms.floor);

    // the attacker's moves, as plain transactions
    const attackerEatsAsksAndPostsHigh = async () => {
      const bk = await c.book(GPU, MONTH);
      const cost = bk.asks.reduce((a, l) => a + l.price * l.size, 0);
      // the client refuses a buy beyond the asks under the cap ("ThinBook", naming what they hold): buy exactly that
      try {
        await buyLong(c, aw, { gpu: GPU, month: MONTH, dollars: (Math.ceil(cost) + 50).toString() });
      } catch (x) {
        const we = x as WriteError;
        if (we.reason !== "ThinBook" || !we.quote) throw x;
        await buyLong(c, aw, { gpu: GPU, month: MONTH, dollars: String(we.quote.dollars) });
      }
      const asks: { price: bigint; units: bigint }[] = [
        { price: 7_950_000n, units: 10n * 10_000n }, // 10 GPU-hours at $7.95 (inside the band)
        { price: 20_000_000n, units: 1_000n * 10_000n }, // 1,000 GPU-hours at $20 (2.5 x the cap)
      ];
      const tokens = asks.reduce((a, x) => a + x.units * 100n, 0n);
      await send(c, aw, { address: token, abi: agateTokenAbi as Abi, functionName: "approve", args: [MA, tokens], label: "a approve" });
      await send(c, aw, { address: MA, abi: kuruMarginAccountAbi as Abi, functionName: "deposit", args: [aa.address, token, tokens], label: "a deposit" });
      const placed: string[] = [];
      for (const x of asks) {
        try {
          await send(c, aw, { address: market, abi: kuruOrderBookAbi as Abi, functionName: "addSellOrder", args: [Number(x.price), x.units, true], label: "a ask" });
          placed.push(`${toNumber6(x.price)} x ${Number(x.units) / 1e4}`);
        } catch (e) {
          placed.push(`${toNumber6(x.price)} refused: ${(e as Error).message.slice(0, 120)}`);
        }
      }
      return placed;
    };

    // ------------------------------------------------------------ D: the book moves between approve and openLong
    say("\n== D: buyLong $1,000; the book moves right after the approval lands");
    {
      let armed = true;
      let placed: string[] = [];
      const hooked = new Proxy(uw, {
        get(t, p, r) {
          if (p === "writeContract") {
            return async (req: { functionName: string }) => {
              const h = await t.writeContract(req as never);
              if (armed && req.functionName === "approve") {
                armed = false;
                await c.pub.waitForTransactionReceipt({ hash: h });
                placed = await attackerEatsAsksAndPostsHigh();
              }
              return h;
            };
          }
          return Reflect.get(t, p, r);
        },
      }) as WalletClient;
      const a0 = await allowance(ua.address, c.router);
      let err: Error | null = null;
      try {
        await buyLong(c, hooked, { gpu: GPU, month: MONTH, dollars: "1000" });
      } catch (e) {
        err = e as Error;
      }
      const a1 = await allowance(ua.address, c.router);
      check("D", "when the main transaction is refused after its approval landed, the refusal says so and no allowance is left behind", !!err && a1 === a0 && "txs" in (err as object), { refused: err ? { name: err.name, stage: (err as WriteError).stage, reason: (err as WriteError).reason, message: err.message, carriesTxs: "txs" in err } : null, attackerAsks: placed, routerAllowance: { before: a0.toString(), after: a1.toString() } });
    }

    // ------------------------------------------------------------ C: a buy after the book moved
    say("\n== C: the user clicks buy $1,000 again (the app still shows the old ask)");
    {
      // the asks left are 10 at $7.95 and 1,000 at $20 (above the cap): a correct client refuses before sending
      // anything, which passes; a buy that goes through must be priced near the shown ask and never above the cap
      const now = await c.book(GPU, MONTH);
      const from = await headOf(rpc);
      try {
        const r = await buyLong(c, uw, { gpu: GPU, month: MONTH, dollars: "1000" });
        check("C", `a buy never pays far above the shown ask (${shownAsk}) nor above the cap (${cap})`, r.result.avgPrice <= shownAsk * 1.02 && r.result.avgPrice <= cap, { shownAsk, cap, bookAtClick: now.asks, result: r.result, txs: r.txs.map((t: TxSummary) => t.label) });
      } catch (e) {
        const sent = await landed(rpc, ua.address, from);
        check("C", `a buy never pays far above the shown ask (${shownAsk}) nor above the cap (${cap}): refused before anything was sent`, sent.length === 0 && (e as WriteError).stage === "check", { shownAsk, cap, bookAtClick: now.asks, refused: { reason: (e as WriteError).reason, quote: (e as WriteError).quote, message: (e as Error).message }, transactionsLanded: sent });
      }
    }

    // ------------------------------------------------------------ E: closeShort above the cap, sellLong below the floor
    say("\n== E: closeShort against asks above the cap");
    {
      try {
        const r = await closeShort(c, uw, { gpu: GPU, month: MONTH, positionIds: [shortId] });
        const perUnit = r.result.spent / (24 + r.result.surplusGpuHours);
        check("E-closeShort", `closing a short never buys back above the cap (${cap}), where holding it pays more`, perUnit <= cap, { result: r.result, buyBackPerGpuHour: perUnit, cap, netOfClose: r.result.paid - r.result.spent });
      } catch (e) {
        check("E-closeShort", `closing a short never buys back above the cap (${cap})`, true, { refused: (e as Error).message });
      }
    }
    say("\n== E: sellLong against a bid below the floor");
    {
      // the attacker takes every bid, then bids $0.50 for 100 GPU-hours
      const bk = await c.book(GPU, MONTH);
      const q = bk.bids.reduce((a, l) => a + l.size, 0);
      await mintPairs(c, aw, { gpu: GPU, month: MONTH, gpuHours: String(q) });
      await sellLong(c, aw, { gpu: GPU, month: MONTH, gpuHours: String(q), slippageBps: 9_000 });
      await send(c, aw, { address: c.dollar, abi: agateTokenAbi as Abi, functionName: "approve", args: [MA, 50_000_000n], label: "a approve" });
      await send(c, aw, { address: MA, abi: kuruMarginAccountAbi as Abi, functionName: "deposit", args: [aa.address, c.dollar, 50_000_000n], label: "a deposit" });
      await send(c, aw, { address: market, abi: kuruOrderBookAbi as Abi, functionName: "addBuyOrder", args: [500_000, 100n * 10_000n, true], label: "a bid" });
      const bk2 = await c.book(GPU, MONTH);
      let detail: unknown;
      let ok = true;
      try {
        const r = await sellLong(c, uw, { gpu: GPU, month: MONTH, gpuHours: "20" });
        detail = { bids: bk2.bids, result: r.result, floor };
        ok = r.result.avgPrice >= floor;
      } catch (e) {
        detail = { refused: (e as Error).message };
      }
      check("E-sellLong", `a sale never pays below the floor (${floor}), which every held token is worth at least`, ok, detail);
    }
    report.checks = checks;
  } catch (e) {
    say(`\nSTOPPED: ${(e as Error).stack ?? e}`);
    checks.push({ id: "run", name: "the run completed", ok: false, detail: (e as Error).message });
  } finally {
    if (world) {
      pids = world.pids();
      port = new URL(world.fork.rpc).port;
      await world.stop();
    }
    rmSync(state, { recursive: true, force: true });
  }
  const alive = pids.filter((p) => Bun.spawnSync(["kill", "-0", String(p)], { stderr: "ignore" }).success);
  const anvilLeft = port ? Bun.spawnSync(["pgrep", "-f", `anvil --prune-history --port ${port} `], { stdout: "pipe" }).stdout.toString().trim() : "";
  report.leftovers = { pids: alive, anvil: anvilLeft };
  report.diskAfter = dfLine();
  report.anvilTmpAfter = anvilTmp();
  report.checks = checks;
  say(`\nleftovers: ${big(report.leftovers)}; disk after: ${report.diskAfter}; ~/.foundry/anvil/tmp ${report.anvilTmpAfter}`);
  const failed = checks.filter((x) => !x.ok);
  say(`${checks.length - failed.length} of ${checks.length} adversarial checks passed${failed.length ? `; FAILED: ${failed.map((x) => x.id).join(", ")}` : ""}`);
  if (reportPath) writeFileSync(reportPath, big(report));
  return failed.length === 0 ? 0 : 1;
}

process.exit(await main());
