// Lambda: the "Instances pricing" tabs (8x, 4x, 2x, 1x), each a table quoting PRICE/GPU/HR.
import type { GpuModel } from "@agate/report/types";
import type { ParseContext } from "../../types.ts";
import { agree, type Cell, classifyPrice, elements, firstElement, indexOfOnly, LayoutError, textOf } from "../text.ts";

/** plan: the data-plan; vram: the VRAM/GPU cell when the plan name alone is not unique (A100: an 80 GB and a 40 GB
 * row share "NVIDIA A100 SXM", 18.2). */
const PLANS: Partial<Record<GpuModel, { plan: string; vram?: string }>> = {
  H100: { plan: "NVIDIA H100 SXM" },
  B200: { plan: "NVIDIA B200 SXM6" },
  A100: { plan: "NVIDIA A100 SXM", vram: "80 GB" },
};
const PRICE = /^\$(\d[\d,]*(?:\.\d+)?)$/;
const HEADERS = ["Plan", "VRAM/GPU", "vCPUs", "RAM", "STORAGE", "PRICE/GPU/HR*"];

interface PlanRow {
  price: string; // the price cell's text
  vram: string | null; // the VRAM/GPU cell's text, null when the row has none (read only where a plan needs it)
}

/** plan -> every row with that plan in one tab's table. */
function readPanel(body: string, from: number, panelId: string, label: string): Map<string, PlanRow[]> {
  const start = indexOfOnly(body, `role="tabpanel" id="${panelId}"`, `${label} tab panel`, from);
  const end = body.indexOf("</table>", start);
  if (end < 0) throw new LayoutError(`${label} tab panel has no table`);
  const table = body.slice(start, end);
  const thead = firstElement(table, /<thead\b[^<>]*>/g, "</thead>");
  if (thead === null) throw new LayoutError(`${label} table has no header`);
  const heads = elements(thead, /<th\b[^<>]*>/g, "</th>").map((e) => textOf(e.inner));
  if (heads.join("|") !== HEADERS.join("|")) throw new LayoutError(`${label} table header is ${JSON.stringify(heads)}`);
  const rows = new Map<string, PlanRow[]>();
  for (const tr of elements(table, /<tr\b([^<>]*)>/g, "</tr>")) {
    const dp = /\bdata-plan="([^"<>]*)"/.exec(tr.open[1]!);
    if (!dp) continue;
    const plan = dp[1]!;
    const th = elements(tr.inner, /<th\b([^<>]*)>/g, "</th>").filter((e) => /data-label="Plan"/.test(e.open[1]!));
    if (th.length !== 1 || textOf(th[0]!.inner) !== plan) throw new LayoutError(`${label} row ${plan}: plan cell differs from data-plan`);
    const tds = elements(tr.inner, /<td\b([^<>]*)>/g, "</td>");
    const cells = tds.filter((e) => /data-label="PRICE\/GPU\/HR\*"/.test(e.open[1]!));
    if (cells.length !== 1) throw new LayoutError(`${label} row ${plan}: ${cells.length} price cells`);
    const vram = tds.filter((e) => /data-label="VRAM\/GPU"/.test(e.open[1]!));
    const list = rows.get(plan) ?? [];
    list.push({ price: textOf(cells[0]!.inner), vram: vram.length === 1 ? textOf(vram[0]!.inner) : null });
    rows.set(plan, list);
  }
  if (rows.size === 0) throw new LayoutError(`${label} table has no data-plan rows`);
  return rows;
}

export function extractLambda(body: string, _ctx: ParseContext): Partial<Record<GpuModel, Cell>> {
  const anchor = indexOfOnly(body, ">Instances pricing</h2>", "Instances pricing heading");
  const list = body.indexOf('role="tablist"', anchor);
  if (list < 0 || list - anchor > 20_000) throw new LayoutError("no tab list after Instances pricing");
  const listEnd = body.indexOf("</div>", list);
  if (listEnd < 0) throw new LayoutError("tab list not closed");
  const tabs = new Map<string, string>();
  for (const b of elements(body.slice(list, listEnd), /<button\b([^<>]*)>/g, "</button>")) {
    const attrs = b.open[1]!;
    if (!/\brole="tab"/.test(attrs)) continue;
    const ctl = /\baria-controls="([^"<>]+)"/.exec(attrs);
    const label = textOf(b.inner);
    if (!ctl) throw new LayoutError(`tab ${label} controls no panel`);
    if (tabs.has(label)) throw new LayoutError(`tab ${label} twice`);
    tabs.set(label, ctl[1]!);
  }
  for (const need of ["8x", "1x"]) if (!tabs.has(need)) throw new LayoutError(`no ${need} tab (tabs: ${[...tabs.keys()].join(", ")})`);
  const eight = readPanel(body, anchor, tabs.get("8x")!, "8x");
  const one = readPanel(body, anchor, tabs.get("1x")!, "1x");

  const out: Partial<Record<GpuModel, Cell>> = {};
  for (const [g, { plan, vram }] of Object.entries(PLANS) as [GpuModel, { plan: string; vram?: string }][]) {
    if (vram !== undefined) {
      out[g] = byVram(eight, one, plan, vram);
      continue;
    }
    const [label, texts] = eight.has(plan) ? ["8x", eight.get(plan)!.map((r) => r.price)] : one.has(plan) ? ["1x", one.get(plan)!.map((r) => r.price)] : ["", []];
    if (!label) {
      out[g] = { kind: "missing", why: `no ${plan} row in the 8x or 1x tab` };
      continue;
    }
    out[g] = agree(
      texts.map((t) => classifyPrice(t, PRICE, 1, `${label} ${plan}`, "USD")),
      `${label} ${plan}`,
    );
  }
  return out;
}

/** The rows of a shared plan name whose VRAM/GPU cell is `vram`: the 8x tab's, else the 1x tab's. A row of that plan
 * without a VRAM/GPU cell cannot be told apart, so nothing is read for this GPU. */
function byVram(eight: Map<string, PlanRow[]>, one: Map<string, PlanRow[]>, plan: string, vram: string): Cell {
  for (const [label, tab] of [
    ["8x", eight],
    ["1x", one],
  ] as const) {
    const rows = tab.get(plan) ?? [];
    if (rows.some((r) => r.vram === null)) return { kind: "error", code: "layout-changed", why: `${label} ${plan}: a row without a VRAM/GPU cell` };
    const mine = rows.filter((r) => r.vram === vram);
    if (mine.length === 0) continue;
    return agree(
      mine.map((r) => classifyPrice(r.price, PRICE, 1, `${label} ${plan} ${vram}`, "USD")),
      `${label} ${plan} ${vram}`,
    );
  }
  return { kind: "missing", why: `no ${plan} ${vram} row in the 8x or 1x tab` };
}
