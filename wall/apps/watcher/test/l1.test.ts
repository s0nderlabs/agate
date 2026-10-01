// BUILD-SPEC 12.6: the L1 property test (every day final by dayEnd + LAG_MAX with the scripted guardian) and L1b
// (nobody acting: no drop without a prior R1_NO_CANDIDATE, FREEZE_LOOP on every drop). World counts default to a
// CI-sized run; AGATE_L1_WORLDS and AGATE_L1_PROD_WORLDS scale them to the spec's 200 and 50.
import { describe, expect, test } from "bun:test";
import { randomWorld } from "../src/sim/random-world.ts";
import { W_ADDR, World } from "../src/sim/world.ts";

const OCT1 = 20_727;
const N_TEST = Number(process.env.AGATE_L1_WORLDS ?? 24);
const N_PROD = Number(process.env.AGATE_L1_PROD_WORLDS ?? 3);
const DAYS = Number(process.env.AGATE_L1_DAYS ?? 30);

interface Outcome {
  seed: number;
  strategy: string;
  lags: number[];
  late: string[];
  drops: number;
  vetoes: number;
  suspensions: number;
  honestSuspended: number;
  l1b: string[];
  notes: string[];
}

async function runOne(seed: number, guardian: boolean, profile?: { day: number; slices: number }): Promise<Outcome> {
  const rw = randomWorld(seed, { days: DAYS, firstDay: OCT1, loss: seed % 2 === 0 ? 0.01 : 0.03, thief: true, guardian, ...(profile ? { profile } : {}) });
  const w = new World({ ...rw.options, ...(profile ? { step: profile.day / profile.slices / 10 } : {}) });
  const DAY = w.c.day;
  await w.run((OCT1 + DAYS) * DAY + w.c.lagMax);
  const days = w.days(OCT1, OCT1 + DAYS - 1);
  return {
    seed,
    strategy: rw.strategy,
    lags: days.map((r) => r.lag),
    late: days.filter((r) => !r.final || r.lag > w.c.lagMax).map((r) => `day ${r.day - OCT1} final ${r.final} lag ${r.lag}`),
    drops: w.drops().length,
    vetoes: w.vetoes(),
    suspensions: w.suspensions(),
    honestSuspended: w.m.events.filter((e) => e.name === "WriterSuspended" && (rw.thief === null || String(e.args.writer).toLowerCase() !== W_ADDR[rw.thief]!.toLowerCase())).length,
    l1b: w.l1b().why,
    notes: rw.notes,
  };
}

function summary(name: string, xs: Outcome[]): void {
  const lags = xs.flatMap((x) => x.lags).sort((a, b) => a - b);
  const q = (p: number) => lags[Math.min(lags.length - 1, Math.floor(p * lags.length))];
  console.log(
    `${name}: ${xs.length} worlds, ${lags.length} days; lag p50 ${q(0.5)} p90 ${q(0.9)} p99 ${q(0.99)} max ${lags.at(-1)}; drops ${xs.reduce((a, x) => a + x.drops, 0)}, vetoes ${xs.reduce((a, x) => a + x.vetoes, 0)}, suspensions ${xs.reduce((a, x) => a + x.suspensions, 0)} (of an honest writer ${xs.reduce((a, x) => a + x.honestSuspended, 0)})`,
  );
}

describe("L1 and L1b", () => {
  test(`L1 on TEST: ${N_TEST} worlds x ${DAYS} days, the scripted guardian at GUARD_ACT`, async () => {
    const out: Outcome[] = [];
    for (let s = 1; s <= N_TEST; s++) out.push(await runOne(s, true));
    summary("L1 TEST", out);
    const bad = out.filter((x) => x.late.length > 0).map((x) => ({ seed: x.seed, strategy: x.strategy, late: x.late.slice(0, 3), notes: x.notes }));
    expect(bad).toEqual([]);
    expect(out.filter((x) => x.honestSuspended > 0).map((x) => ({ seed: x.seed, notes: x.notes }))).toEqual([]);
  }, 600_000);

  test(`L1 on PRODUCTION (time-warped): ${N_PROD} worlds`, async () => {
    const out: Outcome[] = [];
    for (let s = 1001; s < 1001 + N_PROD; s++) out.push(await runOne(s, true, { day: 86_400, slices: 24 }));
    summary("L1 PRODUCTION", out);
    expect(out.filter((x) => x.late.length > 0).map((x) => ({ seed: x.seed, late: x.late.slice(0, 3), notes: x.notes }))).toEqual([]);
  }, 600_000);

  test(`L1b on TEST: ${N_TEST} worlds with nobody acting`, async () => {
    const out: Outcome[] = [];
    for (let s = 1; s <= N_TEST; s++) out.push(await runOne(s, false));
    summary("L1b TEST", out);
    expect(out.filter((x) => x.l1b.length > 0).map((x) => ({ seed: x.seed, strategy: x.strategy, why: x.l1b.slice(0, 3), notes: x.notes }))).toEqual([]);
  }, 600_000);
});
