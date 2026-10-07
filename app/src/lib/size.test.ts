import { describe, expect, test } from "bun:test";
import { fmtHours, showHours } from "./size";

describe("GPU-hours on screen and in a box", () => {
  test("on screen: two decimals, whole amounts plain", () => {
    expect(showHours(799.5692)).toBe("799.57");
    expect(showHours(1440)).toBe("1,440");
    expect(showHours(122.5)).toBe("122.5");
    expect(showHours(0)).toBe("0");
  });

  test("on screen: a small amount never reads 0", () => {
    expect(showHours(0.0042)).toBe("0.0042");
  });

  test("in a box: four decimals, so a sale never asks for more than is held", () => {
    expect(fmtHours(799.5692)).toBe("799.5692");
  });
});
