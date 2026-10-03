// The parser registry, the host allowlist and readers in force (BUILD-SPEC 4.15, 7.6, 7.7, 8.6), and the replay's
// "redesigned" layout that every "/1" parser must read as NO_ROW (7.9).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GpuModel } from "@agate/report/types";
import {
  assertAllowed,
  EXTRACTORS,
  EXTRACTORS_BY_VERSION,
  GPUS,
  httpsHost,
  isRegistered,
  PARSER_VERSIONS,
  parse,
  parseWith,
  readerAllowed,
  readerInForce,
  readerProblem,
  registeredReader,
  SOURCES,
  sourceOfVersion,
  sourcesApi,
  swapInForce,
} from "../src/pure/index.ts";
import { renderEcb, renderPage, type SynthPage } from "../src/synthetic.ts";
import type { PanelSlot, ReaderSwap } from "../src/types.ts";

const ctx = (t = Date.UTC(2026, 9, 2, 8, 20) / 1000) => ({ utcDate: new Date(t * 1000).toISOString().slice(0, 10), nowSec: t, fx: { date: "2026-10-01", usdPerEur: "1.1700" } });

/** Every GPU a source prices, with a distinct on-demand price. */
function fullPage(id: string): SynthPage {
  const def = SOURCES.find((s) => s.id === id)!;
  const prices: Record<GpuModel, string> = { H100: "3.99", H200: "4.79", B200: "6.69" };
  const p: SynthPage = {};
  for (const g of GPUS) if (def.rules[g]) p[g] = { price: prices[g], count: 8 };
  return p;
}

describe("the parser registry (7.7)", () => {
  test("exactly one /1 per source, and every source's registered version is installed for it", () => {
    for (const d of SOURCES) {
      const ones = Object.entries(EXTRACTORS_BY_VERSION).filter(([v, e]) => e.sourceId === d.id && v.endsWith("/1"));
      expect(ones.length, d.id).toBe(1);
      expect(d.parserVersion, d.id).toBe(ones[0]![0]);
      expect(sourceOfVersion(d.parserVersion)).toBe(d.id);
      expect(EXTRACTORS[d.id]).toBe(EXTRACTORS_BY_VERSION[d.parserVersion]!.extract);
    }
    expect(PARSER_VERSIONS).toEqual(Object.keys(EXTRACTORS_BY_VERSION));
    for (const v of PARSER_VERSIONS) expect(v).toMatch(/^[a-z]+\/[1-9]\d*$/);
    expect(new Set(Object.values(EXTRACTORS_BY_VERSION).map((e) => e.sourceId))).toEqual(new Set(SOURCES.map((s) => s.id)));
  });

  test("the repair markers are present, in order, inside the registry object (repair install writes between them)", () => {
    const text = readFileSync(join(import.meta.dir, "../src/pure/parsers/index.ts"), "utf8").split("\n");
    const open = text.findIndex((l) => l.includes("EXTRACTORS_BY_VERSION") && l.includes("= {"));
    const begin = text.findIndex((l) => l.trim() === "// repair:begin");
    const end = text.findIndex((l) => l.trim() === "// repair:end");
    const close = text.findIndex((l, i) => i > end && l.trim() === "};");
    expect(open).toBeGreaterThan(0);
    expect(begin).toBeGreaterThan(open);
    // between the markers only registry lines repair install wrote (none before the first install)
    for (const l of text.slice(begin + 1, end)) expect(l).toMatch(/^ {2}"[a-z][a-z0-9]*\/([2-9]|[1-9]\d+)": \{ sourceId: "p_[a-z0-9]+", extract: extract[A-Z][a-z0-9]*V\d+ \},$/);
    expect(close).toBe(end + 1);
    expect(text.filter((l) => l.includes("repair:begin")).length).toBe(1);
    expect(text.filter((l) => l.includes("repair:end")).length).toBe(1);
  });

  test("parse(id) equals parseWith(the registered version) on every source's synthetic pages", () => {
    for (const d of SOURCES) {
      const pages = [renderPage(d.id, fullPage(d.id)), renderPage(d.id, fullPage(d.id), { broken: true }), renderPage(d.id, {}), "garbage"];
      for (const body of pages) expect(parseWith(d.parserVersion, body, ctx())).toEqual(parse(d.id, body, ctx()));
    }
    // the shared API object carries the same functions
    expect(sourcesApi.parseWith).toBe(parseWith);
    expect(sourcesApi.PARSER_VERSIONS).toBe(PARSER_VERSIONS);
  });

  test("an unknown version reads nothing (never another source's parser, never a prototype key)", () => {
    const body = renderPage("p_lambda", fullPage("p_lambda"));
    for (const v of ["lambda/999", "lambda", "", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(parseWith(v, body, ctx())).toEqual({});
      expect(sourceOfVersion(v)).toBeNull();
    }
    // a version of another source reads that source's rows, never this page's: readerAllowed refuses it (below)
    expect(parseWith("nebius/1", body, ctx()).H100?.state).toBe("NO_ROW");
  });
});

describe("hosts (7.7)", () => {
  test("every source's hosts hold its registered URL's host, are plain lowercase hostnames and name no forbidden source", () => {
    for (const d of SOURCES) {
      expect(d.hosts.length, d.id).toBeGreaterThan(0);
      expect(d.hosts).toContain(httpsHost(d.url)!);
      for (const h of d.hosts) expect(h, d.id).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
      expect(new Set(d.hosts).size).toBe(d.hosts.length);
      expect(() => assertAllowed(d)).not.toThrow();
    }
    expect(() => assertAllowed({ id: "p_x", company: "X", url: "https://x.example/p", hosts: ["gputable.dev"] })).toThrow(/gputable/);
    // no two companies share a host
    const all = SOURCES.flatMap((d) => d.hosts);
    expect(new Set(all).size).toBe(all.length);
  });

  test("httpsHost takes only plain https URLs of 9 to 256 characters", () => {
    expect(httpsHost("https://lambda.ai/pricing")).toBe("lambda.ai");
    expect(httpsHost("https://WWW.Civo.COM/pricing?x=1#y")).toBe("www.civo.com");
    expect(httpsHost("https://lambda.ai")).toBe("lambda.ai");
    for (const bad of [
      "http://lambda.ai/pricing",
      "https://lambda.ai:8443/pricing",
      "https://user@lambda.ai/pricing",
      "https://lambda.ai@evil.example/x",
      "https://lambda ai/pricing",
      "https://lambda.ai/pri cing",
      "https://lambda.ai\\@evil.example/",
      "https://.lambda.ai/",
      "https://lambda..ai/",
      "https://localhost/",
      "ftp://lambda.ai/",
      `https://lambda.ai/${"a".repeat(250)}`,
      "https://",
    ]) {
      expect(httpsHost(bad), bad).toBeNull();
    }
  });
});

describe("readerAllowed and readerProblem (8.6)", () => {
  test("the registered reader of every source is allowed", () => {
    for (const d of SOURCES) {
      expect(readerAllowed(d.id, registeredReader(d.id)!)).toEqual({ ok: true });
      expect(isRegistered(d.id, { url: d.url, parserVersion: d.parserVersion })).toBe(true);
    }
  });

  test("refuses http, another host, a port, user info, a version of another source; an uninstalled version is missing", () => {
    const cases: [string, { url: string; parserVersion: string }, "missing" | "refused" | null][] = [
      ["p_lambda", { url: "https://lambda.ai/pricing-2026", parserVersion: "lambda/1" }, null], // a moved page, same parser
      ["p_lambda", { url: "https://www.lambdalabs.com/service/gpu-cloud", parserVersion: "lambda/1" }, null],
      ["p_lambda", { url: "http://lambda.ai/pricing", parserVersion: "lambda/1" }, "refused"],
      ["p_lambda", { url: "https://lambda.ai.evil.example/pricing", parserVersion: "lambda/1" }, "refused"],
      ["p_lambda", { url: "https://gputable.dev/data.json", parserVersion: "lambda/1" }, "refused"],
      ["p_lambda", { url: "https://www.coreweave.com/pricing", parserVersion: "lambda/1" }, "refused"], // another company's host
      ["p_lambda", { url: "https://lambda.ai:444/pricing", parserVersion: "lambda/1" }, "refused"],
      ["p_lambda", { url: "https://lambda.ai/pricing", parserVersion: "nebius/1" }, "refused"],
      ["p_lambda", { url: "https://lambda.ai/pricing", parserVersion: "lambda/999" }, "missing"],
      ["p_lambda", { url: "https://lambda.ai/pricing", parserVersion: "" }, "refused"],
      ["p_lambda", { url: "https://lambda.ai/pricing", parserVersion: "x".repeat(33) }, "refused"],
      ["p_nope", { url: "https://lambda.ai/pricing", parserVersion: "lambda/1" }, "refused"],
      // a refused host wins over a missing version: such a swap must be cancelled, installing does not help
      ["p_lambda", { url: "https://evil.example/pricing", parserVersion: "lambda/9" }, "refused"],
    ];
    for (const [id, r, want] of cases) {
      const p = readerProblem(id, r);
      expect(p?.code ?? null, `${id} ${r.url} ${r.parserVersion}`).toBe(want);
      const a = readerAllowed(id, r);
      expect(a.ok).toBe(want === null);
      if (!a.ok) expect(a.why).toBe(p!.why);
    }
  });
});

describe("readerInForce (4.15, 7.6)", () => {
  const slot: PanelSlot = { slot: 2, sourceId: "p_lambda", family: 2, liveAtStart: true };
  const reg = { url: "https://lambda.ai/pricing", parserVersion: "lambda/1" };
  const s1: ReaderSwap = { fromDay: 20_740, url: "https://lambda.ai/pricing", parserVersion: "lambda/2" };
  const s2: ReaderSwap = { fromDay: 20_745, url: "https://lambda.ai/gpu-pricing", parserVersion: "lambda/2" };
  const s3: ReaderSwap = { fromDay: 20_760, url: "https://lambda.ai/gpu-pricing", parserVersion: "lambda/3" };

  test("the registered reader before the first fromDay, the swap from fromDay on", () => {
    expect(readerInForce(slot, [], 20_740)).toEqual(reg);
    expect(readerInForce(slot, [s1], s1.fromDay - 1)).toEqual(reg);
    expect(readerInForce(slot, [s1], s1.fromDay)).toEqual({ url: s1.url, parserVersion: s1.parserVersion });
    expect(readerInForce(slot, [s1], s1.fromDay + 100)).toEqual({ url: s1.url, parserVersion: s1.parserVersion });
  });

  test("three swaps: each day reads with the newest swap that has begun, whatever the history's order", () => {
    for (const h of [
      [s1, s2, s3],
      [s3, s1, s2],
    ]) {
      expect(readerInForce(slot, h, 20_739)).toEqual(reg);
      expect(readerInForce(slot, h, 20_744).parserVersion).toBe("lambda/2");
      expect(readerInForce(slot, h, 20_744).url).toBe(s1.url);
      expect(readerInForce(slot, h, 20_745).url).toBe(s2.url);
      expect(readerInForce(slot, h, 20_759)).toEqual({ url: s2.url, parserVersion: "lambda/2" });
      expect(readerInForce(slot, h, 20_760)).toEqual({ url: s3.url, parserVersion: "lambda/3" });
      expect(swapInForce(h, 20_745)).toEqual(s2);
    }
    expect(() => readerInForce({ ...slot, sourceId: "p_nope" }, [], 1)).toThrow();
  });
});

describe("the redesigned layout (7.9)", () => {
  test("every /1 parser reads NO_ROW for every GPU it prices on a redesigned page of its source", () => {
    for (const d of SOURCES) {
      const page = fullPage(d.id);
      const ok = parse(d.id, renderPage(d.id, page), ctx());
      for (const g of GPUS.filter((x) => d.rules[x])) expect(ok[g]?.state, `${d.id} ${g} in its own layout`).toBe("VALID");
      const r = parse(d.id, renderPage(d.id, page, { redesigned: true }), ctx());
      for (const g of GPUS.filter((x) => d.rules[x])) expect(r[g]?.state, `${d.id} ${g} redesigned`).toBe("NO_ROW");
    }
  });

  test("the redesigned Lambda page carries the scripted on-demand prices beside a spot price, in a new structure", () => {
    const body = renderPage("p_lambda", { H100: { price: "3.29", count: 8 }, B200: { state: "not-rentable" } }, { redesigned: true });
    expect(body).toContain("$3.29 per GPU per hour");
    expect(body).toContain("Sold out");
    expect(body).toContain("gpu-card__price--spot");
    expect(body).not.toContain("Instances pricing");
    expect(body).not.toContain("data-plan");
    expect(parseWith("lambda/1", body, ctx())).toEqual(parse("p_lambda", body, ctx()));
    expect(renderEcb({ "2026-10-01": "1.17" })).toContain("1.17"); // the ECB file has one layout
  });
});
