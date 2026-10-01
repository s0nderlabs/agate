import { describe, expect, test } from "bun:test";
import { archivedFx, archivePresent, listHours, readArchived } from "../src/io/archive.ts";
import { parseEcb } from "../src/pure/index.ts";
import { renderEcb } from "../src/synthetic.ts";

// Fri Sep 25, Mon Sep 28, Tue Sep 29, Wed Sep 30 2026 (no weekend rates).
const WEEK = renderEcb({ "2026-09-25": "1.1403", "2026-09-28": "1.1378", "2026-09-29": "1.1355", "2026-09-30": "1.1360" });

describe("parseEcb: the last ECB business day strictly before the page's UTC date", () => {
  test("weekdays, weekends and the strictly-before rule", () => {
    expect(parseEcb(WEEK, "2026-10-01")).toEqual({ date: "2026-09-30", usdPerEur: "1.1360" });
    expect(parseEcb(WEEK, "2026-09-30")).toEqual({ date: "2026-09-29", usdPerEur: "1.1355" }); // never the same day
    expect(parseEcb(WEEK, "2026-09-28")).toEqual({ date: "2026-09-25", usdPerEur: "1.1403" }); // Monday: Friday's
    expect(parseEcb(WEEK, "2026-09-27")).toEqual({ date: "2026-09-25", usdPerEur: "1.1403" }); // Sunday
    expect(parseEcb(WEEK, "2026-09-26")).toEqual({ date: "2026-09-25", usdPerEur: "1.1403" }); // Saturday
    expect(parseEcb(WEEK, "2026-09-25")).toBeNull(); // nothing before the first day
  });

  test("holiday gaps (Easter: Thursday to Tuesday) and Christmas", () => {
    const easter = renderEcb({ "2027-03-25": "1.0800", "2027-03-30": "1.0850" });
    expect(parseEcb(easter, "2027-03-29")).toEqual({ date: "2027-03-25", usdPerEur: "1.0800" });
    expect(parseEcb(easter, "2027-03-30")).toEqual({ date: "2027-03-25", usdPerEur: "1.0800" });
    expect(parseEcb(easter, "2027-03-31")).toEqual({ date: "2027-03-30", usdPerEur: "1.0850" });
    const xmas = renderEcb({ "2026-12-24": "1.1", "2026-12-29": "1.2" });
    expect(parseEcb(xmas, "2026-12-28")?.date).toBe("2026-12-24");
  });

  test("a stale file gives no rate (more than 7 days back), never an old one", () => {
    const old = renderEcb({ "2026-09-20": "1.1" });
    expect(parseEcb(old, "2026-09-27")?.date).toBe("2026-09-20");
    expect(parseEcb(old, "2026-09-28")).toBeNull();
  });

  test("the daily file's shape (single quotes, whitespace) parses the same", () => {
    const daily = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
\t<gesmes:subject>Reference rates</gesmes:subject>
\t<gesmes:Sender>\n\t\t<gesmes:name>European Central Bank</gesmes:name>\n\t</gesmes:Sender>
\t<Cube>
\t\t<Cube time='2026-09-30'>
\t\t\t<Cube currency='JPY' rate='178.27'/>
\t\t\t<Cube currency='USD' rate='1.1355'/>
\t\t</Cube>
\t</Cube>
</gesmes:Envelope>`;
    expect(parseEcb(daily, "2026-10-01")).toEqual({ date: "2026-09-30", usdPerEur: "1.1355" });
  });

  test("a corrupt or foreign file gives null", () => {
    expect(parseEcb("<html>not the ECB</html>", "2026-10-01")).toBeNull();
    expect(parseEcb(WEEK, "2026-13-01")).toBeNull();
    expect(parseEcb(WEEK, "yesterday")).toBeNull();
    expect(parseEcb(renderEcb({ "2026-09-30": "11.355" }), "2026-10-01")).toBeNull(); // absurd rate
    expect(parseEcb(renderEcb({ "2026-09-30": "1.1355678" }), "2026-10-01")).toBeNull(); // more than 6 decimals
    expect(parseEcb(renderEcb({ "2026-09-30": "abc" }), "2026-10-01")).toBeNull();
    const twice = WEEK.replace('<Cube time="2026-09-30">', '<Cube time="2026-09-30"><Cube currency="USD" rate="1.2000"/>');
    expect(parseEcb(twice, "2026-10-01")).toBeNull(); // two USD rates on one day
    const dup = WEEK.replace('<Cube time="2026-09-25"><Cube currency="USD" rate="1.1403"/>', '<Cube time="2026-09-30"><Cube currency="USD" rate="1.0000"/>');
    expect(parseEcb(dup, "2026-10-01")).toBeNull(); // the same day twice with different rates
    const noUsd = WEEK.replace('<Cube time="2026-09-30"><Cube currency="USD" rate="1.1360"/>', '<Cube time="2026-09-30">');
    expect(parseEcb(noUsd, "2026-10-01")).toBeNull(); // the latest day lacks USD: never fall back silently
  });

  test("the archived ECB files (skipped without AGATE_RAW_DIR)", () => {
    if (!archivePresent()) {
      console.log("archive absent: skipping the archived ECB check");
      return;
    }
    const bodies = listHours()
      .map((h) => readArchived(h, "fx_ecb"))
      .filter((b): b is string => b !== null);
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      const latest = /time=["'](\d{4}-\d{2}-\d{2})["']/.exec(b)![1]!;
      const next = new Date(Date.parse(`${latest}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      const fx = parseEcb(b, next);
      expect(fx?.date).toBe(latest);
      expect(Number(fx!.usdPerEur)).toBeGreaterThan(0.5);
    }
    expect(archivedFx("2026-10-01")).toEqual({ date: "2026-09-30", usdPerEur: "1.1355" });
  });
});
