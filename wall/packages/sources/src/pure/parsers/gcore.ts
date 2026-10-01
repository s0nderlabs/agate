// Gcore (EUR): the "Virtual GPU" table (pay only while powered on). The bare-metal table above it is never read:
// its pricing model (on-demand or a commitment) is not stated in the served page.
import type { GpuModel } from "@agate/report/types";
import type { ParseContext } from "../../types.ts";
import { agree, type Cell, classifyPrice, elements, firstElement, indexOfFirst, indexOfOnly, LayoutError, textOf } from "../text.ts";

const HEADERS = ["GPU Configuration", "GPU Memory", "CPU/RAM", "Storage", "Cost per hour"];
const PRICE = /^\u20ac(\d[\d,]*(?:\.\d+)?)$/;
const ROW = /^(\d{1,2})\u00d7(H100|H200|B200)$/;

export function extractGcore(body: string, _ctx: ParseContext): Partial<Record<GpuModel, Cell>> {
  const start = indexOfOnly(body, 'id="virtual-gpu"', "Virtual GPU section");
  const section = body.slice(start, indexOfFirst(body, "</section>", "end of the Virtual GPU section", start));
  const h2 = elements(section, /<h2\b[^<>]*>/g, "</h2>").map((e) => textOf(e.inner));
  if (!h2.includes("Virtual GPU")) throw new LayoutError("Virtual GPU heading missing");
  if (!section.includes("Pay only while powered on")) throw new LayoutError("pay-as-you-go statement missing");
  if (!section.includes('value="EUR" checked') || section.includes('value="USD" checked')) {
    throw new LayoutError("the Virtual GPU table is not served in EUR");
  }
  const tables = elements(section, /<table\b[^<>]*>/g, "</table>");
  if (tables.length !== 1) throw new LayoutError(`${tables.length} tables in the Virtual GPU section`);
  const table = tables[0]!.inner;
  const thead = firstElement(table, /<thead\b[^<>]*>/g, "</thead>");
  if (thead === null) throw new LayoutError("Virtual GPU table has no header");
  const heads = elements(thead, /<th\b[^<>]*>/g, "</th>").map((e) => textOf(e.inner));
  if (heads.slice(0, HEADERS.length).join("|") !== HEADERS.join("|")) throw new LayoutError(`header is ${JSON.stringify(heads.slice(0, 10))}`);
  const rows = elements(table.slice(table.indexOf("</thead>")), /<tr\b[^<>]*>/g, "</tr>").map((tr) => elements(tr.inner, /<td\b[^<>]*>/g, "</td>").map((c) => textOf(c.inner)));
  if (rows.length === 0) throw new LayoutError("Virtual GPU table has no rows");

  const sized: Record<string, Map<number, Cell[]>> = {};
  for (const r of rows) {
    if (r.length < 5) throw new LayoutError(`a row with ${r.length} cells`);
    const m = ROW.exec(r[0]!);
    if (!m) continue;
    const n = Number(m[1]);
    const by = (sized[m[2]!] ??= new Map());
    const list = by.get(n) ?? [];
    list.push(classifyPrice(r[4]!, PRICE, n, `Virtual GPU ${n}x${m[2]}`, "EUR"));
    by.set(n, list);
  }
  const out: Partial<Record<GpuModel, Cell>> = {};
  for (const g of ["H100", "H200"] as GpuModel[]) {
    const by = sized[g];
    const pick = by?.has(8) ? 8 : by?.has(1) ? 1 : 0;
    out[g] = pick ? agree(by!.get(pick)!, `Virtual GPU ${pick}x${g}`) : { kind: "missing", why: `no 8x or 1x ${g} row in the Virtual GPU table` };
  }
  return out;
}
