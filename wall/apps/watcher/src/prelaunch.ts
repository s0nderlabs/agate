// Pre-launch history (Oct 5 2026): the daily prices the index would have recorded on the days before its firstDay,
// computed offline by driving the index's model (sim/model-index.ts: postReport, closeDay, attest, carryDay) with the
// index logger's archived hours. Display only: nothing here is onchain, nothing settles on it. One archived hour is
// one writer report of that slice (the logger fetched each page once an hour, the writers do the same); the GPUs are
// registered as the deploy registered them, live from the first day computed, so that day is an entry day as the
// index's own firstDay was. The writer closes each day at its end plus CLOSE_GRACE, the attester countersigns what
// needs it, and a day without quorum is carried at its end plus GRACE, as the keeper would.
import type { Address, Hex } from "@agate/report/types";
import { Status } from "@agate/report/types";
import type { HourValues } from "@agate/sources/io";
import { slotValues } from "@agate/sources/pure";
import type { Panel } from "@agate/sources/types";
import { deriveClocks, type ProfileInput } from "./clock.ts";
import { daysFromCivil, isoOfDay } from "./date.ts";
import { ModelIndex } from "./sim/model-index.ts";

export interface PrelaunchDay {
  day: number;
  date: string;
  /** 10^-6 USD per GPU-hour, on the cent grid (a carried day: the day before's) */
  valueU: number;
  status: "FULL" | "DEGRADED" | "DEMO" | "CARRIED";
  /** families with a fresh reading that day */
  fresh: number;
  /** archived hours of the day with at least one valid reading of this GPU */
  hours: number;
}

export interface PrelaunchInput {
  hours: readonly HourValues[];
  panels: readonly Panel[];
  /** the deploy config's profile (minReadings, qMin, signAll, epoch) */
  profile: ProfileInput;
  /** first and last UTC day to compute (inclusive); the first is the model's firstDay */
  fromDay: number;
  toDay: number;
}

const WRITER: Address = "0x0000000000000000000000000000000000000001";
const ATTESTER: Address = "0x0000000000000000000000000000000000000002";
const GUARDIAN: Address = "0x0000000000000000000000000000000000000003";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const STATUS_NAME: Record<number, PrelaunchDay["status"]> = { [Status.FULL]: "FULL", [Status.DEGRADED]: "DEGRADED", [Status.DEMO]: "DEMO", [Status.CARRIED]: "CARRIED" };

/** "2026-10-01T05" -> [day 20727, slice 5]. */
export function dayAndSlice(hour: string): [number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(hour);
  if (!m || Number(m[4]) > 23 || isoOfDay(daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3]))) !== hour.slice(0, 10)) throw new Error(`not an archive hour: ${hour}`);
  return [daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3])), Number(m[4])];
}

/** The day id of a UTC date "2026-10-01" (throws on anything else). */
export function dayOfDate(date: string): number {
  return dayAndSlice(`${date}T00`)[0];
}

/** Per GPU, what the index's model records for fromDay..toDay from the archived hours: closed days, and carried days
 *  (the day before's value) where the model carries; a day skipped for want of any record before it is left out. */
export function prelaunchDays(x: PrelaunchInput): Record<string, PrelaunchDay[]> {
  const clocks = deriveClocks(x.profile);
  if (clocks.day !== 86_400 || clocks.slices !== 24 || clocks.epochTs !== 0n || clocks.epochDay !== 0) throw new Error(`the archive is hourly UTC: a ${clocks.slices}-slice day of ${clocks.day} s from epoch ${clocks.epochTs} cannot be read from it`);
  const m = new ModelIndex(clocks, { writers: [WRITER, ZERO], attester: ATTESTER, guardians: [GUARDIAN, ZERO] });
  const C = m.C;
  for (const p of x.panels) {
    const mask = p.slots.reduce((s, slot) => s + (slot.liveAtStart ? 2 ** slot.slot : 0), 0);
    m.registerGpu(p.gpuId as Hex, p.slots.map((s) => s.family), p.families.map((f) => f.famQ), x.fromDay, mask, m.dayStart(x.fromDay));
  }
  const hours = x.panels.map(() => new Map<number, number>()); // per GPU: day -> archived hours with a valid reading
  const byDay = new Map<number, HourValues[]>();
  for (const h of x.hours) {
    const [d] = dayAndSlice(h.hour);
    if (d < x.fromDay || d > x.toDay) continue;
    byDay.set(d, [...(byDay.get(d) ?? []), h]);
  }
  for (let d = x.fromDay; d <= x.toDay; d++) {
    for (const h of [...(byDay.get(d) ?? [])].sort((a, b) => a.hour.localeCompare(b.hour))) {
      const slice = dayAndSlice(h.hour)[1];
      const rows: Record<string, Record<string, { state: string; valueU: number }>> = {};
      for (const [id, src] of Object.entries(h.sources)) {
        if (src) rows[id] = Object.fromEntries(Object.entries(src.rows).map(([g, r]) => [g, { state: r!.s, valueU: r!.v }]));
      }
      const readAt = m.dayStart(d) + slice * C.slice + C.slice / 2;
      const entries = x.panels.map((p, gi) => {
        const values = slotValues(p, rows as Parameters<typeof slotValues>[1]);
        if (values.some((v) => v > 0)) hours[gi]!.set(d, (hours[gi]!.get(d) ?? 0) + 1);
        return { gpuId: p.gpuId as Hex, day: d, slice, readAt, values };
      });
      const skipped = m.postReport(WRITER, entries, readAt);
      if (skipped.length > 0) throw new Error(`${h.hour}: the model refused readings (${skipped.join(", ")})`);
    }
    // the writer closes at the day's end plus CLOSE_GRACE and the attester countersigns at once; without quorum the
    // day is carried at its end plus GRACE (the keeper's carryDay case 2)
    for (const p of x.panels) {
      const gpuId = p.gpuId as Hex;
      const closeAt = m.dayEnd(d) + C.closeGrace;
      if (m.source(m.g(gpuId), d, closeAt) !== null) {
        m.closeDay(gpuId, WRITER, closeAt);
        const r = m.g(gpuId).records.get(d)!;
        if (r.needsSign) m.attest(gpuId, d, WRITER, r.digest, ATTESTER, closeAt);
      } else {
        // a carry records the day before's value, or skips the day when there is none
        m.carryDay(gpuId, ATTESTER, m.dayEnd(d) + C.grace);
      }
    }
  }
  const out: Record<string, PrelaunchDay[]> = {};
  x.panels.forEach((p, gi) => {
    const g = m.g(p.gpuId as Hex);
    const days: PrelaunchDay[] = [];
    for (let d = x.fromDay; d <= x.toDay; d++) {
      const r = g.records.get(d);
      if (!r || r.value === 0) continue;
      const status = STATUS_NAME[r.status];
      if (!status) throw new Error(`${p.gpu} ${isoOfDay(d)}: unexpected record status ${r.status}`);
      days.push({ day: d, date: isoOfDay(d), valueU: r.value, status, fresh: r.fresh, hours: hours[gi]!.get(d) ?? 0 });
    }
    out[p.gpu] = days;
  });
  return out;
}
