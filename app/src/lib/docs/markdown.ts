// Markdown for the docs, at build time: the frontmatter, GitHub-style heading ids, link rewriting and the HTML.
// The content is the repo's own (trusted), but raw HTML in it is still shown as text, never passed through.
// The HTML carries the rich parts the prose styles draw: highlighted code blocks with a Copy button (highlight.ts),
// callouts, a link beside each H2 and H3, an arrow on links that leave the docs, and tables with a header row.
import { Lexer, Marked, type Links, type Token, type Tokens } from "marked";
import { codeBlock, escapeHtml } from "./highlight";
import { GITHUB, GROUPS, SITE, type ChapterMeta, type Group, type Heading, type Section } from "./types";

/** A chapter file's name maps to its slug; README.md (the index) maps to "" (the contents page). */
export type FileMap = Record<string, string>;

/** Slugs a chapter may not take: static routes that sit beside /docs/[slug]. */
export const RESERVED = new Set(["raw", "search.json"]);

/** The flat `key: value` lines between the opening `---` lines. Quotes around a value are dropped. */
export function parseFrontmatter(src: string): { data: Record<string, string>; body: string } {
  const text = src.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
    else if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"');
    data[kv[1]] = v;
  }
  return { data, body: text.slice(m[0].length).replace(/^\n+/, "") };
}

/** The frontmatter as a chapter's facts; a missing or wrong field stops the build with the file's name. */
export function chapterMeta(data: Record<string, string>, file: string): ChapterMeta {
  const need = (k: string) => {
    const v = data[k]?.trim();
    if (!v) throw new Error(`docs: ${file} has no "${k}" in its frontmatter`);
    return v;
  };
  const slug = need("slug");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || RESERVED.has(slug)) throw new Error(`docs: ${file} has a slug the site cannot use: "${slug}"`);
  const group = need("group");
  if (!(GROUPS as readonly string[]).includes(group)) throw new Error(`docs: ${file} has an unknown group "${group}"`);
  const order = Number(need("order"));
  if (!Number.isFinite(order)) throw new Error(`docs: ${file} has an order that is not a number`);
  const source = (data.source ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return { slug, title: need("title"), description: need("description"), group: group as Group, order, source };
}

/** GitHub's heading id: lower case, punctuation and symbols dropped (hyphen and underscore stay), spaces to hyphens. */
export function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** Ids for one page, deduplicated the way GitHub does it: the second "x" is "x-1", the third "x-2". */
export class Slugger {
  private seen = new Map<string, number>();
  slug(text: string) {
    const base = slugify(text);
    let id = base;
    while (this.seen.has(id)) {
      const n = (this.seen.get(base) ?? 0) + 1;
      this.seen.set(base, n);
      id = `${base}-${n}`;
    }
    this.seen.set(id, 0);
    return id;
  }
}

const INLINE = new Set(["text", "codespan", "escape", "strong", "em", "link", "del", "image", "html"]);

/** The words of inline or block tokens, without the markdown (code text, link text and table cells included). */
export function plainText(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  let out = "";
  for (const t of tokens) {
    if (t.type === "table") {
      const tb = t as Tokens.Table;
      out += [...tb.header, ...tb.rows.flat()].map((c) => plainText(c.tokens)).join(" ");
    } else if (t.type === "list") {
      out += (t as Tokens.List).items.map((i) => plainText(i.tokens)).join(" ");
    } else if (t.type === "code") {
      out += (t as Tokens.Code).text;
    } else if ("tokens" in t && Array.isArray(t.tokens)) {
      out += plainText(t.tokens);
    } else if ("text" in t && typeof t.text === "string") {
      out += t.text;
    }
    // blocks (and line breaks) end with a space, so words from two blocks never run together
    if (!INLINE.has(t.type)) out += " ";
  }
  return out.replace(/\s+/g, " ").trim();
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** Files that live at the repo root, so ../X from docs/site means the root's X, not docs/X (../JUDGES.md). */
const ROOT_FILES = new Set(["JUDGES.md", "README.md", "LICENSE"]);

/**
 * One link's address, rewritten for the site. NN-slug.md#x becomes /docs/slug#x (or the absolute URL when base is the
 * site), README.md the contents page; any other relative path opens on GitHub; #x, absolute and external links stay.
 */
export function rewriteHref(href: string, files: FileMap, base = ""): string {
  if (!href || href.startsWith("#") || SCHEME.test(href) || href.startsWith("//")) return href;
  if (href.startsWith("/")) return base + href;
  const hashAt = href.indexOf("#");
  const path = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const hash = hashAt >= 0 ? href.slice(hashAt) : "";
  const local = path.replace(/^\.\//, "");
  if (local in files) return `${base}/docs${files[local] ? `/${files[local]}` : ""}${hash}`;
  // resolve against docs/site; a root file reached by going up is the root's own
  const parts = ["docs", "site"];
  for (const seg of local.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  let repo = parts.join("/");
  const name = parts[parts.length - 1] ?? "";
  if (local.startsWith("../") && ROOT_FILES.has(name)) repo = name;
  return `${GITHUB}/${path.endsWith("/") ? "tree" : "blob"}/main/${repo}${path.endsWith("/") ? "/" : ""}${hash}`;
}

/** The same rewrite inside markdown source (the raw route and llms-full.txt), outside code. */
export function rewriteMarkdownLinks(md: string, files: FileMap, base = ""): string {
  let fenced = false;
  return md
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      // a reference definition: [x]: path
      const def = /^(\s{0,3}\[[^\]]+\]:\s*)(\S+)(.*)$/.exec(line);
      if (def) return def[1] + rewriteHref(def[2], files, base) + def[3];
      // inline links, skipping code spans
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, i) => (i % 2 ? part : part.replace(/(\]\(\s*)([^)\s]+)((?:\s+"[^"]*")?\s*\))/g, (_m, a: string, h: string, z: string) => a + rewriteHref(h, files, base) + z)))
        .join("");
    })
    .join("\n");
}

export { escapeHtml };
const SAFE_URL = /^(https?:|mailto:|\/|#)/i;

const OWN_DOCS = new RegExp(`^${SITE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/docs(?:[/?#]|$)`, "i");
/** A link that leaves the docs: any http(s) address except the docs' own pages on the site. */
export function isExternal(url: string) {
  return /^https?:\/\//i.test(url) && !OWN_DOCS.test(url);
}

/** The arrow after a link that opens in a new tab; its label tells a screen reader so. */
const ARROW =
  '<svg class="ext-arrow" viewBox="0 0 12 12" role="img" aria-label="(opens in a new tab)"><path d="M3 9 9 3M4 3h5v5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

/**
 * A link's HTML with the arrow glued to its last character: the text still wraps where it could before, but the arrow
 * never starts a line alone. Elements the last character sits in close before the glue and open again inside it; a
 * code span cut this way is marked on both sides so the two halves draw as one box.
 */
export function withArrow(html: string): string {
  const closers = /(?:<\/[a-z][a-z0-9]*>)*$/i.exec(html)?.[0] ?? "";
  const body = html.slice(0, html.length - closers.length);
  // nothing to glue to (an image ends the link): the arrow simply follows
  if (!body || body.endsWith(">")) return `${html}<span class="ext-tail">${ARROW}</span>`;
  const last = /(?:&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);|[\s\S])$/iu.exec(body)?.[0] ?? "";
  let head = body.slice(0, body.length - last.length);
  let headClose = closers;
  // an element that would be left empty in the head moves into the glue whole
  let moved = 0;
  for (let open = /<([a-z][a-z0-9]*)>$/i.exec(head); open && headClose.startsWith(`</${open[1]}>`); open = /<([a-z][a-z0-9]*)>$/i.exec(head)) {
    head = head.slice(0, -open[0].length);
    headClose = headClose.slice(open[1].length + 3);
    moved++;
  }
  let reopen = (closers.match(/<\/[a-z][a-z0-9]*>/gi) ?? [])
    .reverse()
    .map((c) => `<${c.slice(2)}`)
    .join("");
  if (closers.startsWith("</code>") && moved === 0) {
    const at = head.lastIndexOf("<code>");
    head = `${head.slice(0, at)}<code class="ext-head">${head.slice(at + 6)}`;
    reopen = `${reopen.slice(0, -6)}<code class="ext-rest">`;
  }
  return `${head}${headClose}<span class="ext-tail">${reopen}${last}${closers}${ARROW}</span>`;
}

/** Callout kinds: the word each shows and its icon (16 px, drawn in the text color). */
const CALLOUTS = {
  note: { word: "Note", icon: '<rect x="2.2" y="2.2" width="11.6" height="11.6"/><path d="M8 7.2v4.4M8 4.6v.3"/>' },
  tip: { word: "Tip", icon: '<path d="M8 1.9 9.4 6.6 14.1 8 9.4 9.4 8 14.1 6.6 9.4 1.9 8 6.6 6.6Z"/>' },
  important: { word: "Important", icon: '<rect x="2.2" y="2.2" width="11.6" height="11.6"/><path d="M8 4.6v4.6M8 11.1v.3"/>' },
  warning: { word: "Warning", icon: '<path d="M8 2.2 14.4 13.6H1.6Z"/><path d="M8 6.4v3.6M8 11.8v.3"/>' },
  caution: { word: "Caution", icon: '<path d="M5.6 1.9h4.8l3.7 3.7v4.8l-3.7 3.7H5.6l-3.7-3.7V5.6Z"/><path d="M8 5v4.2M8 11.1v.3"/>' },
} as const;
type CalloutKind = keyof typeof CALLOUTS;
const ALERT = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i;
const LEAD = /^(note|tip|important|warning|caution)([.:]?)$/i;

/** A figure in a table cell: an optional sign and currency, digits with thousands commas, decimals, a % or x after. */
const NUMBER = /^[+\-−]?[$€£]?\d[\d,]*(?:\.\d+)?\s?(?:%|x|×)?$/;

type HeadingToken = Tokens.Heading & { id?: string };

/**
 * A chapter body (frontmatter removed) as HTML, with its H2 and H3 for "On this page" and its text in sections for
 * the search. The body's own H1 stays: it is the page's headline.
 */
export function renderChapter(body: string, files: FileMap): { html: string; toc: Heading[]; sections: Section[] } {
  // the chapter's reference definitions ([x]: url), for text that is read again on its own (an alert's first paragraph)
  let links: Links = {};
  const md = new Marked({
    gfm: true,
    renderer: {
      // H2 and H3 end in a link to themselves (drawn on hover or focus); no space before it, so it never wraps alone
      heading(token) {
        const { depth, id } = token as HeadingToken;
        const anchor = id && (depth === 2 || depth === 3) ? `<a class="anchor" href="#${escapeHtml(id)}" aria-label="Link to this section"></a>` : "";
        return `<h${depth}${id ? ` id="${escapeHtml(id)}"` : ""}>${this.parser.parseInline(token.tokens)}${anchor}</h${depth}>\n`;
      },
      // a link that leaves the docs opens in a new tab and ends in an arrow; links within the docs stay as they are
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const url = rewriteHref(href, files);
        if (!SAFE_URL.test(url)) return text;
        const attrs = `href="${escapeHtml(url)}"${title ? ` title="${escapeHtml(title)}"` : ""}`;
        if (!isExternal(url)) return `<a ${attrs}>${text}</a>`;
        return `<a ${attrs} class="ext" target="_blank" rel="noopener noreferrer">${withArrow(text)}</a>`;
      },
      // a quote that opens with **Note.** (Tip, Important, Warning) or a GitHub alert line ([!NOTE] and the rest) is a
      // callout; any other quote stays a quote
      blockquote({ tokens }) {
        let kind: CalloutKind | null = null;
        let body: Token[] = tokens;
        const first = tokens[0];
        if (first?.type === "paragraph") {
          const p = first as Tokens.Paragraph;
          const alert = ALERT.exec(p.text);
          const lead = p.tokens[0]?.type === "strong" ? LEAD.exec(plainText((p.tokens[0] as Tokens.Strong).tokens)) : null;
          if (alert) {
            kind = alert[1].toLowerCase() as CalloutKind;
            const rest = p.text.slice(alert[0].length);
            // read back into blocks in the same GitHub flavor, knowing the chapter's reference definitions
            const again = new Lexer({ gfm: true });
            Object.assign(again.tokens.links, links);
            body = [...(rest.trim() ? again.lex(rest) : []), ...tokens.slice(1)];
          } else if (lead) {
            kind = lead[1].toLowerCase() as CalloutKind;
            // the bold word becomes the callout's own first line; a "." or ":" written after it goes with it
            const inline = p.tokens.slice(1);
            const next = inline[0];
            if (next?.type === "text") {
              const t = next as Tokens.Text;
              const trimmed = t.text.replace(lead[2] ? /^\s+/ : /^[.:]?\s*/, "");
              inline[0] = { ...t, raw: trimmed, text: trimmed };
            }
            const hasText = inline.some((t) => t.type !== "text" || (t as Tokens.Text).text.trim());
            body = [...(hasText ? [{ ...p, tokens: inline }] : []), ...tokens.slice(1)];
          }
        }
        if (!kind) return `<blockquote>\n${this.parser.parse(tokens)}</blockquote>\n`;
        const { word, icon } = CALLOUTS[kind];
        const svg = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="square">${icon}</svg>`;
        return `<aside class="callout" data-kind="${kind}" role="note"><p class="callout-kind">${svg}<span>${word}</span></p>\n${this.parser.parse(body)}</aside>\n`;
      },
      image({ href, title, text }) {
        const url = rewriteHref(href, files);
        if (!SAFE_URL.test(url)) return escapeHtml(text);
        return `<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ""} loading="lazy">`;
      },
      // raw HTML in the markdown is shown as the text it is
      html({ text }) {
        return escapeHtml(text);
      },
      // the code as written (never the markdown's own escaping), highlighted at build, in a figure with its header row
      code({ text, lang }) {
        return codeBlock(text, lang ?? "");
      },
      // tables sit in their own box, which scrolls sideways when the table is wider than the column; a column whose
      // cells are all figures (and that sets no alignment of its own) lines them up on the right
      table(token) {
        const numeric = token.header.map((h, i) => {
          if (h.align) return false;
          const vals = token.rows.map((r) => plainText(r[i]?.tokens).trim()).filter(Boolean);
          return vals.length > 0 && vals.every((v) => NUMBER.test(v));
        });
        const cell = (c: Tokens.TableCell, tag: "th" | "td", i: number) =>
          `<${tag}${tag === "th" ? ' scope="col"' : ""}${numeric[i] ? ' class="num"' : ""}${c.align ? ` style="text-align:${c.align}"` : ""}>${this.parser.parseInline(c.tokens)}</${tag}>`;
        const head = `<tr>${token.header.map((c, i) => cell(c, "th", i)).join("")}</tr>`;
        const rows = token.rows.map((r) => `<tr>${r.map((c, i) => cell(c, "td", i)).join("")}</tr>`).join("\n");
        return `<div class="tablebox"><table><thead>${head}</thead>${rows ? `<tbody>${rows}</tbody>` : ""}</table></div>\n`;
      },
    },
  });
  const tokens = md.lexer(body);
  links = tokens.links;
  const slugger = new Slugger();
  const toc: Heading[] = [];
  const sections: Section[] = [{ id: null, heading: "", text: "" }];
  for (const t of tokens) {
    if (t.type === "heading") {
      const h = t as HeadingToken;
      const text = plainText(h.tokens);
      h.id = slugger.slug(text);
      if (h.depth === 1 && sections.length === 1) sections[0].heading = text;
      if (h.depth === 2 || h.depth === 3) toc.push({ id: h.id, text, depth: h.depth });
      if (h.depth >= 2) sections.push({ id: h.id, heading: text, text: "" });
    } else {
      const last = sections[sections.length - 1];
      last.text += " " + plainText([t]);
    }
  }
  const html = md.parser(tokens);
  return { html, toc, sections: sections.map((s) => ({ ...s, text: s.text.replace(/\s+/g, " ").trim() })) };
}
