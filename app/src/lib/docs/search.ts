// The docs search, in the browser: every word typed must appear somewhere in a chapter (its title, description,
// headings or text). Title matches rank first, then headings, the description, the text. A hit says where it
// matched when that is not the title or description: the heading itself, or a few words around the match.
import type { SearchDoc } from "./types";

export interface Hit {
  slug: string;
  score: number;
  /** id: the section's anchor (none for the text under the headline) */
  hint?: { id: string | null; text: string; heading: boolean };
}

export function terms(query: string) {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8);
}

/** About `size` characters of `text` around the first match, cut at word edges. */
export function snippet(text: string, words: string[], size = 96) {
  const low = text.toLowerCase();
  const at = words.map((w) => low.indexOf(w)).filter((i) => i >= 0);
  const i = at.length ? Math.min(...at) : 0;
  let start = Math.max(0, i - Math.floor(size / 3));
  let end = Math.min(text.length, start + size);
  if (start > 0) start = text.indexOf(" ", start) + 1 || start;
  if (end < text.length) end = text.lastIndexOf(" ", end) > start ? text.lastIndexOf(" ", end) : end;
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

export function searchDocs(docs: SearchDoc[], query: string): Hit[] {
  const words = terms(query);
  if (!words.length) return [];
  const hits: (Hit & { at: number })[] = [];
  docs.forEach((d, at) => {
    const title = d.title.toLowerCase();
    const desc = d.description.toLowerCase();
    const heads = d.sections.map((s) => s.heading.toLowerCase());
    const texts = d.sections.map((s) => s.text.toLowerCase());
    let score = 0;
    for (const w of words) {
      const t = title.includes(w);
      const h = heads.some((x) => x.includes(w));
      const de = desc.includes(w);
      const b = texts.some((x) => x.includes(w));
      if (!t && !h && !de && !b) return;
      score += (t ? 8 : 0) + (h ? 4 : 0) + (de ? 2 : 0) + (b ? 1 : 0);
    }
    let hint: Hit["hint"];
    if (!words.every((w) => title.includes(w) || desc.includes(w))) {
      // the section that holds the most of the words, a heading match counting double
      let best = -1;
      let bestScore = 0;
      d.sections.forEach((s, i) => {
        const sc = words.reduce((n, w) => n + (heads[i].includes(w) ? 2 : 0) + (texts[i].includes(w) ? 1 : 0), 0);
        if (sc > bestScore) {
          best = i;
          bestScore = sc;
        }
      });
      if (best >= 0) {
        const s = d.sections[best];
        const allInHeading = words.every((w) => heads[best].includes(w));
        hint = allInHeading && s.id ? { id: s.id, text: s.heading, heading: true } : { id: s.id, text: snippet(s.text || s.heading, words), heading: false };
      }
    }
    hits.push({ slug: d.slug, score, hint, at });
  });
  return hits.sort((a, b) => b.score - a.score || a.at - b.at).map(({ slug, score, hint }) => ({ slug, score, hint }));
}
