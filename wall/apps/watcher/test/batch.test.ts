// BUILD-SPEC 12.5 "Fuzz E and plant batch": honest worlds with 1% and 3% transient loss (standby present, the
// guardian at one slice), and plant worlds judged by I28 / I28u against the honest writer, with a negative control (an
// attester that signs every change) that must show violations. Counts default to a CI-sized run; AGATE_FUZZ_WORLDS,
// AGATE_PLANT_WORLDS and AGATE_CONTROL_WORLDS scale them to the spec's 60, 1,000 and 300.
import { describe, expect, test } from "bun:test";
import { randomWorld, type Strategy } from "../src/sim/random-world.ts";
import { World } from "../src/sim/world.ts";

const OCT1 = 20_727;
const N_FUZZ = Number(process.env.AGATE_FUZZ_WORLDS ?? 12);
const N_PLANT = Number(process.env.AGATE_PLANT_WORLDS ?? 40);
const N_CONTROL = Number(process.env.AGATE_CONTROL_WORLDS ?? 12);
const DAYS = 23;

describe("fuzz E: honest worlds with transient loss", () => {
  for (const loss of [0.01, 0.03]) {
    test(`${N_FUZZ} worlds x ${DAYS} days at ${loss * 100}% loss: no drop, veto or suspension; every day final within LAG_MAX`, async () => {
      let drops = 0;
      let vetoes = 0;
      let suspensions = 0;
      const lags: number[] = [];
      const late: string[] = [];
      for (let s = 1; s <= N_FUZZ; s++) {
        const rw = randomWorld(500 + s, { days: DAYS, firstDay: OCT1, loss, thief: false, guardian: true });
        const w = new World(rw.options);
        await w.run((OCT1 + DAYS) * w.c.day + w.c.lagMax);
        drops += w.drops().length;
        vetoes += w.vetoes();
        suspensions += w.suspensions();
        for (const r of w.days(OCT1, OCT1 + DAYS - 1)) {
          lags.push(r.lag);
          if (!r.final || r.lag > w.c.lagMax) late.push(`seed ${500 + s} day ${r.day - OCT1}: ${rw.notes.join(", ")}`);
        }
      }
      lags.sort((a, b) => a - b);
      console.log(`fuzz E ${loss * 100}%: ${N_FUZZ} worlds, drops ${drops}, vetoes ${vetoes}, suspensions ${suspensions}, lag p50 ${lags[lags.length >> 1]} p99 ${lags[Math.floor(lags.length * 0.99)]} max ${lags.at(-1)}`);
      expect([drops, vetoes, suspensions]).toEqual([0, 0, 0]);
      expect(late).toEqual([]);
    }, 600_000);
  }
});

async function plantRun(seed: number, careless: boolean) {
  const strategies: Strategy[] = ["plant", "freeze", "garbage", "withhold"];
  const rw = randomWorld(seed, { days: DAYS, firstDay: OCT1, loss: 0.01, thief: true, guardian: false, strategy: strategies[seed % strategies.length]!, thiefWriter: 0, careless });
  const w = new World(rw.options);
  await w.run((OCT1 + DAYS) * w.c.day + w.c.lagMax);
  return { rw, i28: w.i28(0) };
}

describe("plant batch: I28 / I28u against the honest standby", () => {
  test(`${N_PLANT} plant worlds: no violation; thief values final only as stated residuals`, async () => {
    const tot = { exact: 0, shade: 0, residual: 0, violation: 0 };
    const bad: string[] = [];
    for (let s = 1; s <= N_PLANT; s++) {
      const { rw, i28 } = await plantRun(2_000 + s, false);
      tot.exact += i28.exact;
      tot.shade += i28.shade;
      tot.residual += i28.residual;
      tot.violation += i28.violation;
      if (i28.violation > 0) bad.push(`seed ${2_000 + s} ${rw.strategy}: ${i28.days.join("; ")} [${rw.notes.join(", ")}]`);
    }
    console.log(`plant batch: ${N_PLANT} worlds; thief-sourced final days: exact ${tot.exact}, shade (residual 11) ${tot.shade}, other residuals ${tot.residual}, violations ${tot.violation}`);
    expect(bad).toEqual([]);
  }, 900_000);

  test(`negative control: ${N_CONTROL} worlds with an attester that signs every change show violations`, async () => {
    let violations = 0;
    for (let s = 1; s <= N_CONTROL; s++) violations += (await plantRun(2_000 + s, true)).i28.violation;
    console.log(`control: ${N_CONTROL} worlds, violations ${violations}`);
    expect(violations).toBeGreaterThan(0);
  }, 600_000);
});
