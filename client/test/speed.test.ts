// The fast paths of the reads (Oct 6): the markets snapshot and what is read once (a listed month's series, a
// series' terms) or every time (a series' market, whose book follows it when it is replaced).
import { describe, expect, setSystemTime, test } from "bun:test";
import type { PublicClient } from "viem";
import { AgateClient, GPUS, SNAPSHOT_MAX_AGE_MS, snapshotOf, TESTNET_DEPLOYMENTS } from "../src/index.ts";
import type { Book, Market, MarketsSnapshot } from "../src/types.ts";

const F = TESTNET_DEPLOYMENTS.factories.real!;
const INDEX = F.index.toLowerCase();
const H100 = `0x${"11".repeat(32)}`;
const SERIES = `0x${"5e".repeat(20)}`;
const TOKEN = `0x${"70".repeat(20)}`;
const M1 = `0x${"a1".repeat(20)}`;
const M2 = `0x${"a2".repeat(20)}`;
const ZERO = `0x${"00".repeat(20)}`;
const NOV = 2026 * 12 + 10;
const BOOK_HEX = `0x${"00".repeat(31)}01${"00".repeat(32)}`;

/** A chain with H100 November listed (its market `market()`), counting every read by name. */
function chain(o: { market?: () => string; listedFrom?: number } = {}) {
  const reads: string[] = [];
  let seriesOfCalls = 0;
  const read = ({ address, functionName, args }: { address: string; functionName: string; args?: readonly unknown[] }): unknown => {
    reads.push(functionName === "getL2Book" ? `getL2Book@${address.toLowerCase()}` : functionName);
    switch (functionName) {
      case "gpuIds":
        return [H100];
      case "labelOf":
        return String(args?.[0]).toLowerCase() === H100 ? "H100" : "";
      case "seriesOf":
        seriesOfCalls++;
        return Number(args?.[1]) === NOV && seriesOfCalls >= (o.listedFrom ?? 1) ? SERIES : ZERO;
      case "terms":
        return { gpuId: H100, month: NOV, startDay: 20758, n: 30, startTs: 1_793_491_200n, day: 86_400, floor: 1_950_000, cap: 8_000_000 };
      case "token":
        return TOKEN;
      case "name":
        return "agate H100 Nov 2026";
      case "symbol":
        return "H100-NOV26";
      case "marketOf":
        return [o.market ? o.market() : M1, 1];
      case "previewSync":
        return [0, 0n];
      case "state":
        return [0, 0n, 0, false, false, 0n, 1n, 0n];
      case "totalSupply":
        return 0n;
      case "getL2Book":
        return BOOK_HEX;
    }
    throw new Error(`unexpected read ${functionName}`);
  };
  const pub = {
    getCode: async () => undefined, // call by call, so every read is counted
    readContract: async (r: { address: string; functionName: string; args?: readonly unknown[] }) => read(r),
    getBlock: async () => ({ timestamp: 1_791_300_000n }),
  } as unknown as PublicClient;
  return { pub, reads };
}

const BOOK: Book = { asks: [{ price: 4.1, size: 10 }], bids: [{ price: 3.9, size: 20 }], spread: 0.2 } as Book;
function snap(o: Partial<MarketsSnapshot> = {}): MarketsSnapshot {
  return {
    v: 1,
    chainId: TESTNET_DEPLOYMENTS.chainId,
    index: INDEX,
    readAt: new Date().toISOString(),
    ageMs: 1_000,
    markets: GPUS.map((gpu) => ({ gpu, price: 4, series: [], history: [] }) as unknown as Market),
    books: { "H100 2026-11": BOOK },
    ...o,
  };
}
function server(answer: () => Response | Promise<Response>) {
  let calls = 0;
  const fetch = (async () => {
    calls++;
    return answer();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls: () => calls };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

describe("snapshotOf", () => {
  test("a snapshot of this chain and index, young and well formed, is used", () => {
    expect(snapshotOf(snap(), TESTNET_DEPLOYMENTS.chainId, INDEX)).not.toBeNull();
    expect(snapshotOf(snap(), TESTNET_DEPLOYMENTS.chainId, INDEX.toUpperCase().replace("0X", "0x"))).not.toBeNull();
  });
  test("another chain, another index, an old one, a wrong version or a broken shape is not", () => {
    const id = TESTNET_DEPLOYMENTS.chainId;
    expect(snapshotOf(snap({ chainId: 143 }), id, INDEX)).toBeNull();
    expect(snapshotOf(snap({ index: ZERO }), id, INDEX)).toBeNull();
    expect(snapshotOf(snap({ ageMs: SNAPSHOT_MAX_AGE_MS + 1 }), id, INDEX)).toBeNull();
    expect(snapshotOf(snap({ ageMs: -1 }), id, INDEX)).toBeNull();
    expect(snapshotOf({ ...snap(), v: 2 }, id, INDEX)).toBeNull();
    expect(snapshotOf(snap({ markets: snap().markets.slice(1) }), id, INDEX)).toBeNull();
    expect(snapshotOf(snap({ markets: [...snap().markets].reverse() }), id, INDEX)).toBeNull();
    expect(snapshotOf(snap({ books: { "H100 2026-11": { asks: [] } as unknown as Book } }), id, INDEX)).toBeNull();
    expect(snapshotOf(null, id, INDEX)).toBeNull();
    expect(snapshotOf("nope", id, INDEX)).toBeNull();
  });
});

describe("the markets snapshot", () => {
  test("getMarkets, getMarket and book answer from a fresh snapshot, one request for reads close together", async () => {
    const { pub, reads } = chain();
    const s = server(() => json(snap()));
    const c = new AgateClient({ publicClient: pub, graphqlUrl: null, snapshotUrl: "http://snap/api/markets", fetch: s.fetch });
    const [ms, h100, book] = await Promise.all([c.getMarkets(), c.getMarket("H100"), c.book("H100", "2026-11")]);
    expect(ms.map((m) => m.gpu)).toEqual(GPUS);
    expect(h100.gpu).toBe("H100");
    expect(book).toEqual(BOOK);
    expect(s.calls()).toBe(1);
    expect(reads).toEqual([]);
  });

  test("a month the snapshot has no book for is read from the chain", async () => {
    const { pub, reads } = chain();
    const c = new AgateClient({ publicClient: pub, graphqlUrl: null, snapshotUrl: "http://snap/api/markets", fetch: server(() => json(snap({ books: {} }))).fetch });
    await c.book("H100", "2026-11");
    expect(reads).toContain("seriesOf");
    expect(reads).toContain(`getL2Book@${M1}`);
  });

  test("a failed snapshot falls back to the chain and rests a minute: past the 2 s share it is still not asked", async () => {
    const { pub, reads } = chain();
    const s = server(() => json({ error: "down" }, 503));
    const c = new AgateClient({ publicClient: pub, graphqlUrl: null, snapshotUrl: "http://snap/api/markets", fetch: s.fetch });
    const t0 = Date.now();
    try {
      await c.book("H100", "2026-11");
      setSystemTime(new Date(t0 + 3_000));
      await c.book("H100", "2026-11");
      expect(s.calls()).toBe(1);
      expect(reads.filter((r) => r === "marketOf").length).toBe(2);
      setSystemTime(new Date(t0 + 61_000));
      await c.book("H100", "2026-11");
      expect(s.calls()).toBe(2);
    } finally {
      setSystemTime();
    }
  });

  test("an unreachable or malformed snapshot falls back too", async () => {
    for (const answer of [() => Promise.reject(new TypeError("fetch failed")), () => new Response("<html>", { status: 200 }), () => json(snap({ ageMs: 120_000 }))]) {
      const { pub, reads } = chain();
      const c = new AgateClient({ publicClient: pub, graphqlUrl: null, snapshotUrl: "http://snap/api/markets", fetch: server(answer).fetch });
      await c.book("H100", "2026-11");
      expect(reads).toContain(`getL2Book@${M1}`);
    }
  });

  test("an unknown GPU or a month not written YYYY-MM is still refused with a snapshot", async () => {
    const { pub } = chain();
    const c = new AgateClient({ publicClient: pub, graphqlUrl: null, snapshotUrl: "http://snap/api/markets", fetch: server(() => json(snap())).fetch });
    await expect(c.book("H999" as never, "2026-11")).rejects.toThrow("unknown GPU");
    await expect(c.getMarket("H999" as never)).rejects.toThrow("unknown GPU");
    await expect(c.book("H100", "Nov")).rejects.toThrow("YYYY-MM");
  });
});

describe("read once, read every time", () => {
  test("a listed month's series is read once; a month not listed yet is asked again", async () => {
    const { pub, reads } = chain({ listedFrom: 2 });
    const c = new AgateClient({ publicClient: pub, graphqlUrl: null });
    const pair = [{ gpuId: H100, month: NOV }];
    expect(await c.seriesAddresses(pair)).toEqual([null]);
    expect(await c.seriesAddresses(pair)).toEqual([SERIES as `0x${string}`]);
    expect(await c.seriesAddresses(pair)).toEqual([SERIES as `0x${string}`]);
    expect(reads.filter((r) => r === "seriesOf").length).toBe(2);
  });

  test("a series' terms are read once; its market every time, and a replaced market's book is read from the new one", async () => {
    let market = M1;
    const { pub, reads } = chain({ market: () => market });
    const c = new AgateClient({ publicClient: pub, graphqlUrl: null });
    const first = await c.seriesLive([SERIES as `0x${string}`]);
    expect(first[0]!.terms.name).toBe("agate H100 Nov 2026");
    expect(first[0]!.market?.toLowerCase()).toBe(M1);
    reads.length = 0;
    await c.seriesLive([SERIES as `0x${string}`]);
    // the second read: no terms, token, name or symbol; the market and the last market's book in the same round
    expect(reads.filter((r) => ["terms", "token", "name", "symbol"].includes(r))).toEqual([]);
    expect(reads).toContain("marketOf");
    expect(reads).toContain(`getL2Book@${M1}`);
    market = M2;
    reads.length = 0;
    const moved = await c.seriesLive([SERIES as `0x${string}`]);
    expect(moved[0]!.market?.toLowerCase()).toBe(M2);
    expect(reads).toContain(`getL2Book@${M2}`);
    expect(moved[0]!.book).not.toBeNull();
  });

  test("a series whose market is gone has no book", async () => {
    let market = M1;
    const { pub } = chain({ market: () => market });
    const c = new AgateClient({ publicClient: pub, graphqlUrl: null });
    await c.seriesLive([SERIES as `0x${string}`]);
    market = ZERO;
    const gone = await c.seriesLive([SERIES as `0x${string}`]);
    expect(gone[0]!.market).toBeNull();
    expect(gone[0]!.book).toBeNull();
  });

  test("the factory's GPUs: the panels' ids are labelled in the same round as the list", async () => {
    const { pub, reads } = chain();
    const c = new AgateClient({ publicClient: pub, graphqlUrl: null });
    const mg = await c.marketGpus();
    expect([...mg.entries()]).toEqual([[H100, "H100"]]);
    expect(reads.filter((r) => r === "gpuIds").length).toBe(1);
  });
});

describe("an RPC list", () => {
  test("a comma list is tried in order: a URL that is rate limited passes the call to the next", async () => {
    let limited = 0;
    let served = 0;
    const a = Bun.serve({ port: 0, fetch: () => (limited++, new Response("Monthly capacity limit exceeded", { status: 429 })) });
    const b = Bun.serve({
      port: 0,
      fetch: async (req) => {
        served++;
        const { id } = (await req.json()) as { id: number };
        return Response.json({ jsonrpc: "2.0", id, result: { number: "0x10", hash: `0x${"ab".repeat(32)}`, timestamp: "0x6a10a000", transactions: [], logsBloom: null } });
      },
    });
    try {
      const { createAgateClient } = await import("../src/index.ts");
      const c = createAgateClient({ rpcUrl: ` http://127.0.0.1:${a.port}/ , http://127.0.0.1:${b.port}/ `, graphqlUrl: null });
      expect(c.chain.rpcUrls.default.http).toEqual([`http://127.0.0.1:${a.port}/`, `http://127.0.0.1:${b.port}/`]);
      expect(await c.chainTime()).toBe(0x6a10a000n);
      expect(limited).toBeGreaterThan(0);
      expect(served).toBeGreaterThan(0);
    } finally {
      a.stop(true);
      b.stop(true);
    }
  });

  test("one URL, or none given, is a single transport", async () => {
    const { createAgateClient, PUBLIC_RPC } = await import("../src/index.ts");
    expect(createAgateClient({ graphqlUrl: null }).chain.rpcUrls.default.http).toEqual([PUBLIC_RPC]);
    expect(createAgateClient({ rpcUrl: " , ", graphqlUrl: null }).chain.rpcUrls.default.http).toEqual([PUBLIC_RPC]);
  });
});
