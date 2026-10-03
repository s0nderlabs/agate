// Nebius: the docs pricing page as Markdown (one section per platform, USD and ILS tabs, dated blocks).
import type { GpuModel } from "@agate/report/types";
import type { ParseContext } from "../../types.ts";
import { agree, type Cell, classifyPrice, LayoutError } from "../text.ts";

const REG = "\u00ae"; // the registered sign Nebius writes after NVIDIA
const DASH = "[\\u2014\\u2013-]";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const HEADER = new RegExp(
  `^\\|\\s*\\*\\*Item(?:\\s*${DASH}\\s*(from|before)\\s+([A-Z][a-z]+)\\s+(\\d{1,2}),\\s+(\\d{4}))?\\*\\*\\s*\\|\\s*\\*\\*Price\\*\\*\\s*\\|\\s*\\*\\*Per\\*\\*\\s*\\|$`,
);
const DIVIDER = /^\|\s*-+\s*\|\s*-+\s*\|\s*-+\s*\|$/;
const ROW = /^\|([^|]*)\|([^|]*)\|([^|]*)\|$/;
const PRICE = /^\\?\$(\d[\d,]*(?:\.\d+)?)$/;
/** The GPUs with an NVLink (SXM) platform section; B300 is "gpu-b300-sxm" (18.2). L40S is sold as GPU, vCPU and RAM
 * lines with no instance price and is never read. */
const PLATFORMS: readonly GpuModel[] = ["H100", "H200", "B200", "B300"];

interface Block {
  kind: "plain" | "from" | "before";
  at: number; // unix seconds of 00:00 UTC of the date (0 for plain)
  rows: { item: string; price: string; per: string }[];
}

function dateSec(month: string, day: string, year: string): number {
  const mo = MONTHS.indexOf(month);
  const d = Number(day);
  const y = Number(year);
  if (mo < 0) throw new LayoutError(`unknown month ${month}`);
  const t = Date.UTC(y, mo, d);
  if (new Date(t).getUTCDate() !== d) throw new LayoutError(`bad date ${month} ${day}, ${year}`);
  return t / 1000;
}

function blocksOf(tab: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of tab.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const h = HEADER.exec(line);
    if (h) {
      blocks.push(h[1] ? { kind: h[1] as "from" | "before", at: dateSec(h[2]!, h[3]!, h[4]!), rows: [] } : { kind: "plain", at: 0, rows: [] });
      continue;
    }
    if (DIVIDER.test(line)) continue;
    const r = ROW.exec(line);
    if (!r) throw new LayoutError(`unexpected table line ${JSON.stringify(line.slice(0, 60))}`);
    const b = blocks[blocks.length - 1];
    if (!b) throw new LayoutError("table row before any Item header");
    b.rows.push({ item: r[1]!.trim(), price: r[2]!.trim(), per: r[3]!.trim() });
  }
  return blocks;
}

/** The block in effect at nowSec: the latest "from X" with X <= now, else a "before X" with X > now, else the plain one. */
function inEffect(blocks: Block[], nowSec: number): Block | undefined {
  const plain = blocks.filter((b) => b.kind === "plain");
  const dated = blocks.filter((b) => b.kind !== "plain");
  if (plain.length > 1 || (plain.length === 1 && dated.length > 0)) throw new LayoutError("mixed or repeated undated Item blocks");
  if (plain.length === 1) return plain[0];
  const from = dated.filter((b) => b.kind === "from" && b.at <= nowSec).sort((a, b) => b.at - a.at)[0];
  if (from) return from;
  return dated.filter((b) => b.kind === "before" && b.at > nowSec).sort((a, b) => a.at - b.at)[0];
}

export function extractNebius(body: string, ctx: ParseContext): Partial<Record<GpuModel, Cell>> {
  if (!body.includes("# Compute pricing in Nebius AI Cloud")) throw new LayoutError("title missing");
  if (!body.includes("Prices in US dollars (USD, \\$)")) throw new LayoutError("USD statement missing");
  if (!body.includes("prices are shown without any applicable taxes")) throw new LayoutError("tax statement missing");
  const lines = body.split("\n");
  const out: Partial<Record<GpuModel, Cell>> = {};
  for (const g of PLATFORMS) {
    const head = new RegExp(`^#### NVIDIA${REG} ${g} NVLink(?:, [a-z0-9-]+)?\\s*$`);
    const item = `NVIDIA${REG} ${g} NVLink`;
    const cells: Cell[] = [];
    try {
      for (let i = 0; i < lines.length; i++) {
        if (!head.test(lines[i]!)) continue;
        let j = i + 1;
        while (j < lines.length && !/^#{2,4} /.test(lines[j]!)) j++;
        const section = lines.slice(i + 1, j).join("\n");
        const open = section.indexOf('<Tab title="USD">');
        if (open < 0 || section.indexOf('<Tab title="USD">', open + 1) >= 0) throw new LayoutError(`${lines[i]}: not exactly one USD tab`);
        const close = section.indexOf("</Tab>", open);
        if (close < 0) throw new LayoutError(`${lines[i]}: USD tab not closed`);
        const block = inEffect(blocksOf(section.slice(open, close)), ctx.nowSec);
        const where = `${lines[i]!.slice(5)} (${block ? block.kind : "none"})`;
        if (!block) {
          cells.push({ kind: "missing", why: `${where}: no price block in effect` });
          continue;
        }
        const rows = block.rows.filter((r) => r.item === item);
        if (rows.length !== 1) {
          cells.push(rows.length === 0 ? { kind: "missing", why: `${where}: no ${item} row` } : { kind: "error", code: "ambiguous", why: `${where}: ${rows.length} rows` });
          continue;
        }
        const r = rows[0]!;
        if (r.per !== "1 GPU hour") throw new LayoutError(`${where}: unit ${JSON.stringify(r.per)}`);
        cells.push(classifyPrice(r.price, PRICE, 1, where, "USD"));
      }
      out[g] = agree(cells, `${g} platform`);
    } catch (e) {
      if (!(e instanceof LayoutError)) throw e;
      out[g] = { kind: "error", code: "layout-changed", why: e.message };
    }
  }
  return out;
}
