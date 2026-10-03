// The market's fork e2e as one test (BOTS-SPEC 6). Opt-in: it forks Monad testnet (the network, read only) and runs
// for several minutes, so it has its own gate: AGATE_MARKET_E2E=1 bun test e2e/test/market-fork.test.ts (from wall/).
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { OUT } from "../src/market/fork.ts";
import { runMarketFork } from "../src/market/scenario.ts";

const on = process.env.AGATE_MARKET_E2E === "1" && Boolean(Bun.which("anvil")) && existsSync(join(OUT, "AgateFactory.sol", "AgateFactory.json"));

describe("market fork e2e", () => {
  test.skipIf(!on)("bots and indexer on one anvil-safe fork of Monad testnet", async () => {
    const rep = await runMarketFork({});
    expect(rep.failed().map((c) => `${c.id} ${c.name}: ${c.detail}`)).toEqual([]);
  }, 3_600_000);
});
