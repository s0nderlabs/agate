// LV-1 (fix round 1, BUILD-SPEC 6.2): the dark-edge span. Slot 2 (the median) is sold out, comes back at its old price
// and is repriced inside one interval (left), or is repriced and then sells out right after the writers' reads
// (right). The writers read the old (left) or new (right) price; the watcher reads the other one. Before the fix the
// span of that slice was the watcher's single value, a closed range no honest reading lay in: nothing could sign the
// day and it dropped 7 DAY later. Every profile, one and two writers, the scripted guardian acting at GUARD_ACT.
import { describe, expect, test } from "bun:test";
import { PROFILES } from "../src/clock.ts";
import { Pages, World } from "../src/sim/world.ts";

const OCT1 = 20_727;
const BASE = [3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000];
const A = 2;

function run(name: keyof typeof PROFILES, side: "left" | "right", writers: 1 | 2) {
  const P = PROFILES[name];
  const S = P.day / P.slices;
  const gap = Math.max(1, Math.floor(P.slices / 8));
  const D = OCT1 + 3;
  const dark = gap + 2; // enough NR intervals before the slice to exhaust the GAP walk
  const sliceAt = (h: number) => D * P.day + h * S; // absolute slice h counted from the start of D
  const kDark = D * P.slices + dark;
  const tStep = sliceAt(dark) + (side === "left" ? S / 2 : S / 4);
  const outage = side === "left"
    ? { slot: A, from: sliceAt(0) - S, to: sliceAt(dark), state: "NR" as const }
    : { slot: A, from: sliceAt(dark) + S / 2, to: sliceAt(2 * dark + 1), state: "NR" as const };
  const pages = new Pages(BASE, [{ slot: A, at: tStep, v: 4_400_000 }], [outage]);
  const readOffset = (d: number, h: number) => (d * P.slices + h === kDark ? (side === "left" ? Math.floor(S / 3) : S / 2 - 1) : undefined);
  const ws = [{ net: "w1", readOffset }, ...(writers === 2 ? [{ net: "w2", readOffset }] : [])];
  const w = new World({
    firstDay: OCT1,
    profile: P,
    pages: pages.fn,
    writers: ws,
    watcherOffset: (slot, k) => (slot === A && k === kDark ? (side === "left" ? Math.floor((3 * S) / 4) : Math.floor(S / 20)) : undefined),
    guardian: { delay: Math.floor(P.day / 4), looks: true },
    step: Math.max(1, Math.floor(S / 20)),
  });
  return { w, D };
}

describe("LV-1 dark edge: honest writers next to a sold-out run are signable (L1)", () => {
  for (const name of ["PRODUCTION", "TEST", "DEMO", "FAST"] as const) {
    for (const side of ["left", "right"] as const) {
      for (const writers of [1, 2] as const) {
        test(`${name} ${side} ${writers} writer${writers === 2 ? "s" : ""}`, async () => {
          const { w, D } = run(name, side, writers);
          await w.run((D + 6) * PROFILES[name].day);
          const days = w.days(OCT1, D + 3);
          const bad = days.filter((x) => !x.final || x.lag > w.c.lagMax);
          expect(bad.map((x) => `${x.day} final ${x.final} lag ${x.lag}`)).toEqual([]);
          expect(days.filter((x) => x.dropped).map((x) => x.day)).toEqual([]);
        }, 120_000);
      }
    }
  }
});
