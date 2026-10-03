// Seeweb (EUR): one card per GPU, Standard/Spot switch, "Hourly Cost" per GPU of the default 1-GPU option.
import type { GpuModel } from "@agate/report/types";
import type { ParseContext } from "../../types.ts";
import { agree, allMatches, type Cell, classifyPrice, countOf, elements, firstElement, LayoutError, textOf } from "../text.ts";

/** The card name and the form its card must state: "GPU SXM" for H100 and H200, "GPU PCI" for L40S (its only form;
 * 18.2). The A100 card says "GPU PCI" and is never read. */
const CARDS: Partial<Record<GpuModel, { name: string; form: string }>> = {
  H100: { name: "NVIDIA H100", form: "GPU SXM" },
  H200: { name: "NVIDIA H200", form: "GPU SXM" },
  L40S: { name: "NVIDIA L40S", form: "GPU PCI" },
};
const PRICE = /^(\d[\d,]*(?:\.\d+)?) \u20ac$/;

export function extractSeeweb(body: string, _ctx: ParseContext): Partial<Record<GpuModel, Cell>> {
  // The Standard (on-demand) / Spot switch: exactly one, unchecked.
  const sw = allMatches(/<input class="js-switch" type="checkbox"([^<>]*)>/g, body);
  if (sw.length !== 1) throw new LayoutError(`${sw.length} Standard/Spot switches`);
  if (/checked/i.test(sw[0]![1]!)) throw new LayoutError("the Spot switch is on");
  if (countOf(body, '<div class="instances-type">Standard</div>') !== 1) throw new LayoutError("Standard label missing");
  const cards = body.split(/<div id="gpu\d+" class="cardType/).slice(1);
  if (cards.length < 3) throw new LayoutError(`${cards.length} GPU cards`);

  const out: Partial<Record<GpuModel, Cell>> = {};
  for (const [g, { name, form }] of Object.entries(CARDS) as [GpuModel, { name: string; form: string }][]) {
    const cells: Cell[] = [];
    for (const card of cards) {
      const cn = firstElement(card, /<span class="cardname">/g, "</span>");
      if (cn === null || textOf(cn) !== name) continue;
      try {
        if (!textOf(card).includes(`${form} |`)) {
          cells.push({ kind: "missing", why: `${name}: the card does not say ${form}` });
          continue;
        }
        const sel = firstElement(card, /<select class="gpu-params" name="card-number"[^<>]*>/g, "</select>");
        if (sel === null) throw new LayoutError(`${name}: no GPU count select`);
        const opts = elements(sel, /<option\b([^<>]*)>/g, "</option>");
        if (opts.length === 0 || !/value="1"/.test(opts[0]!.open[1]!) || opts.some((o) => /selected/i.test(o.open[1]!))) {
          throw new LayoutError(`${name}: the GPU count does not default to 1`);
        }
        const hourly = elements(card, /<h3>Hourly Cost<\/h3>\s*<p class="hourly">/g, "</p>");
        if (hourly.length !== 1) throw new LayoutError(`${name}: ${hourly.length} hourly costs`);
        cells.push(classifyPrice(textOf(hourly[0]!.inner), PRICE, 1, `${name} hourly`, "EUR"));
      } catch (e) {
        if (!(e instanceof LayoutError)) throw e;
        cells.push({ kind: "error", code: "layout-changed", why: e.message });
      }
    }
    out[g] = agree(cells, `${name} card`);
  }
  return out;
}
