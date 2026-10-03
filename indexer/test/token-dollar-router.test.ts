// AgateToken Transfer (balances, mint and burn), AgateDollar Transfer and Dripped, AgateRouter Routed.
import { createTestIndexer } from "envio";
import { describe, expect, it } from "vitest";
import { SEP20, demoTs, listed } from "./build.ts";
import { ev } from "./ev.ts";
import { DEMO, DOLLAR, U, ZERO, series, token, user } from "./world.ts";

type TI = ReturnType<typeof createTestIndexer>;
const run = (indexer: TI, simulate: unknown[]) => indexer.process({ chains: { 10143: { simulate: simulate as never } } });
const t0 = demoTs(SEP20) + 50;

describe("AgateToken Transfer", () => {
  it("a mint, a transfer and a burn: balances, token and series supply; the zero address is no account", async () => {
    const i = createTestIndexer();
    const tr = (from: string, to: string, value: bigint, block: number) => ev("AgateToken", "Transfer", { from, to, value }, { src: token(1), block, ts: t0 + block });
    await run(i, [
      listed({ series: series(1), token: token(1), block: 100 }),
      tr(ZERO, user(1), 10n * U, 101),
      tr(user(1), user(2), 4n * U, 102),
      tr(user(2), user(2), 1n * U, 103), // to oneself
      tr(user(2), ZERO, 3n * U, 104),
    ]);
    expect((await i.TokenBalance.getOrThrow(`${token(1)}-${user(1)}`)).balance).toBe(6n * U);
    expect(await i.TokenBalance.getOrThrow(`${token(1)}-${user(2)}`)).toMatchObject({ balance: 1n * U, series_id: series(1), token_id: token(1), account_id: user(2) });
    expect((await i.Token.getOrThrow(token(1))).supply).toBe(7n * U);
    expect((await i.Series.getOrThrow(series(1))).tokenSupply).toBe(7n * U);
    expect(await i.Account.get(ZERO)).toBeUndefined();
    expect((await i.TokenBalance.getAll()).length).toBe(2);
  });
});

describe("AgateDollar", () => {
  it("Transfer moves balances; Dripped adds a row and the account's next drip", async () => {
    const i = createTestIndexer();
    const tr = (from: string, to: string, value: bigint, block: number) => ev("AgateDollar", "Transfer", { from, to, value }, { src: DOLLAR, block, ts: t0 + block });
    await run(i, [
      tr(ZERO, user(1), 10_000n * U, 100),
      ev("AgateDollar", "Dripped", { to: user(1), amount: 10_000n * U, nextAt: BigInt(t0 + 86_500) }, { src: DOLLAR, block: 100, ts: t0 + 100 }),
      tr(user(1), user(2), 2_500n * U, 101),
    ]);
    expect((await i.DollarBalance.getOrThrow(`${DOLLAR}-${user(1)}`)).balance).toBe(7_500n * U);
    expect(await i.DollarBalance.getOrThrow(`${DOLLAR}-${user(2)}`)).toMatchObject({ balance: 2_500n * U, dollar: DOLLAR });
    expect((await i.Drip.getAll())[0]).toMatchObject({ account_id: user(1), amount: 10_000n * U, nextAt: BigInt(t0 + 86_500) });
    expect((await i.Account.getOrThrow(user(1))).nextDripAt).toBe(BigInt(t0 + 86_500));
  });
});

describe("AgateRouter Routed", () => {
  it("one row per click with net = dollarsOut - dollarsIn (negative for a buy) and the position ids", async () => {
    const i = createTestIndexer();
    await run(i, [
      listed({ series: series(1), token: token(1), block: 100 }),
      ev(
        "AgateRouter",
        "Routed",
        { user: user(1), series: series(1), flow: 1, tokens: 120n * U, dollarsIn: 250n * U, dollarsOut: 13n * U, refund: 1n * U, tokensIn: 0n, tokensOut: 0n, positionIds: [5n, 6n, 7n, 8n] },
        { src: DEMO.router, block: 101, ts: t0 + 101, tx: `0x${"ab".repeat(32)}` },
      ),
      ev(
        "AgateRouter",
        "Routed",
        { user: user(1), series: series(1), flow: 3, tokens: 10n * U, dollarsIn: 0n, dollarsOut: 19n * U, refund: 0n, tokensIn: 10n * U, tokensOut: 0n, positionIds: [] },
        { src: DEMO.router, block: 102, ts: t0 + 102 },
      ),
    ]);
    const flows = (await i.RouterFlow.getAll()).sort((a, b) => Number(a.block - b.block));
    expect(flows[0]).toMatchObject({ router: DEMO.router, user_id: user(1), series_id: series(1), flow: "OPEN_LONG_DAILY", net: -237n * U, positionIds: [5n, 6n, 7n, 8n], txHash: `0x${"ab".repeat(32)}` });
    expect(flows[1]).toMatchObject({ flow: "CLOSE_LONG", net: 19n * U, tokensIn: 10n * U, positionIds: [] });
  });
});
