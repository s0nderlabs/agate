import { describe, expect, test } from "bun:test";
import { codeBlock, parseInfo } from "./highlight";
import { chapterMeta, isExternal, parseFrontmatter, renderChapter, rewriteHref, rewriteMarkdownLinks, Slugger, slugify, withArrow } from "./markdown";
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
    expect(r.html).toContain('<h2 id="1-what-the-number-is">1. What the number is<a class="anchor" href="#1-what-the-number-is" aria-label="Link to this section"></a></h2>');
    expect(r.html).toContain('<h3 id="sanity-bounds">Sanity bounds<a class="anchor" href="#sanity-bounds" aria-label="Link to this section"></a></h3>');
    // the headline has no link to itself
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
    expect(r.html).toContain('<pre><code><span class="line"> a --&gt; b  &lt;c&gt;</span></code></pre>');
  });

  test("tables sit in their own scrolling box, with their alignment", () => {
    expect(r.html).toContain('<div class="tablebox"><table><thead><tr><th scope="col">GPU</th><th scope="col" style="text-align:right">Price</th></tr></thead>');
    expect(r.html).toContain("<td>H100</td>");
  });

  test("the text in sections under each heading, for the search", () => {
    expect(r.sections[0]).toEqual({ id: null, heading: "One number per GPU per day.", text: expect.stringContaining("Read how or the API.") });
    expect(r.sections[1].id).toBe("1-what-the-number-is");
    expect(r.sections[1].text).toContain("H100 $2.19");
    expect(r.sections[2]).toEqual({ id: "sanity-bounds", heading: "Sanity bounds", text: "a --> b <c>" });
  });
});

/** The text a block's Copy button takes: its data-copy, or else the code as shown (tags dropped, entities read). */
function copied(html: string) {
  const own = /data-copy="([^"]*)"/.exec(html)?.[1];
  const text = own ?? /<pre><code>([\s\S]*?)<\/code><\/pre>/.exec(html)?.[1] ?? "";
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

describe("code blocks", () => {
  test("a fence's language and title", () => {
    expect(parseInfo("ts")).toEqual({ lang: "ts", title: null });
    expect(parseInfo('ts title="price.ts"')).toEqual({ lang: "ts", title: "price.ts" });
    expect(parseInfo("sh title='install steps'")).toEqual({ lang: "sh", title: "install steps" });
    expect(parseInfo('title="notes.txt"')).toEqual({ lang: "", title: "notes.txt" });
    expect(parseInfo("")).toEqual({ lang: "", title: null });
  });

  test("a figure with the language in words, a Copy button and the code in its own box", () => {
    const html = codeBlock('const a = "x"; // why', "ts");
    expect(html.startsWith('<figure class="code" data-lang="ts"><figcaption>TypeScript</figcaption>')).toBe(true);
    expect(html).toContain('<button type="button" class="copy" data-copy aria-label="Copy code"><span class="copy-idle">Copy</span>');
    expect(html).toContain('<span class="tk-keyword">const</span>');
    expect(html).toContain('<span class="tk-string-expression">&quot;x&quot;</span>');
    expect(html).toContain('<span class="tk-comment">// why</span>');
    expect(copied(html)).toBe('const a = "x"; // why');
  });

  test("each language the docs use is named and colored; anything else is plain text", () => {
    const names: [string, string, string][] = [
      ["sh", "Shell", "curl https://x.y # note"],
      ["bash", "Shell", "echo 'hi'"],
      ["json", "JSON", '{ "a": 1 }'],
      ["solidity", "Solidity", "contract A {}"],
      ["js", "JavaScript", "let a = 1"],
      ["", "Text", "a -> b"],
      ["python", "Python", "print(1)"],
      ["weird", "Text", "x"],
    ];
    for (const [lang, name, code] of names) {
      const html = codeBlock(code, lang);
      expect(html).toContain(`<figcaption>${name}</figcaption>`);
      expect(copied(html)).toBe(code);
    }
    expect(codeBlock('{ "a": 1 }', "json")).toContain('<span class="tk-constant">1</span>');
    expect(codeBlock("contract A {}", "solidity")).toContain('<span class="tk-keyword">contract</span>');
    // a shell command's bare arguments stay in the text color; its comment is muted
    const sh = codeBlock("curl https://x.y # note", "sh");
    expect(sh).toContain("https://x.y");
    expect(sh).not.toMatch(/<span class="tk-string">https/);
    expect(sh).toContain('<span class="tk-comment"># note</span>');
    // nothing highlighted where there is no grammar, and nothing unescaped
    expect(codeBlock("<b>&</b>", "")).toContain('<span class="line">&lt;b&gt;&amp;&lt;/b&gt;</span>');
  });

  test("a title from the fence replaces the language name", () => {
    expect(codeBlock("x", 'ts title="price.ts"')).toContain("<figcaption data-title>price.ts</figcaption>");
    expect(codeBlock("x", 'ts title="<b>"')).toContain("<figcaption data-title>&lt;b&gt;</figcaption>");
  });

  test("a shell transcript: the prompt cannot be selected, Copy takes only the commands", () => {
    const html = codeBlock(["$ bun install", "installed 44 packages", "$ forge build \\", "  --sizes", "Compiler run successful"].join("\n"), "sh");
    expect(html).toContain('<span class="prompt" aria-hidden="true">$ </span>');
    expect(html).toContain('<span class="out">installed 44 packages</span>');
    expect(html).toContain('<span class="out">Compiler run successful</span>');
    // the continued line is part of the command, not output
    expect(html).not.toContain('<span class="out">  --sizes</span>');
    expect(copied(html)).toBe("bun install\nforge build \\\n  --sizes");
  });

  test("a shell block without a single prompt is copied whole", () => {
    const html = codeBlock("bun install\ncd app", "sh");
    expect(html).not.toContain("prompt");
    expect(copied(html)).toBe("bun install\ncd app");
  });

  test("inside a chapter, fenced code becomes a figure and its text still feeds the search", () => {
    const r = renderChapter(["# T", "", "## Run", "", '```sh title="setup"', "$ bun install", "```"].join("\n"), FILES);
    expect(r.html).toContain('<figure class="code" data-lang="sh"><figcaption data-title>setup</figcaption>');
    expect(r.html).toContain('data-copy="bun install"');
    expect(r.sections[1].text).toBe("$ bun install");
  });
});

describe("callouts", () => {
  const html = (md: string) => renderChapter(md, FILES).html;

  test("a quote opening with a bold Note., Tip., Important. or Warning. is a callout", () => {
    const out = html("> **Note.** The price is final after 6 hours.");
    expect(out).toContain('<aside class="callout" data-kind="note" role="note"><p class="callout-kind"><svg');
    expect(out).toContain("<span>Note</span></p>");
    expect(out).toContain("<p>The price is final after 6 hours.</p>");
    expect(out).not.toContain("<strong>Note.</strong>");
    expect(out).not.toContain("<blockquote>");
    expect(html("> **Warning.** Testnet only.")).toContain('data-kind="warning"');
    expect(html("> **Tip:** Use the API.")).toContain('data-kind="tip"');
    expect(html("> **Important**. Read this.")).toContain("<p>Read this.</p>");
  });

  test("GitHub alerts, every kind, with the alert line taken out", () => {
    for (const kind of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]) {
      const out = html(`> [!${kind}]\n> Useful **information**.`);
      expect(out).toContain(`data-kind="${kind.toLowerCase()}"`);
      expect(out).toContain("<p>Useful <strong>information</strong>.</p>");
      expect(out).not.toContain("[!");
    }
    const two = html("> [!WARNING]\n>\n> First.\n>\n> Second.");
    expect(two).toContain("<p>First.</p>\n<p>Second.</p>");
  });

  test("an alert's first paragraph knows the chapter's reference links", () => {
    const out = html("> [!NOTE]\n> See [the spec][spec] first.\n\n[spec]: /docs/api");
    expect(out).toContain('<a href="/docs/api">the spec</a>');
    expect(out).not.toContain("[spec]");
  });

  test("a plain quote stays a quote, and raw HTML in a callout is still text", () => {
    expect(html("> Just a quote.")).toBe("<blockquote>\n<p>Just a quote.</p>\n</blockquote>\n");
    expect(html("> **Bold** start.")).toContain("<blockquote>");
    for (const md of ["> **Note.** <img src=x onerror=alert(1)>", "> [!TIP]\n> <img src=x onerror=alert(1)>"]) {
      const out = html(md);
      expect(out).toContain("<aside");
      expect(out).not.toContain("<img");
      expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
    }
  });
});

describe("links that leave the docs", () => {
  test("which links are external", () => {
    expect(isExternal("https://viem.sh")).toBe(true);
    expect(isExternal(`${GITHUB}/blob/main/docs/judge.md`)).toBe(true);
    expect(isExternal(`${SITE}/api/v1/prices`)).toBe(true);
    expect(isExternal(`${SITE}/docs/api#errors`)).toBe(false);
    expect(isExternal(`${SITE}/docs`)).toBe(false);
    expect(isExternal(`${SITE}/docsx`)).toBe(true);
    expect(isExternal("/docs/api")).toBe(false);
    expect(isExternal("#errors")).toBe(false);
    expect(isExternal("mailto:a@b.c")).toBe(false);
  });

  test("a new tab, no referrer, and an arrow that tells a screen reader", () => {
    const out = renderChapter("See [viem](https://viem.sh) and [the API](08-api.md).", FILES).html;
    expect(out).toContain('<a href="https://viem.sh" class="ext" target="_blank" rel="noopener noreferrer">vie<span class="ext-tail">m<svg class="ext-arrow"');
    expect(out).toContain('aria-label="(opens in a new tab)"');
    expect(out).toContain('<a href="/docs/api">the API</a>');
  });

  test("the arrow is glued to the last character, inside or outside a code span", () => {
    expect(withArrow("go there")).toMatch(/^go ther<span class="ext-tail">e<svg/);
    expect(withArrow("&amp;co")).toMatch(/^&amp;c<span class="ext-tail">o<svg/);
    expect(withArrow("a &amp;")).toMatch(/^a <span class="ext-tail">&amp;<svg/);
    // a code span is cut into two halves drawn as one box
    expect(withArrow("<code>0x4193</code>")).toMatch(/^<code class="ext-head">0x419<\/code><span class="ext-tail"><code class="ext-rest">3<\/code><svg/);
    // nested: the bold closes before the glue and opens again inside it
    expect(withArrow("<strong>Bun</strong>")).toMatch(/^<strong>Bu<\/strong><span class="ext-tail"><strong>n<\/strong><svg/);
    // a one-character code span moves into the glue whole, never leaving an empty box behind
    expect(withArrow("see <code>x</code>")).toMatch(/^see <span class="ext-tail"><code>x<\/code><svg/);
    // an image ends the link: nothing to glue to, the arrow follows
    expect(withArrow('<img src="a">')).toMatch(/^<img src="a"><span class="ext-tail"><svg/);
  });

  test("the text without its tags reads as it did", () => {
    for (const html of ["viem", "<code>0x4193...5E36</code>", "<code>AgateIndex</code> at <code>0x41</code>", "<strong>Bun</strong> and <em>Foundry</em>"]) {
      const strip = (s: string) => s.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "");
      expect(strip(withArrow(html))).toBe(strip(html));
    }
  });
});

describe("tables", () => {
  test("a column of figures is marked to line up on the right; a set alignment wins", () => {
    const out = renderChapter(["| GPU | Price | Sources | Note |", "|---|---|:--|---|", "| H100 | $2.19 | 5 | ok |", "| B200 | $4.10 | 3 | 12 |"].join("\n"), FILES).html;
    expect(out).toContain('<th scope="col">GPU</th><th scope="col" class="num">Price</th><th scope="col" style="text-align:left">Sources</th><th scope="col">Note</th>');
    expect(out).toContain('<td class="num">$2.19</td>');
    expect(out).toContain('<td style="text-align:left">5</td>');
  });
});
