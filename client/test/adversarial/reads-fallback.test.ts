// The reads' documented promise: when the indexer cannot serve, every read still answers from the chain. The default
// URL is http://localhost:8080/v1/graphql, which in a visitor's browser is the visitor's own machine; whatever answers
// there (a dev server's HTML page, a proxy's error page with status 200) must count as "no indexer", not crash the
// read. The defects these found are fixed; each test now guards its fix.
import { describe, expect, test } from "bun:test";

import { AgateClient } from "../../src/client.ts";
import { graphql, IndexerError } from "../../src/graphql.ts";

const html = (async () => new Response("<!doctype html><title>some dev server</title>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
const SERIES = "0x0000000000000000000000000000000000000011";

describe("an indexer URL that answers HTML with status 200", () => {
  test("graphql() reports it as an IndexerError (before the fix: a SyntaxError from r.json())", async () => {
    const g = graphql("http://localhost:8080/v1/graphql", { fetch: html });
    const e = await g.query("{ __typename }").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(IndexerError);
  });
  test("a read falls back to the chain (listedAt \"\") instead of throwing", async () => {
    const c = new AgateClient({ graphqlUrl: "http://localhost:8080/v1/graphql", fetch: html, publicClient: {} as never });
    const m = await c.seriesExtras([SERIES]);
    expect(m.get(SERIES)?.listedAt).toBe("");
  });
  test("control: an unreachable indexer does fall back", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const c = new AgateClient({ graphqlUrl: "http://localhost:8080/v1/graphql", fetch: down, publicClient: {} as never });
    const m = await c.seriesExtras([SERIES]);
    expect(m.get(SERIES)?.listedAt).toBe("");
  });
});
