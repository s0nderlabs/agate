// The workflow body under the CRE SDK's test runtime with the REAL @agate/sources parsers and the real launch panels:
// HTTP and EVM capabilities mocked, the pages hand-written synthetic ones in each cloud's own structure (never copies).
import { expect } from "bun:test";
import { decodeReport } from "@agate/report";
import type { Panel } from "@agate/sources/types";
import { renderPage } from "@agate/sources/synthetic";
import { EvmMock, HttpActionsMock, newTestRuntime, REPORT_METADATA_HEADER_LENGTH, test } from "@chainlink/cre-sdk/test";
import { bytesToHex } from "viem";
import { type Config, onCron } from "../handler.ts";

const SELECTOR = 2183018362218727504n;
const PANELS = ((await Bun.file(`${import.meta.dir}/../../../../packages/sources/panels/default.json`).json()) as { panels: Panel[] }).panels;
const cfg: Config = {
  index: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  chainSelector: SELECTOR.toString(),
  gasLimit: "1614000", // the runner's creGasLimit: ceil(1.5 x MEASURED onReport)
  schedule: "0 7 * * * *",
  role: "primary",
  timeout: "10s",
  sourceBaseUrl: "http://replay.test",
  clock: { day: 2_400, slices: 12, epochTs: 1_790_812_800, epochDay: 20_727 },
  panels: PANELS,
};
const NOW = 1_790_812_800 + 5 * 200 + 37; // TEST day 20,727, slice 5
const PAGES: Record<string, string> = {
  p_verda: renderPage("p_verda", { H100: { price: "3.63", count: 8 }, H200: { price: "4.73", count: 8 }, B200: { price: "6.92", count: 8 }, B300: { price: "8.80", count: 8 }, A100: { price: "1.80", count: 8 }, L40S: { price: "1.56", count: 8 } }),
  p_nebius: renderPage("p_nebius", { H100: { price: "4.50", count: 8 }, H200: { price: "5.40", count: 8 }, B200: { price: "8.50", count: 8 }, B300: { price: "9.50", count: 8 } }),
  p_lambda: renderPage("p_lambda", { H100: { price: "3.99", count: 8 }, B200: { state: "not-rentable" }, A100: { price: "2.79", count: 8 } }),
  p_hyperstack: renderPage("p_hyperstack", { H100: { price: "2.40", count: 8 }, H200: { price: "3.50", count: 8 }, B200: { price: "5.90", count: 8 }, B300: { price: "7.40", count: 8 }, A100: { price: "1.60", count: 8 } }),
};

test("one run: every page once with the agate user agent, the real parsers, one entry per GPU, one writeReport", () => {
  const urls: string[] = [];
  const http = HttpActionsMock.testInstance();
  http.sendRequest = (req) => {
    urls.push(req.url);
    expect(req.headers["User-Agent"]).toBe("agate-wall/primary/0.1 (+https://github.com/s0nderlabs/agate)");
    const id = req.url.split("/").pop()!;
    if (id === "p_civo") return { statusCode: 503, body: "" };
    return { statusCode: 200, body: Buffer.from(PAGES[id]!).toString("base64"), headers: { "X-Agate-Page-Time": String(NOW) } };
  };
  let written: { receiver: string; payload: `0x${string}`; gas: string } | undefined;
  const evm = EvmMock.testInstance(SELECTOR);
  evm.writeReport = (input) => {
    written = {
      receiver: bytesToHex(input.receiver),
      payload: bytesToHex(input.report!.rawReport.slice(REPORT_METADATA_HEADER_LENGTH)),
      gas: String(input.gasConfig?.gasLimit),
    };
    return { txStatus: 2, txHash: new Uint8Array(32).fill(0xab) } as never;
  };

  const runtime = newTestRuntime<Config>(null, { timeProvider: () => NOW * 1000 }, cfg);
  const out = JSON.parse(onCron(runtime as never, {} as never));

  expect(urls.sort()).toEqual(["p_civo", "p_hyperstack", "p_lambda", "p_nebius", "p_verda"].map((id) => `http://replay.test/${id}`));
  expect(out).toMatchObject({ agate: 1, dayId: 20_727, slice: 5, t: NOW - 2 });
  expect(out.tx.status).toBe(2);
  expect(out.tx.hash).toBe(`0x${"ab".repeat(32)}`);
  expect(written!.receiver.toLowerCase()).toBe(cfg.index.toLowerCase());
  expect(written!.gas).toBe("1614000");
  const report = decodeReport(written!.payload);
  expect(report).toMatchObject({ version: 1, chainSelector: SELECTOR });
  expect(report.entries.map((e) => e.values)).toEqual([
    [3_630_000, 4_500_000, 3_990_000, 0, 2_400_000], // H100: Civo answered 503, its slot sends 0
    [4_730_000, 5_400_000, 0, 3_500_000], // H200: the reserve (Hyperstack) carries its value; E8b ignores it onchain
    [6_920_000, 8_500_000, 0, 5_900_000], // B200: Lambda not rentable
    [8_800_000, 9_500_000, 0, 7_400_000], // B300 (price-only, 18.1): Civo's slot sends 0
    [1_800_000, 2_790_000, 1_600_000], // A100 SXM 80GB
    [1_560_000, 0], // L40S: Verda live, Civo (503) the reserve
  ]);
  expect(report.entries.map((e) => e.gpuId)).toEqual(PANELS.map((p) => p.gpuId)); // one entry per registered GPU, in panel order
  expect(report.entries.every((e) => e.slice === 5 && e.readAt === BigInt(NOW - 2))).toBe(true);
  const civo = out.sources.find((s: { sourceId: string }) => s.sourceId === "p_civo");
  expect(civo.rows.H100.state).toBe("FAILED");
  expect(out.sources.find((s: { sourceId: string }) => s.sourceId === "p_lambda").rows.B200.state).toBe("NOT_RENTABLE");
});

test("a FAST clock (24-second day, signAll) is derived inside the workflow without throwing", () => {
  const http = HttpActionsMock.testInstance();
  http.sendRequest = (req) => ({ statusCode: 200, body: Buffer.from(PAGES[req.url.split("/").pop()!] ?? "").toString("base64") });
  const evm = EvmMock.testInstance(SELECTOR);
  evm.writeReport = () => ({ txStatus: 2, txHash: new Uint8Array(32).fill(1) }) as never;
  const fast: Config = { ...cfg, clock: { day: 24, slices: 2, epochTs: 1_790_812_800, epochDay: 20_727, signAll: true } };
  const t = 1_790_812_800 + 24 * 3 + 13; // day 20,730, slice 1
  const out = JSON.parse(onCron(newTestRuntime<Config>(null, { timeProvider: () => t * 1000 }, fast) as never, {} as never));
  expect(out).toMatchObject({ dayId: 20_730, slice: 1, t });
});

// ---------------------------------------------------------------- Oct 3: readers in force (8.2 (3), 8.6)

const LAUNCH = ((await Bun.file(`${import.meta.dir}/../../../../packages/sources/panels/launch.json`).json()) as { panels: Panel[] }).panels;
const lambdaSlot = (gpu: string) => LAUNCH.find((p) => p.gpu === gpu)!.slots.find((s) => s.sourceId === "p_lambda")!.slot;

function runWith(c: Config, page: (url: string) => string | undefined) {
  const urls: string[] = [];
  const http = HttpActionsMock.testInstance();
  http.sendRequest = (req) => {
    urls.push(req.url);
    const body = page(req.url);
    return body === undefined ? { statusCode: 404, body: "" } : { statusCode: 200, body: Buffer.from(body).toString("base64"), headers: { "X-Agate-Page-Time": String(NOW) } };
  };
  let payload: `0x${string}` | undefined;
  const evm = EvmMock.testInstance(SELECTOR);
  evm.writeReport = (input) => {
    payload = bytesToHex(input.report!.rawReport.slice(REPORT_METADATA_HEADER_LENGTH));
    return { txStatus: 2, txHash: new Uint8Array(32).fill(0xcd) } as never;
  };
  const out = JSON.parse(onCron(newTestRuntime<Config>(null, { timeProvider: () => NOW * 1000 }, c) as never, {} as never));
  return { urls, out, report: decodeReport(payload!) };
}

const LIVE: Record<string, string> = {
  "https://api.verda.com/v1/instance-types": renderPage("p_verda", { H100: { price: "3.63" }, H200: { price: "4.73" }, B200: { price: "6.92" } }),
  "https://docs.nebius.com/compute/resources/pricing.md": renderPage("p_nebius", { H100: { price: "4.50" }, H200: { price: "5.40" }, B200: { price: "8.50" } }),
  "https://lambda.ai/pricing": renderPage("p_lambda", { H100: { price: "3.99" }, B200: { price: "6.69" } }),
  "https://lambda.ai/pricing-2026": renderPage("p_lambda", { H100: { price: "3.79" }, B200: { price: "6.49" } }),
  "https://www.coreweave.com/pricing": renderPage("p_coreweave", { H100: { price: "6.16" }, H200: { price: "6.31" }, B200: { price: "8.60" } }),
  "https://www.civo.com/pricing": renderPage("p_civo", { H100: { price: "2.99" }, H200: { price: "3.49" } }),
  "https://www.hyperstack.cloud/gpu-pricing": renderPage("p_hyperstack", { H100: { price: "2.40" }, H200: { price: "3.50" }, B200: { price: "5.90" } }),
};

test("readers in force: a moved Lambda page for H100 is fetched beside the registered one, each URL once", () => {
  const h100 = LAUNCH.find((p) => p.gpu === "H100")!;
  const c: Config = { ...cfg, panels: LAUNCH, readers: { [h100.gpuId]: { [String(lambdaSlot("H100"))]: { url: "https://lambda.ai/pricing-2026", parserVersion: "lambda/1" } } } };
  delete (c as { sourceBaseUrl?: string }).sourceBaseUrl;
  const { urls, out, report } = runWith(c, (u) => LIVE[u]);
  expect(urls.filter((u) => u.startsWith("https://lambda.ai/"))).toEqual(["https://lambda.ai/pricing", "https://lambda.ai/pricing-2026"]);
  expect(new Set(urls).size).toBe(urls.length); // every distinct URL once
  const e = (gpu: string) => report.entries.find((x) => x.gpuId === LAUNCH.find((p) => p.gpu === gpu)!.gpuId)!;
  expect(e("H100").values[lambdaSlot("H100")]).toBe(3_790_000); // the swapped reader's page
  expect(e("B200").values[lambdaSlot("B200")]).toBe(6_690_000); // B200's slot not swapped: the registered page
  const lam = out.sources.find((s: { sourceId: string }) => s.sourceId === "p_lambda");
  expect(lam.urls).toEqual({ H100: "https://lambda.ai/pricing-2026" });
  expect(lam.parsers).toBeUndefined(); // a URL-only swap: every GPU still on lambda/1
});

test("a version the compiled workflow lacks reads 0 for that slot (MISSED), never another reader; a refused one is never fetched", () => {
  const b200 = LAUNCH.find((p) => p.gpu === "B200")!;
  const h100 = LAUNCH.find((p) => p.gpu === "H100")!;
  const civo = h100.slots.find((s) => s.sourceId === "p_civo")!.slot;
  const c: Config = {
    ...cfg,
    panels: LAUNCH,
    readers: {
      [b200.gpuId]: { [String(lambdaSlot("B200"))]: { url: "https://lambda.ai/pricing", parserVersion: "lambda/9" } },
      [h100.gpuId]: { [String(civo)]: { refused: "host evil.example is not on p_civo's hosts" } },
    },
  };
  const { urls, out, report } = runWith(c, (u) => {
    const id = u.split("/").pop()!;
    const def = Object.entries(LIVE).find(([k]) => k.includes(id.replace("p_", "")))?.[1];
    return def;
  });
  expect(urls.filter((u) => u.endsWith("/p_lambda")).length).toBe(1); // under the replay base: /p_lambda once
  const e = (gpu: string) => report.entries.find((x) => x.gpuId === LAUNCH.find((p) => p.gpu === gpu)!.gpuId)!;
  expect(e("B200").values[lambdaSlot("B200")]).toBe(0);
  expect(e("H100").values[lambdaSlot("H100")]).toBe(3_990_000); // H100's Lambda slot keeps lambda/1
  expect(e("H100").values[civo]).toBe(0);
  const lam = out.sources.find((s: { sourceId: string }) => s.sourceId === "p_lambda");
  expect(lam.rows.B200.state).toBe("MISSED");
  expect(lam.refused.B200).toMatch(/lambda\/9/);
  expect(lam.parsers).toEqual({ H100: "lambda/1", A100: "lambda/1" }); // every GPU Lambda prices but the refused one
  const cv = out.sources.find((s: { sourceId: string }) => s.sourceId === "p_civo");
  expect(cv.rows.H100.state).toBe("MISSED");
  expect(cv.rows.H200.state).toBe("VALID"); // the civo page was still fetched once for H200
});

// ---------------------------------------------------------------- Oct 9: the workflow reads the index (EVM read)

import { agateIndexAbi } from "@agate/report/abi";
import { decodeFunctionData, encodeFunctionResult, type Hex, multicall3Abi } from "viem";
import { MULTICALL3 } from "../handler.ts";

const WRITER = "0x00000000000000000000000000000000000000aa" as const;
type AbiParam = { type: string; components?: readonly AbiParam[]; name?: string };
const fnOut = (name: string) => (agateIndexAbi as readonly { type: string; name?: string; outputs?: readonly AbiParam[] }[]).find((x) => x.type === "function" && x.name === name)!.outputs![0]!;
/** A zero value of an ABI type, with overrides by field name at the top level. */
function zeroOf(p: AbiParam, over: Record<string, unknown> = {}): unknown {
  if (p.type.endsWith("[]")) return [];
  if (p.type === "tuple") return Object.fromEntries(p.components!.map((c) => [c.name!, c.name! in over ? over[c.name!] : zeroOf(c)]));
  if (p.type === "bool") return false;
  if (p.type === "address") return "0x0000000000000000000000000000000000000000";
  if (p.type.startsWith("bytes")) return p.type === "bytes" ? "0x" : `0x${"00".repeat(Number(p.type.slice(5)))}`;
  return p.type.startsWith("uint") && Number(p.type.slice(4) || 256) > 48 ? 0n : 0;
}
const CHAIN_CLOCK = { day: cfg.clock.day, slices: cfg.clock.slices, epochTs: BigInt(cfg.clock.epochTs), epochDay: cfg.clock.epochDay, signAll: false, chainSelector: SELECTOR };
/** A readings() result as large as the real one: every slot of the GPU carries a sum and a count. */
const readingsRet = (gpu: string, bits: bigint) => {
  const n = PANELS.find((p) => p.gpu === gpu)!.slots.length;
  return encodeFunctionResult({ abi: agateIndexAbi, functionName: "readings", result: zeroOf(fnOut("readings"), { sliceBits: bits, sums: Array(n).fill(2 ** 39), counts: Array(n).fill(24) }) as never });
};

/** The index as the workflow's reads see it. posted(gpu, phase) says whether slice 5's bit is set: phase 0 before the
 * write, 1 after it; fail(gpu) makes that readings() sub-call fail. */
function evmWith(posted: (gpu: string, phase: number) => boolean, o: { clock?: typeof CHAIN_CLOCK; fail?: (gpu: string) => boolean } = {}) {
  const evm = EvmMock.testInstance(SELECTOR);
  const reads: { phase: number; clock: boolean; gpus: string[]; bytes: number }[] = [];
  let writes = 0;
  let written: ReturnType<typeof decodeReport> | undefined;
  evm.callContract = (input) => {
    expect(bytesToHex(input.call!.to).toLowerCase()).toBe(MULTICALL3.toLowerCase());
    const calls = decodeFunctionData({ abi: multicall3Abi, data: bytesToHex(input.call!.data) as Hex }).args![0] as readonly { callData: Hex }[];
    const phase = writes === 0 ? 0 : 1;
    const gpus: string[] = [];
    let clock = false;
    const out = calls.map((c) => {
      const d = decodeFunctionData({ abi: agateIndexAbi, data: c.callData });
      if (d.functionName === "clocks") {
        clock = true;
        return { success: true, returnData: encodeFunctionResult({ abi: agateIndexAbi, functionName: "clocks", result: zeroOf(fnOut("clocks"), o.clock ?? CHAIN_CLOCK) as never }) };
      }
      const a = d.args as readonly [Hex, number, string];
      expect(a[2].toLowerCase()).toBe(WRITER);
      expect(Number(a[1])).toBe(20_727);
      const gpu = PANELS.find((p) => p.gpuId.toLowerCase() === a[0].toLowerCase())!.gpu;
      gpus.push(gpu);
      if (o.fail?.(gpu)) return { success: false, returnData: "0x" as Hex };
      return { success: true, returnData: readingsRet(gpu, posted(gpu, phase) ? 1n << 5n : 1n << 4n) }; // slice 5 is NOW's
    });
    const reply = encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: out });
    reads.push({ phase, clock, gpus, bytes: (reply.length - 2) / 2 });
    return { data: Buffer.from(reply.slice(2), "hex") } as never;
  };
  evm.writeReport = (input) => {
    writes++;
    written = decodeReport(bytesToHex(input.report!.rawReport.slice(REPORT_METADATA_HEADER_LENGTH)));
    return { txStatus: 2, txHash: new Uint8Array(32).fill(0xee) } as never;
  };
  return { evm, reads, writes: () => writes, written: () => written };
}
function httpAll() {
  const urls: string[] = [];
  const http = HttpActionsMock.testInstance();
  http.sendRequest = (req) => {
    urls.push(req.url);
    const body = PAGES[req.url.split("/").pop()!];
    return body ? { statusCode: 200, body: Buffer.from(body).toString("base64"), headers: { "X-Agate-Page-Time": String(NOW) } } : { statusCode: 503, body: "" };
  };
  return urls;
}
const runAt = (c: Config) => JSON.parse(onCron(newTestRuntime<Config>(null, { timeProvider: () => NOW * 1000 }, c) as never, {} as never));
const ALL = PANELS.map((p) => p.gpu);

test("reads the index first: a GPU already posted for the slice stays out of the report; the read-back confirms the rest landed", () => {
  const urls = httpAll();
  const m = evmWith((g, phase) => phase > 0 || g === "H100");
  const out = runAt({ ...cfg, writer: WRITER });
  const before = m.reads.filter((r) => r.phase === 0);
  expect(before.flatMap((r) => r.gpus)).toEqual(ALL); // every GPU, in panel order, across the batches
  expect(before.filter((r) => r.clock).length).toBe(1); // the clock once
  expect(m.reads.every((r) => r.bytes < 5_000)).toBe(true); // CRE's ChainRead.PayloadSizeLimit is 5 kb
  expect(m.reads.length).toBeLessThanOrEqual(15); // CRE's ChainRead.CallLimit
  expect(urls.length).toBeGreaterThan(0);
  const ids = m.written()!.entries.map((e) => e.gpuId);
  expect(ids).not.toContain(PANELS.find((p) => p.gpu === "H100")!.gpuId);
  expect(ids.length).toBe(PANELS.length - 1);
  expect(out.entries.length).toBe(PANELS.length); // the run still reports every GPU it read
  expect(out.chain).toMatchObject({ clockOk: true, posted: ["H100"] });
  expect(out.chain.landed).toEqual(Object.fromEntries(ALL.filter((g) => g !== "H100").map((g) => [g, true])));
});

test("every GPU already posted for the slice: no page fetched, nothing written, the run says skipped", () => {
  const urls = httpAll();
  const m = evmWith(() => true);
  const out = runAt({ ...cfg, writer: WRITER });
  expect(urls).toEqual([]);
  expect(m.writes()).toBe(0);
  expect(out).toMatchObject({ skipped: "posted", entries: [], dayId: 20_727, slice: 5, chain: { posted: ALL } });
});

test("a GPU not seen on the first read-back is read once more (a node one block behind); one still unset is reported false", () => {
  httpAll();
  let pass = 0;
  const seen = new Set<string>();
  const m = evmWith((g, phase) => {
    if (phase === 0) return false;
    if (!seen.has(g)) seen.add(g);
    else pass = 2;
    // B200 lags on the first read-back only; A100 never lands (its onReport reverted inside the forwarder)
    if (g === "A100") return false;
    return !(g === "B200" && pass < 2);
  });
  const out = runAt({ ...cfg, writer: WRITER });
  expect(m.writes()).toBe(1);
  const after = m.reads.filter((r) => r.phase > 0).flatMap((r) => r.gpus);
  expect(after.filter((g) => g === "B200").length).toBe(2);
  expect(after.filter((g) => g === "H100").length).toBe(1);
  expect(out.chain.landed.B200).toBe(true);
  expect(out.chain.landed.A100).toBe(false);
});

test("a failed sub-read reports that GPU as unknown (null), never as not landed", () => {
  httpAll();
  let wrote = false;
  const m = evmWith((_g, phase) => phase > 0, { fail: (g) => wrote && g === "L40S" });
  const ev = m.evm;
  const w = ev.writeReport!;
  ev.writeReport = (input) => {
    wrote = true;
    return w(input);
  };
  const out = runAt({ ...cfg, writer: WRITER });
  expect(out.chain.landed.L40S).toBeNull();
  expect(out.chain.landed.H100).toBe(true);
});

test("a clock on chain that differs from the config (here its epoch) is flagged, and the run still writes", () => {
  httpAll();
  const m = evmWith((_g, phase) => phase > 0, { clock: { ...CHAIN_CLOCK, epochTs: CHAIN_CLOCK.epochTs + 3_600n } });
  const out = runAt({ ...cfg, writer: WRITER });
  expect(out.chain.clockOk).toBe(false);
  expect(m.writes()).toBe(1);
});

test("a failed index read leaves the run as before: every GPU written, no chain field", () => {
  httpAll();
  const evm = EvmMock.testInstance(SELECTOR);
  evm.callContract = () => {
    throw new Error("rpc down");
  };
  let n = 0;
  evm.writeReport = (input) => {
    n = decodeReport(bytesToHex(input.report!.rawReport.slice(REPORT_METADATA_HEADER_LENGTH))).entries.length;
    return { txStatus: 2, txHash: new Uint8Array(32).fill(1) } as never;
  };
  const out = runAt({ ...cfg, writer: WRITER });
  expect(n).toBe(PANELS.length);
  expect(out.chain).toBeUndefined();
});

test("no writer in the config: no read at all (the old behaviour)", () => {
  httpAll();
  const m = evmWith(() => true);
  const out = runAt(cfg);
  expect(m.reads.length).toBe(0);
  expect(m.writes()).toBe(1);
  expect(out.chain).toBeUndefined();
});
