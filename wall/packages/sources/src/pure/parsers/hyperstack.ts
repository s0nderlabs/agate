// Hyperstack: the "On-Demand GPU Pricing" card, per-GPU hourly prices.
import type { GpuModel } from "@agate/report/types";
import type { ParseContext } from "../../types.ts";
import { agree, type Cell, classifyPrice, elements, indexOfOnly, LayoutError, nearest, textOf } from "../text.ts";

const NAMES: Record<GpuModel, string> = { H100: "NVIDIA H100 SXM", H200: "NVIDIA H200 SXM", B200: "NVIDIA B200" };
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
    return { name: textOf(cols[0]!.inner), price: textOf(cols[4]!.inner) };
  });
  const out: Partial<Record<GpuModel, Cell>> = {};
  for (const g of Object.keys(NAMES) as GpuModel[]) {
    const mine = named.filter((r) => r.name === NAMES[g]);
    out[g] = mine.length
      ? agree(
          mine.map((r) => classifyPrice(r.price, PRICE, 1, `on-demand ${r.name}`, "USD")),
          NAMES[g],
        )
      : { kind: "missing", why: `no ${NAMES[g]} row in the on-demand card` };
  }
  return out;
}
