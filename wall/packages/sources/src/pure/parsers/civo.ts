// Civo: one table per GPU (caption "<GPU> GPU pricing"), rows "<n> x NVIDIA ...", an On-demand cell per row.
import type { GpuModel } from "@agate/report/types";
import type { ParseContext } from "../../types.ts";
import { agree, type Cell, classifyPrice, countOf, elements, firstElement, LayoutError, textOf } from "../text.ts";

const TABLES: Record<GpuModel, { caption: string; row: RegExp }> = {
  H100: { caption: "NVIDIA H100 SXM GPU pricing", row: /^(\d{1,2}) x NVIDIA H100 - 80GB$/ },
  H200: { caption: "NVIDIA H200 SXM GPU pricing", row: /^(\d{1,2}) x NVIDIA H200 - 141GB HBM3e$/ },
  B200: { caption: "NVIDIA B200 GPU pricing", row: /^(\d{1,2}) x NVIDIA B200 - 180GB$/ },
};
const HEADERS = ["Size", "RAM", "vCPU", "Storage", "Data Transfer", "On-demand", "Commitment"];
const PRICE = /^\$(\d[\d,]*(?:\.\d+)?)$/;

export function extractCivo(body: string, _ctx: ParseContext): Partial<Record<GpuModel, Cell>> {
  if (countOf(body, 'class="pricing-data on-demand-pricing"') < 3) throw new LayoutError("on-demand pricing cells missing");
  const out: Partial<Record<GpuModel, Cell>> = {};
  for (const g of Object.keys(TABLES) as GpuModel[]) {
    const { caption, row } = TABLES[g];
    try {
      const n = countOf(body, `<caption>${caption}</caption>`);
      if (n === 0) {
        out[g] = { kind: "missing", why: `no table captioned ${caption}` };
        continue;
      }
      if (n > 1) throw new LayoutError(`${n} tables captioned ${caption}`);
      const start = body.indexOf(`<caption>${caption}</caption>`);
      const end = body.indexOf("</table>", start);
      if (end < 0) throw new LayoutError(`${caption}: table not closed`);
      const table = body.slice(start, end);
      const heads = elements(table, /<th\b[^<>]*>/g, "</th>").map((e) => textOf(e.inner));
      if (heads.join("|") !== HEADERS.join("|")) throw new LayoutError(`${caption}: header is ${JSON.stringify(heads.slice(0, 10))}`);
      const tbody = table.indexOf("<tbody>");
      if (tbody < 0) throw new LayoutError(`${caption}: no table body`);
      const sized = new Map<number, Cell[]>();
      for (const tr of elements(table.slice(tbody), /<tr\b[^<>]*>/g, "</tr>")) {
        const detail = firstElement(tr.inner, /<div class="product-detail">/g, "</div>");
        if (detail === null) throw new LayoutError(`${caption}: a row without a product line`);
        const m = row.exec(textOf(detail));
        if (!m) continue; // another product in the same table is never read
        const count = Number(m[1]);
        const od = elements(tr.inner, /<td data-title="On-demand price" class="pricing-data on-demand-pricing">/g, "</td>");
        if (od.length !== 1) throw new LayoutError(`${caption} ${count}x: ${od.length} on-demand cells`);
        const hourly = elements(od[0]!.inner, /<div\b[^<>]*data-option="hourly"[^<>]*class="price-value">/g, "<span>per hour</span></div>");
        if (hourly.length !== 1) throw new LayoutError(`${caption} ${count}x: ${hourly.length} hourly on-demand values`);
        const list = sized.get(count) ?? [];
        list.push(classifyPrice(textOf(hourly[0]!.inner), PRICE, count, `${caption} ${count}x`, "USD"));
        sized.set(count, list);
      }
      const pick = sized.has(8) ? 8 : sized.has(1) ? 1 : 0;
      out[g] = pick ? agree(sized.get(pick)!, `${caption} ${pick}x`) : { kind: "missing", why: `${caption}: no 8x or 1x row` };
    } catch (e) {
      if (!(e instanceof LayoutError)) throw e;
      out[g] = { kind: "error", code: "layout-changed", why: e.message };
    }
  }
  return out;
}
