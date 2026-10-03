// AgateIndex handlers (both indexes): finality per MS 8.6, the veto, reopen and carry path, RecordReplaced finality,
// skips, owner actions (a tuple argument), reader swaps and suspensions.
import { createTestIndexer } from "envio";
import { describe, expect, it } from "vitest";
import { dayLabel } from "../src/lib/labels.ts";
import { isoOfDay } from "../src/lib/math.ts";
import { ev } from "./ev.ts";
import { DEMO, H100, H200, REAL, ZERO, user } from "./world.ts";

type TI = ReturnType<typeof createTestIndexer>;
const run = (indexer: TI, simulate: unknown[]) => indexer.process({ chains: { 10143: { simulate: simulate as never } } });
const D = 20_727; // an index day (2026-10-01)
const DIG = `0x${"d1".repeat(32)}`;
const DIG2 = `0x${"d2".repeat(32)}`;
let blk = 100;
let t = 1_791_000_000;
const ix = (name: string, args: Record<string, unknown>, o: { index?: string; at?: number; from?: string } = {}) =>
  ev("AgateIndex", name, args, { src: o.index ?? DEMO.index, block: blk++, ts: o.at ?? (t += 10), from: o.from });
const closed = (o: { gpu?: string; day?: number; value?: number; needsSign?: boolean; source?: string; digest?: string; index?: string; at?: number } = {}) =>
  ix(
    "DayClosed",
    {
      gpuId: o.gpu ?? H100,
      day: o.day ?? D,
      source: o.source ?? user(1),
      value: o.value ?? 2_010_000,
      status: 1,
      fresh: 5,
      held: 1,
      freshMedian: 2_000_000,
      changed: o.needsSign ?? false,
      needsSign: o.needsSign ?? false,
      late: false,
      incomplete: true,
      digest: o.digest ?? DIG,
    },
    { index: o.index, at: o.at },
  );
const fix = (i: TI, day = D, gpu = H100, index = DEMO.index) => i.DailyFix.getOrThrow(`${index}-${gpu}-${day}`);

describe("daily fixes", () => {
  it("DayClosed without a countersign: PENDING, final at t + tPend (per index), an audit row", async () => {
    const i = createTestIndexer();
    await run(i, [closed({ at: 1_791_000_100 }), closed({ index: REAL.index, gpu: H200, at: 1_791_000_200 })]);
    const f = await fix(i);
    expect(f).toMatchObject({ index_id: DEMO.index, gpuId: H100, day: D, date: isoOfDay(D), value: 2_010_000n, status: "FULL", fresh: 5, held: 1, freshMedian: 2_000_000n, incomplete: true, source: user(1), digest: DIG, postedAt: 1_791_000_100n, finalAt: 1_791_000_100n + 210n, state: "PENDING" });
    expect((await fix(i, D, H200, REAL.index)).finalAt).toBe(1_791_000_200n + 21_600n);
    expect(dayLabel(f, f.finalAt! - 1n)).toBe("pending");
    expect(dayLabel(f, f.finalAt!)).toBe("final");
    expect((await i.FixEvent.getAll()).map((e) => [e.kind, e.fix_id, e.value, e.source])).toContainEqual(["DayClosed", f.id, 2_010_000n, user(1)]);
    expect(await i.PriceIndex.getOrThrow(REAL.index)).toMatchObject({ tPend: 21_600, names: ["real", "pilot"] });
    expect(await i.Account.get(user(1))).toBeDefined(); // the source writer
  });

  it("needsSign: NEEDS_SIGN until Attested; final at the event's finalAt", async () => {
    const i = createTestIndexer();
    await run(i, [closed({ needsSign: true, at: 1_791_000_100 })]);
    expect(await fix(i)).toMatchObject({ state: "NEEDS_SIGN", finalAt: undefined, needsSign: true });
    expect(dayLabel(await fix(i), 2_000_000_000n)).toBe("pending");
    // attested before postedAt + tPend: final then (IndexDays.attest), so still PENDING now
    await run(i, [ix("Attested", { gpuId: H100, day: D, by: user(8), source: user(1), digest: DIG, finalAt: 1_791_000_310n }, { at: 1_791_000_300 })]);
    expect(await fix(i)).toMatchObject({ state: "PENDING", finalAt: 1_791_000_310n, attestedAt: 1_791_000_300n, attestedBy: user(8) });
  });

  it("RecordReplaced (the attester's select): final at max(postedAt + tPend, now)", async () => {
    const i = createTestIndexer();
    const replaced = (at: number) => ix("RecordReplaced", { gpuId: H100, day: D, by: user(8), oldSource: user(1), newSource: user(2), oldValue: 2_010_000, newValue: 2_020_000, oldDigest: DIG, newDigest: DIG2 }, { at });
    await run(i, [closed({ needsSign: true, at: 1_791_000_100 }), replaced(1_791_000_150)]);
    expect(await fix(i)).toMatchObject({ value: 2_020_000n, source: user(2), digest: DIG2, replaced: true, state: "PENDING", finalAt: 1_791_000_100n + 210n, postedAt: 1_791_000_100n });
    const j = createTestIndexer();
    await run(j, [closed({ needsSign: true, at: 1_791_000_100 }), replaced(1_791_009_000)]);
    expect((await fix(j)).finalAt).toBe(1_791_009_000n);
  });

  it("a veto, the reopened day closed again, dropped, then carried: carried, unverified", async () => {
    const i = createTestIndexer();
    await run(i, [
      closed({ needsSign: true }),
      ix("Vetoed", { gpuId: H100, day: D, by: user(9), source: user(1), digest: DIG, value: 2_010_000 }),
    ]);
    expect(await fix(i)).toMatchObject({ state: "VETOED", finalAt: undefined, vetoed: true, vetoCount: 1 });
    expect(dayLabel(await fix(i), 2_000_000_000n)).toBe("pending");
    await run(i, [closed({ needsSign: true, source: user(2), digest: DIG2, value: 2_030_000 })]);
    expect(await fix(i)).toMatchObject({ state: "NEEDS_SIGN", vetoed: true, vetoCount: 1, source: user(2), value: 2_030_000n });
    await run(i, [
      ix("FixDropped", { gpuId: H100, day: D, source: user(2), value: 2_030_000, digest: DIG2 }),
    ]);
    expect(await fix(i)).toMatchObject({ state: "DROPPED", dropped: true, finalAt: undefined });
    await run(i, [ix("DayCarried", { gpuId: H100, day: D, value: 2_000_000, carryCase: 1, dropped: true, missAdvanced: 3 }, { at: 1_799_000_000 })]);
    const f = await fix(i);
    expect(f).toMatchObject({ state: "CARRIED_UNVERIFIED", status: "CARRIED", value: 2_000_000n, finalAt: 1_799_000_000n, postedAt: 1_799_000_000n, source: undefined, digest: undefined, fresh: 0, dropped: true, vetoed: true });
    expect(dayLabel(f, 1_799_000_000n)).toBe("carried, unverified");
    expect((await i.FixEvent.getAll()).map((e) => e.kind)).toEqual(["DayClosed", "Vetoed", "DayClosed", "FixDropped", "DayCarried"]);
  });

  it("a vetoed day that is carried without a drop is still unverified; a plain carry is carried", async () => {
    const i = createTestIndexer();
    await run(i, [
      closed({ needsSign: true }),
      ix("Vetoed", { gpuId: H100, day: D, by: user(9), source: user(1), digest: DIG, value: 2_010_000 }),
      ix("DayCarried", { gpuId: H100, day: D, value: 2_000_000, carryCase: 2, dropped: false, missAdvanced: 0 }),
      ix("DayCarried", { gpuId: H100, day: D + 1, value: 2_000_000, carryCase: 2, dropped: false, missAdvanced: 1 }),
    ]);
    expect((await fix(i)).state).toBe("CARRIED_UNVERIFIED");
    const plain = await fix(i, D + 1);
    expect(plain).toMatchObject({ state: "CARRIED", vetoed: false, dropped: false });
    expect(dayLabel(plain, plain.finalAt!)).toBe("carried");
  });

  it("DaySkipped: skipped; a day with no row is open", async () => {
    const i = createTestIndexer();
    await run(i, [ix("DaySkipped", { gpuId: H100, day: D, carryCase: 2 })]);
    const f = await fix(i);
    expect(f).toMatchObject({ state: "SKIPPED", finalAt: undefined, value: 0n });
    expect(dayLabel(f, 2_000_000_000n)).toBe("skipped");
    expect(dayLabel(await i.DailyFix.get(`${DEMO.index}-${H100}-${D + 1}`), 2_000_000_000n)).toBe("open");
  });

  it("GpuRegistered and WriterSuspended", async () => {
    const i = createTestIndexer();
    await run(i, [
      ix("GpuRegistered", { gpuId: H100, recipeHash: DIG, firstDay: D, family: [0, 0, 1], famQ: [1, 1], liveAtStartMask: 7 }),
      ix("WriterSuspended", { writer: user(1), by: user(9) }),
    ]);
    expect(await i.IndexGpu.getOrThrow(`${DEMO.index}-${H100}`)).toMatchObject({ index_id: DEMO.index, gpuId: H100, recipeHash: DIG, firstDay: D });
    expect((await i.WriterSuspension.getAll())[0]).toMatchObject({ index_id: DEMO.index, writer: user(1), by: user(9) });
  });
});

describe("owner actions and reader swaps", () => {
  it("ActionQueued, ActionExecuted, ActionCancelled (the Action tuple decoded)", async () => {
    const i = createTestIndexer();
    const id1 = `0x${"a1".repeat(32)}`;
    const id2 = `0x${"a2".repeat(32)}`;
    const action = { kind: 4, slot: 2, addr: ZERO, gpuId: H100, day: D, mode: 0 };
    await run(i, [
      ix("ActionQueued", { id: id1, action, eta: 1_800_000_000n }, { at: 1_791_000_000 }),
      ix("ActionQueued", { id: id2, action: { kind: 0, slot: 1, addr: user(5), gpuId: `0x${"00".repeat(32)}`, day: 0, mode: 0 }, eta: 1_800_000_001n }),
      ix("ActionExecuted", { id: id1, action }, { at: 1_800_000_050 }),
      ix("ActionCancelled", { id: id2 }, { at: 1_800_000_060 }),
    ]);
    expect(await i.OwnerAction.getOrThrow(`${DEMO.index}-${id1}`)).toMatchObject({ actionId: id1, kind: 4, slot: 2, gpuId: H100, day: D, mode: 0, eta: 1_800_000_000n, status: "EXECUTED", queuedAt: 1_791_000_000n, executedAt: 1_800_000_050n });
    expect(await i.OwnerAction.getOrThrow(`${DEMO.index}-${id2}`)).toMatchObject({ kind: 0, slot: 1, addr: user(5), status: "CANCELLED", cancelledAt: 1_800_000_060n });
  });

  it("ReaderSwapQueued, ReaderSwapped, ReaderSwapCancelled", async () => {
    const i = createTestIndexer();
    const s1 = `0x${"b1".repeat(32)}`;
    const s2 = `0x${"b2".repeat(32)}`;
    const reader = { gpuId: H100, slot: 3, url: "https://example.com/prices", parserVersion: "lambda/2", reason: "page moved" };
    await run(i, [
      ix("ReaderSwapQueued", { id: s1, ...reader, eta: 1_800_000_000n }),
      ix("ReaderSwapQueued", { id: s2, ...reader, slot: 4, eta: 1_800_000_000n }),
      ix("ReaderSwapped", { id: s1, ...reader, fromDay: D + 3, readerHash: DIG }),
      ix("ReaderSwapCancelled", { id: s2, gpuId: H100, slot: 4 }),
    ]);
    expect(await i.ReaderSwap.getOrThrow(`${DEMO.index}-${s1}`)).toMatchObject({ slot: 3, url: reader.url, parserVersion: "lambda/2", reason: "page moved", fromDay: D + 3, readerHash: DIG, status: "EXECUTED", eta: 1_800_000_000n });
    expect(await i.ReaderSwap.getOrThrow(`${DEMO.index}-${s2}`)).toMatchObject({ slot: 4, status: "CANCELLED" });
  });
});
