// Adversarial: getWallet's entry prices on a fake chain and a fake indexer (no network). The held-tokens entry and
// the short-balance entry are volume-weighted over the user's trades; these cases check which trades count.
// Scenario (one listed series, H100 Nov 2026):
//   tx A  openLong       the router buys 100 tokens at $4.00 (taker buy, txOrigin = user): they stay in the wallet
//   tx B  openLongDaily  the router buys 50 tokens at $5.00 (taker buy, txOrigin = user): burned into position 1
//   tx C  closeLong      the router sells 20 of the held tokens at $3.00 (taker sell, txOrigin = user)
//   tx D  a limit ask of the user's (10 minted pairs) is lifted at $4.50 (maker = user, taker buy)
// Wallet now: 80 tokens (100 - 20), 10 short units, position 1 (long, 50, daily).
// The held tokens were all bought in tx A, so their entry is $4.00; the short balance's tokens were sold in tx D, so
// its entry is $4.50; position 1's entry is tx B's $5.00.
import { describe, expect, test } from "bun:test";
import type { Hex, PublicClient } from "viem";
import { AgateClient } from "../../src/client.ts";
import { PANELS, TESTNET_DEPLOYMENTS } from "../../src/static.ts";

const USER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const SERIES = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const MARKET = "0x3333333333333333333333333333333333333333";
const H100 = PANELS.find((p) => p.gpu === "H100")!.gpuId as Hex;
const OCT = 2026 * 12 + 9;
const NOV = OCT + 1;
const NOW = 1_791_158_400n; // 2026-10-05T00:00:00Z
const dep = TESTNET_DEPLOYMENTS;
const f = dep.factories.real!;
const lc = (s: string) => s.toLowerCase();

function fakeChain(): PublicClient {
  const emptyBook = `0x${"00".repeat(31)}01${"00".repeat(32)}` as Hex;
  const read = ({ address, functionName, args }: { address: string; functionName: string; args?: readonly unknown[] }): unknown => {
    const a = lc(address);
    switch (functionName) {
      case "currentMonth":
        return OCT;
      case "gpuIds":
        return [H100];
      case "labelOf":
        return "H100";
      case "gpu":
        return { recipeHash: `0x${"00".repeat(32)}`, nSlots: 6, nFamilies: 6, firstDay: 20730, registeredAt: 0n, lastCarryAt: 0n, head: 20731 };
      case "seriesOf":
        return Number(args?.[1]) === NOV ? SERIES : "0x0000000000000000000000000000000000000000";
      case "terms":
        return { gpuId: H100, month: NOV, startDay: 20758, n: 30, startTs: 1_793_491_200n, day: 86_400, floor: 1_950_000, cap: 8_000_000 };
      case "token":
        return TOKEN;
      case "name":
        return "agate H100 Nov 2026";
      case "symbol":
        return "H100-NOV26";
      case "marketOf":
        return [MARKET, 1];
      case "previewSync":
        return [0, 0n];
      case "state":
        return [0, 0n, 0, false, false, 0n, 2n, 10_000_000n];
      case "totalSupply":
        return 90_000_000n;
      case "getL2Book":
        return emptyBook;
      case "balanceOf":
        if (a === lc(f.dollar)) return 1_000_000_000n;
        if (a === TOKEN) return 80_000_000n;
        throw new Error(`balanceOf at ${a}`);
      case "nextDripAt":
        return 0n;
      case "dripPeriod":
        return 86_400n;
      case "getBalance":
        return 0n;
      case "shortOf":
        return 10_000_000n;
      case "position":
        if (BigInt(args?.[0] as bigint) === 1n) return { owner: USER, side: 0, daily: true, openedK: 0, payee: USER, q: 50_000_000n, operator: f.router, paid: 0n };
        return { owner: "0x0000000000000000000000000000000000000000", side: 0, daily: false, openedK: 0, payee: "0x0000000000000000000000000000000000000000", q: 0n, operator: "0x0000000000000000000000000000000000000000", paid: 0n };
      case "claimable":
        return 0n;
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  };
  return {
    getCode: async () => undefined, // no Multicall3: the client reads call by call
    readContract: async (r: { address: string; functionName: string; args?: readonly unknown[] }) => read(r),
    getBlock: async () => ({ timestamp: NOW }),
    getBalance: async () => 10n ** 18n,
  } as unknown as PublicClient;
}

const trade = (id: string, tx: string, price: number, tokens: number, takerIsBuy: boolean, maker: string, txOrigin: string) => ({
  id,
  block: id.split("-")[0],
  timestamp: String(Number(NOW) - 3600 + Number(id.split("-")[0])),
  priceU: String(price),
  tokens: String(tokens),
  takerIsBuy,
  maker,
  taker: f.router.toLowerCase(),
  txOrigin,
  txHash: tx,
  series_id: SERIES,
});
const BOT = "0x9a410e49a53115e85b751fe8d3b589bb8f1a717f";
const STRANGER = "0x00000000000000000000000000000000000000aa";

function fakeIndexer(): typeof fetch {
  const data = {
    Position: [{ id: `${SERIES}-1`, positionId: "1", openedAt: String(NOW - 3000n), series_id: SERIES, side: "LONG", q: "50000000", status: "OPEN" }],
    RouterFlow: [
      { flow: "OPEN_LONG", series_id: SERIES, tokens: "100000000", dollarsIn: "400000000", dollarsOut: "0", refund: "0", positionIds: [], txHash: "0xa", timestamp: "1" },
      { flow: "OPEN_LONG_DAILY", series_id: SERIES, tokens: "50000000", dollarsIn: "250000000", dollarsOut: "0", refund: "0", positionIds: ["1"], txHash: "0xb", timestamp: "2" },
      { flow: "CLOSE_LONG", series_id: SERIES, tokens: "20000000", dollarsIn: "0", dollarsOut: "60000000", refund: "0", positionIds: [], txHash: "0xc", timestamp: "3" },
    ],
    Trade: [
      trade("10-0", "0xa", 4_000_000, 100_000_000, true, BOT, USER),
      trade("11-0", "0xb", 5_000_000, 50_000_000, true, BOT, USER),
      trade("12-0", "0xc", 3_000_000, 20_000_000, false, BOT, USER),
      trade("13-0", "0xd", 4_500_000, 10_000_000, true, USER, STRANGER),
    ],
  };
  return (async (_url: string, init: { body: string }) => {
    const q = (JSON.parse(init.body) as { query: string }).query;
    const out = q.includes("query Wallet") ? data : q.includes("s0: Position") ? { s0: [{ positionId: "1" }] } : null;
    if (!out) throw new Error(`unexpected query ${q.slice(0, 60)}`);
    return new Response(JSON.stringify({ data: out }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("getWallet entry prices (adversarial)", () => {
  const c = new AgateClient({ publicClient: fakeChain(), fetch: fakeIndexer(), graphqlUrl: "http://fake/v1/graphql" });

  test("the pay-me-daily position's entry is its own flow's price", async () => {
    const w = await c.getWallet(USER);
    const p = w.positions.find((x) => x.kind === "position")!;
    expect(p.q).toBe(50);
    expect(p.entry).toBe(5);
  });

  test("held tokens: only the buys whose tokens stayed in the wallet count (expected $4.00)", async () => {
    const w = await c.getWallet(USER);
    const t = w.positions.find((x) => x.kind === "tokens")!;
    expect(t.q).toBe(80);
    expect(t.entry).toBe(4);
  });

  test("short balance: only the sales of minted tokens count, not the sale of bought tokens (expected $4.50)", async () => {
    const w = await c.getWallet(USER);
    const s = w.positions.find((x) => x.kind === "shortBalance")!;
    expect(s.q).toBe(10);
    expect(s.entry).toBe(4.5);
  });
});
