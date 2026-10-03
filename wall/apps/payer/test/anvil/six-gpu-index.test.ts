// The market keeps three GPUs while the index prices six (wall spec 18): a factory over an index that registers
// H100, H200, B200 and the price-only B300, A100 and L40S lists only its own three, whatever the index holds. Local
// anvil (anvil-safe) with the MockIndex on the demo clock, the lister of the payer app in process.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Abi, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bootstrap } from "@agate/market";
import { buildApp, type PayerApp } from "../../src/app.ts";
import { parseConfig } from "../../src/config.ts";
import { type Chain, freeGb, haveAnvil, read, startChain } from "./chain.ts";
import { A100, agateFactoryAbi, B200, B300, buildMarket, EPOCH_DAY, finalAt, fund, H100, H200, L40S, type MarketWorld, NOV, OCT, putDay, seriesOf } from "./market.ts";

const DEPLOYER: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil #0: a local chain only
const KEY = generatePrivateKey();
const ME = privateKeyToAccount(KEY).address;
const ZERO = "0x0000000000000000000000000000000000000000";
const now = () => Math.floor(Date.now() / 1000);

let c: Chain;
let w: MarketWorld;
let dir: string;

async function app(): Promise<PayerApp> {
  process.env.AGATE_RPC_URLS = `${c.rpc},${c.rpc2}`;
  process.env.AGATE_CHAIN_ID = String(c.chainId);
  process.env.AGATE_DEPLOYMENTS = w.depFile;
  process.env.AGATE_WALL_HOME = join(dir, "home");
  process.env.AGATE_MARKET_GAS_LIMITS = JSON.stringify({ "factory.createMarket": 1_950_000 });
  process.env.AGATE_SIX_KEY = KEY;
  delete process.env.AGATE_DRY_RUN;
  const rt = await bootstrap({ role: "payer", keyVar: "AGATE_SIX_KEY", addressVar: "AGATE_PAYER_ADDRESS", now, console: false, noLock: true, marginAccount: "optional" });
  return buildApp(rt, parseConfig({ tickS: 1 }), { now, log: () => {}, pollMs: 20 });
}

describe.skipIf(!haveAnvil)("a factory on a six-GPU index (local anvil)", () => {
  beforeAll(async () => {
    console.log(`df -h /: ${freeGb()} GB free`);
    dir = mkdtempSync(join(tmpdir(), "agate-six-gpu-"));
    c = await startChain(["--chain-id", "31337"]);
    const t0 = await c.time();
    w = await buildMarket(c, {
      deployer: DEPLOYER,
      epochTs: t0 - 50n,
      dir,
      indexGpus: [H100, H200, B200, B300, A100, L40S],
      factoryGpus: [
        { id: H100, label: "H100" },
        { id: H200, label: "H200" },
        { id: B200, label: "B200" },
      ],
    });
    await fund(w, ME);
  }, 300_000);

  afterAll(async () => {
    await c?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true }); // this test's own temp dir only
    console.log(`df -h /: ${freeGb()} GB free after`);
  });

  test("the lister lists the factory's three GPUs for both months and nothing of the price-only three", async () => {
    expect(await read<Hex[]>(c, w.factory, agateFactoryAbi as Abi, "gpuIds")).toEqual([H100, H200, B200]);
    // every one of the six has a final anchor on the index
    for (const [g, v] of [[H100, 3_600_000n], [H200, 4_200_000n], [B200, 5_000_000n], [B300, 8_710_000n], [A100, 2_700_000n], [L40S, 1_560_000n]] as const) await putDay(w, g, EPOCH_DAY, v);
    await c.warp(finalAt(w, EPOCH_DAY) + 1n);
    const r = await (await app()).tick();
    expect(r.lister!.listed).toEqual(["demo H100 2026-10", "demo H100 2026-11", "demo H200 2026-10", "demo H200 2026-11", "demo B200 2026-10", "demo B200 2026-11"]);
    expect(r.lister!.created.length).toBe(6);
    expect(r.lister!.owed).toEqual([]);
    for (const g of [H100, H200, B200]) for (const m of [OCT, NOV]) expect(await seriesOf(w, g, m)).not.toBe(ZERO);
    for (const g of [B300, A100, L40S]) for (const m of [OCT, NOV]) expect(await seriesOf(w, g, m)).toBe(ZERO);
    // a second pass owes nothing and sends nothing
    const again = await (await app()).tick();
    expect(again.lister!.listed).toEqual([]);
    expect(again.lister!.owed).toEqual([]);
  }, 300_000);
});
