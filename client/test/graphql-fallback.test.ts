// The indexer reader over several URLs (since Oct 6: Envio Cloud first, whose free plan allows 100 queries a minute,
// then agate's own indexer): which answers move a query on, how long a failing URL rests, what is never retried.
import { describe, expect, test } from "bun:test";
import { graphql, IndexerError } from "../src/graphql.ts";

const A = "https://envio.example/v1/graphql";
const B = "https://agate.example:8443/v1/graphql";
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });

/** A fetch whose answer per URL comes from `answer`; it records each URL it was asked. */
function rig(answer: (url: string) => Response | Error) {
  const asked: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const a = answer(url);
    if (a instanceof Error) throw a;
    return a;
  }) as typeof globalThis.fetch;
  return { asked, fetch };
}

describe("graphql over several indexers", () => {
  test("one URL behaves as before: one try, the same errors", async () => {
    const r = rig(() => new Response("rate limited", { status: 429 }));
    const g = graphql(A, { fetch: r.fetch });
    expect(g.url).toBe(A);
    await expect(g.query("{ x }")).rejects.toThrow("the indexer answered HTTP 429");
    expect(r.asked).toEqual([A]);
  });

  test("HTTP 429 from the first moves the query to the next, and the first rests for a minute", async () => {
    let t = 1_000_000;
    const r = rig((u) => (u === A ? new Response("slow down", { status: 429 }) : ok({ n: 1 })));
    const g = graphql(`${A}, ${B}`, { fetch: r.fetch, now: () => t });
    expect(g.url).toBe(A);
    expect(await g.query<{ n: number }>("{ n }")).toEqual({ n: 1 });
    expect(r.asked).toEqual([A, B]);
    // while A rests, B is asked first
    t += 30_000;
    await g.query("{ n }");
    expect(r.asked).toEqual([A, B, B]);
    // after the rest, A is first again
    t += 31_000;
    await g.query("{ n }");
    expect(r.asked).toEqual([A, B, B, A, B]);
  });

  test("unreachable, 5xx and a non-JSON page move on; the last failure is the one reported", async () => {
    for (const bad of [new Error("dns error"), new Response("bad gateway", { status: 502 }), new Response("<html>", { status: 200 })]) {
      const r = rig((u) => (u === A ? bad : ok({ fine: true })));
      expect(await graphql(`${A},${B}`, { fetch: r.fetch }).query<{ fine: boolean }>("{ fine }")).toEqual({ fine: true });
    }
    const down = rig((u) => (u === A ? new Error("dns error") : new Response("oops", { status: 503 })));
    const e = await graphql(`${A},${B}`, { fetch: down.fetch }).query("{ x }").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(IndexerError);
    expect((e as IndexerError).message).toBe("the indexer answered HTTP 503");
  });

  test("a query this indexer's schema refuses goes to the next without resting it; a limit or database error rests it", async () => {
    let t = 0;
    const schema = new Response(JSON.stringify({ errors: [{ message: "field 'nope' not found", extensions: { code: "validation-failed" } }] }), { status: 200 });
    const r = rig((u) => (u === A ? schema : ok({ nope: 1 })));
    const g = graphql(`${A},${B}`, { fetch: r.fetch, now: () => t });
    expect(await g.query<{ nope: number }>("{ nope }")).toEqual({ nope: 1 });
    await g.query("{ nope }");
    expect(r.asked).toEqual([A, B, A, B]); // A was not rested
    const limited = rig((u) => (u === A ? new Response(JSON.stringify({ errors: [{ message: "rate limit exceeded", extensions: { code: "rate-limit-exceeded" } }] }), { status: 200 }) : ok({})));
    const g2 = graphql(`${A},${B}`, { fetch: limited.fetch, now: () => t });
    await g2.query("{ x }");
    t += 1_000;
    await g2.query("{ x }");
    expect(limited.asked).toEqual([A, B, B]); // A rested
  });

  test("401, 402, 403 and 404 move on; a malformed request (400, 413, 422) is never retried", async () => {
    for (const status of [401, 402, 403, 404]) {
      const r = rig((u) => (u === A ? new Response("no", { status }) : ok({ ok: true })));
      expect(await graphql(`${A},${B}`, { fetch: r.fetch }).query<{ ok: boolean }>("{ ok }")).toEqual({ ok: true });
    }
    for (const status of [400, 413, 422]) {
      const r = rig((u) => (u === A ? new Response("bad", { status }) : ok({})));
      await expect(graphql(`${A},${B}`, { fetch: r.fetch }).query("{ x }")).rejects.toThrow(`HTTP ${status}`);
      expect(r.asked).toEqual([A]);
    }
  });

  test("variables that cannot be sent fail at once, with no request and no rest", async () => {
    const r = rig(() => ok({}));
    const g = graphql(`${A},${B}`, { fetch: r.fetch });
    const e = await g.query("{ x }", { n: 1n }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(IndexerError);
    expect((e as IndexerError).retryable).toBe(false);
    expect(r.asked).toEqual([]);
    await g.query("{ x }");
    expect(r.asked).toEqual([A]);
  });

  test("a success never cuts a rest short (a request sent before a concurrent 429)", async () => {
    let t = 0;
    let first = true;
    const r = rig((u) => {
      if (u !== A) return ok({});
      if (first) {
        first = false;
        return new Response("slow down", { status: 429 });
      }
      return ok({ late: true });
    });
    const g = graphql(`${A},${B}`, { fetch: r.fetch, now: () => t });
    await g.query("{ x }"); // A 429, rests; B answers
    t += 10_000;
    await g.query("{ x }"); // B first while A rests
    expect(r.asked).toEqual([A, B, B]);
  });

  test("with every URL resting, each is still tried in order", async () => {
    const t = 5_000;
    const r = rig(() => new Response("busy", { status: 429 }));
    const g = graphql(`${A},${B}`, { fetch: r.fetch, now: () => t });
    await expect(g.query("{ x }")).rejects.toThrow("HTTP 429");
    await expect(g.query("{ x }")).rejects.toThrow("HTTP 429");
    expect(r.asked).toEqual([A, B, A, B]);
  });

  test("a value with no URL in it reads the chain only: each query throws, the client is still built", async () => {
    const g = graphql(" , ");
    expect(g.url).toBe("");
    await expect(g.query("{ x }")).rejects.toThrow("no indexer URL is set");
  });
});
