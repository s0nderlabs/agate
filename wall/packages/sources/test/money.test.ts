import { describe, expect, test } from "bun:test";
import { centValueU, parseMicro, priceRow, toValueU } from "../src/pure/index.ts";

const ctx = { utcDate: "2026-10-01", nowSec: 1_790_830_000, fx: { date: "2026-09-30", usdPerEur: "1.1355" } };

/** The spec's formula written out literally, as an independent reference: floor((200X + 10^12 g) / (2 * 10^12 g)) * 10^4. */
function reference(native: string, rate: string, g: number): bigint {
  const micro = (s: string) => {
    const [i, f = ""] = s.replaceAll(",", "").split(".");
    return BigInt(i!) * 1_000_000n + BigInt(f.padEnd(6, "0"));
  };
  const X = micro(native) * micro(rate);
  const G = BigInt(g);
  return ((200n * X + 10n ** 12n * G) / (2n * 10n ** 12n * G)) * 10_000n;
}

describe("parseMicro", () => {
  test("exact decimals, grouping, and refusals", () => {
    expect(parseMicro("3.627")).toBe(3_627_000n);
    expect(parseMicro("17,461.60")).toBe(17_461_600_000n);
    expect(parseMicro("0.000001")).toBe(1n);
    expect(parseMicro("49")).toBe(49_000_000n);
    for (const bad of ["1,89", "-1", "+1", "1e3", " 1.0", "1.0 ", "1..0", ".5", "1.", "", "1,2345.00", "$1.00", "1 000"]) {
      expect(() => parseMicro(bad)).toThrow();
    }
    expect(() => parseMicro("1.2345678")).toThrow(/more than 6 decimals/);
  });
});

describe("toValueU (7.4)", () => {
  test("hand-checked vectors, including half-up ties", () => {
    const v: [string, number, number][] = [
      ["49.24", 8, 6_160_000], // CoreWeave H100: 6.155 -> 6.16 (the spec's example)
      ["50.44", 8, 6_310_000], // CoreWeave H200: 6.305 -> 6.31
      ["68.80", 8, 8_600_000],
      ["29.02", 8, 3_630_000], // Verda H100: 3.6275 -> 3.63
      ["37.86", 8, 4_730_000], // 4.7325 -> 4.73
      ["55.34", 8, 6_920_000], // 6.9175 -> 6.92
      ["3.627", 1, 3_630_000],
      ["0.125", 1, 130_000], // tie up
      ["0.124999", 1, 120_000],
      ["23.92", 8, 2_990_000],
      ["0.095", 1, 100_000],
    ];
    for (const [n, g, want] of v) expect(toValueU(n, "USD", g)).toBe(want);
  });

  test("EUR: per instance, then FX, cent half-up once", () => {
    const fx = (r: string) => ({ date: "2026-09-30", usdPerEur: r });
    expect(toValueU("1.89", "EUR", 1, fx("1.1355"))).toBe(2_150_000); // 2.146095 -> 2.15
    expect(toValueU("18.91", "EUR", 8, fx("1.1355"))).toBe(2_680_000); // 21.472305 / 8 = 2.684038 -> 2.68
    expect(toValueU("1.00", "EUR", 1, fx("1.125"))).toBe(1_130_000); // tie up
    expect(toValueU("10.00", "EUR", 1, fx("1.0005"))).toBe(10_010_000); // 10.005 -> 10.01
    // Rounding happens once, after FX: per-GPU EUR rounded first would give 2.36 * 1.1355 = 2.67978 -> 2.68 here too,
    // so use a case where the two orders differ.
    expect(toValueU("2.005", "EUR", 1, fx("1.5"))).toBe(3_010_000); // 3.0075 -> 3.01 (rounding 2.005 first gives 2.01 * 1.5 = 3.015 -> 3.02)
  });

  test("matches the literal spec formula on 5,000 random vectors", () => {
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let i = 0; i < 5000; i++) {
      const native = `${rnd(2000)}.${String(rnd(1_000_000)).padStart(6, "0").slice(0, 1 + rnd(6))}`;
      const g = [1, 2, 4, 8][rnd(4)]!;
      const eur = rnd(2) === 1;
      const rate = `1.${String(rnd(10_000)).padStart(4, "0")}`;
      const got = eur ? toValueU(native, "EUR", g, { date: "2026-09-30", usdPerEur: rate }) : toValueU(native, "USD", g);
      expect(BigInt(got)).toBe(reference(native, eur ? rate : "1", g));
      expect(got % 10_000).toBe(0);
    }
  });

  test("refuses malformed inputs instead of guessing", () => {
    expect(() => toValueU("1.00", "EUR", 1)).toThrow(RangeError);
    expect(() => toValueU("1.00", "EUR", 1, { date: "2026-09-30", usdPerEur: "11.355" })).toThrow(RangeError);
    expect(() => toValueU("1.00", "USD", 0)).toThrow(RangeError);
    expect(() => toValueU("1.00", "USD", 1.5)).toThrow(RangeError);
    expect(() => toValueU("abc", "USD", 1)).toThrow(RangeError);
    expect(() => toValueU("1.1234567", "USD", 1)).toThrow(RangeError);
    expect(() => centValueU(-1n, 1_000_000n, 1)).toThrow(RangeError);
  });
});

describe("priceRow: bounds of rule 7 and the row states", () => {
  test("bounds apply after rounding", () => {
    expect(priceRow("0.10", 1, "USD", ctx, "t").state).toBe("VALID");
    expect(priceRow("0.095", 1, "USD", ctx, "t")).toMatchObject({ state: "VALID", valueU: 100_000 });
    expect(priceRow("0.094", 1, "USD", ctx, "t")).toMatchObject({ state: "BAD_VALUE", valueU: 0 });
    expect(priceRow("1000.00", 1, "USD", ctx, "t")).toMatchObject({ state: "VALID", valueU: 1_000_000_000 });
    expect(priceRow("1000.01", 1, "USD", ctx, "t").state).toBe("BAD_VALUE");
    expect(priceRow("8000.00", 8, "USD", ctx, "t")).toMatchObject({ state: "VALID", valueU: 1_000_000_000 });
    expect(priceRow("8000.08", 8, "USD", ctx, "t").state).toBe("BAD_VALUE"); // 1000.01 per GPU
    expect(priceRow("999999999999999", 1, "USD", ctx, "t").state).toBe("BAD_VALUE");
    expect(priceRow("0", 1, "USD", ctx, "t").detail).toMatch(/^out-of-bounds: /);
  });

  test("more than 6 decimals is BAD_VALUE, a malformed number NO_ROW, EUR without a usable rate NO_ROW", () => {
    expect(priceRow("3.1234567", 1, "USD", ctx, "t")).toMatchObject({ state: "BAD_VALUE", valueU: 0 });
    expect(priceRow("3.1234567", 1, "USD", ctx, "t").detail).toMatch(/^too-many-decimals: /);
    expect(priceRow("3,99", 1, "USD", ctx, "t")).toMatchObject({ state: "NO_ROW" });
    const { fx: _fx, ...noFx } = ctx;
    expect(priceRow("1.89", 1, "EUR", noFx, "t").detail).toMatch(/^no-fx: /);
    expect(priceRow("1.89", 1, "EUR", { ...ctx, fx: { date: "2026-10-01", usdPerEur: "1.1" } }, "t").state).toBe("NO_ROW"); // not strictly before
    expect(priceRow("1.89", 1, "EUR", { ...ctx, fx: { date: "2026-09-20", usdPerEur: "1.1" } }, "t").state).toBe("NO_ROW"); // stale
    expect(priceRow("1.89", 1, "EUR", ctx, "t")).toMatchObject({ state: "VALID", valueU: 2_150_000, raw: "1.89", gpuCount: 1 });
  });
});
