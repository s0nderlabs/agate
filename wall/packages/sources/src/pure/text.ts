// String helpers for the parsers: no DOM, no Node, regex and indexOf only.
// Every parser refuses to read (throws LayoutError, or returns an error cell) when a structural anchor moves.

export class LayoutError extends Error {
  override name = "LayoutError";
}

/** What an extractor found for one GPU, before money math. */
export type Cell =
  | { kind: "price"; raw: string; gpuCount: number; where: string }
  | { kind: "not-rentable"; text: string; where: string }
  | { kind: "missing"; why: string }
  | { kind: "error"; code: "parse-error" | "ambiguous" | "layout-changed" | "other-currency"; why: string };

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  euro: "\u20ac",
  dollar: "$",
  reg: "\u00ae",
  trade: "\u2122",
  times: "\u00d7",
  mdash: "-",
  ndash: "-",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});/g, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      if (!Number.isFinite(cp) || cp > 0x10ffff) return m;
      return cp === 0xa0 ? " " : String.fromCodePoint(cp);
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML comments removed in one linear pass (an unclosed comment hides the rest, as in a browser). */
function stripComments(s: string): string {
  let out = "";
  let i = 0;
  for (let open = s.indexOf("<!--"); open >= 0; open = s.indexOf("<!--", i)) {
    out += `${s.slice(i, open)} `;
    const close = s.indexOf("-->", open + 4);
    if (close < 0) return out;
    i = close + 3;
  }
  return out + s.slice(i);
}

/** Visible text of an HTML fragment: tags and comments become spaces, entities decoded, whitespace collapsed. */
export function textOf(html: string): string {
  return decodeEntities(stripComments(html).replace(/<[^<>]*>/g, " "))
    .replace(/[\s\u00a0\u200b]+/g, " ")
    .trim();
}

export interface Element {
  open: RegExpExecArray; // the opening match (its groups carry attributes)
  inner: string; // text between the opening match and the close marker
}

/**
 * Every element from a match of `open` (a global regex for the opening tag, written so it cannot run past the next
 * "<", e.g. [^<>]* for attributes) to the next `close` marker. Linear time: scanning resumes after each close, and an
 * opening without a close ends the scan, so no page can make a parser quadratic (lazy [\s\S]*? regexes can).
 */
export function elements(s: string, open: RegExp, close: string): Element[] {
  if (!open.global) throw new Error("elements needs a global regex");
  const out: Element[] = [];
  open.lastIndex = 0;
  for (let m = open.exec(s); m; m = open.exec(s)) {
    const from = m.index + m[0].length;
    const end = s.indexOf(close, from);
    if (end < 0) break;
    out.push({ open: m, inner: s.slice(from, end) });
    open.lastIndex = end + close.length;
  }
  return out;
}

/** The inner text of the first element, or null. */
export function firstElement(s: string, open: RegExp, close: string): string | null {
  return elements(s, open, close)[0]?.inner ?? null;
}

/** Every index where needle starts (non-overlapping), in order. */
export function positions(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

export function countOf(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Index of the single occurrence of needle at or after from; LayoutError when it is absent or not unique. */
export function indexOfOnly(hay: string, needle: string, what: string, from = 0): number {
  const i = hay.indexOf(needle, from);
  if (i < 0) throw new LayoutError(`anchor missing: ${what}`);
  if (hay.indexOf(needle, i + needle.length) >= 0) throw new LayoutError(`anchor not unique: ${what}`);
  return i;
}

/** Index of the first occurrence at or after from; LayoutError when absent. */
export function indexOfFirst(hay: string, needle: string, what: string, from = 0): number {
  const i = hay.indexOf(needle, from);
  if (i < 0) throw new LayoutError(`anchor missing: ${what}`);
  return i;
}

/** The end of a region: the nearest of several markers after from, or the end of the string. */
export function nearest(hay: string, from: number, markers: readonly string[]): number {
  let end = hay.length;
  for (const m of markers) {
    const i = hay.indexOf(m, from);
    if (i >= 0 && i < end) end = i;
  }
  return end;
}

export function allMatches(re: RegExp, s: string): RegExpExecArray[] {
  if (!re.global) throw new Error("allMatches needs a global regex");
  const out: RegExpExecArray[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    out.push(m);
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

// Not orderable now (rule 6). Checked on the whole cell text, case-insensitive.
const NOT_RENTABLE =
  /^(?:n\/?a|-|sold out|out of stock|waitlist|wait ?list|join (?:the )?waitlist|contact (?:sales|us)|talk to (?:sales|us|our team)|coming soon|unavailable|not available|notify me|request access|reserve(?: now)?)$/i;
const FOREIGN = /(?:\u20ac|\u00a3|\u00a5|\u20aa|\u20b9|\bEUR\b|\bGBP\b|\bJPY\b|\bILS\b|\bINR\b|\bCHF\b|\bCAD\b|\bAUD\b|\bSGD\b|C\$|A\$|S\$)/;

/**
 * Classifies the visible text of one price cell. `pattern` must capture the bare decimal in group 1 and match
 * the whole cell (the source's exact currency marks and suffixes). A cell in another currency is never read.
 */
export function classifyPrice(text: string, pattern: RegExp, gpuCount: number, where: string, homeCurrency: "USD" | "EUR"): Cell {
  const t = text.replace(/\s+/g, " ").trim();
  const m = pattern.exec(t);
  if (m?.[1] !== undefined) return { kind: "price", raw: m[1], gpuCount, where };
  if (NOT_RENTABLE.test(t.replace(/^[$\u20ac\u00a3]\s*|\s*[$\u20ac\u00a3]$/g, ""))) return { kind: "not-rentable", text: t, where };
  const foreign = homeCurrency === "USD" ? FOREIGN.test(t) : /\$|\bUSD\b|\u00a3|\u00a5/.test(t);
  if (foreign) return { kind: "error", code: "other-currency", why: `${where}: price cell in another currency: ${JSON.stringify(t.slice(0, 40))}` };
  return { kind: "error", code: "parse-error", why: `${where}: unreadable price cell ${JSON.stringify(t.slice(0, 60))}` };
}

/** Several cells for one GPU (duplicate rows, several platforms): they must agree, or nothing is read. */
export function agree(cells: readonly Cell[], what: string): Cell {
  if (cells.length === 0) return { kind: "missing", why: `no ${what} row` };
  const err = cells.find((c) => c.kind === "error");
  if (err) return err;
  const key = (c: Cell) => (c.kind === "price" ? `p:${c.raw}/${c.gpuCount}` : c.kind === "not-rentable" ? "nr" : `m`);
  const k0 = key(cells[0]!);
  if (cells.every((c) => key(c) === k0)) return cells[0]!;
  return {
    kind: "error",
    code: "ambiguous",
    why: `${cells.length} ${what} rows disagree: ${cells.map((c) => (c.kind === "price" ? `${c.raw}/${c.gpuCount}` : c.kind)).join(", ")}`,
  };
}
