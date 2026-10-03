// Audit (bot money and risk lens): the market maker and the shared MarketSender, probed where the existing
// tests stopped. The audit round asserted the behaviour it found; the fix round flipped each assertion to the fixed
// behaviour (Oct 3). Fakes and one local HTTP endpoint only: no chain, no Keychain, no network; the one
// key is generated here and never printed.
import { afterEach, describe, expect, test } from "bun:test";
import { type Abi, type Address, type Hex, keccak256, parseEther, toBytes } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { RpcPool } from "@agate/watcher";
import { BROADCAST_UNCONFIRMED, kuruOrderBookAbi, LimitTable, MarketSender, type SendResult, type SendSpec, U } from "@agate/market";
import { C, DAY, F, H100, makerBook, MONTH, REF, type Rig, rig, START_DAY } from "../helpers.ts";

let r: Rig;
afterEach(() => r?.cleanup());
const T = 10_000n; // Kuru size units per token
const lc = (a: string) => a.toLowerCase();
const openCodes = (x: Rig): string[] => x.alerts.open().map((a) => a.code as string);

describe("AUDIT M-H1 (fixed): a newer index value that is public but not final widens the band at once", () => {
  test("a closed-but-pending day 40 cents up: every ask moves above 4.00 in the same tick; a taker who read it gains nothing", async () => {
    r = rig({ config: { staleS: 864_000 } });
    await r.tick(); // 3.56 / 3.64 around fair 3.60
    r.w.t += BigInt(DAY);
    // yesterday is closed and its value is on chain, but still pending (T_PEND: 210 s demo, 6 h production)
    r.ix.put(H100, r.today() - 1, 4_000_000n, false);
    await r.tick();
    // FIXED: fair stays on the final 3.60, the band is [3.60, 4.00]: asks over 4.00 + h, bids under 3.60 - h
    expect(r.mm.report.decisions[0]!.d).toMatchObject({ act: "requote", cond: 2, urgent: true });
    const b = makerBook(r);
    expect(b.asks.map((a) => a[0])).toEqual([4_040_000n, 4_050_000n, 4_060_000n]);
    expect(b.bids.map((x) => x[0])).toEqual([3_560_000n, 3_550_000n, 3_540_000n]);
    r.w.tx(() => r.k.takerBuy(r.user, 7_000n * T)); // anyone who read the pending record buys every ask...
    r.ix.put(H100, r.today() - 1, 4_000_000n, true); // ...and it becomes final
    await r.tick();
    // sold at 4.04 to 4.06, worth 4.00: the maker is up, not down $2,420
    expect(r.mm.report.pnl!).toBeGreaterThan(0n);
  });

  test("an ended day the wall has not closed yet: index.previewFix widens the band the same way", async () => {
    r = rig({ config: { staleS: 864_000 } });
    await r.tick();
    r.w.t += BigInt(DAY);
    // yesterday ended; the wall has not closed it (head = yesterday), previewFix already shows 4.00
    r.ix.data.head = r.today() - 1;
    r.ix.setPreview(H100, 4_000_000n);
    await r.tick();
    expect(makerBook(r).asks.every(([p]) => p > 4_000_000n)).toBe(true);
    // a running head day (head = today) is not used: its readings may still move
    r.ix.data.head = r.today();
    r.ix.put(H100, r.today() - 1, 3_600_000n, true);
    r.ix.setPreview(H100, 5_000_000n);
    await r.tick();
    expect(makerBook(r).asks[0]![0]).toBe(3_640_000n); // back to the plain ladder around 3.60 (condition 3)
  });

  test("once the newer value is final the band collapses: one requote around the new fair, then nothing", async () => {
    r = rig({ config: { staleS: 864_000 } });
    await r.tick();
    r.w.t += BigInt(DAY);
    r.ix.put(H100, r.today() - 1, 3_700_000n, false);
    await r.tick(); // band [3.60, 3.70]
    r.ix.put(H100, r.today() - 1, 3_700_000n, true);
    await r.tick(); // fair 3.70
    const b = makerBook(r);
    expect(b.bids.map((x) => x[0])).toEqual([3_660_000n, 3_650_000n, 3_640_000n]);
    expect(b.asks.map((x) => x[0])).toEqual([3_740_000n, 3_750_000n, 3_760_000n]);
    const n = r.sender.nonce;
    await r.tick();
    expect(r.sender.nonce).toBe(n);
  });
});

describe("AUDIT M-M1 (fixed): the inventory gate cuts each side to the room left", () => {
  test("maxNetTokens 1,500 and 3,000 tokens a side: the side rests only 1,500, so one taker order leaves |E| at the cap", async () => {
    r = rig({ config: { maxNetTokens: 1_500, sizesTokens: [1000, 1000, 1000] } });
    await r.tick();
    expect(makerBook(r).asks.reduce((s, a) => s + a[1], 0n)).toBe(1_500n * T);
    expect(makerBook(r).bids.reduce((s, b) => s + b[1], 0n)).toBe(1_500n * T);
    r.w.tx(() => r.k.takerBuy(r.user, 3_000n * T));
    const tokens = r.w.balanceOf(r.s.token, r.maker) + r.w.margin(r.maker, r.s.token);
    // FIXED: E = -1,500 tokens, exactly the cap (was -3,000, twice the cap)
    expect(tokens - r.s.shortOf(r.maker)).toBe(-1_500n * U);
    await r.tick();
    expect(makerBook(r).asks).toEqual([]); // no room left on the ask side
    expect(makerBook(r).bids.length).toBeGreaterThan(0); // the bids stay (their room is now 3,000)
    expect(openCodes(r)).toContain("MM_INVENTORY_CAP");
  });
});

describe("AUDIT M-M2 (fixed): a fair move through the quotes is a requote under the day's budget; only its cancel is safety", () => {
  test("a 10-cent move on a day whose budget is ~0: only the three crossed asks are cancelled (safety); nothing is placed", async () => {
    r = rig();
    await r.tick();
    r.w.t += BigInt(DAY);
    r.w.setMon(r.maker, parseEther("20.01")); // the same nearly-zero budget as the existing test, where 2 cents waits
    r.ix.put(H100, r.today() - 1, 3_700_000n);
    const from = r.sender.log.length;
    await r.tick();
    const sent = r.sender.log.slice(from).filter((x) => x.result.ok);
    // FIXED: one landed send, the safety cancel of the asks at 3.64 / 3.65 / 3.66 (the bids are under 3.70 and stay)
    expect(sent.map((x) => [x.spec.functionName, x.spec.adds, x.spec.cancels, x.spec.safety])).toEqual([["batchUpdate", 0, 3, true]]);
    expect(makerBook(r).asks).toEqual([]);
    expect(makerBook(r).bids.map((x) => x[0])).toEqual([3_560_000n, 3_550_000n, 3_540_000n]);
    const day = r.budget.today!;
    expect(day.spentWei - day.safetyWei <= day.budgetWei).toBe(true); // the non-safety spend kept to the budget
    // the next day has a budget again: the re-placement goes out as an ordinary requote
    r.w.setMon(r.maker, parseEther("200"));
    r.w.t += BigInt(DAY);
    r.ix.put(H100, r.today() - 1, 3_700_000n);
    await r.tick();
    const last = r.sender.log.filter((x) => x.spec.functionName === "batchUpdate").at(-1)!;
    expect(last.result.ok).toBe(true);
    expect(last.spec.safety).toBe(false);
    expect(makerBook(r).asks.map((a) => a[0])).toEqual([3_740_000n, 3_750_000n, 3_760_000n]);
  });

  test("with a budget, a move through the quotes is one ordinary batch (cancel and re-place), not a safety send", async () => {
    r = rig();
    await r.tick();
    r.w.t += BigInt(DAY);
    r.ix.put(H100, r.today() - 1, 3_700_000n);
    const from = r.sender.log.length;
    await r.tick();
    const sent = r.sender.log.slice(from).filter((x) => x.result.ok);
    expect(sent.every((x) => x.spec.safety !== true)).toBe(true);
    expect(sent.filter((x) => x.spec.functionName === "batchUpdate").map((x) => [x.spec.adds, x.spec.cancels])).toEqual([[6, 6]]);
    expect(r.budget.today!.safetyWei).toBe(0n);
  });
});

describe("AUDIT M-H2 (fixed): the maker's settle keeps the D1 hold", () => {
  test("every day overdue and previewSync at N while the wall's head is at day 25 of 30: no settle, MM_FORCE_HELD; once the wall has closed them, it settles", async () => {
    r = rig();
    await r.tick(); // holds 7,000 pairs in the series
    const endTs = BigInt((START_DAY + 30) * DAY);
    r.w.t = endTs + r.s.terms.lastResort + 1n; // days 26 to 30 past their last resort
    r.s.setPreview(30, 30n * REF); // previewSync: 25 final days + 5 a sync would FORCE
    r.ix.data.head = START_DAY + 25; // the wall has closed up to day 25 only (catching up)
    await r.tick();
    // FIXED: nothing settled, the hold raised
    expect(r.sender.log.filter((x) => x.spec.functionName === "settle").length).toBe(0);
    expect(openCodes(r)).toContain("MM_FORCE_HELD");
    // the wall closes the last five days and they are final: the settle goes out and the hold clears
    r.ix.data.head = START_DAY + 30;
    for (let d = START_DAY; d < START_DAY + 30; d++) r.ix.put(H100, d, REF, true);
    await r.tick();
    expect(r.sender.log.filter((x) => x.spec.functionName === "settle" && x.result.ok).length).toBe(2);
    expect(openCodes(r)).not.toContain("MM_FORCE_HELD");
  });

  test("a closed day still pending finality past its last resort is held too", async () => {
    r = rig();
    await r.tick();
    const endTs = BigInt((START_DAY + 30) * DAY);
    r.w.t = endTs + r.s.terms.lastResort + 1n;
    r.s.setPreview(30, 30n * REF);
    r.ix.data.head = START_DAY + 30; // every day closed...
    for (let d = START_DAY; d < START_DAY + 30; d++) r.ix.put(H100, d, REF, d !== START_DAY + 29); // ...the last pending
    await r.tick();
    expect(r.sender.log.filter((x) => x.spec.functionName === "settle").length).toBe(0);
    expect(openCodes(r)).toContain("MM_FORCE_HELD");
  });
});

describe("AUDIT M-M3 (fixed): a batch whose broadcast outcome is unknown is never forgotten", () => {
  function server(answer: "timeout" | "refused") {
    const raws: string[] = [];
    const s = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const b = (await req.json()) as { id: number; method: string; params: unknown[] };
        const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: b.id, result });
        switch (b.method) {
          case "eth_chainId":
            return ok("0x279f");
          case "eth_call":
            return ok("0x");
          case "eth_estimateGas":
            return ok("0x7a120"); // 500,000
          case "eth_maxPriorityFeePerGas":
            return ok("0x3b9aca00");
          case "eth_getBlockByNumber":
            return ok({ number: "0x3e8", hash: `0x${"1".padStart(64, "0")}`, parentHash: `0x${"0".repeat(64)}`, timestamp: "0x7000", baseFeePerGas: "0x174876e800", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: `0x${"0".repeat(40)}`, extraData: "0x", logsBloom: `0x${"0".repeat(512)}`, transactions: [], difficulty: "0x0", nonce: "0x0000000000000000", sha3Uncles: `0x${"0".repeat(64)}`, size: "0x0", stateRoot: `0x${"0".repeat(64)}`, receiptsRoot: `0x${"0".repeat(64)}`, transactionsRoot: `0x${"0".repeat(64)}`, uncles: [], mixHash: `0x${"0".repeat(64)}`, totalDifficulty: "0x0" });
          case "eth_getTransactionCount":
            return ok("0x0");
          case "eth_sendRawTransaction":
            raws.push(b.params[0] as string);
            if (answer === "refused") return Response.json({ jsonrpc: "2.0", id: b.id, error: { code: -32000, message: "insufficient funds for gas * price + value" } });
            return new Response("upstream timeout", { status: 504 }); // the node took it, the answer never came back
          default:
            return Response.json({ jsonrpc: "2.0", id: b.id, error: { code: -32601, message: "not supported" } });
        }
      },
    });
    return { raws, s };
  }
  async function sendOnce(answer: "timeout" | "refused"): Promise<{ res: SendResult; raws: string[] }> {
    const { raws, s } = server(answer);
    const KEYVAR = "AGATE_AUDIT_MM_KEY";
    process.env[KEYVAR] = generatePrivateKey();
    try {
      const pool = await RpcPool.create({ urls: [`http://127.0.0.1:${s.port}`, `http://localhost:${s.port}`], expectChainId: 10143, timeoutMs: 5_000, staleS: 10 ** 9, role: "audit", now: () => 0 });
      const sender = new MarketSender({ pool, role: "audit", keyEnv: KEYVAR, limits: new LimitTable(), now: () => 0 });
      const market = "0x000000000000000000000000000000000000beef" as Address;
      const res = await sender.send({ to: market, abi: kuruOrderBookAbi as Abi, functionName: "batchUpdate", args: [[3_560_000], [10_000_000n], [3_640_000], [10_000_000n], [], true], shape: "kuru.batchUpdate", adds: 2, cancels: 0, label: "audit" });
      return { res, raws };
    } finally {
      delete process.env[KEYVAR];
      s.stop(true);
    }
  }

  test("MarketSender: every URL failing after the request went out is sent: true (outcome unknown), never sent: false", async () => {
    const { res, raws } = await sendOnce("timeout");
    expect(raws.length).toBe(2); // both URLs took the raw transaction
    expect(res.ok).toBe(false);
    expect(res.sent).toBe(true); // FIXED (was false)
    expect(res.error!.startsWith(BROADCAST_UNCONFIRMED)).toBe(true);
    expect(res.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("MarketSender: a node's own refusal still proves nothing went out (sent: false)", async () => {
    const { res } = await sendOnce("refused");
    expect(res).toMatchObject({ ok: false, sent: false });
    expect(res.error!.startsWith(BROADCAST_UNCONFIRMED)).toBe(false);
  });

  for (const reported of [
    { ok: false, sent: true, error: `${BROADCAST_UNCONFIRMED}: every RPC URL failed: HTTP request failed` },
    { ok: false, sent: false, error: "every RPC URL failed: HTTP request failed" }, // the old sender's answer
  ] as SendResult[]) {
    test(`the maker keeps its pending id scan after a landed batch reported ${reported.sent ? "sent: true (unknown)" : "sent: false"}: no orphan order`, async () => {
      r = rig({ config: { staleS: 864_000 } });
      await r.tick();
      const orig = r.sender.send.bind(r.sender);
      let once = true;
      r.sender.send = async (s: SendSpec): Promise<SendResult> => {
        const res = await orig(s);
        if (once && s.functionName === "batchUpdate" && res.ok) {
          once = false;
          return reported;
        }
        return res;
      };
      r.w.t += BigInt(DAY);
      r.ix.put(H100, r.today() - 1, 3_700_000n); // the requote lands, reported as failed
      await r.tick();
      await r.tick(); // the reconciliation finds the landed ladder from the counter read before it
      r.w.t += BigInt(DAY);
      r.ix.put(H100, r.today() - 1, 4_000_000n); // fair 4.00
      await r.tick();
      const known = new Set((r.mm.state.orders[lc(r.k.address)] ?? []).map((o) => o.id));
      const mine = [...r.k.data.orders].filter(([id, o]) => lc(o.owner) === lc(r.maker) && r.k.status(id) === "ACTIVE");
      // FIXED: no orphan; every ask of the maker rests above fair 4.00
      expect(mine.filter(([id]) => !known.has(id))).toEqual([]);
      expect(mine.filter(([, o]) => !o.isBuy).every(([, o]) => o.price > 4_000_000n)).toBe(true);
      expect(mine.length).toBe(6);
    });
  }
});

describe("AUDIT M-M4 (fixed): one GPU without an index value never switches the loss limit off", () => {
  test("H200's walk finds nothing; H100 moves 40 cents against a 1,000-token short with maxLossU $100: H200 marked at its last fair, the kill engages", async () => {
    r = rig({ config: { maxLossU: 100_000_000, staleS: 864_000 } });
    const H200 = keccak256(toBytes("H200-SXM/on-demand-list/neocloud/v1")) as Hex;
    r.w.list(r.f, H200, MONTH, { startDay: START_DAY, startTs: BigInt(START_DAY * DAY), n: 30, floor: F, cap: C });
    for (let d = r.today() - 41; d <= r.today() - 1; d++) r.ix.put(H200, d, REF, true);
    await r.tick(); // both books quoted, the maker holds pairs in both series
    r.w.tx(() => r.k.takerBuy(r.user, 1_000n * T)); // the maker is short 1,000 H100
    await r.tick();
    for (const key of [...r.ix.data.recs.keys()]) if (key.startsWith(lc(H200))) r.ix.data.recs.delete(key);
    r.w.t += BigInt(DAY);
    r.ix.put(H100, r.today() - 1, 4_000_000n); // the existing loss test: this jump kills at maxLossU $100
    await r.tick();
    // FIXED: the mark is kept (H200 at its last fair), the loss limit engages, every book cancelled
    expect(r.mm.report.value).not.toBe(null);
    expect(r.mm.report.killed).toBe("loss");
    expect(makerBook(r)).toEqual({ bids: [], asks: [] });
    expect(openCodes(r)).toContain("MM_MARK_FALLBACK");
    expect(openCodes(r)).toContain("MM_LOSS_LIMIT");
  });

  test("a series with no index value ever seen is marked at the worst case of [F, C]", async () => {
    r = rig({ config: { staleS: 864_000 } });
    await r.tick();
    r.w.tx(() => r.k.takerBuy(r.user, 1_000n * T)); // net short 1,000 tokens
    await r.tick();
    const v0 = r.mm.report.value!;
    for (const key of [...r.ix.data.recs.keys()]) r.ix.data.recs.delete(key);
    r.mm.state.lastFair = {}; // as after a restart without the state file
    await r.tick();
    // the short 1,000 tokens marked at C: down (C - fair) x 1,000 = (7.20 - 3.60) x 1,000 against the mark at 3.60
    expect(r.mm.report.value).toBe(v0 - 3_600n * U);
    expect(openCodes(r)).toContain("MM_MARK_FALLBACK");
  });
});
