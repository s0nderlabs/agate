import { describe, expect, test } from "bun:test";
import { back, daily, gain, later, middle, putIn, signed0, startAvg, type Book } from "./play";

// H100 November as it traded on Oct 8: the example the page falls back to
const b: Book = { floor: 1.95, cap: 8, days: 30, ask: 4.03, bid: 3.95 };

describe("what goes in and what comes back", () => {
  test("put in", () => {
    expect(putIn(b, "long")).toBe(403);
    expect(putIn(b, "short")).toBe(405);
  });

  test("a Long gets the counted average back", () => {
    expect(back(b, "long", 4.5)).toBe(450);
    expect(back(b, "long", 5)).toBe(500);
    expect(back(b, "long", 3.5)).toBe(350);
    expect(back(b, "long", 1.95)).toBe(195);
    expect(back(b, "long", 1.0)).toBe(195);
    expect(back(b, "long", 8)).toBe(800);
    expect(back(b, "long", 9)).toBe(800);
  });

  test("a Short gets the highest less the counted average", () => {
    expect(back(b, "short", 3.5)).toBe(450);
    expect(back(b, "short", 4.5)).toBe(350);
    expect(back(b, "short", 8)).toBe(0);
    expect(back(b, "short", 1.95)).toBe(605);
  });

  test("gain from the rounded figures", () => {
    expect(gain(b, "long", 5)).toBe(97);
    expect(gain(b, "long", 1.95)).toBe(-208);
    expect(gain(b, "short", 8)).toBe(-405);
    expect(gain(b, "short", 1.95)).toBe(200);
    // the side switch keeps the average: +$47 becomes -$55
    expect(gain(b, "long", 4.5)).toBe(47);
    expect(gain(b, "short", 4.5)).toBe(-55);
  });

  test("nobody loses more than they put in", () => {
    for (let a = 0; a <= 12; a += 0.01) {
      expect(gain(b, "long", a)).toBeGreaterThanOrEqual(-putIn(b, "long"));
      expect(gain(b, "short", a)).toBeGreaterThanOrEqual(-putIn(b, "short"));
    }
  });
});

describe("where the pictures start", () => {
  test("where the play starts", () => {
    expect(startAvg(b)).toBe(4.5);
    expect(startAvg({ ...b, ask: 4.1 })).toBe(4.5);
    expect(startAvg({ ...b, ask: 7.9 })).toBe(8);
  });
});

describe("pay me daily", () => {
  test("Long", () => {
    const d = daily(b, "long", 5);
    expect(d.now).toBe(195);
    expect(d.perDay).toBeCloseTo(10.1667, 4);
    expect(d.total).toBe(500);
  });

  test("Short", () => {
    const d = daily(b, "short", 5);
    expect(d.now).toBe(0);
    expect(d.perDay).toBeCloseTo(10, 6);
    expect(d.total).toBe(300);
  });

  test("over a whole month it adds up to waiting", () => {
    for (const a of [1.95, 3.5, 4.03, 4.5, 6.1, 8]) {
      for (const side of ["long", "short"] as const) {
        const d = daily(b, side, a);
        expect(d.now + d.perDay * b.days).toBeCloseTo(d.total, 6);
      }
    }
  });

  test("the example card: +$8.50 a day on a Long at 4.50", () => {
    expect(daily(b, "long", 4.5).perDay).toBeCloseTo(8.5, 6);
  });
});

describe("closing early", () => {
  test("later", () => {
    expect(later(b, "long")).toEqual({ at: 4.5, keep: 47 });
    expect(later(b, "short")).toEqual({ at: 3.5, keep: 45 });
  });
});

describe("the middle price", () => {
  test("odd count", () => {
    const m = middle([4.5, 2.99, 6.16, 3.79, 3.99]);
    expect(m.value).toBe(3.99);
    expect(m.at).toEqual([2]);
  });

  test("even count is halfway between the middle two", () => {
    const m = middle([3, 4, 5, 6]);
    expect(m.value).toBe(4.5);
    expect(m.at).toEqual([1, 2]);
  });
});

describe("words", () => {
  test("signed0", () => {
    expect(signed0(97)).toBe("+$97");
    expect(signed0(-53)).toBe("−$53");
    expect(signed0(0)).toBe("$0");
    expect(signed0(1234)).toBe("+$1,234");
  });
});
