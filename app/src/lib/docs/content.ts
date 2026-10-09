// The docs content, read from the repo's docs/site at BUILD time only: every docs route is prerendered (static params,
// force-static handlers), so nothing here runs on a request in production. One file per chapter (NN-slug.md) with
// flat frontmatter; docs/site/README.md is the repo's index, not a page.
import fs from "node:fs";
import path from "node:path";
import { chapterMeta, parseFrontmatter, renderChapter, rewriteMarkdownLinks, type FileMap } from "./markdown";
import { GROUPS, SITE, type ChapterMeta, type Heading, type NavGroup, type SearchDoc, type Section } from "./types";

/** next build and next dev run from app/; the content sits beside it at the repo root. */
const DIR = path.join(process.cwd(), "..", "docs", "site");
const FILE = /^\d{2}-[a-z0-9-]+\.md$/;

export interface Chapter extends ChapterMeta {
  file: string;
  /** the file as written (frontmatter included), its links made absolute for reading off the site */
  markdown: string;
  /** the same without the frontmatter */
  bodyMarkdown: string;
  html: string;
  toc: Heading[];
  sections: Section[];
}

let cache: Chapter[] | null = null;

/** Every chapter, in reading order (group, then order). Read once per build; dev reads afresh so edits show. */
export function getChapters(): Chapter[] {
  if (cache && process.env.NODE_ENV === "production") return cache;
  const parsed = fs
    .readdirSync(DIR)
    .filter((f) => FILE.test(f))
    .sort()
    .map((file) => {
      const src = fs.readFileSync(path.join(DIR, file), "utf8");
      const { data, body } = parseFrontmatter(src);
      return { file, src, body, meta: chapterMeta(data, file) };
    });
  const seen = new Set<string>();
  for (const p of parsed) {
    if (seen.has(p.meta.slug)) throw new Error(`docs: two chapters use the slug "${p.meta.slug}"`);
    seen.add(p.meta.slug);
  }
  const files: FileMap = { "README.md": "" };
  for (const p of parsed) files[p.file] = p.meta.slug;
  cache = parsed
    .map(({ file, src, body, meta }) => {
      const { html, toc, sections } = renderChapter(body, files);
      return { ...meta, file, markdown: rewriteMarkdownLinks(src, files, SITE), bodyMarkdown: rewriteMarkdownLinks(body, files, SITE), html, toc, sections };
    })
    .sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || a.order - b.order);
  return cache;
}

export function getChapter(slug: string) {
  const all = getChapters();
  const i = all.findIndex((c) => c.slug === slug);
  if (i < 0) return null;
  return { chapter: all[i], prev: all[i - 1] ?? null, next: all[i + 1] ?? null };
}

/** The sidebar: the groups in order, each chapter with its H2s. */
export function getNav(): NavGroup[] {
  const all = getChapters();
  return GROUPS.map((group) => ({
    group,
    chapters: all
      .filter((c) => c.group === group)
      .map((c) => ({ slug: c.slug, title: c.title, description: c.description, sections: c.toc.filter((h) => h.depth === 2).map(({ id, text }) => ({ id, text })) })),
  })).filter((g) => g.chapters.length > 0);
}

/** The search index the browser fetches once (/docs/search.json). */
export function getSearchIndex(): SearchDoc[] {
  return getChapters().map((c) => ({ slug: c.slug, title: c.title, description: c.description, sections: c.sections }));
}

/** /llms.txt: what the docs hold, one line per chapter, grouped (llmstxt.org). */
export function llmsIndex(): string {
  const lines = [
    "# Agate",
    "",
    "> Agate makes the price of compute tradable: an open onchain price for renting a GPU for an hour, and fully backed monthly markets on it, on Monad testnet.",
    "",
    `Every page below is also plain markdown at ${SITE}/docs/raw/<slug>.md, and all of them in one file at ${SITE}/llms-full.txt.`,
  ];
  for (const g of getNav()) {
    lines.push("", `## ${g.group}`, "");
    for (const c of g.chapters) lines.push(`- [${c.title}](${SITE}/docs/${c.slug}): ${c.description}`);
  }
  return lines.join("\n") + "\n";
}

/** /llms-full.txt: every chapter's markdown in reading order, each under its title and address. */
export function llmsFull(): string {
  const head = ["# Agate documentation", "", `> Every chapter of ${SITE}/docs, in reading order. The index: ${SITE}/llms.txt`].join("\n");
  const parts = getChapters().map((c) => [`# ${c.title}`, "", `Source: ${SITE}/docs/${c.slug}`, "", c.bodyMarkdown.trim()].join("\n"));
  return [head, ...parts].join("\n\n") + "\n";
}
