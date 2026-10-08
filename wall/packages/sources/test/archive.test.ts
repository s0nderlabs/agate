// Every parser over EVERY archived hour in AGATE_RAW_DIR (default ~/.agate-index-logger/data/raw); skipped when absent.
// Raw pages are read in place, never copied. Expected numbers below were checked by hand against the pages.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GpuModel, ReadState } from "@agate/report/types";
import { archivePresent, listHours, rawDir, readArchived } from "../src/io/archive.ts";
import { archiveValues, type HourValues } from "../src/io/archiveValues.ts";
import { GPUS, SOURCES } from "../src/pure/index.ts";

const present = archivePresent();
if (!present) console.log(`archive absent at ${rawDir()}: skipping the real-page tests (set AGATE_RAW_DIR)`);
const values: HourValues[] = present ? archiveValues() : [];

// Hand-checked against the archived pages (n = 3 hours per source; the pages were identical within each date).
// Sep 30 hours: Nebius still "before October 1" prices; EUR rows have no rate (the archive's ECB file is dated Sep 30).
// The price-only GPUs (18.2; numbers only): checked by hand against the same pages and against an independent reader's
// readings of those hours. Verda's "B300 CC" and "A100 40GB" rows and Hyperstack's PCIe A100 rows are never read;
// CoreWeave's B300 on-demand cell says "Contact sales"; Seeweb's L40S is EUR (0.85 x the ECB rate).
const HAND: Record<string, Record<string, Partial<Record<GpuModel, [ReadState, number]>>>> = {
  "2026-09-30T17": {
    p_verda: { H100: ["VALID", 3_630_000], H200: ["VALID", 4_730_000], B200: ["VALID", 6_920_000], B300: ["VALID", 8_620_000], A100: ["VALID", 1_790_000], L40S: ["VALID", 1_540_000] }, // 29.02/8, 37.86/8, 55.34/8, 68.98/8, 14.30/8, 12.34/8
    p_nebius: { H100: ["VALID", 3_850_000], H200: ["VALID", 4_500_000], B200: ["VALID", 7_150_000], B300: ["VALID", 7_850_000] },
    p_lambda: { H100: ["VALID", 3_990_000], B200: ["VALID", 6_690_000], A100: ["VALID", 2_790_000] }, // 8x tab, per GPU; A100 the 80 GB row
    p_coreweave: { H100: ["VALID", 6_160_000], H200: ["VALID", 6_310_000], B200: ["VALID", 8_600_000], B300: ["NOT_RENTABLE", 0], A100: ["VALID", 2_700_000], L40S: ["VALID", 2_250_000] }, // 49.24/8, 50.44/8, 68.80/8, contact sales, 21.60/8, 18.00/8
    p_civo: { H100: ["VALID", 2_990_000], H200: ["VALID", 3_490_000], B200: ["NOT_RENTABLE", 0], B300: ["VALID", 7_490_000], L40S: ["VALID", 1_290_000] }, // 23.92/8, 27.92/8, N/A, 59.92/8, 10.32/8
    p_hyperstack: { H100: ["VALID", 3_200_000], H200: ["VALID", 3_990_000], B200: ["VALID", 6_000_000], B300: ["VALID", 7_400_000], A100: ["VALID", 1_600_000] },
    p_seeweb: { H100: ["NO_ROW", 0], H200: ["NO_ROW", 0], L40S: ["NO_ROW", 0] },
    p_gcore: { H100: ["NO_ROW", 0], H200: ["NO_ROW", 0] },
  },
  "2026-10-01T00": {
    p_verda: { H100: ["VALID", 3_630_000], H200: ["VALID", 4_730_000], B200: ["VALID", 6_920_000], B300: ["VALID", 8_620_000], A100: ["VALID", 1_790_000], L40S: ["VALID", 1_540_000] },
    p_nebius: { H100: ["VALID", 4_500_000], H200: ["VALID", 5_400_000], B200: ["VALID", 8_500_000], B300: ["VALID", 9_500_000] }, // "from October 1"
    p_lambda: { H100: ["VALID", 3_990_000], B200: ["VALID", 6_690_000], A100: ["VALID", 2_790_000] },
    p_coreweave: { H100: ["VALID", 6_160_000], H200: ["VALID", 6_310_000], B200: ["VALID", 8_600_000], B300: ["NOT_RENTABLE", 0], A100: ["VALID", 2_700_000], L40S: ["VALID", 2_250_000] },
    p_civo: { H100: ["VALID", 2_990_000], H200: ["VALID", 3_490_000], B200: ["NOT_RENTABLE", 0], B300: ["VALID", 7_490_000], L40S: ["VALID", 1_290_000] },
    p_hyperstack: { H100: ["VALID", 3_200_000], H200: ["VALID", 3_990_000], B200: ["VALID", 6_000_000], B300: ["VALID", 7_400_000], A100: ["VALID", 1_600_000] },
    p_seeweb: { H100: ["VALID", 2_150_000], H200: ["VALID", 2_950_000], L40S: ["VALID", 970_000] }, // 1.89, 2.60 and 0.85 EUR x 1.1355 (ECB Sep 30)
    p_gcore: { H100: ["VALID", 2_680_000], H200: ["NO_ROW", 0] }, // 18.91 EUR x 1.1355 / 8; no Virtual GPU H200
  },
  "2026-10-01T04": {
    p_verda: { H100: ["VALID", 3_630_000], H200: ["VALID", 4_730_000], B200: ["VALID", 6_920_000], B300: ["VALID", 8_620_000], A100: ["VALID", 1_790_000], L40S: ["VALID", 1_540_000] },
    p_nebius: { H100: ["VALID", 4_500_000], H200: ["VALID", 5_400_000], B200: ["VALID", 8_500_000], B300: ["VALID", 9_500_000] },
    p_lambda: { H100: ["VALID", 3_990_000], B200: ["VALID", 6_690_000], A100: ["VALID", 2_790_000] },
    p_coreweave: { H100: ["VALID", 6_160_000], H200: ["VALID", 6_310_000], B200: ["VALID", 8_600_000], B300: ["NOT_RENTABLE", 0], A100: ["VALID", 2_700_000], L40S: ["VALID", 2_250_000] },
    p_civo: { H100: ["VALID", 2_990_000], H200: ["VALID", 3_490_000], B200: ["NOT_RENTABLE", 0], B300: ["VALID", 7_490_000], L40S: ["VALID", 1_290_000] },
    p_hyperstack: { H100: ["VALID", 3_200_000], H200: ["VALID", 3_990_000], B200: ["VALID", 6_000_000], B300: ["VALID", 7_400_000], A100: ["VALID", 1_600_000] },
    p_seeweb: { H100: ["VALID", 2_150_000], H200: ["VALID", 2_950_000], L40S: ["VALID", 970_000] },
    p_gcore: { H100: ["VALID", 2_680_000], H200: ["NO_ROW", 0] },
  },
  // Verda's Oct 2 18 UTC step: 70.36/8 = 8.795 and 14.38/8 = 1.7975, both cent half-up; Seeweb L40S 0.85 x 1.1298.
  "2026-10-02T18": {
    p_verda: { B300: ["VALID", 8_800_000], A100: ["VALID", 1_800_000], L40S: ["VALID", 1_560_000] }, // 12.46/8 = 1.5575
    p_nebius: { B300: ["VALID", 9_500_000] },
    p_lambda: { A100: ["VALID", 2_790_000] },
    p_coreweave: { B300: ["NOT_RENTABLE", 0], A100: ["VALID", 2_700_000], L40S: ["VALID", 2_250_000] },
    p_civo: { B300: ["VALID", 7_490_000], L40S: ["VALID", 1_290_000] },
    p_hyperstack: { B300: ["VALID", 7_400_000], A100: ["VALID", 1_600_000] },
    p_seeweb: { L40S: ["VALID", 960_000] },
  },
};

/** A bot wall served with HTTP 200 instead of the pricing page (seen: Gcore's "Site verification" page at
 * 2026-10-02T11, 3,803 bytes). The parser must read it as NO_ROW, which is right: it is not the page. */
function botWall(id: string, hour: string): boolean {
  const h = listHours().find((x) => `${x.date}T${x.hour}` === hour);
  const body = h ? readArchived(h, id) : null;
  return body !== null && body.length < 20_000 && /<title>\s*(?:Site verification|Just a moment|Attention Required|Access denied)/i.test(body);
}

/** States a source/GPU may legitimately show; anything else (layout-changed, ambiguous, parse-error) fails. */
function allowed(id: string, g: GpuModel, h: HourValues): ReadState[] {
  if (id === "p_civo" && g === "B200") return ["NOT_RENTABLE", "VALID"];
  if (id === "p_coreweave" && g === "B300") return ["NOT_RENTABLE", "VALID"]; // "Contact sales" today
  if (id === "p_gcore" && g === "H200") return ["NO_ROW", "VALID"];
  const def = SOURCES.find((s) => s.id === id)!;
  if (def.currency === "EUR" && !h.fx) return ["NO_ROW"];
  return ["VALID"];
}

describe("parsers on every archived hour", () => {
  test.skipIf(!present)("every page of every hour parses to an expected state (100% parse rate)", () => {
    const table: string[] = [];
    for (const def of SOURCES) {
      let pages = 0;
      let ok = 0;
      for (const h of values) {
        const src = h.sources[def.id];
        if (!src) continue;
        pages++;
        let good = true;
        for (const g of GPUS.filter((x) => def.rules[x])) {
          const r = src.rows[g]!;
          if (!allowed(def.id, g, h).includes(r.s) && !(r.s === "NO_ROW" && botWall(def.id, h.hour))) {
            good = false;
            console.log(`${h.hour} ${def.id} ${g}: unexpected ${r.s}`);
          }
        }
        if (good) ok++;
      }
      table.push(`${def.id}: ${ok}/${pages} hours`);
      expect(ok).toBe(pages);
      expect(pages).toBeGreaterThan(0);
    }
    console.log(`archive parse rate over ${values.length} hours: ${table.join(", ")}`);
  });

  // A parser that flaps would step many times a day. Real pages step at most once a UTC day: Verda reprices every GPU
  // about once a day (H100 3.63 to 3.85 from Oct 1 to Oct 7), and the EUR pages (Seeweb, Gcore) move with the ECB rate
  // published once a day. The archive keeps growing, so the bound is per day, not per archive.
  test.skipIf(!present)("values are stable or step plausibly (at most one step per series a UTC day, each within 35%)", () => {
    for (const def of SOURCES) {
      for (const g of GPUS.filter((x) => def.rules[x])) {
        const series = values.map((h) => ({ hour: h.hour, r: h.sources[def.id]?.rows[g] })).filter((x): x is { hour: string; r: { s: ReadState; v: number } } => x.r?.s === "VALID");
        const stepsOn = new Map<string, number>();
        // a USD page's value never goes back to the one before its last step (A to B to A); a EUR page's can, with the rate
        const flips: string[] = [];
        let prior: number | null = null;
        for (let i = 1; i < series.length; i++) {
          const a = series[i - 1]!.r.v;
          const b = series[i]!.r.v;
          if (a === b) continue;
          const day = series[i]!.hour.slice(0, 10);
          stepsOn.set(day, (stepsOn.get(day) ?? 0) + 1);
          expect(Math.abs(b - a) / a).toBeLessThanOrEqual(0.35);
          if (def.currency !== "EUR" && prior === b) flips.push(`${series[i]!.hour} back to ${b}`);
          prior = a;
        }
        for (const [day, n] of stepsOn) expect(`${def.id} ${g} ${day}: ${n} steps`).toBe(`${def.id} ${g} ${day}: 1 steps`);
        expect(`${def.id} ${g}: ${flips.join(", ")}`).toBe(`${def.id} ${g}: `);
        for (const x of series) expect(x.r.v % 10_000).toBe(0);
      }
    }
  });

  test.skipIf(!present)("hand-checked values at three hours per source", () => {
    let checked = 0;
    for (const [hour, srcs] of Object.entries(HAND)) {
      const h = values.find((v) => v.hour === hour);
      if (!h) {
        console.log(`hour ${hour} not in this archive: skipped`);
        continue;
      }
      for (const [id, rows] of Object.entries(srcs)) {
        const src = h.sources[id];
        expect(src).toBeTruthy();
        for (const [g, [s, v]] of Object.entries(rows) as [GpuModel, [ReadState, number]][]) {
          expect({ hour, id, g, ...src!.rows[g] }).toEqual({ hour, id, g, s, v });
          checked++;
        }
      }
    }
    // 21 cells of the first three GPUs and 13 of the price-only ones per hour, three hours, plus the Oct 2 18 UTC step
    if (listHours().some((h) => h.date === "2026-10-01")) expect(checked).toBeGreaterThanOrEqual(3 * (21 + 13));
    if (listHours().some((h) => `${h.date}T${h.hour}` === "2026-10-02T18")) expect(checked).toBe(3 * (21 + 13) + 13);
  });

  test.skipIf(!present)("the numbers-only fixture agrees with a fresh parse of the hours it covers", () => {
    const f = join(import.meta.dir, "fixtures", "archive-values.json");
    if (!existsSync(f)) throw new Error("test/fixtures/archive-values.json missing: run bun run scripts/archive-values.ts");
    const fixture = JSON.parse(readFileSync(f, "utf8")) as { hours: HourValues[] };
    expect(fixture.hours.length).toBeGreaterThan(0);
    // States and values must match; pageTime may differ if the logger appended its log line after the fixture.
    const rowsOf = (h: HourValues) => ({ hour: h.hour, fx: h.fx, rows: Object.fromEntries(Object.entries(h.sources).map(([id, x]) => [id, x?.rows ?? null])) });
    for (const fh of fixture.hours) {
      const h = values.find((v) => v.hour === fh.hour);
      if (h) expect(rowsOf(fh)).toEqual(rowsOf(h));
    }
  });
});
