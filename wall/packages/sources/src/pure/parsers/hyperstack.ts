// Hyperstack: the "On-Demand GPU Pricing" card, per-GPU hourly prices.
import type { GpuModel } from "@agate/report/types";
import type { ParseContext } from "../../types.ts";
import { agree, type Cell, classifyPrice, elements, indexOfOnly, LayoutError, nearest, textOf } from "../text.ts";

/** The exact row name; vram: the VRAM (GB) cell the row must show (A100 80GB). "NVIDIA A100 NVLink" and "NVIDIA A100"
 * are PCIe cards and "NVIDIA L40" is not an L40S, so none is read (18.2). */
const NAMES: Partial<Record<GpuModel, { name: string; vram?: string }>> = {
  H100: { name: "NVIDIA H100 SXM" },
  H200: { name: "NVIDIA H200 SXM" },
  B200: { name: "NVIDIA B200" },
  B300: { name: "NVIDIA B300" },
  A100: { name: "NVIDIA A100 SXM", vram: "80" },
};
const HEADERS = ["GPU Model", "VRAM (GB)", "Max pCPUs per GPU", "Max RAM (GB) per GPU", "Pricing Per Hour"];
const PRICE = /^\$(\d[\d,]*(?:\.\d+)?)$/;
const ROW = '<div class="page-price_card_row_item df">';

export function extractHyperstack(body: string, _ctx: ParseContext): Partial<Record<GpuModel, Cell>> {
  const anchor = indexOfOnly(body, "<h3><span>On-Demand GPU</span> Pricing</h3>", "On-Demand GPU card");
  const card = body.slice(anchor, nearest(body, anchor + 10, ["<h3><span>"]));
  const heads = elements(card, /<div class="page-price_card_head_item page-price_card_head_item\d">\s*<span>/g, "</span>").map((e) => textOf(e.inner));
  if (heads.join("|") !== HEADERS.join("|")) throw new LayoutError(`header is ${JSON.stringify(heads.slice(0, 10))}`);
  const rows = card.split(ROW).slice(1);
  if (rows.length < 3) throw new LayoutError(`${rows.length} rows in the on-demand card`);
  const named = rows.map((r, i) => {
    const cols = elements(r, /page-price_card_row_item_col(\d)">\s*<span>/g, "</span>");
    if (cols.length !== 5 || cols.some((c, k) => c.open[1] !== String(k + 1))) throw new LayoutError(`row ${i}: ${cols.length} columns`);
    return { name: textOf(cols[0]!.inner), vram: textOf(cols[1]!.inner), price: textOf(cols[4]!.inner) };
  });
  const out: Partial<Record<GpuModel, Cell>> = {};
  for (const [g, { name, vram }] of Object.entries(NAMES) as [GpuModel, { name: string; vram?: string }][]) {
    // a row of the same name with another VRAM is another product: left out, as Lambda does
    const all = named.filter((r) => r.name === name);
    const mine = vram === undefined ? all : all.filter((r) => r.vram === vram);
    out[g] = mine.length
      ? agree(mine.map((r) => classifyPrice(r.price, PRICE, 1, `on-demand ${r.name}`, "USD")), name)
      : { kind: "missing", why: all.length ? `no ${name} row with ${vram} GB VRAM in the on-demand card` : `no ${name} row in the on-demand card` };
  }
  return out;
}
