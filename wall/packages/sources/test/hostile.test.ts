// Hostile or broken pages: unclosed tags repeated thousands of times inside the very regions each parser scans.
// The parsers are linear (no lazy cross-tag regex), so every parse stays fast; CRE's QuickJS has no regex JIT, so a
// quadratic scan that takes 1 s here would take far longer there and could stall a whole run.
import { describe, expect, test } from "bun:test";
import { MAX_BODY_CHARS, parse, parseEcb, SOURCES } from "../src/pure/index.ts";
import { renderEcb, renderPage } from "../src/synthetic.ts";

const ctx = { utcDate: "2026-10-01", nowSec: Date.UTC(2026, 9, 1, 5) / 1000, fx: { date: "2026-09-30", usdPerEur: "1.1355" } };
const BOMBS = [
  '<tr data-plan="x">',
  "<tr>",
  "<td>",
  "<th>",
  "<thead>",
  "<table>",
  "<!--",
  "<",
  '<div class="table-header-text">',
  '<div class="table-v2-cell">',
  '<h3 class="table-model-name">',
  '<div class="table-meta-value">        ',
  '<div class="product-detail">',
  '<td data-title="On-demand price" class="pricing-data on-demand-pricing">',
  '<div data-option="hourly" class="price-value">',
  '<div class="page-price_card_head_item page-price_card_head_item1"><span>',
  'page-price_card_row_item_col1"><span>',
  '<span class="cardname">',
  '<option value="1">',
  "<h3>Hourly Cost</h3>",
  '<p class="hourly">',
  "<h2>",
  '<button role="tab" aria-controls="x">',
  "| **Item | **Price** |",
  "                                ",
];
// Insert points: just after anchors the parsers slice regions from.
const ANCHORS = ["<tbody>", "<thead>", '<div role="list">', '<div class="page-price_card_row">', '<div class="page-price_card_head df">', 'class="cardType', '<Tab title="USD">', '<figure class="table"><table>', "<caption>", 'role="tablist">', "[", "Item"];

function bombed(page: string, bomb: string): string[] {
  const reps = Math.max(1, Math.floor(200_000 / bomb.length));
  const blob = bomb.repeat(reps);
  const out: string[] = [];
  for (const a of ANCHORS) {
    const i = page.indexOf(a);
    if (i >= 0) out.push(page.slice(0, i + a.length) + blob + page.slice(i + a.length));
  }
  return out;
}

describe("hostile pages", () => {
  for (const s of SOURCES) {
    test(`${s.id}: every bomb parses in bounded time and never gives a wrong VALID value`, () => {
      const page = renderPage(s.id, Object.fromEntries(Object.keys(s.rules).map((g) => [g, { price: "3.99" }])));
      const good = parse(s.id, page, ctx);
      let worst = 0;
      for (const bomb of BOMBS) {
        for (const body of bombed(page, bomb)) {
          const t0 = performance.now();
          const r = parse(s.id, body, ctx);
          worst = Math.max(worst, performance.now() - t0);
          for (const [g, row] of Object.entries(r)) {
            if (row!.state === "VALID") expect(row!.valueU).toBe(good[g as "H100"]!.valueU);
          }
        }
      }
      expect(worst).toBeLessThan(250);
    });
  }

  test("parseEcb on a bombed file is bounded too", () => {
    for (const bomb of ['<Cube time="2026-09-30">', "<Cube ", "<"]) {
      const body = renderEcb({ "2026-09-30": "1.1355" }).replace("<Cube>", `<Cube>${bomb.repeat(Math.floor(200_000 / bomb.length))}`);
      const t0 = performance.now();
      parseEcb(body, "2026-10-01");
      expect(performance.now() - t0).toBeLessThan(250);
    }
  });

  test("a body far larger than any page is refused without scanning", () => {
    const big = "x".repeat(MAX_BODY_CHARS + 1);
    const t0 = performance.now();
    const r = parse("p_lambda", big, ctx);
    expect(performance.now() - t0).toBeLessThan(250);
    expect(r.H100!.detail).toMatch(/^layout-changed: body of/);
  });
});
