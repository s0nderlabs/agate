// A true sandwich of buyLong on a local anvil fork of Monad testnet (the live deployment, the e2e's own World: index
// days written on the fork, the lister and the market maker with the kit's public rehearsal keys, no indexer). The
// user's openLong is held in the mempool (automine off) while an attacker's transactions with a higher tip go in
// before it in the same block, then one block is mined: the attacker acts after the client's quote, approval and
// simulation, exactly where a mempool front-runner would. Run from client/:
//   bun run test/adversarial/fork-sandwich.ts [--report <file.json>]
//
//   S1 default slippage: every fair ask taken and 1,000 GPU-hours re-posted at the cap ($8.00) in front of a $1,000
//      buy quoted at $4.03: the buy reverts at its minimum out, nothing bought, the approval put back (allowance 0)
//   S2 slippage 9,999 bps, the fair asks cancelled in front of the buy, the $8.00 ask left: the buy lands at $8.00, the
//      band's top, never above it; allowance 0
//   S3 slippage 9,999 bps, the only ask left one tick above the cap ($8.01): the buy reverts; allowance 0
// Sends transactions only to the loopback fork (assertFork); anvil's well-known test keys 7 and 8, fork only.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Abi, type Address, createWalletClient, encodeFunctionData, type Hex, http, parseAbi, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agateDollarAbi, agateTokenAbi, kuruMarginAccountAbi, kuruOrderBookAbi } from "../../src/abi.ts";
import { buyLong, createAgateClient, drip, mintPairs, send, toNumber6, type WriteError } from "../../src/index.ts";
import { anvilOnPort, anvilTmp, assertFork, dfLine, rpcCall } from "../../e2e/fork.ts";
import { DEPLOYMENTS_FILE, World } from "../../e2e/world.ts";

const USER_KEY: Hex = "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356"; // anvil account 7
const ATTACKER_KEY: Hex = "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97"; // anvil account 8
const GPU = "H100" as const;
const MONTH = "2026-11";
const CAP = 8_000_000n;
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
  const state = mkdtempSync(join(tmpdir(), "agate-client-sandwich-"));
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
    // the maker stops (its resting ladder stays), so only the attacker moves the book from here on
    const mm = w.bots.find((b) => b.name === "marketmaker")!;
    mm.proc.kill("SIGTERM");
    await mm.proc.exited;
    await Bun.sleep(1500);

    const ua = privateKeyToAccount(USER_KEY);
    const aa = privateKeyToAccount(ATTACKER_KEY);
    for (const a of [ua.address, aa.address]) {
      await rpcCall(rpc, "anvil_setCode", [a, "0x"]);
      await rpcCall(rpc, "anvil_setBalance", [a, `0x${(100n * 10n ** 18n).toString(16)}`]);
    }
    const wallet = (acc: ReturnType<typeof privateKeyToAccount>): WalletClient => createWalletClient({ account: acc, chain: c.chain, transport: http(rpc) });
    const uw = wallet(ua);
    const aw = wallet(aa);
    const minter = `0x${((await rpcCall(rpc, "eth_call", [{ to: dep.dollar, data: encodeFunctionData({ abi: parseAbi(["function minter() view returns (address)"]), functionName: "minter" }) }, "latest"])) as string).slice(-40)}`;
    await w.fork.sendAs(minter, dep.dollar, encodeFunctionData({ abi: parseAbi(["function mint(address,uint256)"]), functionName: "mint", args: [aa.address, 300_000n * 1_000_000n] }));
    const s0 = await c.seriesAt(GPU, MONTH);
    const market = s0.market as Address;
    const token = s0.terms.token;
    const MA = c.marginAccount;
    const read = async <T>(address: Address, abi: Abi, functionName: string, a: unknown[]) => (await c.pub.readContract({ address, abi, functionName, args: a } as never)) as T;
    const usd = async (who: Address) => read<bigint>(c.dollar, agateDollarAbi as Abi, "balanceOf", [who]);
    const tok = async (who: Address) => read<bigint>(token, agateTokenAbi as Abi, "balanceOf", [who]);
    const routerAllowance = async (who: Address) => read<bigint>(c.dollar, agateTokenAbi as Abi, "allowance", [who, c.router]);

    // the attacker's inventory: 3,000 pairs minted, the tokens deposited in Kuru's margin account; tUSD approved to the
    // market for its market buys
    await mintPairs(c, aw, { gpu: GPU, month: MONTH, gpuHours: "3000" });
    await send(c, aw, { address: token, abi: agateTokenAbi as Abi, functionName: "approve", args: [MA, 3_000_000_000n], label: "a approve tokens" });
    await send(c, aw, { address: MA, abi: kuruMarginAccountAbi as Abi, functionName: "deposit", args: [aa.address, token, 3_000_000_000n], label: "a deposit tokens" });
    await send(c, aw, { address: c.dollar, abi: agateTokenAbi as Abi, functionName: "approve", args: [market, 200_000_000_000n], label: "a approve tUSD to the market" });
    const ask = async (price: bigint, hours: bigint) => {
      const t = await send(c, aw, { address: market, abi: kuruOrderBookAbi as Abi, functionName: "addSellOrder", args: [Number(price), hours * 10_000n, false], label: `a ask ${price}` });
      return Number(t.events.find((e) => e.name === "OrderCreated")?.args.orderId ?? 0);
    };
    await drip(c, uw);

    const base = BigInt(((await rpcCall(rpc, "eth_getBlockByNumber", ["latest", false])) as { baseFeePerGas: string }).baseFeePerGas);
    const fees = { maxPriorityFeePerGas: 100n * 10n ** 9n, maxFeePerGas: base * 3n + 100n * 10n ** 9n };
    /** The user's wallet with a sandwich armed on its first openLong: the user's transaction is held in the mempool,
     *  the attacker's go in front of it (higher tip), then one block is mined. */
    const sandwiched = (front: () => Promise<Hex[]>) => {
      let armed = true;
      const out: { block?: string; order?: string[]; front?: Hex[]; user?: Hex } = {};
      const hooked = new Proxy(uw, {
        get(t, p, r) {
          if (p === "writeContract") {
            return async (req: { functionName: string }) => {
              if (!armed || req.functionName !== "openLong") return t.writeContract(req as never);
              armed = false;
              await rpcCall(rpc, "evm_setAutomine", [false]);
              try {
                const h = await t.writeContract(req as never);
                out.user = h;
                out.front = await front();
                await rpcCall(rpc, "evm_mine");
                const blk = (await rpcCall(rpc, "eth_getBlockByNumber", ["latest", false])) as { number: string; transactions: string[] };
                out.block = String(BigInt(blk.number));
                out.order = blk.transactions;
                return h;
              } finally {
                await rpcCall(rpc, "evm_setAutomine", [true]);
              }
            };
          }
          return Reflect.get(t, p, r);
        },
      }) as WalletClient;
      return { hooked, out };
    };
    const raw = (functionName: string, a: unknown[]) => aw.writeContract({ address: market, abi: kuruOrderBookAbi as Abi, functionName, args: a, gas: 3_000_000n, ...fees, chain: c.chain, account: aa } as never);
    const attempt = async (hooked: WalletClient, p: { dollars: string; slippageBps?: number }) => {
      const u0 = await usd(ua.address);
      const t0 = await tok(ua.address);
      let e: WriteError | null = null;
      try {
        await buyLong(c, hooked, { gpu: GPU, month: MONTH, ...p });
      } catch (x) {
        e = x as WriteError;
      }
      const spent = u0 - (await usd(ua.address));
      const got = (await tok(ua.address)) - t0;
      return { e, spent, got, allowance: await routerAllowance(ua.address), avg: got > 0n ? toNumber6((spent * 1_000_000n) / got) : 0 };
    };

    // ------------------------------------------------------------ S1: default slippage
    {
      const quoted = await c.book(GPU, MONTH);
      const fairDollars = quoted.asks.reduce((a, l) => a + l.price * l.size, 0);
      say(`\n== S1: the book the app quotes ${big(quoted.asks)} ($${fairDollars.toFixed(2)} of asks)`);
      const { hooked, out } = sandwiched(async () => [
        (await raw("placeAndExecuteMarketBuy", [BigInt(Math.ceil(fairDollars + 100)) * 1_000_000n, 1n, false, false])) as Hex,
        (await raw("addSellOrder", [Number(CAP), 10_000_000n, false])) as Hex,
      ]);
      const r = await attempt(hooked, { dollars: "1000" });
      const userLast = out.order?.at(-1)?.toLowerCase() === out.user?.toLowerCase() && (out.order?.length ?? 0) >= 3;
      check("S1", "every fair ask taken and 1,000 GPU-hours re-posted at $8.00 in front of a $1,000 buy quoted at $4.03 (default slippage): the buy reverts at its minimum out, nothing bought, the approval put back", userLast && r.e?.stage === "receipt" && r.got === 0n && r.spent === 0n && r.allowance === 0n && (r.e?.txs.map((t) => t.label).join() ?? "") === "approve tUSD to the router,put back: approve tUSD to the router", { block: out.block, order: out.order, user: out.user, stage: r.e?.stage, reason: r.e?.reason, txs: r.e?.txs.map((t) => t.label), spent: toNumber6(r.spent), got: toNumber6(r.got), allowance: String(r.allowance) });
      say(`book after S1: ${big((await c.book(GPU, MONTH)).asks)}`);
    }

    // ------------------------------------------------------------ S2: 9,999 bps, the fair asks pulled, $8.00 behind
    {
      const fairIds = [await ask(4_030_000n, 300n)];
      const quoted = await c.book(GPU, MONTH);
      say(`\n== S2: the book the app quotes ${big(quoted.asks)}`);
      const { hooked, out } = sandwiched(async () => [(await raw("batchCancelOrders", [fairIds])) as Hex]);
      const r = await attempt(hooked, { dollars: "1000", slippageBps: 9_999 });
      const userLast = out.order?.at(-1)?.toLowerCase() === out.user?.toLowerCase() && (out.order?.length ?? 0) >= 2;
      check("S2", "slippage 9,999 bps, the $4.03 asks cancelled in front of the buy, the $8.00 ask left: the buy lands at the band's top ($8.00 each), never above; no allowance left", userLast && r.e === null && r.got === 125_000_000n && r.spent === 1_000_000_000n && r.avg <= 8 && r.allowance === 0n, { block: out.block, order: out.order, user: out.user, err: r.e ? { stage: r.e.stage, reason: r.e.reason, message: r.e.message } : null, spent: toNumber6(r.spent), got: toNumber6(r.got), avg: r.avg, allowance: String(r.allowance) });
    }

    // ------------------------------------------------------------ S3: 9,999 bps, the only ask left at $8.01
    {
      // the attacker cancels what it still rests (the rest of the $8.00 ask), then rests $8.01 and fair asks at $4.03
      const mine = (await c.openOrders(aa.address)).map((o) => Number(o.id));
      if (mine.length) await send(c, aw, { address: market, abi: kuruOrderBookAbi as Abi, functionName: "batchCancelOrders", args: [mine], label: "a cancel its asks" });
      say(`asks left after the attacker's cancel: ${big((await c.book(GPU, MONTH)).asks)}`);
      await ask(CAP + 10_000n, 1_000n);
      const fairIds = [await ask(4_030_000n, 300n)];
      const quoted = await c.book(GPU, MONTH);
      say(`\n== S3: the book the app quotes ${big(quoted.asks)}`);
      const { hooked, out } = sandwiched(async () => [(await raw("batchCancelOrders", [fairIds])) as Hex]);
      const r = await attempt(hooked, { dollars: "1000", slippageBps: 9_999 });
      const userLast = out.order?.at(-1)?.toLowerCase() === out.user?.toLowerCase() && (out.order?.length ?? 0) >= 2;
      check("S3", "slippage 9,999 bps, the only ask left in front of the buy one tick above the cap ($8.01): the buy reverts, nothing bought, no allowance left", userLast && r.e?.stage === "receipt" && r.got === 0n && r.spent === 0n && r.allowance === 0n, { block: out.block, order: out.order, user: out.user, stage: r.e?.stage, reason: r.e?.reason, txs: r.e?.txs.map((t) => t.label), spent: toNumber6(r.spent), got: toNumber6(r.got), allowance: String(r.allowance) });
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
