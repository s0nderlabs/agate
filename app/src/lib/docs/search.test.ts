import { describe, expect, test } from "bun:test";
import { buildSearchIndex, highlight, matcher, navIndex, parseQuery, prepareIndex, searchIndex, snippet, type ChapterSource, type Part } from "./search";

const CHAPTERS: ChapterSource[] = [
  {
    slug: "introduction",
    title: "Introduction",
    description: "Agate makes the price of compute tradable.",
    toc: [{ id: "who-it-is-for", text: "Who it is for", depth: 2 }],
    sections: [
      { id: null, heading: "Agate makes the price of compute tradable.", text: "Renting a GPU for an hour has a price, and that price moves." },
      { id: "who-it-is-for", heading: "Who it is for", text: "Teams that rent GPUs, traders, AI agents, and builders who read the price from an API." },
    ],
  },
  {
    slug: "api",
    title: "Developer API",
    description: "Read-only JSON for prices, sources and candles. No key.",
    toc: [
      { id: "endpoints", text: "Endpoints", depth: 2 },
      { id: "errors", text: "Errors", depth: 3 },
    ],
    sections: [
      { id: null, heading: "Every number on the screen, as JSON.", text: "The developer API serves read-only market data." },
      { id: "endpoints", heading: "Endpoints", text: "GET /v1/markets lists every market." },
      { id: "errors", heading: "Errors", text: "A wrong GPU name answers 404 with a JSON body." },
      { id: "status-codes", heading: "Status codes", text: "Retries back off after a 429." },
    ],
  },
  {
    slug: "contracts",
    title: "Contracts and addresses",
    description: "Every deployed contract on Monad testnet.",
    toc: [{ id: "the-vault", text: "The vault", depth: 2 }],
    sections: [
      { id: null, heading: "Contracts and addresses", text: "" },
      { id: "the-vault", heading: "The vault", text: "Holds the dollars that back each position. Its address is fixed." },
    ],
  },
];

const INDEX = buildSearchIndex(CHAPTERS);
const READY = prepareIndex(INDEX);
const find = (q: string) => searchIndex(READY, q);
const at = (q: string) => find(q).map((h) => `${h.entry.slug}${h.entry.id ? `#${h.entry.id}` : ""}`);
const marked = (parts: Part[]) => parts.map((p) => (p.mark ? `<mark>${p.text}</mark>` : p.text)).join("");

describe("the index", () => {
  test("one entry per chapter and one per H2 and H3 section", () => {
    expect(INDEX.map((e) => `${e.slug}${e.id ? `#${e.id}` : ""}`)).toEqual(["introduction", "introduction#who-it-is-for", "api", "api#endpoints", "api#errors", "contracts", "contracts#the-vault"]);
  });

  test("a chapter's entry holds its description, its headline and the text before its first section", () => {
    const e = INDEX.find((x) => x.slug === "api" && !x.id)!;
    expect(e.heading).toBeNull();
    expect(e.chapter).toBe("Developer API");
    expect(e.text).toBe("Read-only JSON for prices, sources and candles. No key. Every number on the screen, as JSON. The developer API serves read-only market data.");
  });

  test("a headline the description already says is not repeated", () => {
    const e = INDEX.find((x) => x.slug === "introduction" && !x.id)!;
    expect(e.text).toBe("Agate makes the price of compute tradable. Renting a GPU for an hour has a price, and that price moves.");
  });

  test("an H4's words count toward the section above it", () => {
    const e = INDEX.find((x) => x.id === "errors")!;
    expect(e.text).toContain("Status codes");
    expect(e.text).toContain("429");
  });

  test("a section keeps its whole text, on one line, so a word deep in a long section is found", () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join("\n ");
    const [, deep] = buildSearchIndex([{ slug: "x", title: "X", description: "", toc: [{ id: "a", text: "A", depth: 2 }], sections: [{ id: null, heading: "X", text: "" }, { id: "a", heading: "A", text: long }] }]);
    expect(deep.text).toBe(long.replace(/\s+/g, " "));
    expect(searchIndex(prepareIndex([deep]), "word399 ").map((h) => h.entry.id)).toEqual(["a"]);
  });

  test("the sidebar's own data makes a smaller index of the same shape", () => {
    const nav = [{ group: "Reference" as const, chapters: [{ slug: "api", title: "Developer API", description: "JSON.", sections: [{ id: "errors", text: "Errors" }] }] }];
    expect(navIndex(nav)).toEqual([
      { slug: "api", chapter: "Developer API", heading: null, id: null, text: "JSON." },
      { slug: "api", chapter: "Developer API", heading: "Errors", id: "errors", text: "" },
    ]);
  });
});

describe("the search", () => {
  test("an empty query finds nothing", () => {
    expect(find("   ")).toEqual([]);
    expect(find("// ,")).toEqual([]);
  });

  test("every word must match the same entry", () => {
    expect(at("json 404")).toEqual(["api#errors"]);
    expect(at("json traders")).toEqual([]);
  });

  test("words spread over one chapter's sections find the chapter, below entries that hold every word", () => {
    // "markets" is in Endpoints, "429" in Errors: no section holds both
    expect(at("markets 429 ")).toEqual(["api"]);
    // across chapters, nothing
    expect(at("vault 429 ")).toEqual([]);
    // a section that holds every word is enough: the chapter is not added again
    expect(at("json 404 ")).toEqual(["api#errors"]);
  });

  test("the last word also matches the start of a word, while it is being typed", () => {
    expect(at("vau")).toEqual(["contracts#the-vault"]);
    // a space after it means the word is finished
    expect(at("vau ")).toEqual([]);
    // only the last word: an earlier one must be a whole word
    expect(at("vau holds")).toEqual([]);
    expect(at("vault hol")).toEqual(["contracts#the-vault"]);
  });

  test("a word does not match inside another word", () => {
    expect(at("pi")).toEqual([]);
    expect(at("ray")).toEqual([]);
  });

  test("a plural matches its singular and the other way round", () => {
    expect(at("gpu ")).toContain("introduction#who-it-is-for");
    // the title says "addresses", the vault's text "address"
    expect(at("addresses ")).toEqual(["contracts", "contracts#the-vault"]);
    expect(at("address ")).toEqual(["contracts", "contracts#the-vault"]);
  });

  test("a title match outranks a heading match, which outranks a text match", () => {
    // "Developer API" holds it in the title, "Who it is for" only in its text
    expect(at("api")[0]).toBe("api");
    expect(at("api").indexOf("api")).toBeLessThan(at("api").indexOf("introduction#who-it-is-for"));
    // a heading over the text
    expect(at("errors")[0]).toBe("api#errors");
  });

  test("a chapter's own entry comes before its sections on an equal match", () => {
    expect(at("developer")).toEqual(["api"]);
    const contracts = at("contracts");
    expect(contracts[0]).toBe("contracts");
  });

  test("a section that matches only through its chapter's title is left to the chapter", () => {
    expect(at("developer")).not.toContain("api#endpoints");
    expect(at("developer")).not.toContain("api#errors");
  });

  test("at most twenty hits", () => {
    const many: ChapterSource[] = Array.from({ length: 30 }, (_, i) => ({ slug: `c${i}`, title: `Chapter ${i}`, description: "About the price.", toc: [], sections: [{ id: null, heading: "", text: "" }] }));
    expect(searchIndex(prepareIndex(buildSearchIndex(many)), "price")).toHaveLength(20);
  });

  test("a hit names its section, or its chapter on the chapter's own entry, matches marked", () => {
    const [e] = find("errors");
    expect(marked(e.name)).toBe("<mark>Errors</mark>");
    const [c] = find("developer");
    expect(marked(c.name)).toBe("<mark>Developer</mark> API");
  });

  test("the snippet shows the words around the first match, marked", () => {
    const [h] = find("404");
    expect(marked(h.snippet)).toContain("answers <mark>404</mark> with");
  });
});

describe("marking", () => {
  test("a typed prefix marks what was typed, a whole word marks the word", () => {
    const { terms, prefix } = parseQuery("vault hol");
    expect(marked(highlight("The vault holds it", matcher(terms, prefix)))).toBe("The <mark>vault</mark> <mark>hol</mark>ds it");
  });

  test("marking ignores case and never marks inside a word", () => {
    const re = matcher(["api"], false);
    expect(marked(highlight("API, apis and rapid", re))).toBe("<mark>API</mark>, <mark>apis</mark> and rapid");
  });

  test("no query, no marks", () => {
    expect(highlight("text", null)).toEqual([{ text: "text", mark: false }]);
    expect(highlight("", null)).toEqual([]);
  });
});

describe("snippets", () => {
  const text = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");

  test("about 140 characters around the first match, cut at word edges, ellipses where text was left out", () => {
    const parts = snippet(text, matcher(["w30"], false));
    const s = marked(parts);
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(s).toContain("<mark>w30</mark>");
    const body = parts.map((p) => p.text).join("").replace(/…/g, "");
    expect(body.length).toBeLessThanOrEqual(140);
    expect(body.length).toBeGreaterThan(100);
    expect(text).toContain(body);
    expect(body).not.toMatch(/^\s|\s$/);
  });

  test("the start of the text when nothing in it matches", () => {
    const s = marked(snippet(text, matcher(["zzz"], false)));
    expect(s.startsWith("w0 w1")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
  });

  test("a match near the end keeps a full window", () => {
    const body = snippet(text, matcher(["w59"], false))
      .map((p) => p.text)
      .join("")
      .replace(/…/g, "");
    expect(body.endsWith("w59")).toBe(true);
    expect(body.length).toBeGreaterThan(100);
  });

  test("short text comes whole", () => {
    expect(marked(snippet("A short line.", matcher(["short"], false)))).toBe("A <mark>short</mark> line.");
  });
});
