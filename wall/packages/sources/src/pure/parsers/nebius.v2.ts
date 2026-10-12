// Nebius, second reader: the docs pricing page as Markdown, as nebius/1, plus the dated block Nebius added on
// Oct 8 2026, "Item - from October 1 until October 8, 2026" (a price that held between two dates), beside the
// "from X" and "before X" blocks. nebius/1 does not know that header, so it read the block's rows into the block
// above and found every GPU twice. The block in effect is still chosen by date; a range counts from 00:00 UTC of its
// first date until 00:00 UTC of its last.
import type { GpuModel } from "@agate/report/types";
import type { ParseContext } from "../../types.ts";
import { agree, type Cell, classifyPrice, LayoutError } from "../text.ts";

const REG = "\u00ae"; // the registered sign Nebius writes after NVIDIA
const DASH = "[\\u2014\\u2013-]";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// "from M D, Y" | "before M D, Y" | "from M D[, Y] until M D, Y" (the first date's year may be left out)
const HEADER = new RegExp(
  `^\\|\\s*\\*\\*Item(?:\\s*${DASH}\\s*((from|before)\\s+([A-Z][a-z]+)\\s+(\\d{1,2})(?:,\\s+(\\d{4}))?(?:\\s+until\\s+([A-Z][a-z]+)\\s+(\\d{1,2}),\\s+(\\d{4}))?))?\\*\\*\\s*\\|\\s*\\*\\*Price\\*\\*\\s*\\|\\s*\\*\\*Per\\*\\*\\s*\\|$`,
);
const DIVIDER = /^\|\s*-+\s*\|\s*-+\s*\|\s*-+\s*\|$/;
const ROW = /^\|([^|]*)\|([^|]*)\|([^|]*)\|$/;
const PRICE = /^\\?\$(\d[\d,]*(?:\.\d+)?)$/;

interface Block {
  kind: "plain" | "since" | "before" | "range"; // since: a page's "from X" (gate 1 refuses that word as a string)
  head: string; // the dated phrase as the page writes it, for diagnostics ("" for plain)
  at: number; // unix seconds of 00:00 UTC of the (first) date (0 for plain)
  until: number; // a range's end, 00:00 UTC of its last date (0 otherwise)
  rows: { item: string; price: string; per: string }[];
}

const DAYS_IN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Unix seconds of 00:00 UTC of a calendar date (days from civil, with no Date: the reader runs under gate 1). */
function dateSec(month: string, day: string, year: string): number {
  const mo = MONTHS.indexOf(month);
  const d = Number(day);
  const y = Number(year);
  if (mo < 0) throw new LayoutError(`unknown month ${month}`);
  if (d < 1 || d > (mo === 1 && leap(y) ? 29 : DAYS_IN[mo | 0]!)) throw new LayoutError(`bad date ${month} ${day}, ${year}`);
  const yy = mo < 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (mo + 10) % 12; // March = 0 (0-based months)
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return (era * 146097 + doe - 719468) * 86400;
}

function headerBlock(h: RegExpExecArray): Block {
  const head = h[1] ?? "";
  const word = h[2];
  if (!word) return { kind: "plain", head, at: 0, until: 0, rows: [] };
  const [m1, d1, y1, m2, d2, y2] = [h[3]!, h[4]!, h[5], h[6], h[7], h[8]];
  if (!m2) {
    if (!y1) throw new LayoutError(`a ${word} date with no year`);
    return { kind: word === "before" ? "before" : "since", head, at: dateSec(m1, d1, y1), until: 0, rows: [] };
  }
  if (word === "before") throw new LayoutError("an until date after before");
  const until = dateSec(m2, d2!, y2!);
  // no year on the first date: the last date's year, or the year before when the start would come after the end
  let at = dateSec(m1, d1, y1 ?? y2!);
  if (!y1 && at > until) at = dateSec(m1, d1, String(Number(y2) - 1));
  if (at >= until) throw new LayoutError("a range that does not end after it starts");
  return { kind: "range", head, at, until, rows: [] };
}

function blocksOf(tab: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of tab.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const h = HEADER.exec(line);
    if (h) {
      blocks.push(headerBlock(h));
      continue;
    }
    if (DIVIDER.test(line)) continue;
    // a header this reader does not know is never read as a row of the block above it
    if (/^\|\s*\*\*Item\b/.test(line)) throw new LayoutError(`unknown Item header ${JSON.stringify(line.slice(0, 80))}`);
    const r = ROW.exec(line);
    if (!r) throw new LayoutError(`unexpected table line ${JSON.stringify(line.slice(0, 60))}`);
    const b = blocks[blocks.length - 1];
    if (!b) throw new LayoutError("table row before any Item header");
    b.rows.push({ item: r[1]!.trim(), price: r[2]!.trim(), per: r[3]!.trim() });
  }
  return blocks;
}

/** The block in effect at nowSec: of the "from X" blocks with X <= now and the ranges holding now, the one that
 *  started last; else a "before X" with X > now; else the plain one. Layouts this reader cannot place are refused:
 *  two blocks starting the same day, and a "from X" older than a range that has already ended (the range replaced
 *  it, so reading it again would bring back an old price). */
function inEffect(blocks: Block[], nowSec: number): Block | undefined {
  const plain = blocks.filter((b) => b.kind === "plain");
  const dated = blocks.filter((b) => b.kind !== "plain");
  if (plain.length > 1 || (plain.length === 1 && dated.length > 0)) throw new LayoutError("mixed or repeated undated Item blocks");
  if (plain.length === 1) return plain[0];
  const live = dated.filter((b) => (b.kind === "since" && b.at <= nowSec) || (b.kind === "range" && b.at <= nowSec && nowSec < b.until)).sort((a, b) => b.at - a.at);
  if (live.length > 1 && live[0]!.at === live[1]!.at) throw new LayoutError("two price blocks start the same day");
  const top = live[0];
  if (top && dated.some((b) => b.kind === "range" && b.until <= nowSec && b.at >= top.at)) throw new LayoutError("an ended range replaced the block that would be read");
  if (top) return top;
  return dated.filter((b) => b.kind === "before" && b.at > nowSec).sort((a, b) => a.at - b.at)[0];
}

export function extract(body: string, ctx: ParseContext): Partial<Record<GpuModel, Cell>> {
  if (!body.includes("# Compute pricing in Nebius AI Cloud")) throw new LayoutError("title missing");
  if (!body.includes("Prices in US dollars (USD, \\$)")) throw new LayoutError("USD statement missing");
  if (!body.includes("prices are shown without any applicable taxes")) throw new LayoutError("tax statement missing");
  const lines = body.split("\n");
  const out: Partial<Record<GpuModel, Cell>> = {};
  // the GPUs with an NVLink (SXM) platform section; B300 is "gpu-b300-sxm". L40S is sold as GPU, vCPU and RAM lines
  // with no instance price and is never read
  for (const g of ["H100", "H200", "B200", "B300"] as const) {
    const title = new RegExp(`^#### NVIDIA${REG} ${g} NVLink(?:, [a-z0-9-]+)?\\s*$`);
    const item = `NVIDIA${REG} ${g} NVLink`;
    const cells: Cell[] = [];
    try {
      for (let i = 0; i < lines.length; i++) {
        if (!title.test(lines[i | 0]!)) continue;
        let j = i + 1;
        while (j < lines.length && !/^#{2,4} /.test(lines[j | 0]!)) j++;
        const section = lines.slice(i + 1, j).join("\n");
        const open = section.indexOf('<Tab title="USD">');
        if (open < 0 || section.indexOf('<Tab title="USD">', open + 1) >= 0) throw new LayoutError(`${lines[i | 0]}: not exactly one USD tab`);
        const close = section.indexOf("</Tab>", open);
        if (close < 0) throw new LayoutError(`${lines[i | 0]}: USD tab not closed`);
        const block = inEffect(blocksOf(section.slice(open, close)), ctx.nowSec);
        const where = `${lines[i | 0]!.slice(5)} (${block ? block.head || block.kind : "none"})`;
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
