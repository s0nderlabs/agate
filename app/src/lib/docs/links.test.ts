// Every link between the docs' own pages lands: for each chapter in docs/site, each link written as /docs/<slug>,
// /docs/<slug>#id, NN-slug.md, NN-slug.md#id or #id must name a chapter that exists and a heading id on it. A broken
// link is printed with its file and line. Links already broken in the content are listed in KNOWN (the content is
// not edited here), so the check passes today and catches any new one.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { chapterMeta, parseFrontmatter, renderChapter, type FileMap } from "./markdown";
import { SITE } from "./types";

const DIR = path.join(import.meta.dir, "..", "..", "..", "..", "docs", "site");
const FILE = /^\d{2}-[a-z0-9-]+\.md$/;

/** Broken today, as "file -> link". Remove a line once the content fixes it. */
const KNOWN = new Set<string>([]);

interface Page {
  file: string;
  slug: string;
  src: string;
  /** every id on the rendered page (headings first of all) */
  ids: Set<string>;
}

interface Broken {
  file: string;
  line: number;
  href: string;
  why: string;
}

/** The links on each line of a markdown file, outside the frontmatter, fenced code and code spans. */
function linksIn(src: string): { line: number; href: string }[] {
  const out: { line: number; href: string }[] = [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) i = end + 1;
  }
  let fence: string | null = null;
  for (; i < lines.length; i++) {
    const text = lines[i];
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const def = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/.exec(text);
    if (def) {
      out.push({ line: i + 1, href: def[1] });
      continue;
    }
    const prose = text.split(/(`+[^`]*`+)/).filter((_, k) => k % 2 === 0).join(" ");
    for (const m of prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push({ line: i + 1, href: m[1] });
  }
  return out;
}

/** The chapter a link points at (its slug, "" for the contents page, null for a chapter file that does not exist) and
 *  its #id; null when the link leaves the docs. */
function target(href: string, here: Page, files: FileMap): { slug: string | null; hash: string } | null {
  const at = href.indexOf("#");
  let pathPart = at >= 0 ? href.slice(0, at) : href;
  let hash = at >= 0 ? href.slice(at + 1) : "";
  try {
    hash = decodeURIComponent(hash);
  } catch {
    // a malformed escape is checked as written
  }
  if (!pathPart) return { slug: here.slug, hash };
  if (pathPart.startsWith(SITE + "/")) pathPart = pathPart.slice(SITE.length);
  const docs = /^\/docs(?:\/([^/?#]*))?\/?$/.exec(pathPart);
  if (docs) return { slug: docs[1] ?? "", hash };
  const raw = /^\/docs\/raw\/([^/?#]+)\.md$/.exec(pathPart);
  if (raw) return { slug: raw[1], hash: "" };
  const local = pathPart.replace(/^\.\//, "");
  if (FILE.test(local) || local === "README.md") return { slug: local in files ? files[local] : null, hash };
  return null;
}

/** Every internal link of every page that does not land. */
function brokenLinks(pages: Page[], files: FileMap): Broken[] {
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const out: Broken[] = [];
  for (const page of pages) {
    for (const { line, href } of linksIn(page.src)) {
      const t = target(href, page, files);
      if (!t) continue;
      if (t.slug === null) {
        out.push({ file: page.file, line, href, why: "no such chapter file in docs/site" });
        continue;
      }
      if (t.slug === "") {
        if (t.hash) out.push({ file: page.file, line, href, why: "the contents page has no headings to link to" });
        continue;
      }
      const to = bySlug.get(t.slug);
      if (!to) out.push({ file: page.file, line, href, why: `no chapter "${t.slug}"` });
      else if (t.hash && !to.ids.has(t.hash)) out.push({ file: page.file, line, href, why: `no heading #${t.hash} in ${to.file}` });
    }
  }
  return out;
}

/** The chapters as the site builds them: the same file map and renderer, so the ids are the ones the pages carry. */
function loadPages(): { pages: Page[]; files: FileMap } {
  const parsed = fs
    .readdirSync(DIR)
    .filter((f) => FILE.test(f))
    .sort()
    .map((file) => {
      const src = fs.readFileSync(path.join(DIR, file), "utf8");
      const { data, body } = parseFrontmatter(src);
      return { file, src, body, slug: chapterMeta(data, file).slug };
    });
  const files: FileMap = { "README.md": "" };
  for (const p of parsed) files[p.file] = p.slug;
  const pages = parsed.map(({ file, src, body, slug }) => {
    const { html } = renderChapter(body, files);
    return { file, slug, src, ids: new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])) };
  });
  return { pages, files };
}

describe("links between the docs' pages", () => {
  test("every internal link names a chapter and a heading that exist", () => {
    const { pages, files } = loadPages();
    expect(pages.length).toBeGreaterThan(0);
    // the check reads real links (a parsing slip that found none would pass silently otherwise)
    const internal = pages.flatMap((p) => linksIn(p.src).filter((l) => target(l.href, p, files)));
    expect(internal.length).toBeGreaterThan(20);
    const broken = brokenLinks(pages, files);
    const key = (b: Broken) => `${b.file} -> ${b.href}`;
    const fresh = broken.filter((b) => !KNOWN.has(key(b)));
    for (const b of broken) console.log(`${KNOWN.has(key(b)) ? "known broken" : "BROKEN"}: docs/site/${b.file}:${b.line} ${b.href} (${b.why})`);
    const stale = [...KNOWN].filter((k) => !broken.some((b) => key(b) === k));
    for (const k of stale) console.log(`fixed, can leave KNOWN: ${k}`);
    expect(fresh.map((b) => `docs/site/${b.file}:${b.line} ${b.href} (${b.why})`)).toEqual([]);
  });
});

describe("the link check itself", () => {
  const files: FileMap = { "README.md": "", "04-the-price.md": "the-price", "08-api.md": "api" };
  const page = (file: string, slug: string, src: string, ids: string[]): Page => ({ file, slug, src, ids: new Set(ids) });

  test("finds links in prose and definitions, never in code", () => {
    const src = ["---", "slug: x", "---", "See [a](08-api.md#errors) and `[b](04-the-price.md)`.", "```", "[c](08-api.md)", "```", "[d]: /docs/the-price#x"].join("\n");
    expect(linksIn(src)).toEqual([
      { line: 4, href: "08-api.md#errors" },
      { line: 8, href: "/docs/the-price#x" },
    ]);
  });

  test("a missing chapter, a missing heading and a hash on the contents page are broken; good links pass", () => {
    const api = page("08-api.md", "api", "", ["errors", "prices"]);
    const price = page(
      "04-the-price.md",
      "the-price",
      [
        "[ok](08-api.md#errors) [ok](/docs/api) [ok](#sources) [ok](./08-api.md) [ok](README.md) [ok](/docs)",
        `[ok](${SITE}/docs/api#prices) [ok](https://viem.sh#x) [ok](../judge.md#y) [ok](/docs/raw/api.md)`,
        "[bad](08-api.md#nope) [bad](/docs/nope) [bad](#gone) [bad](09-gone.md) [bad](/docs#x) [bad](/docs/raw/gone.md)",
      ].join("\n"),
      ["sources"],
    );
    const broken = brokenLinks([api, price], files);
    expect(broken.map((b) => [b.line, b.href])).toEqual([
      [3, "08-api.md#nope"],
      [3, "/docs/nope"],
      [3, "#gone"],
      [3, "09-gone.md"],
      [3, "/docs#x"],
      [3, "/docs/raw/gone.md"],
    ]);
    expect(broken[0].why).toBe("no heading #nope in 08-api.md");
  });
});
