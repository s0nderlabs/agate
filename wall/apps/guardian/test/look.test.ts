// The guardian's look reader: a replayed page from an earlier UTC date than today is read at its own date (with the
// ECB rate for that date), exactly as a writer reads it; a missing ECB rate is FAILED; the replay base may end in "/".
import { describe, expect, test } from "bun:test";
import { parse, parseEcb } from "@agate/sources/pure";
import { renderEcb, renderPage } from "@agate/sources/synthetic";
import type { PageResult } from "@agate/writer-standby/core";
import { lookReader } from "../src/look.ts";

const PAGE_TIME = Date.UTC(2026, 8, 30, 12) / 1000; // 2026-09-30 12:00 UTC, an archived hour
const NOW = Date.UTC(2026, 9, 2, 6) / 1000; // the guardian runs on Oct 2
const ECB = renderEcb({ "2026-09-28": "1.1000", "2026-09-29": "1.2000", "2026-10-01": "1.3000" });
const BODIES: Record<string, string> = {
  p_lambda: renderPage("p_lambda", { H100: { price: "3.00" }, B200: { price: "5.00" } }),
  p_gcore: renderPage("p_gcore", { H100: { price: "3.00" }, H200: { price: "4.00" } }),
};
const ok = (body: string, pageTime?: number): PageResult => ({ ok: true, httpStatus: 200, body, bytes: body.length, ...(pageTime !== undefined ? { pageTime } : {}) });

function reader(o: { ecb?: boolean } = {}) {
  const urls: string[] = [];
  const look = lookReader({
    base: "http://replay.test/r/look/",
    timeoutMs: 1_000,
    now: () => NOW,
    fetchPage: async (url) => {
      urls.push(url);
      const id = url.split("/").at(-1)!;
      if (id === "fx_ecb") return o.ecb === false ? { ok: false, httpStatus: 503, body: "", bytes: 0 } : ok(ECB, NOW);
      return ok(BODIES[id]!, PAGE_TIME);
    },
  });
  return { look, urls };
}

describe("guardian look reader", () => {
  test("a page from an earlier date is parsed at its own date and FX, as the writers parse it", async () => {
    const { look, urls } = reader();
    const out = await look(["p_lambda", "p_gcore"]);
    const date = "2026-09-30";
    const want = (id: string) => parse(id, BODIES[id]!, { utcDate: date, nowSec: PAGE_TIME, fx: parseEcb(ECB, date)! });
    for (const id of ["p_lambda", "p_gcore"]) {
      for (const [g, r] of Object.entries(want(id))) {
        expect(r!.state).toBe("VALID");
        expect(out[id]![g as "H100"]).toEqual({ state: "VALID", valueU: r!.valueU });
      }
    }
    expect(out.p_gcore!.H100!.valueU).toBe(3_600_000); // the Sep 29 rate (1.2), not the Oct 1 one
    expect(urls).toEqual(["http://replay.test/r/look/p_lambda", "http://replay.test/r/look/p_gcore", "http://replay.test/r/look/fx_ecb"]);
  });

  test("8.6: a swapped reader fetches its own URL; one this build may not use reads MISSED, unfetched, never another reader", async () => {
    const urls: string[] = [];
    const look = lookReader({
      timeoutMs: 1_000,
      now: () => NOW,
      fetchPage: async (url) => {
        urls.push(url);
        return ok(BODIES.p_lambda!, PAGE_TIME);
      },
    });
    // the same parser on another page of Lambda's own hosts: fetched there and parsed as before
    const moved = await look(["p_lambda"], { p_lambda: { url: "https://lambda.ai/pricing-moved", parserVersion: "lambda/1" } });
    expect(urls).toEqual(["https://lambda.ai/pricing-moved"]);
    expect(moved.p_lambda!.H100!.state).toBe("VALID");
    // a host off the allowlist, and a version not installed: MISSED with the reason, no fetch
    urls.length = 0;
    const off = await look(["p_lambda"], { p_lambda: { url: "https://evil.example/pricing", parserVersion: "lambda/1" } });
    expect(off.p_lambda!.H100).toMatchObject({ state: "MISSED", valueU: 0 });
    expect(off.p_lambda!.H100!.why).toContain("evil.example");
    const missing = await look(["p_lambda"], { p_lambda: { url: "https://lambda.ai/pricing", parserVersion: "lambda/99" } });
    expect(missing.p_lambda!.B200!.state).toBe("MISSED");
    expect(urls).toEqual([]);
  });

  test("no ECB rate: the EUR rows are FAILED (missing evidence), never a dark page", async () => {
    const { look } = reader({ ecb: false });
    const out = await look(["p_gcore", "p_lambda"]);
    expect(out.p_gcore).toEqual({ H100: { state: "FAILED", valueU: 0 }, H200: { state: "FAILED", valueU: 0 } });
    expect(out.p_lambda!.H100!.state).toBe("VALID");
  });
});
