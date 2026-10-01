// A synthetic stand-in for @agate/sources/pure: JSON pages {"H100": "2.99", "H200": null} (null = sold out).
// Only for writer tests; the real parsers are builder B's.
import type { Hex } from "@agate/report/types";
import type { Currency, FxRate, Panel, ParseContext, ParseResult, SourceDef, SourcesPureApi } from "@agate/sources/types";
import { keccak256, toHex } from "viem";

const rule = {
  product: "synthetic",
  form: "SXM",
  priceClass: "on-demand",
  instance: "per-GPU of the 8-GPU instance, else of the 1-GPU instance",
  rentable: "page-shows-availability",
  effectiveDate: "a price shown from date X counts from 00:00 UTC of X",
  tax: "excluding VAT",
  notes: "test only",
} as const;

export const FAKE_SOURCES: SourceDef[] = [
  { id: "f_a", company: "A", url: "https://a.invalid/p", currency: "USD", parserVersion: "t1", rules: { H100: rule, H200: rule, B200: rule } },
  { id: "f_b", company: "B", url: "https://b.invalid/p", currency: "USD", parserVersion: "t1", rules: { H100: rule, B200: rule } },
  { id: "f_c", company: "C", url: "https://c.invalid/p", currency: "USD", parserVersion: "t1", rules: { H100: rule, H200: rule } },
  { id: "f_e", company: "E", url: "https://e.invalid/p", currency: "EUR", parserVersion: "t1", rules: { H100: rule, H200: rule } },
];

function micro(s: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`bad decimal ${s}`);
  const [i, f = ""] = s.split(".");
  return BigInt(i!) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
}

export function toValueU(native: string, currency: Currency, gpuCount: number, fx?: FxRate): number {
  const X = micro(native) * (currency === "USD" ? 1_000_000n : micro(fx!.usdPerEur));
  const g = BigInt(gpuCount);
  return Number(((200n * X + 10n ** 12n * g) / (2n * 10n ** 12n * g)) * 10_000n);
}

export const fakeSources: SourcesPureApi = {
  SOURCES: FAKE_SOURCES,
  parse(id: string, body: string, ctx: ParseContext): ParseResult {
    const def = FAKE_SOURCES.find((s) => s.id === id);
    const out: ParseResult = {};
    if (!def) return out;
    if (body === "THROW") throw new Error("boom");
    let j: Record<string, string | null> | null = null;
    try {
      j = JSON.parse(body);
    } catch {
      j = null;
    }
    for (const g of ["H100", "H200", "B200"] as const) {
      if (!def.rules[g]) continue;
      const v = j?.[g];
      if (j === null || v === undefined) out[g] = { state: "NO_ROW", valueU: 0 };
      else if (v === null) out[g] = { state: "NOT_RENTABLE", valueU: 0 };
      else {
        const u = toValueU(v, def.currency, 1, ctx.fx);
        out[g] = u < 100_000 || u > 1_000_000_000 ? { state: "BAD_VALUE", valueU: 0 } : { state: "VALID", valueU: u, raw: v };
      }
    }
    return out;
  },
  parseEcb(body: string, forUtcDate: string): FxRate | null {
    const j = JSON.parse(body) as Record<string, string>;
    const d = Object.keys(j)
      .filter((k) => k < forUtcDate)
      .sort()
      .pop();
    return d ? { date: d, usdPerEur: j[d]! } : null;
  },
  toValueU,
  slotValues(panel: Panel, rows) {
    return panel.slots.map((s) => {
      const r = rows[s.sourceId]?.[panel.gpu];
      return r?.state === "VALID" ? r.valueU : 0;
    });
  },
  recipeHash: (p: Panel): Hex => keccak256(toHex(JSON.stringify(p))),
  gpuIdOf: (spec: string): Hex => keccak256(toHex(spec)),
};

function panel(gpu: "H100" | "H200" | "B200", ids: string[]): Panel {
  const spec = `${gpu}-SXM/on-demand-list/neocloud/v1`;
  return {
    gpu,
    spec,
    gpuId: fakeSources.gpuIdOf(spec),
    families: ids.map((id) => ({ name: id, famQ: 1 })),
    slots: ids.map((sourceId, i) => ({ slot: i, sourceId, family: i, liveAtStart: true })),
  };
}

export const PANELS: Panel[] = [panel("H100", ["f_a", "f_b", "f_c", "f_e"]), panel("H200", ["f_a", "f_c", "f_e"]), panel("B200", ["f_a", "f_b"])];

export const PAGES: Record<string, string> = {
  f_a: JSON.stringify({ H100: "2.99", H200: "3.49", B200: "5.25" }),
  f_b: JSON.stringify({ H100: "6.155", B200: null }),
  f_c: JSON.stringify({ H100: "3.10", H200: "3.80" }),
  f_e: JSON.stringify({ H100: "2.27", H200: null }),
  fx_ecb: JSON.stringify({ "2026-09-29": "1.1700", "2026-09-30": "1.1734" }),
};
