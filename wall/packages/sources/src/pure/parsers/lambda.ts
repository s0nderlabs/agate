// Lambda: the "Instances pricing" tabs (8x, 4x, 2x, 1x), each a table quoting PRICE/GPU/HR.
import type { GpuModel } from "@agate/report/types";
import type { ParseContext } from "../../types.ts";
import { agree, type Cell, classifyPrice, elements, firstElement, indexOfOnly, LayoutError, textOf } from "../text.ts";

const PLANS: Partial<Record<GpuModel, string>> = { H100: "NVIDIA H100 SXM", B200: "NVIDIA B200 SXM6" };
const PRICE = /^\$(\d[\d,]*(?:\.\d+)?)$/;
const HEADERS = ["Plan", "VRAM/GPU", "vCPUs", "RAM", "STORAGE", "PRICE/GPU/HR*"];

/** plan -> the price cell texts of every row with that plan in one tab's table. */
function readPanel(body: string, from: number, panelId: string, label: string): Map<string, string[]> {
  const start = indexOfOnly(body, `role="tabpanel" id="${panelId}"`, `${label} tab panel`, from);
  const end = body.indexOf("</table>", start);
  if (end < 0) throw new LayoutError(`${label} tab panel has no table`);
  const table = body.slice(start, end);
  const thead = firstElement(table, /<thead\b[^<>]*>/g, "</thead>");
  if (thead === null) throw new LayoutError(`${label} table has no header`);
  const heads = elements(thead, /<th\b[^<>]*>/g, "</th>").map((e) => textOf(e.inner));
  if (heads.join("|") !== HEADERS.join("|")) throw new LayoutError(`${label} table header is ${JSON.stringify(heads)}`);
  const rows = new Map<string, string[]>();
  for (const tr of elements(table, /<tr\b([^<>]*)>/g, "</tr>")) {
    const dp = /\bdata-plan="([^"<>]*)"/.exec(tr.open[1]!);
    if (!dp) continue;
    const plan = dp[1]!;
    const th = elements(tr.inner, /<th\b([^<>]*)>/g, "</th>").filter((e) => /data-label="Plan"/.test(e.open[1]!));
    if (th.length !== 1 || textOf(th[0]!.inner) !== plan) throw new LayoutError(`${label} row ${plan}: plan cell differs from data-plan`);
    const cells = elements(tr.inner, /<td\b([^<>]*)>/g, "</td>").filter((e) => /data-label="PRICE\/GPU\/HR\*"/.test(e.open[1]!));
    if (cells.length !== 1) throw new LayoutError(`${label} row ${plan}: ${cells.length} price cells`);
    const list = rows.get(plan) ?? [];
    list.push(textOf(cells[0]!.inner));
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
  for (const [g, plan] of Object.entries(PLANS) as [GpuModel, string][]) {
    const [label, texts] = eight.has(plan) ? ["8x", eight.get(plan)!] : one.has(plan) ? ["1x", one.get(plan)!] : ["", []];
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
