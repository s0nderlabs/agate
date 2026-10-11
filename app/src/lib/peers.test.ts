import { describe, expect, test } from "bun:test";
import { newerOrnn, ornnIndexOf, peersFor } from "./peers";

// the shape Ornn's free daily index answered on Oct 11 2026 (api.ornnai.com/api/daily-index/all)
const day = "2026-10-10T20:00:00.000Z";
const sec = (iso: string) => Date.parse(iso) / 1000;
const ornnPayload = (rows: unknown[], over: Record<string, unknown> = {}) => ({ success: true, date: day, data: rows, count: rows.length, ...over });
const row = (gpu_type: string, index_value: unknown, extra: Record<string, unknown> = {}) => ({ gpu_type, region: "global", index_value, date: day, ...extra });

describe("ornnIndexOf: Ornn's daily index", () => {
  test("keeps the three GPUs Ornn agreed to, under our names, each with its day", () => {
    const got = ornnIndexOf(ornnPayload([row("A100 SXM4", 0.95), row("B200", 7.53), row("H100 SXM", 2.67), row("H200", 5.91), row("RTX 5090", 0.61)]));
    expect(got).toEqual({ gpus: { H100: { price: 2.67, at: sec(day) }, H200: { price: 5.91, at: sec(day) }, B200: { price: 7.53, at: sec(day) } } });
  });

  test("a row keeps its own day, the top date stands in when it has none, and the newest row per GPU wins", () => {
    const got = ornnIndexOf(
      ornnPayload([
        row("B200", 7.4, { date: "2026-10-09T20:00:00.000Z" }),
        row("H100 SXM", 2.6, { date: "2026-10-09T20:00:00.000Z" }),
        row("H100 SXM", 2.67),
        row("H200", 5.91, { date: undefined }),
      ]),
    );
    expect(got?.gpus.B200).toEqual({ price: 7.4, at: sec("2026-10-09T20:00:00.000Z") });
    expect(got?.gpus.H100).toEqual({ price: 2.67, at: sec(day) });
    expect(got?.gpus.H200).toEqual({ price: 5.91, at: sec(day) });
  });

  test("leaves out a row that is not global, not a number, or outside $0 to $100 an hour", () => {
    expect(ornnIndexOf(ornnPayload([row("H100 SXM", 2.67, { region: "us-east" }), row("H100 SXM", 2.5, { region: undefined }), row("H200", "5.91"), row("B200", 0), row("B200", 250)]))).toBeNull();
    expect(ornnIndexOf(ornnPayload([row("H100 SXM", Number.NaN), row("H200", 5.91)]))?.gpus).toEqual({ H200: { price: 5.91, at: sec(day) } });
  });

  test("anything not in Ornn's shape reads as no reading", () => {
    expect(ornnIndexOf(null)).toBeNull();
    expect(ornnIndexOf("<html>")).toBeNull();
    expect(ornnIndexOf(ornnPayload([row("H100 SXM", 2.67)], { success: false }))).toBeNull();
    expect(ornnIndexOf(ornnPayload([row("H100 SXM", 2.67, { date: "not a date" })], { date: "not a date" }))).toBeNull();
    expect(ornnIndexOf(ornnPayload([row("H100 SXM", 2.67)], { data: { H100: 2.67 } }))).toBeNull();
    expect(ornnIndexOf(ornnPayload([null, 7, row("toString", 1)]))).toBeNull();
  });
});

describe("newerOrnn: a copy and Ornn's own, as one", () => {
  const older = { gpus: { H100: { price: 2.6, at: sec("2026-10-09T20:00:00.000Z") }, B200: { price: 7.4, at: sec("2026-10-09T20:00:00.000Z") } } };
  const newer = { gpus: { H100: { price: 2.67, at: sec(day) } } };

  test("per GPU the newer day wins, whichever side it comes from", () => {
    expect(newerOrnn(older, newer)?.gpus).toEqual({ H100: newer.gpus.H100, B200: older.gpus.B200 });
    expect(newerOrnn(newer, older)?.gpus).toEqual({ H100: newer.gpus.H100, B200: older.gpus.B200 });
  });

  test("one side missing leaves the other; both missing is no reading", () => {
    expect(newerOrnn(null, newer)).toBe(newer);
    expect(newerOrnn(older, null)).toBe(older);
    expect(newerOrnn(null, null)).toBeNull();
  });
});

describe("peersFor: Ornn beside ours", () => {
  const read = { gpus: { H100: { price: 2.5, at: sec("2026-10-13T20:00:00.000Z") } } };

  test("a live reading replaces the hand-read value and carries its own day", () => {
    const ornn = peersFor("H100", null, read).find((p) => p.name === "Ornn");
    expect(ornn?.price).toBe(2.5);
    expect(ornn?.asOf).toBe("Oct 13");
  });

  test("a GPU the reading lacks, no reading, or a reading older than the hand read keeps the hand-read value", () => {
    const old = { gpus: { H100: { price: 2.9, at: sec("2026-10-08T20:00:00.000Z") } } };
    for (const ornn of [peersFor("H200", null, read), peersFor("H100"), peersFor("H100", null, old)].map((ps) => ps.find((p) => p.name === "Ornn"))) {
      expect(ornn?.asOf).toBe("Oct 10");
    }
    expect(peersFor("H200", null, read).find((p) => p.name === "Ornn")?.price).toBe(5.91);
    expect(peersFor("H100", null, old).find((p) => p.name === "Ornn")?.price).toBe(2.67);
  });
});
