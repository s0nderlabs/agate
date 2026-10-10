// The docs search. At build, every chapter becomes one entry for the chapter itself (its title, description and the
// text before its first section) and one per H2 and H3 section (an H4's words count toward the section above it),
// each with its whole text; the list is served as /docs/search.json. In the browser, every word of the query must
// match a whole word of an entry (a plural counts), except the last, which may also be the start of a word while it is
// still being typed. A match in the chapter's title weighs 6, in the section's heading 4, in its text 1; a chapter's
// own entry gets a small lift over its sections. A query whose words sit in different sections of one chapter (none
// holds them all) still finds that chapter, ranked below the entries that hold every word. Plain functions over plain
// data: no dependencies.
import type { Heading, NavGroup, Section } from "./types";

/** One stop in the index: a chapter's own entry (heading and id null) or one of its H2 or H3 sections. */
export interface SearchEntry {
  slug: string;
  /** the chapter's title */
  chapter: string;
  heading: string | null;
  /** the section's anchor */
  id: string | null;
  /** plain text: a chapter's description, headline and opening text, or a section's text */
  text: string;
}

/** A run of text, marked when it is what the query matched. */
export interface Part {
  text: string;
  mark: boolean;
}

export interface Hit {
  entry: SearchEntry;
  score: number;
  /** what the hit is called, matches marked: the section's heading, or the chapter's title on its own entry */
  name: Part[];
  /** about SNIPPET characters of the text around the first match, matches marked */
  snippet: Part[];
}

export const SNIPPET = 140;
export const LIMIT = 20;
const WEIGHT = { title: 6, heading: 4, body: 1 } as const;
const CHAPTER_LIFT = 0.5;
/** a chapter found only across its sections ranks at this share of its words' best weights */
const SPREAD = 0.5;
const MAX_TERMS = 8;

/** What the build hands over for each chapter (content.ts's Chapter has these fields). */
export interface ChapterSource {
  slug: string;
  title: string;
  description: string;
  toc: Heading[];
  sections: Section[];
}

/** `text` on one line, runs of white space as one space. */
export function tidy(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

/** The index the build writes to /docs/search.json. */
export function buildSearchIndex(chapters: ChapterSource[]): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const c of chapters) {
    const listed = new Set(c.toc.filter((h) => h.depth === 2 || h.depth === 3).map((h) => h.id));
    const [lead, ...rest] = c.sections;
    // the headline, unless the description already says it
    const headline = lead?.heading && !c.description.toLowerCase().includes(lead.heading.toLowerCase()) ? lead.heading : "";
    const parts: { id: string | null; heading: string | null; text: string[] }[] = [{ id: null, heading: null, text: [c.description, headline, lead?.text ?? ""] }];
    for (const s of rest) {
      if (s.id && listed.has(s.id)) parts.push({ id: s.id, heading: s.heading, text: [s.text] });
      else parts[parts.length - 1].text.push(s.heading, s.text);
    }
    for (const p of parts) out.push({ slug: c.slug, chapter: c.title, heading: p.heading, id: p.id, text: tidy(p.text.filter(Boolean).join(" ")) });
  }
  return out;
}

/** The same shape from the sidebar's own data (titles, descriptions, H2s), searched until the full index lands. */
export function navIndex(nav: NavGroup[]): SearchEntry[] {
  return nav.flatMap((g) =>
    g.chapters.flatMap((c) => [
      { slug: c.slug, chapter: c.title, heading: null, id: null, text: c.description },
      ...c.sections.map((s) => ({ slug: c.slug, chapter: c.title, heading: s.text, id: s.id, text: "" })),
    ]),
  );
}

const SPLIT = /[^\p{L}\p{N}]+/u;

function words(text: string) {
  return text.toLowerCase().split(SPLIT).filter(Boolean);
}

/** The query's words (at most eight), and whether the last one is still being typed (no space after it). */
export function parseQuery(query: string): { terms: string[]; prefix: boolean } {
  return { terms: words(query).slice(0, MAX_TERMS), prefix: !/\s$/.test(query) };
}

interface Field {
  set: Set<string>;
  list: string[];
}
function field(text: string): Field {
  const set = new Set(words(text));
  return { set, list: [...set] };
}

export interface PreparedIndex {
  entries: SearchEntry[];
  fields: { title: Field; heading: Field; body: Field }[];
}

/** The index with each entry's words split out once, so a keystroke only compares words. */
export function prepareIndex(entries: SearchEntry[]): PreparedIndex {
  const titles = new Map<string, Field>();
  const fields = entries.map((e) => {
    let title = titles.get(e.chapter);
    if (!title) titles.set(e.chapter, (title = field(e.chapter)));
    return { title, heading: field(e.heading ?? ""), body: field(e.text) };
  });
  return { entries, fields };
}

const SIBILANT = /(?:s|x|z|ch|sh)$/;
/** The whole words a term stands for: itself, its plural, and its singular when it looks like a plural. */
function forms(t: string) {
  const f = [t, SIBILANT.test(t) ? `${t}es` : `${t}s`];
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) f.push(t.slice(0, -1));
  if (t.length > 4 && t.endsWith("es") && SIBILANT.test(t.slice(0, -2))) f.push(t.slice(0, -2));
  return f;
}

function has(f: Field, t: string, prefix: boolean) {
  if (forms(t).some((w) => f.set.has(w))) return true;
  return prefix && f.list.some((w) => w.startsWith(t));
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EDGE_BEFORE = "(?<![\\p{L}\\p{N}])";
const EDGE_AFTER = "(?![\\p{L}\\p{N}])";

/** One pattern for every word the query matches, the same rules as the search, for marking text. */
export function matcher(terms: string[], prefix: boolean): RegExp | null {
  if (!terms.length) return null;
  const alts = terms.flatMap((t, i) => {
    const whole = `${EDGE_BEFORE}(?:${forms(t)
      .sort((a, b) => b.length - a.length)
      .map(esc)
      .join("|")})${EDGE_AFTER}`;
    return prefix && i === terms.length - 1 ? [whole, `${EDGE_BEFORE}${esc(t)}`] : [whole];
  });
  return new RegExp(alts.join("|"), "giu");
}

/** `text` split into runs, the matches marked. */
export function highlight(text: string, re: RegExp | null): Part[] {
  if (!re || !text) return text ? [{ text, mark: false }] : [];
  const out: Part[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (!m[0]) continue;
    if (m.index > at) out.push({ text: text.slice(at, m.index), mark: false });
    out.push({ text: m[0], mark: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false });
  return out;
}

/** About `size` characters of `text` around its first match (its start when nothing matches), cut at word edges and
 *  marked with an ellipsis where text was left out. */
export function snippet(text: string, re: RegExp | null, size = SNIPPET): Part[] {
  if (!text) return [];
  let hit = 0;
  if (re) {
    re.lastIndex = 0;
    const m = re.exec(text);
    re.lastIndex = 0;
    if (m) hit = m.index;
  }
  let start = Math.max(0, hit - Math.round(size * 0.3));
  let end = Math.min(text.length, start + size);
  // near the end of the text, the window keeps its full size by starting earlier
  if (end === text.length) start = Math.max(0, end - size);
  if (start > 0) {
    const sp = text.indexOf(" ", start);
    if (sp >= 0 && sp < hit) start = sp + 1;
  }
  if (end < text.length) {
    const sp = text.lastIndexOf(" ", end);
    if (sp > hit) end = sp;
  }
  const parts = highlight(text.slice(start, end).trim(), re);
  if (start > 0) parts.unshift({ text: "…", mark: false });
  if (end < text.length) parts.push({ text: "…", mark: false });
  return parts;
}

/** The best `limit` entries for a query, best first (reading order breaks ties); an empty query finds nothing. */
export function searchIndex(index: PreparedIndex, query: string, limit = LIMIT): Hit[] {
  const { terms, prefix } = parseQuery(query);
  if (!terms.length) return [];
  const last = terms.length - 1;
  const found: { at: number; score: number }[] = [];
  index.fields.forEach((f, at) => {
    let score = 0;
    let own = false;
    for (let i = 0; i < terms.length; i++) {
      const p = prefix && i === last;
      const t = has(f.title, terms[i], p);
      const h = has(f.heading, terms[i], p);
      const b = has(f.body, terms[i], p);
      if (!t && !h && !b) return;
      if (h || b) own = true;
      score += (t ? WEIGHT.title : 0) + (h ? WEIGHT.heading : 0) + (b ? WEIGHT.body : 0);
    }
    const entry = index.entries[at];
    // a section that matches only through its chapter's title adds nothing the chapter's own entry does not
    if (entry.heading === null) score += CHAPTER_LIFT;
    else if (!own) return;
    found.push({ at, score });
  });
  // words spread over one chapter's sections: the chapter itself, when no entry of it holds them all
  const hitAt = new Set(found.map((f) => f.at));
  const chapters = new Map<string, number[]>();
  index.entries.forEach((e, at) => chapters.set(e.slug, [...(chapters.get(e.slug) ?? []), at]));
  for (const ats of chapters.values()) {
    const own = ats.find((at) => index.entries[at].heading === null);
    if (own === undefined || ats.some((at) => hitAt.has(at))) continue;
    let score = 0;
    const spread = terms.every((t, i) => {
      const p = prefix && i === last;
      let best = 0;
      for (const at of ats) {
        const f = index.fields[at];
        best = Math.max(best, (has(f.title, t, p) ? WEIGHT.title : 0) + (has(f.heading, t, p) ? WEIGHT.heading : 0) + (has(f.body, t, p) ? WEIGHT.body : 0));
      }
      score += best;
      return best > 0;
    });
    if (spread) found.push({ at: own, score: score * SPREAD });
  }
  found.sort((a, b) => b.score - a.score || a.at - b.at);
  const re = matcher(terms, prefix);
  return found.slice(0, limit).map(({ at, score }) => {
    const entry = index.entries[at];
    return { entry, score, name: highlight(entry.heading ?? entry.chapter, re), snippet: snippet(entry.text, re) };
  });
}
