// The primary writer's workflow body (BUILD-SPEC 8.2): fetch every page once, parse with @agate/sources, build one
// entry per registered GPU for the current slice, write the report. It only reads and reports: no memory, no
// smoothing. main.ts wires it to the CRE runner; the bun runner (../src/runner.ts) schedules simulate runs.
import * as sourcesModule from "@agate/sources/pure";
import type { Address, GpuModel } from "@agate/report/types";
import type { Panel, SourcesPureApi } from "@agate/sources/types";
import {
  asSourcesApi,
  buildEntries,
  type ClockConfig,
  clockOf,
  ECB_ID,
  ECB_URL,
  entryToJson,
  flatFields,
  flattenLogs,
  neededSources,
  needsFx,
  type PageResult,
  pageUrl,
  parsePages,
  readAtFor,
  reportHex,
  unflatten,
  userAgent,
} from "@agate/writer-standby/core";
import {
  bytesToHex,
  ConsensusAggregationByFields,
  type CronPayload,
  cre,
  getHeader,
  type HTTPSendRequester,
  median,
  prepareReportRequest,
  type Runtime,
} from "@chainlink/cre-sdk";

export type Config = {
  index: Address;
  chainSelector: string; // decimal (uint64)
  gasLimit: string; // writeReport gas limit: ceil(1.5 x MEASURED onReport), 13.4 (the runner computes it)
  schedule: string; // cron, used only by a deployed DON workflow; the runner fires simulate itself
  role: string; // user agent role, "primary"
  timeout: string; // per page, e.g. "40s" (slice / 10 on demo profiles)
  sourceBaseUrl?: string; // replay server; absent = live pages
  skewS?: number; // readAt lag behind the run start (default min(2, slice / 20)), see readAtFor
  clock: ClockConfig;
  panels: Panel[];
};

export type Flat = Record<string, number>;

let sources: SourcesPureApi | undefined;
/** Tests swap in a synthetic sources API; the workflow uses @agate/sources/pure. */
export function useSources(m: unknown): void {
  sources = asSourcesApi(m);
}
function api(): SourcesPureApi {
  sources ??= asSourcesApi(sourcesModule);
  return sources;
}

function fetchPage(s: HTTPSendRequester, url: string, cfg: Config): PageResult {
  try {
    const resp = s
      .sendRequest({ url, method: "GET", headers: { "User-Agent": userAgent(cfg.role) }, timeout: cfg.timeout })
      .result();
    const ok = resp.statusCode >= 200 && resp.statusCode < 300 && resp.body.length > 0;
    const page: PageResult = {
      ok,
      httpStatus: resp.statusCode,
      body: new TextDecoder("utf-8").decode(resp.body),
      bytes: resp.body.length,
    };
    const pt = getHeader(resp, "x-agate-page-time");
    if (pt && /^\d+$/.test(pt)) page.pageTime = Number(pt);
    if (!ok) page.error = `HTTP ${resp.statusCode}`;
    return page;
  } catch (e) {
    return { ok: false, httpStatus: 0, body: "", bytes: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Node mode: every page once (ECB first when an EUR source is read), parsed, flattened to numbers. */
export function readPages(s: HTTPSendRequester, cfg: Config, readAt: number): Flat {
  const defs = neededSources(api(), cfg.panels);
  const fx = needsFx(defs) ? fetchPage(s, pageUrl(ECB_ID, ECB_URL, cfg.sourceBaseUrl), cfg) : undefined;
  const pages: Record<string, PageResult> = {};
  for (const d of defs) pages[d.id] = fetchPage(s, pageUrl(d.id, d.url, cfg.sourceBaseUrl), cfg);
  return flattenLogs(parsePages(api(), defs, pages, fx, readAt).logs);
}

export const onCron = (runtime: Runtime<Config>, _payload: CronPayload): string => {
  const cfg = runtime.config;
  const defs = neededSources(api(), cfg.panels);
  const { dayId, slice, readAt } = readAtFor(clockOf(cfg.clock), Math.floor(runtime.now().getTime() / 1000), cfg.skewS);

  const fields = Object.fromEntries(flatFields(defs).map((k) => [k, median])) as never;
  const flat = new cre.capabilities.HTTPClient()
    .sendRequest(runtime, readPages, ConsensusAggregationByFields<Flat>(fields))(cfg, readAt)
    .result();
  const { rows, logs } = unflatten(defs, flat);
  const entries = buildEntries(api(), cfg.panels, rows, dayId, slice, readAt);
  const valid = Object.fromEntries(
    cfg.panels.map((p) => [p.gpu as GpuModel, entries.find((e) => e.gpuId === p.gpuId)?.values.filter((v) => v > 0).length ?? 0]),
  );
  runtime.log(`agate ${cfg.index} day ${dayId} slice ${slice} readAt ${readAt} valid ${JSON.stringify(valid)}`);

  const hex = reportHex(BigInt(cfg.chainSelector), cfg.index, entries);
  const report = runtime.report(prepareReportRequest(hex)).result();
  const reply = new cre.capabilities.EVMClient(BigInt(cfg.chainSelector))
    .writeReport(runtime, { receiver: cfg.index, report, gasConfig: { gasLimit: cfg.gasLimit } })
    .result();
  const tx = {
    status: reply.txStatus,
    receiverStatus: reply.receiverContractExecutionStatus ?? null,
    hash: reply.txHash && reply.txHash.length > 0 ? bytesToHex(reply.txHash) : null,
    error: reply.errorMessage ?? null,
  };
  runtime.log(`agate writeReport ${JSON.stringify(tx)}`);
  return JSON.stringify({ agate: 1, t: readAt, index: cfg.index, dayId, slice, entries: entries.map(entryToJson), sources: logs, tx });
};

export const initWorkflow = (cfg: Config) => [cre.handler(new cre.capabilities.CronCapability().trigger({ schedule: cfg.schedule }), onCron)];
