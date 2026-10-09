import { describe, expect, test } from "bun:test";
import { searchDocs, snippet } from "./search";
import type { SearchDoc } from "./types";

const DOCS: SearchDoc[] = [
  {
    slug: "introduction",
    title: "Introduction",
    description: "agate makes the price of compute tradable.",
    sections: [
      { id: null, heading: "agate makes the price of compute tradable.", text: "Renting a GPU for an hour has a price, and that price moves." },
      { id: "who-it-is-for", heading: "Who it is for", text: "Teams that rent GPUs, traders, AI agents, and builders who read the price from an API." },
    ],
  },
  {
    slug: "api",
    title: "Developer API",
    description: "Read-only JSON for prices, sources and candles. No key.",
    sections: [
      { id: null, heading: "Every number on the screen, as JSON.", text: "The developer API serves read-only market data." },
      { id: "errors", heading: "Errors", text: "A wrong GPU name answers 404 with a JSON body." },
    ],
  },
];

describe("docs search", () => {
  test("an empty query finds nothing", () => {
    expect(searchDocs(DOCS, "   ")).toEqual([]);
  });

  test("every word must appear somewhere in the chapter", () => {
    expect(searchDocs(DOCS, "json 404").map((h) => h.slug)).toEqual(["api"]);
    expect(searchDocs(DOCS, "json traders")).toEqual([]);
  });

  test("a title match ranks above a text match", () => {
    expect(searchDocs(DOCS, "api").map((h) => h.slug)).toEqual(["api", "introduction"]);
  });

  test("a match in the title or description needs no hint", () => {
    expect(searchDocs(DOCS, "developer")[0].hint).toBeUndefined();
  });

  test("a heading match points at its section", () => {
    expect(searchDocs(DOCS, "errors")[0].hint).toEqual({ id: "errors", text: "Errors", heading: true });
  });

  test("a text match shows the words around it and links to its section", () => {
    const hint = searchDocs(DOCS, "404")[0].hint;
    expect(hint?.id).toBe("errors");
    expect(hint?.heading).toBe(false);
    expect(hint?.text).toContain("404");
  });

  test("a snippet is cut at word edges and marks what it left out", () => {
    const text = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen";
    const s = snippet(text, ["eight"], 30);
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(s).toContain("eight");
    expect(s).not.toMatch(/…\S*\s$/);
  });
});
