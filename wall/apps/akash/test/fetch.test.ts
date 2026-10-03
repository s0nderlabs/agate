// BUILD-SPEC 16 tests: REST reads, the group cache, endpoint failover (mock servers), the output file, the start guard.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { cachePath, outPath, readGroups, runOnce } from "../src/fetch.ts";
import { keyVars } from "../src/guard.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "agate-akash-"));
  dirs.push(d);
  return d;
};
const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface MockOpts {
  chainId?: string;
  mode?: "ok" | "error" | "hang";
  leases?: unknown[];
  deployments?: unknown[];
}

const LATEST = 28_889_184;
/** A mock Akash REST endpoint in the real routes and field names. Counts every request by route. */
function mockAkash(o: MockOpts = {}) {
  const hits: Record<string, number> = {};
  const leases = o.leases ?? [];
  const deps = o.deployments ?? [];
  const page = <T>(all: T[], key: string | null, limit: number) => {
    const from = key ? Number(key) : 0;
    const next = from + limit < all.length ? String(from + limit) : null;
    return { items: all.slice(from, from + limit), next };
  };
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const route = u.pathname.replace(/\/\d+$/, "/<h>");
      hits[route] = (hits[route] ?? 0) + 1;
      if (req.headers.get("user-agent") !== "agate-wall/akash/0.1 (+https://github.com/s0nderlabs/agate)") return new Response("no ua", { status: 400 });
      if (o.mode === "error") return new Response("boom", { status: 500 });
      if (o.mode === "hang") {
        await Bun.sleep(5_000);
        return new Response("late");
      }
      const header = (height: number, time: string) => Response.json({ block: { header: { chain_id: o.chainId ?? "akashnet-2", height: String(height), time } } });
      if (u.pathname.endsWith("/blocks/latest")) return header(LATEST, "2026-10-02T18:36:40.000000000Z");
      if (/\/blocks\/\d+$/.test(u.pathname)) return header(LATEST - 10_000, "2026-10-02T02:14:20.000000000Z");
      if (u.pathname.endsWith("/akash/market/v1beta5/leases/list")) {
        expect(u.searchParams.get("filters.state")).toBe("active");
        const p = page(leases, u.searchParams.get("pagination.key"), Number(u.searchParams.get("pagination.limit")));
        return Response.json({ leases: p.items, pagination: { next_key: p.next, total: "0" } });
      }
      if (u.pathname.endsWith("/akash/deployment/v1beta4/deployments/info")) {
        const d = deps.find((x) => (x as { deployment: { id: { owner: string; dseq: string } } }).deployment.id.owner === u.searchParams.get("id.owner") && (x as { deployment: { id: { dseq: string } } }).deployment.id.dseq === u.searchParams.get("id.dseq"));
        return d ? Response.json(d) : new Response("not found", { status: 404 });
      }
      if (u.pathname.endsWith("/akash/deployment/v1beta4/deployments/list")) {
        const p = page(deps, u.searchParams.get("pagination.key"), Number(u.searchParams.get("pagination.limit")));
        return Response.json({ deployments: p.items, pagination: { next_key: p.next, total: "0" } });
      }
      return new Response("Not Implemented", { status: 501 });
    },
  });
  servers.push(srv);
  return { url: `http://127.0.0.1:${srv.port}`, hits };
}

const leaseJson = (owner: string, dseq: string, provider: string, amount: string, denom = "uact") => ({
  lease: { id: { owner, dseq, gseq: 1, oseq: 1, provider, bseq: 0 }, state: "active", price: { denom, amount }, created_at: "1", closed_on: "0" },
  escrow_payment: {},
});
const depJson = (owner: string, dseq: string, keys: string[], units = 1, count = 1) => ({
  deployment: { id: { owner, dseq }, state: "active" },
  groups: [
    {
      id: { owner, dseq, gseq: 1 },
      state: "open",
      group_spec: {
        name: "akash",
        resources: [{ resource: { id: 1, cpu: { units: { val: "1000" } }, gpu: { units: { val: String(units) }, attributes: keys.map((key) => ({ key, value: "true" })) } }, count, price: { denom: "uact", amount: "1.0" } }],
      },
    },
  ],
});

const H100 = "vendor/nvidia/model/h100";
const world = () => {
  const leases = [leaseJson("akash1buyer1", "100", "akash1sellerA", "4263.344103000000000000"), leaseJson("akash1buyer1", "101", "akash1sellerA", "4263.344103000000000000"), leaseJson("akash1buyer2", "102", "akash1sellerB", "4500.000000000000000000"), leaseJson("akash1buyer3", "103", "akash1sellerB", "300.000000000000000000")];
  const deployments = [depJson("akash1buyer1", "100", [H100]), depJson("akash1buyer1", "101", [`${H100}/ram/80Gi/interface/sxm`]), depJson("akash1buyer2", "102", [H100]), depJson("akash1buyer3", "103", [H100, "vendor/nvidia/model/a100"])];
  return { leases, deployments };
};

describe("one run against a mock endpoint", () => {
  test("output shape, numbers and the history line", async () => {
    const m = mockAkash(world());
    const home = tmp();
    const r = await runOnce({ home, endpoints: [m.url], now: () => 1_790_000_000 });
    expect(r.ok).toBe(true);
    const f = JSON.parse(readFileSync(outPath(home), "utf8"));
    expect(Object.keys(f)).toEqual(["kind", "version", "label", "displayOnly", "generatedAt", "chain", "endpoint", "blockMs", "blockMsOverBlocks", "unit", "gpus", "leasesSeen", "missingGroups", "notes", "error"]);
    expect(f.kind).toBe("agate.akash-traded");
    expect(f.label).toBe("traded, Akash chain");
    expect(f.displayOnly).toBe(true);
    expect(f.chain).toEqual({ id: "akashnet-2", height: LATEST, time: "2026-10-02T18:36:40.000000000Z" });
    expect(f.blockMs).toBe(5894); // 58,940 s over 10,000 blocks
    expect(f.unit.denom).toBe("uact");
    expect(f.gpus.H100.leases).toBe(3);
    expect(f.gpus.H100.medianU).toBe(2_604_011);
    expect(f.gpus.H100.median).toBe("2.60");
    expect(f.gpus.H100.sellers).toBe(2);
    expect(f.gpus.H100.buyers).toBe(2);
    expect(f.gpus.H100.excluded).toEqual({ ambiguousModel: 1, otherDenom: 0 });
    expect(f.gpus.H100.interfaces).toEqual({ sxm: 1, pcie: 0, unstated: 2 });
    expect(f.error).toBeNull();
    const hist = readdirSync(join(home, "history"));
    expect(hist).toEqual(["2026-09-21.jsonl"]);
    expect(readFileSync(join(home, "history", hist[0]!), "utf8").trim().split("\n").length).toBe(1);
  });

  test("lease pages are all read (next_key)", async () => {
    const w = world();
    const many = Array.from({ length: 2_350 }, (_, i) => leaseJson(`akash1cpu${i}`, String(5_000 + i), "akash1sellerC", "1"));
    const m = mockAkash({ leases: [...w.leases, ...many], deployments: w.deployments });
    const home = tmp();
    const r = await runOnce({ home, endpoints: [m.url], infoCap: 10 });
    expect(r.ok).toBe(true);
    expect(m.hits["/akash/market/v1beta5/leases/list"]).toBe(3);
    expect(r.file.leasesSeen).toBe(2_354);
  });
});

describe("group cache (16.3)", () => {
  test("incremental: only missing groups are looked up, then served from the cache", async () => {
    const m = mockAkash(world());
    const home = tmp();
    await runOnce({ home, endpoints: [m.url] });
    expect(m.hits["/akash/deployment/v1beta4/deployments/info"]).toBe(4);
    const cache = JSON.parse(readFileSync(cachePath(home), "utf8"));
    expect(Object.keys(cache).sort()).toEqual(["akash1buyer1/100/1", "akash1buyer1/101/1", "akash1buyer2/102/1", "akash1buyer3/103/1"]);
    await runOnce({ home, endpoints: [m.url] });
    expect(m.hits["/akash/deployment/v1beta4/deployments/info"]).toBe(4); // nothing new
    expect(m.hits["/akash/deployment/v1beta4/deployments/list"]).toBeUndefined();
  });
  test("more missing deployments than the cap: the active list in pages of 500 instead", async () => {
    const w = world();
    const m = mockAkash(w);
    const leases = w.leases.map((l) => ({ owner: l.lease.id.owner, dseq: l.lease.id.dseq, gseq: 1, provider: l.lease.id.provider, price: l.lease.price }));
    const r = await readGroups(m.url, async (u, t) => (await fetch(u, { headers: { "user-agent": "agate-wall/akash/0.1 (+https://github.com/s0nderlabs/agate)" }, signal: AbortSignal.timeout(t) })).json(), 5_000, leases, {}, 3);
    expect(r.stats.listed).toBe(true);
    expect(r.stats.infoCalls).toBe(0);
    expect(m.hits["/akash/deployment/v1beta4/deployments/list"]).toBe(1);
    expect(Object.keys(r.groups).length).toBe(4);
  });
});

describe("endpoint failover (16.7)", () => {
  test("an error, a hang and a wrong chain id each move to the next endpoint", async () => {
    const bad = mockAkash({ mode: "error" });
    const hang = mockAkash({ mode: "hang" });
    const wrong = mockAkash({ ...world(), chainId: "akashnet-3" });
    const good = mockAkash(world());
    const home = tmp();
    const r = await runOnce({ home, endpoints: [bad.url, hang.url, wrong.url, good.url], timeoutMs: 500, retryMs: 0 });
    expect(r.ok).toBe(true);
    expect(r.endpoint).toBe(good.url);
    expect(r.errors.length).toBe(3);
    expect(r.errors[0]).toContain("HTTP 500");
    expect(r.errors[2]).toContain("akashnet-3");
    expect(wrong.hits["/akash/market/v1beta5/leases/list"]).toBeUndefined(); // nothing read from the wrong chain
  });
  test("every endpoint failing keeps the last good file and sets error", async () => {
    const good = mockAkash(world());
    const home = tmp();
    const first = await runOnce({ home, endpoints: [good.url] });
    const bad = mockAkash({ mode: "error" });
    const r = await runOnce({ home, endpoints: [bad.url], timeoutMs: 500, retryMs: 0 });
    expect(r.ok).toBe(false);
    const f = JSON.parse(readFileSync(outPath(home), "utf8"));
    expect(f.error).toContain("every endpoint failed");
    expect(f.gpus.H100.medianU).toBe(first.file.gpus.H100!.medianU);
    expect(f.generatedAt).toBe(first.file.generatedAt);
  });
  test("no file yet and every endpoint failing: an error file with no prices", async () => {
    const bad = mockAkash({ mode: "error" });
    const home = tmp();
    await runOnce({ home, endpoints: [bad.url], timeoutMs: 500, retryMs: 0 });
    const f = JSON.parse(readFileSync(outPath(home), "utf8"));
    expect(f.gpus).toEqual({});
    expect(typeof f.error).toBe("string");
  });
});

describe("start guard", () => {
  test("refuses to start with a key variable set (never printing its value)", async () => {
    const home = tmp();
    const errors: string[] = [];
    const orig = console.error;
    let err: unknown;
    try {
      console.error = (...a: unknown[]) => errors.push(a.join(" "));
      await main(["run"], { AGATE_WALL_HOME: home, AGATE_STANDBY_KEY: "0xSECRETSECRET" });
    } catch (e) {
      err = e;
    } finally {
      console.error = orig;
    }
    expect(String(err)).toContain("AGATE_STANDBY_KEY");
    expect(String(err)).not.toContain("SECRETSECRET");
    expect(existsSync(join(home, "akash"))).toBe(false);
  });
  test("key names: *_KEY, *_KEY_CMD and CRE_ETH_PRIVATE_KEY", () => {
    expect(keyVars({ A_KEY: "1", B_KEY_CMD: "x", CRE_ETH_PRIVATE_KEY: "y", AGATE_RPC_URLS_CMD: "z", KEYCHAIN: "k" })).toEqual(["A_KEY", "B_KEY_CMD", "CRE_ETH_PRIVATE_KEY"]);
  });
  test("a real process refuses too", () => {
    const home = tmp();
    writeFileSync(join(home, "x"), "");
    const p = Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "../src/cli.ts"), "run"], { env: { PATH: process.env.PATH ?? "", AGATE_WALL_HOME: home, AGATE_KEEPER_KEY: "0xabc" }, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).not.toBe(0);
    expect(p.stderr.toString()).toContain("AGATE_KEEPER_KEY");
  });
});
