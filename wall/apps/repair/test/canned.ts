// Canned extractor sources the fake Claude "drafts" (test fixtures; strings, never loaded into the test process).
// The good ones keep gate 1's syntax rules (15.2): fixed keys from a for ... of over string literals, no Object.

const V1_LAMBDA = `
const PLANS: Partial<Record<GpuModel, string>> = { H100: "NVIDIA H100 SXM", B200: "NVIDIA B200 SXM6" };
const PRICE = /^\\$(\\d[\\d,]*(?:\\.\\d+)?)$/;
const HEADERS = ["Plan", "VRAM/GPU", "vCPUs", "RAM", "STORAGE", "PRICE/GPU/HR*"];

function readPanel(body: string, from: number, panelId: string, label: string): Map<string, string[]> {
  const start = indexOfOnly(body, \`role="tabpanel" id="\${panelId}"\`, \`\${label} tab panel\`, from);
  const end = body.indexOf("</table>", start);
  if (end < 0) throw new LayoutError(\`\${label} tab panel has no table\`);
  const table = body.slice(start, end);
  const thead = firstElement(table, /<thead\\b[^<>]*>/g, "</thead>");
  if (thead === null) throw new LayoutError(\`\${label} table has no header\`);
  const heads = elements(thead, /<th\\b[^<>]*>/g, "</th>").map((e) => textOf(e.inner));
  if (heads.join("|") !== HEADERS.join("|")) throw new LayoutError(\`\${label} table header differs\`);
  const rows = new Map<string, string[]>();
  for (const tr of elements(table, /<tr\\b([^<>]*)>/g, "</tr>")) {
    const dp = /\\bdata-plan="([^"<>]*)"/.exec(tr.open[1]!);
    if (!dp) continue;
    const plan = dp[1]!;
    const cells = elements(tr.inner, /<td\\b([^<>]*)>/g, "</td>").filter((e) => /data-label="PRICE\\/GPU\\/HR\\*"/.test(e.open[1]!));
    if (cells.length !== 1) throw new LayoutError(\`\${label} row \${plan}: \${cells.length} price cells\`);
    const list = rows.get(plan) ?? [];
    list.push(textOf(cells[0]!.inner));
    rows.set(plan, list);
  }
  if (rows.size === 0) throw new LayoutError(\`\${label} table has no data-plan rows\`);
  return rows;
}

function oldLayout(body: string): Partial<Record<GpuModel, Cell>> {
  const anchor = indexOfOnly(body, ">Instances pricing</h2>", "Instances pricing heading");
  const list = body.indexOf('role="tablist"', anchor);
  if (list < 0) throw new LayoutError("no tab list");
  const listEnd = body.indexOf("</div>", list);
  const tabs = new Map<string, string>();
  for (const b of elements(body.slice(list, listEnd), /<button\\b([^<>]*)>/g, "</button>")) {
    const ctl = /\\baria-controls="([^"<>]+)"/.exec(b.open[1]!);
    if (ctl) tabs.set(textOf(b.inner), ctl[1]!);
  }
  if (!tabs.has("8x") || !tabs.has("1x")) throw new LayoutError("no 8x or 1x tab");
  const eight = readPanel(body, anchor, tabs.get("8x")!, "8x");
  const one = readPanel(body, anchor, tabs.get("1x")!, "1x");
  const out: Partial<Record<GpuModel, Cell>> = {};
  for (const g of ["H100", "B200"] as const) {
    const plan = PLANS[g]!;
    const [label, texts] = eight.has(plan) ? ["8x", eight.get(plan)!] : one.has(plan) ? ["1x", one.get(plan)!] : ["", []];
    if (!label) {
      out[g] = { kind: "missing", why: \`no \${plan} row\` };
      continue;
    }
    out[g] = agree(texts.map((t) => classifyPrice(t, PRICE, 1, \`\${label} \${plan}\`, "USD")), \`\${label} \${plan}\`);
  }
  return out;
}
`;

const cards = (cls: string) => `
function cards(body: string): Partial<Record<GpuModel, Cell>> {
  const out: Partial<Record<GpuModel, Cell>> = {};
  const all = elements(body, /<article class="gpu-card" data-model="([A-Z0-9]+)">/g, "</article>");
  for (const g of ["H100", "B200"] as const) {
    const card = all.find((c) => c.open[1] === g);
    if (!card) continue;
    const cell = textOf(firstElement(card.inner, /<dd class="gpu-card__price gpu-card__price--${cls}">/g, "</dd>") ?? "");
    let m = /^\\$(\\d[\\d,]*(?:\\.\\d+)?) per GPU per hour$/.exec(cell);
    if (m) {
      out[g] = { kind: "price", raw: m[1]!, gpuCount: 1, where: "card" };
      continue;
    }
    m = /^\\$(\\d[\\d,]*(?:\\.\\d+)?) per hour for (\\d+) GPUs$/.exec(cell);
    if (m) {
      out[g] = { kind: "price", raw: m[1]!, gpuCount: Number(m[2]), where: "card" };
      continue;
    }
    out[g] = classifyPrice(cell, /^\\$(\\d[\\d,]*(?:\\.\\d+)?)$/, 1, "card", "USD");
  }
  return out;
}
`;

const HEAD = `import type { GpuModel } from "@agate/report/types";
import type { Extractor } from "../../types.ts";
import { agree, type Cell, classifyPrice, elements, firstElement, indexOfOnly, LayoutError, textOf } from "../text.ts";
`;

/** Reads both layouts, the on-demand card on the new one: passes every gate. */
export const GOOD_V2 = `${HEAD}${V1_LAMBDA}${cards("ondemand")}
export const extract: Extractor = (body, _ctx) => (body.includes('class="gpu-cards"') ? cards(body) : oldLayout(body));
`;

/** Reads the spot card on the new layout: fails gate 3 (far from the trackers). */
export const SPOT_V2 = `${HEAD}${V1_LAMBDA}${cards("spot")}
export const extract: Extractor = (body, _ctx) => (body.includes('class="gpu-cards"') ? cards(body) : oldLayout(body));
`;

/** Reads only the new layout: fails gate 2 (old pages read differently). */
export const NEW_ONLY_V2 = `${HEAD}${cards("ondemand")}
export const extract: Extractor = (body, _ctx) => cards(body);
`;

export const LOOP_V2 = `import type { Extractor } from "../../types.ts";
export const extract: Extractor = (_body, _ctx) => {
  let n = 0;
  for (;;) n++;
};
`;

/** Bypasses gate 1 on purpose (tests call the sandbox directly): tries a socket and a file write at import time. */
export const ESCAPE_V2 = (port: number, outside: string) => `import type { Extractor } from "../../types.ts";
try { await fetch("http://127.0.0.1:${port}/escape"); } catch {}
try { require("node:fs").writeFileSync(${JSON.stringify(outside)}, "escaped"); } catch {}
export const extract: Extractor = (_body, _ctx) => ({});
`;
