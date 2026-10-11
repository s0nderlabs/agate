import { describe, expect, test } from "bun:test";
import type { Grant } from "./api";
import { givenOf, safeReturn, timeLeftShare, timeLeftText, tradesIn24h, tradesLeftText } from "./aiView";

describe("safeReturn: an AI app's return address", () => {
  test("http(s) and an app's own scheme are opened", () => {
    expect(safeReturn("https://claude.ai/api/mcp/auth_callback?code=x")).toBe("https://claude.ai/api/mcp/auth_callback?code=x");
    expect(safeReturn("http://127.0.0.1:6274/callback?code=x")).toBe("http://127.0.0.1:6274/callback?code=x");
    expect(safeReturn("cursor://anysphere.cursor-retrieval/oauth/callback?code=x")).toBe("cursor://anysphere.cursor-retrieval/oauth/callback?code=x");
    expect(safeReturn("vscode://ms.vscode/callback?code=x")).toBe("vscode://ms.vscode/callback?code=x");
  });

  test("an address that would run script in the page or read local data is refused, however it is written", () => {
    for (const u of [
      "javascript:alert(document.cookie)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "javascript:alert(1)?code=x",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://agate.example/123",
      "about:blank",
    ]) {
      expect(safeReturn(u)).toBeNull();
    }
  });

  test("nothing, or an address that does not parse, is refused", () => {
    expect(safeReturn(undefined)).toBeNull();
    expect(safeReturn("")).toBeNull();
    expect(safeReturn("not a url")).toBeNull();
  });
});

describe("how much of a connection is left", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  const grant = (over: Partial<Grant> = {}): Grant => ({
    id: "g1",
    label: "Claude",
    status: "active",
    pocket: "0x1",
    mainAccount: "0x2",
    assistant: "0x3",
    budget: "1000000000",
    perTradeCap: "100000000",
    pocketIndex: 0,
    tradesPerDay: 5,
    createdAt: "2026-10-04T12:00:00Z",
    expiresAt: "2026-10-18T12:00:00Z",
    ...over,
  });

  test("time left in days, then hours, then under an hour; nothing once it has passed", () => {
    expect(timeLeftText("2026-10-18T12:00:00Z", now)).toBe("7 days left");
    expect(timeLeftText("2026-10-12T13:00:00Z", now)).toBe("1 day left");
    expect(timeLeftText("2026-10-11T17:30:00Z", now)).toBe("5 hours left");
    expect(timeLeftText("2026-10-11T13:00:00Z", now)).toBe("1 hour left");
    expect(timeLeftText("2026-10-11T12:20:00Z", now)).toBe("Under an hour left");
    expect(timeLeftText("2026-10-11T12:00:00Z", now)).toBeNull();
    expect(timeLeftText("not a date", now)).toBeNull();
  });

  test("the share of its time still to run, kept between 0 and 1", () => {
    expect(timeLeftShare(grant(), now)).toBeCloseTo(0.5, 6);
    expect(timeLeftShare(grant(), Date.parse("2026-10-20T00:00:00Z"))).toBe(0);
    expect(timeLeftShare(grant(), Date.parse("2026-10-01T00:00:00Z"))).toBe(1);
    expect(timeLeftShare(grant({ expiresAt: "2026-10-04T12:00:00Z" }), now)).toBe(0);
  });

  test("a pocket is measured against what moved in, until more than that is in it", () => {
    expect(givenOf(grant(), 400)).toBe(1000);
    expect(givenOf(grant(), undefined)).toBe(1000);
    expect(givenOf(grant(), 1000.004)).toBe(1000);
    expect(givenOf(grant(), 1200)).toBeNull();
  });

  test("trades in the last 24 hours are unknown, not 0, while the activity is not read", () => {
    expect(tradesIn24h("g1", undefined, now)).toBeNull();
    expect(tradesIn24h("g1", [], now)).toBe(0);
  });

  test("the trades it may still make now", () => {
    expect(tradesLeftText(2, 5)).toBe("It can make 3 more now.");
    expect(tradesLeftText(5, 5)).toBe("It can trade again once one is 24 hours old.");
    expect(tradesLeftText(7, 5)).toBe("It can trade again once one is 24 hours old.");
  });
});
