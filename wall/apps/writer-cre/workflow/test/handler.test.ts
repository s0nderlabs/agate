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
  gasLimit: "777371",
  schedule: "0 7 * * * *",
  role: "primary",
  timeout: "10s",
  sourceBaseUrl: "http://replay.test",
  clock: { day: 2_400, slices: 12, epochTs: 1_790_812_800, epochDay: 20_727 },
  panels: PANELS,
};
const NOW = 1_790_812_800 + 5 * 200 + 37; // TEST day 20,727, slice 5
const PAGES: Record<string, string> = {
  p_verda: renderPage("p_verda", { H100: { price: "3.63", count: 8 }, H200: { price: "4.73", count: 8 }, B200: { price: "6.92", count: 8 } }),
  p_nebius: renderPage("p_nebius", { H100: { price: "4.50", count: 8 }, H200: { price: "5.40", count: 8 }, B200: { price: "8.50", count: 8 } }),
  p_lambda: renderPage("p_lambda", { H100: { price: "3.99", count: 8 }, B200: { state: "not-rentable" } }),
  p_hyperstack: renderPage("p_hyperstack", { H100: { price: "2.40", count: 8 }, H200: { price: "3.50", count: 8 }, B200: { price: "5.90", count: 8 } }),
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
  expect(written!.gas).toBe("777371");
  const report = decodeReport(written!.payload);
  expect(report).toMatchObject({ version: 1, chainSelector: SELECTOR });
  expect(report.entries.map((e) => e.values)).toEqual([
    [3_630_000, 4_500_000, 3_990_000, 0, 2_400_000], // H100: Civo answered 503, its slot sends 0
    [4_730_000, 5_400_000, 0, 3_500_000], // H200: the reserve (Hyperstack) carries its value; E8b ignores it onchain
    [6_920_000, 8_500_000, 0, 5_900_000], // B200: Lambda not rentable
  ]);
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
