// Markdown for the docs, at build time: the frontmatter, GitHub-style heading ids, link rewriting and the HTML.
// The content is the repo's own (trusted), but raw HTML in it is still shown as text, never passed through.
import { Marked, type Token, type Tokens } from "marked";
import { GITHUB, GROUPS, type ChapterMeta, type Group, type Heading, type Section } from "./types";

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

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}
const SAFE_URL = /^(https?:|mailto:|\/|#)/i;

type HeadingToken = Tokens.Heading & { id?: string };

/**
 * A chapter body (frontmatter removed) as HTML, with its H2 and H3 for "On this page" and its text in sections for
 * the search. The body's own H1 stays: it is the page's headline.
 */
export function renderChapter(body: string, files: FileMap): { html: string; toc: Heading[]; sections: Section[] } {
  const md = new Marked({
    gfm: true,
    renderer: {
      heading(token) {
        const { depth, id } = token as HeadingToken;
        return `<h${depth}${id ? ` id="${id}"` : ""}>${this.parser.parseInline(token.tokens)}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const url = rewriteHref(href, files);
        if (!SAFE_URL.test(url)) return text;
        const out = /^https?:/i.test(url) ? ' rel="noreferrer"' : "";
        return `<a href="${escapeHtml(url)}"${title ? ` title="${escapeHtml(title)}"` : ""}${out}>${text}</a>`;
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
      code({ text, lang, escaped }) {
        const l = (lang ?? "").match(/^\S*/)?.[0] ?? "";
        return `<pre${l ? ` data-lang="${escapeHtml(l)}"` : ""}><code>${escaped ? text : escapeHtml(text)}</code></pre>\n`;
      },
      // tables sit in their own box, which scrolls sideways when the table is wider than the column
      table(token) {
        const cell = (c: Tokens.TableCell, tag: "th" | "td") =>
          `<${tag}${tag === "th" ? ' scope="col"' : ""}${c.align ? ` style="text-align:${c.align}"` : ""}>${this.parser.parseInline(c.tokens)}</${tag}>`;
        const head = `<tr>${token.header.map((c) => cell(c, "th")).join("")}</tr>`;
        const rows = token.rows.map((r) => `<tr>${r.map((c) => cell(c, "td")).join("")}</tr>`).join("\n");
        return `<div class="table"><table><thead>${head}</thead>${rows ? `<tbody>${rows}</tbody>` : ""}</table></div>\n`;
      },
    },
  });
  const tokens = md.lexer(body);
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
