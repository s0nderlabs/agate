// The README's GraphQL queries (BOTS-SPEC 5.8), parsed from README.md and run once against the local replay plus a
// few index days, every field checked against schema.graphql.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestIndexer } from "envio";
import { beforeAll, describe, expect, it } from "vitest";
import { ev, type RawLog } from "./ev.ts";
import { type Data, parse, readSchema, run } from "./gql.ts";
import { itemsFromLogs } from "./replay.ts";
import { DEMO, H100, deployments, user } from "./world.ts";

const ROOT = join(import.meta.dirname, "..");
const schemaSrc = readFileSync(join(ROOT, "schema.graphql"), "utf8");
const schema = readSchema(schemaSrc);
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const block = readme.slice(readme.indexOf("```graphql\n") + 11, readme.indexOf("```\n", readme.indexOf("```graphql\n") + 11));
const queries = Object.fromEntries(parse(block).map((q) => [q.name, q]));
const fixture = JSON.parse(readFileSync(join(ROOT, "test/fixtures/local-lifecycle.json"), "utf8")) as { logs: RawLog[] };

let data: Data;

beforeAll(async () => {
  const indexer = createTestIndexer();
  const items: unknown[] = itemsFromLogs(deployments, fixture.logs);
  const last = fixture.logs[fixture.logs.length - 1]!;
  let b = last.blockNumber + 10;
  let t = last.timestamp + 10;
  const day0 = 20_757; // index days on the demo index, after the replay
  for (let d = day0; d < day0 + 4; d++) {
    items.push(
      ev(
        "AgateIndex",
        "DayClosed",
        { gpuId: H100, day: d, source: user(1), value: 2_000_000 + (d - day0) * 10_000, status: 1, fresh: 5, held: 0, freshMedian: 2_000_000, changed: false, needsSign: d === day0 + 3, late: false, incomplete: false, digest: `0x${"d1".repeat(32)}` },
        { src: DEMO.index, block: b++, ts: (t += 600) },
      ),
    );
  }
  // two open positions on the November series: one owned by user 4, one only paying user 4
  const nov = (items as { event: string; params: Record<string, unknown> }[]).find((x) => x.event === "SeriesListed" && x.params.symbol === "dH100-NOV26")!.params.series as string;
  for (const [id, owner] of [[1, user(4)], [2, user(5)]] as const) {
    items.push(ev("AgateSeries", "PositionOpened", { id, owner, payee: user(4), side: id - 1, q: 5_000_000n, paidNow: 0n, operator: "0x0000000000000000000000000000000000000000", daily: true, k: 0, to: owner }, { src: nov, block: b++, ts: (t += 10) }));
  }
  items.push(ev("AgateIndex", "Vetoed", { gpuId: H100, day: day0 + 3, by: user(9), source: user(1), digest: `0x${"d1".repeat(32)}`, value: 2_030_000 }, { src: DEMO.index, block: b++, ts: (t += 10) }));
  await indexer.process({ chains: { 10143: { simulate: items as never } } });
  data = {};
  for (const name of schema.entities.keys()) data[name] = (await (indexer as unknown as Record<string, { getAll: () => Promise<Record<string, unknown>[]> }>)[name]!.getAll()) as Data[string];
}, 120_000);

describe("README queries", () => {
  it("the README carries the four queries of the spec", () => {
    expect(Object.keys(queries).sort()).toEqual(["Chart", "Forward", "History", "Me"]);
  });

  it("Forward: one GPU's curve, its months in order, each with its series", () => {
    const r = run(schema, data, queries.Forward!, { gpu: H100, factory: DEMO.factory });
    expect(r.MarketForward!.length).toBe(1);
    const f = r.MarketForward![0]!;
    expect(f.label).toBe("H100");
    const pts = f.points as Record<string, unknown>[];
    expect(pts.map((p) => p.monthLabel)).toEqual(["2026-10", "2026-11"]);
    expect((pts[0]!.series as Record<string, unknown>).symbol).toBe("dH100-OCT26");
    expect(pts.every((p) => p.markSource === "TRADE")).toBe(true);
    expect([f.nearMarkU, f.nextMarkU]).toEqual([pts[0]!.markU, pts[1]!.markU]);
  });

  it("Me: holdings with their marks, open positions, and router clicks newest first", () => {
    const users = new Set((data.RouterFlow ?? []).map((f) => f.user_id as string));
    const a = [...users].find((u) => (data.TokenBalance ?? []).some((b) => b.account_id === u && (b.balance as bigint) > 0n))!;
    const r = run(schema, data, queries.Me!, { a });
    expect(r.TokenBalance!.length).toBeGreaterThan(0);
    for (const b of r.TokenBalance!) {
      expect(b.balance as bigint).toBeGreaterThan(0n);
      expect(((b.series as Record<string, unknown>).pricePoint as Record<string, unknown>).markU).toBeDefined();
    }
    const blocks = r.RouterFlow!.map((f) => f.timestamp as bigint);
    expect(blocks.length).toBeGreaterThan(0);
    expect([...blocks].sort((x, y) => (x > y ? -1 : x < y ? 1 : 0))).toEqual(blocks);
    expect(r.Position).toEqual([]); // every October position was claimed to the end
    const mine = run(schema, data, queries.Me!, { a: user(4) });
    expect(mine.Position!.map((p) => [p.positionId, p.side, p.payee_id, p.operator_id, (p.series as Record<string, unknown>).symbol])).toEqual([
      [1n, "LONG", user(4), null, "dH100-NOV26"],
      [2n, "SHORT", user(4), null, "dH100-NOV26"],
    ]);
  });

  it("History: index days newest first with their state", () => {
    const r = run(schema, data, queries.History!, { index: DEMO.index, gpu: H100 });
    expect(r.DailyFix!.map((d) => [d.day, d.state])).toEqual([
      [20_760, "VETOED"],
      [20_759, "PENDING"],
      [20_758, "PENDING"],
      [20_757, "PENDING"],
    ]);
    expect(r.DailyFix![3]!.date).toBe("2026-10-31");
  });

  it("Chart: a month's candles in order and its last 20 trades", () => {
    const oct = (data.Series ?? []).find((s) => s.symbol === "dH100-OCT26")!.id as string;
    const r = run(schema, data, queries.Chart!, { series: oct });
    const days = r.DailyCandle!.map((c) => c.dayId as number);
    expect(days.length).toBeGreaterThan(1);
    expect([...days].sort((x, y) => x - y)).toEqual(days);
    expect(r.Trade!.length).toBeLessThanOrEqual(20);
    expect(r.Trade!.every((t) => (t.priceU as bigint) > 0n)).toBe(true);
  });

  it("the checker refuses a field the schema does not have", () => {
    const [q] = parse("query X($s: String!) { Trade(where: {series_id: {_eq: $s}}) { price } }");
    expect(() => run(schema, data, q!, { s: "x" })).toThrow(/Trade has no field price/);
    const [w] = parse("query Y($s: String!) { Trade(where: {seriesId: {_eq: $s}}) { priceU } }");
    expect(() => run(schema, data, w!, { s: "x" })).toThrow(/Trade.seriesId is not a column/);
  });
});
