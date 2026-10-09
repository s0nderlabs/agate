import { describe, expect, test } from "bun:test";
import { chapterMeta, parseFrontmatter, renderChapter, rewriteHref, rewriteMarkdownLinks, Slugger, slugify } from "./markdown";
import { GITHUB, SITE } from "./types";

const FILES = { "README.md": "", "04-the-price.md": "the-price", "08-api.md": "api" };

describe("frontmatter", () => {
  const src = ["---", "slug: the-price", "title: How the price is made", "description: The clouds' own price pages, read hourly.", "group: Concepts", "order: 4", "source: 'wall/packages/sources, contracts/src/AgateIndex.sol'", "---", "", "# One number per GPU per day.", ""].join("\n");

  test("flat key: value lines, quotes dropped, the body after it", () => {
    const { data, body } = parseFrontmatter(src);
    expect(data.slug).toBe("the-price");
    expect(data.description).toBe("The clouds' own price pages, read hourly.");
    expect(data.source).toBe("wall/packages/sources, contracts/src/AgateIndex.sol");
    expect(body.startsWith("# One number per GPU per day.")).toBe(true);
  });

  test("Windows line ends and a quoted value with an escaped quote", () => {
    const { data, body } = parseFrontmatter("---\r\ntitle: 'It''s here'\r\nslug: \"a\"\r\n---\r\nText");
    expect(data.title).toBe("It's here");
    expect(data.slug).toBe("a");
    expect(body).toBe("Text");
  });

  test("no frontmatter: all of it is the body", () => {
    expect(parseFrontmatter("# Hi")).toEqual({ data: {}, body: "# Hi" });
  });

  test("a chapter's facts, the source split into paths", () => {
    const meta = chapterMeta(parseFrontmatter(src).data, "04-the-price.md");
    expect(meta).toEqual({
      slug: "the-price",
      title: "How the price is made",
      description: "The clouds' own price pages, read hourly.",
      group: "Concepts",
      order: 4,
      source: ["wall/packages/sources", "contracts/src/AgateIndex.sol"],
    });
  });

  test("a missing field, an unknown group or a reserved slug stops the build", () => {
    const base = { slug: "x", title: "X", description: "d", group: "Concepts", order: "1" };
    expect(() => chapterMeta({ ...base, title: "" }, "01-x.md")).toThrow(/title/);
    expect(() => chapterMeta({ ...base, group: "Other" }, "01-x.md")).toThrow(/group/);
    expect(() => chapterMeta({ ...base, slug: "raw" }, "01-x.md")).toThrow(/slug/);
    expect(() => chapterMeta({ ...base, slug: "Not A Slug" }, "01-x.md")).toThrow(/slug/);
  });
});

describe("heading ids, as GitHub makes them", () => {
  test("lower case, punctuation dropped, spaces to hyphens", () => {
    expect(slugify("1. What the number is")).toBe("1-what-the-number-is");
    expect(slugify("Chainlink CRE: the primary price writer")).toBe("chainlink-cre-the-primary-price-writer");
    expect(slugify("Kuru (the order book)")).toBe("kuru-the-order-book");
    expect(slugify("Measured on Monad testnet (Oct 4 2026, n = 1 to 3 each)")).toBe("measured-on-monad-testnet-oct-4-2026-n--1-to-3-each");
    expect(slugify("A day's price")).toBe("a-days-price");
    expect(slugify("snake_case and-hyphens")).toBe("snake_case-and-hyphens");
  });

  test("a repeated heading gets -1, -2", () => {
    const s = new Slugger();
    expect([s.slug("Errors"), s.slug("Errors"), s.slug("Errors"), s.slug("Errors-1")]).toEqual(["errors", "errors-1", "errors-2", "errors-1-1"]);
  });
});

describe("links", () => {
  test("a chapter file becomes its page, with its anchor", () => {
    expect(rewriteHref("04-the-price.md", FILES)).toBe("/docs/the-price");
    expect(rewriteHref("04-the-price.md#3-a-days-price", FILES)).toBe("/docs/the-price#3-a-days-price");
    expect(rewriteHref("./08-api.md", FILES)).toBe("/docs/api");
    expect(rewriteHref("README.md", FILES)).toBe("/docs");
  });

  test("absolute for the raw markdown and llms-full.txt", () => {
    expect(rewriteHref("08-api.md#errors", FILES, SITE)).toBe(`${SITE}/docs/api#errors`);
  });

  test("files outside docs/site open on GitHub; JUDGES.md is the root's", () => {
    expect(rewriteHref("../judge.md", FILES)).toBe(`${GITHUB}/blob/main/docs/judge.md`);
    expect(rewriteHref("../JUDGES.md", FILES)).toBe(`${GITHUB}/blob/main/JUDGES.md`);
    expect(rewriteHref("../../contracts/src/AgateIndex.sol", FILES)).toBe(`${GITHUB}/blob/main/contracts/src/AgateIndex.sol`);
  });

  test("anchors, external and site links stay", () => {
    expect(rewriteHref("#errors", FILES)).toBe("#errors");
    expect(rewriteHref("https://viem.sh", FILES)).toBe("https://viem.sh");
    expect(rewriteHref("mailto:a@b.c", FILES)).toBe("mailto:a@b.c");
  });

  test("inside markdown source: links rewritten, code left alone", () => {
    const md = ["See [the price](04-the-price.md) and [`../judge.md`](../judge.md).", "`[x](04-the-price.md)` stays", "```", "[y](08-api.md)", "```", "[z]: 08-api.md"].join("\n");
    expect(rewriteMarkdownLinks(md, FILES, SITE).split("\n")).toEqual([
      `See [the price](${SITE}/docs/the-price) and [\`../judge.md\`](${GITHUB}/blob/main/docs/judge.md).`,
      "`[x](04-the-price.md)` stays",
      "```",
      "[y](08-api.md)",
      "```",
      `[z]: ${SITE}/docs/api`,
    ]);
  });
});

describe("rendering a chapter", () => {
  const body = [
    "# One number per GPU per day.",
    "",
    "Read [how](04-the-price.md#2-the-sources) or [the API](08-api.md). <script>alert(1)</script>",
    "",
    "## 1. What the number is",
    "",
    "| GPU | Price |",
    "|---|---:|",
    "| H100 | `$2.19` |",
    "",
    "### Sanity bounds",
    "",
    "```",
    " a --> b  <c>",
    "```",
    "",
    "## Errors",
    "## Errors",
  ].join("\n");
  const r = renderChapter(body, FILES);

  test("H2 and H3 get GitHub ids and make the page's contents", () => {
    expect(r.toc).toEqual([
      { id: "1-what-the-number-is", text: "1. What the number is", depth: 2 },
      { id: "sanity-bounds", text: "Sanity bounds", depth: 3 },
      { id: "errors", text: "Errors", depth: 2 },
      { id: "errors-1", text: "Errors", depth: 2 },
    ]);
    expect(r.html).toContain('<h2 id="1-what-the-number-is">1. What the number is</h2>');
    expect(r.html).toContain('<h1 id="one-number-per-gpu-per-day">One number per GPU per day.</h1>');
  });

  test("links point at the site; no chapter file names are left", () => {
    expect(r.html).toContain('href="/docs/the-price#2-the-sources"');
    expect(r.html).toContain('href="/docs/api"');
    expect(r.html).not.toMatch(/\d\d-[a-z-]+\.md/);
  });

  test("raw HTML is shown as text, code is escaped and kept as written", () => {
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(r.html).toContain("<pre><code> a --&gt; b  &lt;c&gt;</code></pre>");
  });

  test("tables sit in their own scrolling box, with their alignment", () => {
    expect(r.html).toContain('<div class="table"><table><thead><tr><th scope="col">GPU</th><th scope="col" style="text-align:right">Price</th></tr></thead>');
    expect(r.html).toContain("<td>H100</td>");
  });

  test("the text in sections under each heading, for the search", () => {
    expect(r.sections[0]).toEqual({ id: null, heading: "One number per GPU per day.", text: expect.stringContaining("Read how or the API.") });
    expect(r.sections[1].id).toBe("1-what-the-number-is");
    expect(r.sections[1].text).toContain("H100 $2.19");
    expect(r.sections[2]).toEqual({ id: "sanity-bounds", heading: "Sanity bounds", text: "a --> b <c>" });
  });
});
