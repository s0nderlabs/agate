// BUILD-SPEC 12.1 I29 (no poison, D1) and I27b as property tests over random honest worlds: an honest complete
// writer whose freshness equals the watcher's class on every slot is STRICT on every day, whatever the watcher saw
// or missed before (gaps, dark spells, transient loss); and no final record takes OUT a slot whose page showed a
// valid price throughout to every writer.
import { expect, test } from "bun:test";
import { Kind } from "@agate/report/types";
import { randomWorld } from "../src/sim/random-world.ts";
import { World } from "../src/sim/world.ts";

const OCT1 = 20_727;
const N = Number(process.env.AGATE_I29_WORLDS ?? 16);

test(`I29 and I27b over ${N} random honest worlds`, async () => {
  let checked = 0;
  let lossy = 0;
  const bad: string[] = [];
  for (let s = 1; s <= N; s++) {
    const rw = randomWorld(3_000 + s, { days: 25, firstDay: OCT1, loss: s % 2 ? 0.03 : 0.01, thief: false, guardian: false, maxGap: 12 });
    if (rw.notes.some((n) => n.startsWith("view split") || n.startsWith("writer block"))) continue;
    const w = new World(rw.options);
    await w.run((OCT1 + 25) * w.c.day + w.c.lagMax);
    const byDay = new Map<number, (typeof w.evaluations)[number]["ev"]>();
    for (const e of w.evaluations) byDay.set(e.ev.day, e.ev);
    for (const [d, ev] of byDay) {
      for (const c of ev.candidates) {
        if (!c.complete) continue;
        const sameFreshness = ev.slots.every((sv) => !sv.readable || sv.cls === "UNKNOWN" || (c.strict.slots[sv.slot]!.counts >= w.c.minReadings) === (sv.cls === "FRESH"));
        if (!sameFreshness) continue;
        checked++;
        // I29 reads "complete" as a reading in every slice of every slot it reads fresh; an honest writer that lost a
        // few readings to transient failures is judged on its own slices (FIX-OK, HF-2, F4) and must still be tier 2
        const everySlice = c.strict.slots.every((x) => x.cls === null || x.counts < w.c.minReadings || x.counts === w.c.slices);
        if (!everySlice) {
          lossy++;
          if (c.tier < 2) bad.push(`seed ${3_000 + s} day ${d - OCT1} ${c.source.slice(0, 6)} (lossy): tier ${c.tier} ${c.fixOk.why.slice(0, 3).join("; ")} [${rw.notes.join(", ")}]`);
          continue;
        }
        if (c.tier !== 3) bad.push(`seed ${3_000 + s} day ${d - OCT1} ${c.source.slice(0, 6)}: tier ${c.tier} ${c.strict.why.slice(0, 3).join("; ")} [${rw.notes.join(", ")}]`);
      }
    }
    // I27b: a final record never takes OUT a slot whose page was VALID for every writer all day
    const g = w.m.g(w.panel.gpuId);
    for (const [d, r] of g.records) {
      if (r.carried || !w.m.isFinal(r, w.now)) continue;
      for (let i = 0; i < w.n; i++) {
        if (r.kinds[i] !== Kind.OUT) continue;
        let validAll = true;
        for (let t = w.dayStart(d); t < w.dayEnd(d) && validAll; t += Math.floor(w.c.slice / 4)) {
          for (const net of ["w1", "w2"]) if (rw.options.pages(i, t, net).s !== "V") validAll = false;
        }
        if (validAll) bad.push(`I27b seed ${3_000 + s} day ${d - OCT1} slot ${i} OUT while its page was valid all day`);
      }
    }
  }
  console.log(`I29: ${checked} complete honest candidates with the watcher's freshness checked (${lossy} with transient losses, held to FIX-OK)`);
  expect(checked).toBeGreaterThan(100);
  expect(bad).toEqual([]);
}, 600_000);
