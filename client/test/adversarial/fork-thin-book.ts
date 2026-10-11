// A buy larger than the book's depth, and allowances after every write, on a local anvil fork of Monad testnet (the
// live deployment, the e2e's own World: index days written on the fork, the lister and the market maker with the
// kit's public rehearsal keys, no indexer). Run from client/:
//   bun run test/adversarial/fork-thin-book.ts [--report <file.json>]
//
//   P  every write the app can send leaves no allowance of the user's to the router, the series or Kuru's margin
//      account (read on chain after each), and a buy the wallet cannot pay for is put back (at the cost of two fees)
//   T0 control: on a thin book the app's shown ask (maxPrice) refuses the click before anything is sent
//   T1 a buy larger than the asks' depth, with an ask far above the cap resting behind them: what it pays
//   T2 the same with the book clean when the app quotes, and the ask posted after the approval lands (a front-run)
//   T3 a buy of exactly the most a "ThinBook" refusal names: every ask under the cap, nothing of the ask above
//   T4 a front-run inside the depth (an ask taken, $4,000 posted behind, after the approval): at most the slippage
// Each prints pass/FAIL (FAIL = the user paid above the band's top for part of a buy). Sends transactions only to the
// loopback fork (assertFork); anvil's well-known test keys 4, 5 and 6, fork only.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Abi, type Address, createWalletClient, encodeFunctionData, type Hex, http, parseAbi, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agateDollarAbi, agateTokenAbi, kuruMarginAccountAbi, kuruOrderBookAbi } from "../../src/abi.ts";
import { buyLong, cancelLimit, closeLongDaily, closeShort, createAgateClient, drip, mintPairs, openLongDaily, openShort, placeLimit, redeem, send, sellLong, toNumber6, type WriteError, withdrawMargin } from "../../src/index.ts";
import { anvilOnPort, anvilTmp, assertFork, dfLine, rpcCall } from "../../e2e/fork.ts";
import { DEPLOYMENTS_FILE, World } from "../../e2e/world.ts";

const USER_KEY: Hex = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"; // anvil account 4
const ATTACKER_KEY: Hex = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"; // anvil account 5
const SHORT_KEY: Hex = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e"; // anvil account 6
const GPU = "H100" as const;
const MONTH = "2026-11";
const HIGH = 4_000_000_000n; // $4,000 per GPU-hour, 500 x the cap (Kuru's price is a uint32 in u)
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

async function main(): Promise<number> {
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), diskBefore: dfLine(), anvilTmpBefore: anvilTmp() };
  say(`disk before: ${report.diskBefore}; ~/.foundry/anvil/tmp ${report.anvilTmpBefore}`);
  const state = mkdtempSync(join(tmpdir(), "agate-client-thin-"));
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
    await w.days(20730, dep.factories.real.index);
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
    const ua = privateKeyToAccount(USER_KEY);
    const aa = privateKeyToAccount(ATTACKER_KEY);
    const va = privateKeyToAccount(SHORT_KEY);
    for (const a of [ua.address, aa.address, va.address]) {
      await rpcCall(rpc, "anvil_setCode", [a, "0x"]);
      await rpcCall(rpc, "anvil_setBalance", [a, `0x${(100n * 10n ** 18n).toString(16)}`]);
    }
    const wallet = (acc: ReturnType<typeof privateKeyToAccount>): WalletClient => createWalletClient({ account: acc, chain: c.chain, transport: http(rpc) });
    const uw = wallet(ua);
    const aw = wallet(aa);
    const vw = wallet(va);
    await drip(c, uw);
    const minter = `0x${((await rpcCall(rpc, "eth_call", [{ to: dep.dollar, data: encodeFunctionData({ abi: parseAbi(["function minter() view returns (address)"]), functionName: "minter" }) }, "latest"])) as string).slice(-40)}`;
    await w.fork.sendAs(minter, dep.dollar, encodeFunctionData({ abi: parseAbi(["function mint(address,uint256)"]), functionName: "mint", args: [aa.address, 300_000n * 1_000_000n] }));
    const s0 = await c.seriesAt(GPU, MONTH);
    const market = s0.market as Address;
    const token = s0.terms.token;
    const MA = c.marginAccount;
    const read = async <T>(address: Address, abi: Abi, functionName: string, a: unknown[]) => (await c.pub.readContract({ address, abi, functionName, args: a } as never)) as T;
    const usd = async (who: Address) => read<bigint>(c.dollar, agateDollarAbi as Abi, "balanceOf", [who]);
    const tok = async (who: Address) => read<bigint>(token, agateTokenAbi as Abi, "balanceOf", [who]);
    const allowances = async (who: Address) => {
      const out: Record<string, string> = {};
      for (const [asset, an] of [[c.dollar, "tUSD"], [token, "token"]] as const) {
        for (const [spender, sn] of [[c.router, "router"], [s0.terms.series, "series"], [MA, "margin"]] as const) {
          const v = await read<bigint>(asset, agateTokenAbi as Abi, "allowance", [who, spender]);
          if (v !== 0n) out[`${an}->${sn}`] = v.toString();
        }
      }
      return out;
    };

    // ------------------------------------------------------------ P: no allowance left after any write
    say("\n== P: every write, then the user's allowances read on chain");
    const flows: [string, () => Promise<unknown>][] = [
      ["buyLong $300", () => buyLong(c, uw, { gpu: GPU, month: MONTH, dollars: "300" })],
      ["sellLong 20", () => sellLong(c, uw, { gpu: GPU, month: MONTH, gpuHours: "20" })],
      ["openShort 24 in 2 parts", () => openShort(c, uw, { gpu: GPU, month: MONTH, gpuHours: "24", parts: 2 })],
      ["closeShort one", async () => {
        const id = (await c.getWallet(ua.address)).positions.find((p) => p.kind === "position" && p.side === "short")!.positionId!;
        return closeShort(c, uw, { gpu: GPU, month: MONTH, positionIds: [id] });
      }],
      ["openLongDaily $200", () => openLongDaily(c, uw, { gpu: GPU, month: MONTH, dollars: "200", parts: 1 })],
      ["closeLongDaily", async () => {
        const id = (await c.getWallet(ua.address)).positions.find((p) => p.kind === "position" && p.side === "long")!.positionId!;
        return closeLongDaily(c, uw, { gpu: GPU, month: MONTH, positionIds: [id] });
      }],
      ["mintPairs 5", () => mintPairs(c, uw, { gpu: GPU, month: MONTH, gpuHours: "5" })],
      ["redeem 5", () => redeem(c, uw, { gpu: GPU, month: MONTH, gpuHours: "5" })],
      ["placeLimit long 3.80 x 5, cancel, withdraw", async () => {
        const o = await placeLimit(c, uw, { gpu: GPU, month: MONTH, side: "long", price: "3.80", gpuHours: "5" });
        await cancelLimit(c, uw, { gpu: GPU, month: MONTH, orderIds: [o.result.orderId] });
        return withdrawMargin(c, uw, { asset: "dollar" });
      }],
      ["placeLimit short 4.20 x 5 from held tokens, cancel, withdraw", async () => {
        const o = await placeLimit(c, uw, { gpu: GPU, month: MONTH, side: "short", price: "4.20", gpuHours: "5" });
        await cancelLimit(c, uw, { gpu: GPU, month: MONTH, orderIds: [o.result.orderId] });
        return withdrawMargin(c, uw, { asset: { gpu: GPU, month: MONTH } });
      }],
    ];
    for (const [name, run] of flows) {
      let err = "";
      try {
        await run();
      } catch (e) {
        err = (e as Error).message;
      }
      const left = await allowances(ua.address);
      check("P", `${name}: lands and leaves no allowance`, err === "" && Object.keys(left).length === 0, { err, left });
    }
    {
      // a wallet with $5 asks for a $1,000 buy
      await drip(c, vw);
      const all = await usd(va.address);
      await send(c, vw, { address: c.dollar, abi: parseAbi(["function transfer(address,uint256) returns (bool)"]) as Abi, functionName: "transfer", args: [aa.address, all - 5_000_000n], label: "keep $5" });
      let e: WriteError | null = null;
      try {
        await buyLong(c, vw, { gpu: GPU, month: MONTH, dollars: "1000" });
      } catch (x) {
        e = x as WriteError;
      }
      const left = await allowances(va.address);
      check("P-balance", "a buy the wallet cannot pay for leaves no allowance", !!e && Object.keys(left).length === 0, { reason: e?.reason, stage: e?.stage, txs: e?.txs.map((t) => t.label), left });
      check("P-balance-fees", "... and is refused before any transaction (no approve and put-back paid for nothing)", !!e && e.txs.length === 0, { txs: e?.txs.map((t) => ({ label: t.label, gasLimit: t.gasLimit })) });
    }

    // ------------------------------------------------------------ the book thins: the maker stops, the attacker eats the asks
    say("\n== the maker stops (its resting orders stay); the attacker leaves about $600 of asks");
    const mm = w.bots.find((b) => b.name === "marketmaker")!;
    mm.proc.kill("SIGTERM");
    await mm.proc.exited;
    await Bun.sleep(1500);
    const before = await c.book(GPU, MONTH);
    const depth = before.asks.reduce((a, l) => a + l.price * l.size, 0);
    await buyLong(c, aw, { gpu: GPU, month: MONTH, dollars: String(Math.floor(depth - 600)) });
    const thin = await c.book(GPU, MONTH);
    const thinDepth = thin.asks.reduce((a, l) => a + l.price * l.size, 0);
    say(`asks before ${big(before.asks)} ($${depth.toFixed(2)}); after ${big(thin.asks)} ($${thinDepth.toFixed(2)})`);
    // the attacker's ask far above the cap: 1 GPU-hour at $4,000 (raw Kuru calls: the client refuses such a price)
    const postHigh = async () => {
      await send(c, aw, { address: token, abi: agateTokenAbi as Abi, functionName: "approve", args: [MA, 1_000_000n], label: "a approve" });
      await send(c, aw, { address: MA, abi: kuruMarginAccountAbi as Abi, functionName: "deposit", args: [aa.address, token, 1_000_000n], label: "a deposit" });
      const t = await send(c, aw, { address: market, abi: kuruOrderBookAbi as Abi, functionName: "addSellOrder", args: [Number(HIGH), 10_000n, true], label: "a ask at $4,000" });
      return String(t.events.find((e) => e.name === "OrderCreated")?.args.orderId ?? "");
    };
    const cancelHigh = async (id: string) => {
      await send(c, aw, { address: market, abi: kuruOrderBookAbi as Abi, functionName: "batchCancelOrders", args: [[Number(id)]], label: "a cancel" });
    };

    // ------------------------------------------------------------ T0 + T1: the ask rests behind the thin book
    let highId = await postHigh();
    const shown = await c.book(GPU, MONTH);
    say(`the book the app shows: ${big(shown)}`);
    {
      const u0 = await usd(ua.address);
      let e: WriteError | null = null;
      try {
        await buyLong(c, uw, { gpu: GPU, month: MONTH, dollars: "1000", maxPrice: String(shown.asks[0]!.price) });
      } catch (x) {
        e = x as WriteError;
      }
      check("T0", "control: with the shown ask passed (maxPrice), the $1,000 click on a thin book is refused before anything is sent", e?.stage === "check" && e.txs.length === 0 && (await usd(ua.address)) === u0, { reason: e?.reason, quote: e?.quote });
    }
    {
      const u0 = await usd(ua.address);
      const t0 = await tok(ua.address);
      let r: Awaited<ReturnType<typeof buyLong>> | null = null;
      let err = "";
      try {
        r = await buyLong(c, uw, { gpu: GPU, month: MONTH, dollars: "1000" });
      } catch (x) {
        err = (x as Error).message;
      }
      const spent = u0 - (await usd(ua.address));
      const got = (await tok(ua.address)) - t0;
      const atHigh = (await c.book(GPU, MONTH)).asks.find((l) => l.price === toNumber6(HIGH));
      const tookHigh = atHigh === undefined || atHigh.size < 1;
      check("T1", "a $1,000 buy (no shown price) never pays above the band's top ($8.00) for any part of it", err !== "" ? spent === 0n : !tookHigh, { spentDollars: toNumber6(spent), gotGpuHours: toNumber6(got), avgPrice: got > 0n ? toNumber6((spent * 1_000_000n) / got) : 0, highAskLeft: atHigh ?? null, refused: err || null, result: r?.result ?? null, routedTokensOut: r ? String(r.txs.find((t) => t.label === "openLong")?.events.find((e) => e.name === "Routed")?.args.tokensOut ?? "") : null });
    }
    // ------------------------------------------------------------ T3: the most the refusal names lands, and takes nothing above the cap
    {
      let named = "";
      try {
        await buyLong(c, uw, { gpu: GPU, month: MONTH, dollars: "1000" });
      } catch (x) {
        named = String((x as WriteError).quote?.dollars ?? "");
      }
      const fair = (await c.book(GPU, MONTH)).asks.filter((l) => l.price <= 8).reduce((a, l) => a + l.size, 0);
      const u0 = await usd(ua.address);
      const t0 = await tok(ua.address);
      let err = "";
      try {
        if (named) await buyLong(c, uw, { gpu: GPU, month: MONTH, dollars: named });
      } catch (x) {
        err = (x as Error).message;
      }
      const spent = u0 - (await usd(ua.address));
      const got = (await tok(ua.address)) - t0;
      const atHigh = (await c.book(GPU, MONTH)).asks.find((l) => l.price === toNumber6(HIGH));
      check("T3", `a buy of exactly the most the refusal names ($${named}) lands, takes every ask under the cap (${fair} GPU-hours) and nothing of the $4,000 ask behind them`, named !== "" && err === "" && toNumber6(spent) === Number(named) && toNumber6(got) === fair && atHigh !== undefined && atHigh.size === 1, { named, spentDollars: toNumber6(spent), gotGpuHours: toNumber6(got), fairGpuHours: fair, highAskLeft: atHigh ?? null, err: err || null });
    }
    // ------------------------------------------------------------ T2: the book is clean when the app quotes; the ask comes after the approval
    {
      await cancelHigh(highId).catch(() => undefined);
      // the attacker leaves 150 GPU-hours at the fair price, nothing behind
      const bk = await c.book(GPU, MONTH);
      if (bk.asks.length) {
        const ids = (await c.openOrders(aa.address)).filter((o) => o.side === "short").map((o) => o.id);
        if (ids.length) await cancelLimit(c, aw, { gpu: GPU, month: MONTH, orderIds: ids });
        const rest = (await c.book(GPU, MONTH)).asks.reduce((a, l) => a + l.price * l.size, 0);
        // the client refuses a buy beyond the asks under the cap ("ThinBook", naming what they hold): buy exactly that
        if (rest > 0) {
          try {
            await buyLong(c, aw, { gpu: GPU, month: MONTH, dollars: (Math.ceil(rest) + 1).toString() });
          } catch (x) {
            const we = x as WriteError;
            if (we.reason !== "ThinBook" || !we.quote) throw x;
            await buyLong(c, aw, { gpu: GPU, month: MONTH, dollars: String(we.quote.dollars) });
          }
        }
      }
      await placeLimit(c, aw, { gpu: GPU, month: MONTH, side: "short", price: "4.05", gpuHours: "150" });
      const quoted = await c.book(GPU, MONTH);
      say(`the book the app quotes: ${big(quoted)}`);
      let armed = true;
      const hooked = new Proxy(uw, {
        get(t, p, r) {
          if (p === "writeContract") {
            return async (req: { functionName: string }) => {
              const h = await t.writeContract(req as never);
              if (armed && req.functionName === "approve") {
                armed = false;
                await c.pub.waitForTransactionReceipt({ hash: h });
                highId = await postHigh();
              }
              return h;
            };
          }
          return Reflect.get(t, p, r);
        },
      }) as WalletClient;
      const u0 = await usd(ua.address);
      const t0 = await tok(ua.address);
      let err = "";
      try {
        await buyLong(c, hooked, { gpu: GPU, month: MONTH, dollars: "1000" });
      } catch (x) {
        err = (x as Error).message;
      }
      const spent = u0 - (await usd(ua.address));
      const got = (await tok(ua.address)) - t0;
      const atHigh = (await c.book(GPU, MONTH)).asks.find((l) => l.price === toNumber6(HIGH));
      check("T2", "a $1,000 buy whose remainder meets an ask posted after the approval never pays it ($4,000, 500 x the cap)", err !== "" ? true : atHigh !== undefined && atHigh.size >= 1, { spentDollars: toNumber6(spent), gotGpuHours: toNumber6(got), avgPrice: got > 0n ? toNumber6((spent * 1_000_000n) / got) : 0, highAskLeft: atHigh ?? null, refused: err || null });
    }
    // ------------------------------------------------------------ T4: a front-run inside the depth: bounded by the slippage
    {
      // the book the app quotes: 150 at 4.05 (T2 was refused before anything was sent). The user buys all of it
      // ($607.50, the most allowed); after the approval lands the attacker takes 1 GPU-hour at 4.05 and posts $4,000
      // behind: the user's buy then meets the $4,000 ask with the last $4.05, which the minimum out (148.5, the
      // complete fill less 1%) allows, or reverts on chain. Either way the loss is at most 1% of the GPU-hours.
      const quoted = await c.book(GPU, MONTH);
      const spend = quoted.asks.filter((l) => l.price <= 8).reduce((a, l) => a + l.price * l.size, 0).toFixed(6);
      let armed = true;
      const hooked = new Proxy(uw, {
        get(t, p, r) {
          if (p === "writeContract") {
            return async (req: { functionName: string }) => {
              const h = await t.writeContract(req as never);
              if (armed && req.functionName === "approve") {
                armed = false;
                await c.pub.waitForTransactionReceipt({ hash: h });
                await buyLong(c, aw, { gpu: GPU, month: MONTH, dollars: "4.05" });
                highId = await postHigh();
              }
              return h;
            };
          }
          return Reflect.get(t, p, r);
        },
      }) as WalletClient;
      const u0 = await usd(ua.address);
      const t0 = await tok(ua.address);
      let e: WriteError | null = null;
      try {
        await buyLong(c, hooked, { gpu: GPU, month: MONTH, dollars: spend });
      } catch (x) {
        e = x as WriteError;
      }
      const spent = u0 - (await usd(ua.address));
      const got = (await tok(ua.address)) - t0;
      const promised = quoted.asks.filter((l) => l.price <= 8).reduce((a, l) => a + l.size, 0);
      const ok = e === null ? toNumber6(got) >= promised * 0.99 && toNumber6(spent) <= Number(spend) : e.stage === "receipt" || e.stage === "simulate";
      check("T4", `a front-run inside the depth costs at most the slippage: $${spend} bought ${toNumber6(got)} of the ${promised} GPU-hours quoted (at least 99%), or the buy was refused`, ok, { spend, spentDollars: toNumber6(spent), gotGpuHours: toNumber6(got), promised, avgPrice: got > 0n ? toNumber6((spent * 1_000_000n) / got) : 0, refused: e ? { stage: e.stage, reason: e.reason, txs: e.txs.map((t) => t.label) } : null });
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
  const anvilLeft = anvilOnPort(port);
  report.leftovers = { pids: alive, anvil: anvilLeft };
  report.diskAfter = dfLine();
  report.anvilTmpAfter = anvilTmp();
  report.checks = checks;
  say(`\nleftovers: ${big(report.leftovers)}; disk after: ${report.diskAfter}; ~/.foundry/anvil/tmp ${report.anvilTmpAfter}`);
  const failed = checks.filter((x) => !x.ok);
  say(`${checks.length - failed.length} of ${checks.length} checks passed${failed.length ? `; FAILED: ${failed.map((x) => x.id).join(", ")}` : ""}`);
  if (reportPath) writeFileSync(reportPath, big(report));
  return failed.length === 0 ? 0 : 1;
}

process.exit(await main());
