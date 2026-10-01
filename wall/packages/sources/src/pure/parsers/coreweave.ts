// CoreWeave: "On-demand GPU instances", North America block; per-instance prices with a GPU count.
import type { GpuModel } from "@agate/report/types";
import type { ParseContext } from "../../types.ts";
import { agree, type Cell, classifyPrice, elements, indexOfFirst, indexOfOnly, LayoutError, nearest, positions, textOf } from "../text.ts";

const PRODUCTS: Record<GpuModel, { slug: string; name: string }> = {
  H100: { slug: "hgx-h100", name: "NVIDIA HGX H100" },
  H200: { slug: "hgx-h200", name: "NVIDIA HGX H200" },
  B200: { slug: "nvidia-b200", name: "NVIDIA HGX B200" },
};
const HEADERS = [
  "GPU Model",
  "GPU Count",
  "VRAM (GB)",
  "vCPUs",
  "System RAM (GB)",
  "Local Storage (TB)",
  "On-Demand Price (Per Hour)",
  "Spot Price (Per Hour)",
];
const PRICE = /^\$(\d[\d,]*(?:\.\d+)?)$/;
const CELL = '<div class="table-v2-cell">';

function rowCell(row: string, g: GpuModel): Cell {
  const { slug, name } = PRODUCTS[g];
  const names = elements(row, /<h3\b([^<>]*)>/g, "</h3>")
    .filter((e) => /class="table-model-name"/.test(e.open[1]!))
    .map((e) => textOf(e.inner));
  if (names.length === 0 || names.some((n) => n !== name)) throw new LayoutError(`${slug}: model name ${JSON.stringify(names.slice(0, 3))} is not ${name}`);
  // The grid cells after the name cell, in header order: count, VRAM, vCPUs, RAM, storage, on-demand, spot, ...
  // Each runs to the next cell or column marker (boundaries collected in one pass: linear in the row).
  const starts = positions(row, CELL);
  const bounds = [...positions(row, '<div class="table-v2-cell'), ...positions(row, '<div class="table-cell-column'), row.length].sort((a, b) => a - b);
  const cells: string[] = [];
  let k = 0;
  for (const i of starts) {
    while (bounds[k]! <= i) k++;
    cells.push(textOf(row.slice(i + CELL.length, bounds[k])));
  }
  if (cells.length < 7) throw new LayoutError(`${slug}: ${cells.length} grid cells`);
  const count = cells[0]!;
  if (!/^\d{1,2}$/.test(count)) throw new LayoutError(`${slug}: GPU count ${JSON.stringify(count.slice(0, 20))}`);
  const meta = /<div class="table-meta-value">([^<>]*)<\/div>\s*<div>GPU Count<\/div>/.exec(row);
  if (!meta || meta[1]!.trim() !== count) throw new LayoutError(`${slug}: the two GPU count copies differ`);
  const mobile = /<span class="instance-price">On-Demand Price:\s*<span class="item-value">([^<>]*)<\/span>/.exec(row);
  if (!mobile) throw new LayoutError(`${slug}: no mobile on-demand copy`);
  const n = Number(count);
  const where = `NA ${name} x${n}`;
  const cell = classifyPrice(cells[5]!, PRICE, n, where, "USD");
  if (cell.kind === "price" && textOf(mobile[1]!) !== cells[5]) {
    return { kind: "error", code: "layout-changed", why: `${where}: on-demand ${cells[5]} but mobile copy ${JSON.stringify(mobile[1])}` };
  }
  if (cell.kind === "price" && n !== 8 && n !== 1) return { kind: "missing", why: `${where}: only a ${n}-GPU instance` };
  return cell;
}

export function extractCoreWeave(body: string, _ctx: ParseContext): Partial<Record<GpuModel, Cell>> {
  const anchor = indexOfOnly(body, ">On-demand GPU instances</h2>", "On-demand GPU instances heading");
  const sectionEnd = indexOfFirst(body, "</section>", "end of the GPU section", anchor);
  const start = body.indexOf("REGION: NORTH AMERICA</strong>", anchor);
  if (start < 0 || start > sectionEnd) throw new LayoutError("no North America block in the GPU section");
  const end = Math.min(nearest(body, start + 10, ["REGION:"]), sectionEnd);
  const region = body.slice(start, end);
  const firstRow = region.indexOf('role="listitem"');
  if (firstRow < 0) throw new LayoutError("North America block has no rows");
  const heads = elements(region.slice(0, firstRow), /<div class="table-header-text">/g, "</div>").map((e) => textOf(e.inner));
  if (heads.slice(0, HEADERS.length).join("|") !== HEADERS.join("|")) throw new LayoutError(`header is ${JSON.stringify(heads.slice(0, 10))}`);
  const rows = region.split('<div role="listitem"').slice(1);

  const out: Partial<Record<GpuModel, Cell>> = {};
  for (const g of Object.keys(PRODUCTS) as GpuModel[]) {
    const mine = rows.filter((r) => r.includes(`data-product="${PRODUCTS[g].slug}"`));
    try {
      out[g] = mine.length ? agree(mine.map((r) => rowCell(r, g)), `NA ${PRODUCTS[g].name}`) : { kind: "missing", why: `no ${PRODUCTS[g].slug} row in North America` };
    } catch (e) {
      if (!(e instanceof LayoutError)) throw e;
      out[g] = { kind: "error", code: "layout-changed", why: e.message };
    }
  }
  return out;
}
