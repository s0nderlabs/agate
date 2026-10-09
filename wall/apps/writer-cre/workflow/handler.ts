// The primary writer's workflow body (BUILD-SPEC 8.2): fetch every page once, parse with @agate/sources, build one
// entry per registered GPU for the current slice, write the report. It only reads and reports: no memory, no
// smoothing. main.ts wires it to the CRE runner; the bun runner (../src/runner.ts) schedules simulate runs.
// Oct 3 (8.6): the config's `readers` (swapped slots of the run's day) choose each slot's URL and parser version;
// each distinct URL is fetched once (under sourceBaseUrl, /<sourceId>); a version this compiled workflow lacks, or a
// reader off the source's hosts, reads nothing for that slot (0), never another reader.
// Oct 9: the workflow reads the index itself (EVM read, one Multicall3 call at the latest block) before fetching: the
// index's clock beside the config's, and this writer's slice bits per GPU, so a GPU already posted for the slice is
// left out of the report (every GPU posted: no fetch and no write). After the write it reads the bits again and says
// which GPUs landed, since the forwarder swallows an onReport revert. Without `writer` in the config it reads nothing.
import { agateIndexAbi } from "@agate/report/abi";
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
  fetchesOf,
  flatFields,
  flattenLogs,
  neededSources,
  needsFx,
  type PageResult,
  pageUrl,
  parsePages,
  planNotes,
  planReaders,
  readAtFor,
  reportHex,
  type SlotReaders,
  type SourcePlan,
  unflatten,
  userAgent,
} from "@agate/writer-standby/core";
import {
  bytesToHex,
  ConsensusAggregationByFields,
  type CronPayload,
  cre,
  encodeCallMsg,
  getHeader,
  type HTTPSendRequester,
  LATEST_BLOCK_NUMBER,
  median,
  prepareReportRequest,
  type Runtime,
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeFunctionData, type Hex, multicall3Abi, zeroAddress } from "viem";

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
  /** The readers of swapped slots for the run's day: gpuId -> slot -> {url, parserVersion} or {refused} (8.6). */
  readers?: SlotReaders;
  /** The address the index credits this writer's reports to (TX_ORIGIN mode: the broadcasting key); absent: no reads. */
  writer?: Address;
};

/** What the run read from the index (absent when the config has no writer or the first read failed). `landed`, after a
 * write: per written GPU, true when its slice bit is set, false when it is not (after one more read), null if unknown. */
export type ChainView = { clockOk: boolean; posted: string[]; landed?: Record<string, boolean | null> };

export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
/** CRE caps one chain read's reply at 5 kb (ChainRead.PayloadSizeLimit, 15 reads a run): each batch stays well under. */
export const READ_BUDGET = 3_500;
const CLOCKS_BYTES = 640; // clocks()'s 18 words plus its aggregate3 framing
/** A readings() result inside an aggregate3 reply: the struct's head, two array lengths and framing, two words a slot. */
const readingsBytes = (p: Panel) => 448 + 64 * p.slots.length;

type Clocks = { day: number; slices: number; epochTs: bigint; epochDay: number; signAll: boolean; chainSelector: bigint };
type Sub = { success: boolean; returnData: Hex };

function aggregate(runtime: Runtime<Config>, evm: InstanceType<typeof cre.capabilities.EVMClient>, calls: { target: Address; allowFailure: boolean; callData: Hex }[]): readonly Sub[] {
  const reply = evm
    .callContract(runtime, {
      call: encodeCallMsg({ from: zeroAddress, to: MULTICALL3, data: encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] }) }),
      blockNumber: LATEST_BLOCK_NUMBER,
    })
    .result();
  return decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data: bytesToHex(reply.data) as Hex });
}

/** EVM reads at the latest block, through Multicall3 in batches under READ_BUDGET: the index's clocks() (when asked)
 * and readings(gpuId, day, writer) for each panel given. bits[i] is panels[i]'s slice bits (undefined: that sub-call
 * failed). undefined when there is no writer or a read fails. */
export function readIndex(
  runtime: Runtime<Config>,
  evm: InstanceType<typeof cre.capabilities.EVMClient>,
  cfg: Config,
  dayId: number,
  panels: readonly Panel[] = cfg.panels,
  withClock = true,
): { clock?: Clocks; bits: (bigint | undefined)[] } | undefined {
  if (!cfg.writer) return undefined;
  const writer = cfg.writer;
  const batches: Panel[][] = [];
  let size = withClock ? CLOCKS_BYTES : 0;
  for (const p of panels) {
    if (batches.length === 0 || size + readingsBytes(p) > READ_BUDGET) {
      batches.push([]);
      size = batches.length === 1 && withClock ? CLOCKS_BYTES : 0;
    }
    batches.at(-1)!.push(p);
    size += readingsBytes(p);
  }
  const readings = (p: Panel) => ({ target: cfg.index, allowFailure: true, callData: encodeFunctionData({ abi: agateIndexAbi, functionName: "readings", args: [p.gpuId as Hex, dayId, writer] }) });
  try {
    let clock: Clocks | undefined;
    const bits: (bigint | undefined)[] = [];
    batches.forEach((batch, b) => {
      const head = b === 0 && withClock ? [{ target: cfg.index, allowFailure: false, callData: encodeFunctionData({ abi: agateIndexAbi, functionName: "clocks" }) }] : [];
      const res = aggregate(runtime, evm, [...head, ...batch.map(readings)]);
      if (head.length) clock = decodeFunctionResult({ abi: agateIndexAbi, functionName: "clocks", data: res[0]!.returnData }) as unknown as Clocks;
      for (const r of res.slice(head.length)) {
        bits.push(r.success ? BigInt((decodeFunctionResult({ abi: agateIndexAbi, functionName: "readings", data: r.returnData }) as { sliceBits: bigint }).sliceBits) : undefined);
      }
    });
    return { ...(clock ? { clock } : {}), bits };
  } catch (e) {
    runtime.log(`agate index read failed: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

const hasSlice = (bits: bigint | undefined, slice: number) => bits !== undefined && ((bits >> BigInt(slice)) & 1n) === 1n;

/** Does the index's clock say what the config says (the fields dayId and slice come from, and the chain)? */
function clockMatches(c: Clocks, cfg: Config): boolean {
  return (
    Number(c.day) === cfg.clock.day &&
    Number(c.slices) === cfg.clock.slices &&
    BigInt(c.epochTs) === BigInt(cfg.clock.epochTs) &&
    Number(c.epochDay) === cfg.clock.epochDay &&
    Boolean(c.signAll) === Boolean(cfg.clock.signAll) &&
    BigInt(c.chainSelector) === BigInt(cfg.chainSelector)
  );
}

/** Per panel: landed (slice bit set), not landed, or null when its sub-read failed. */
function landedOf(read: { bits: (bigint | undefined)[] } | undefined, panels: readonly Panel[], slice: number): Record<string, boolean | null> | undefined {
  if (!read) return undefined;
  return Object.fromEntries(panels.map((p, i) => [p.gpu, read.bits[i] === undefined ? null : hasSlice(read.bits[i], slice)]));
}

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

function plansOf(cfg: Config): SourcePlan[] | undefined {
  return cfg.readers && Object.keys(cfg.readers).length ? planReaders(api(), neededSources(api(), cfg.panels), cfg.panels, cfg.readers) : undefined;
}

/** Node mode: every page once (ECB first when an EUR source is read), parsed, flattened to numbers. With readers in
 * force, each distinct URL once and each GPU parsed with its slot's version. */
export function readPages(s: HTTPSendRequester, cfg: Config, readAt: number): Flat {
  const defs = neededSources(api(), cfg.panels);
  const fx = needsFx(defs) ? fetchPage(s, pageUrl(ECB_ID, ECB_URL, cfg.sourceBaseUrl), cfg) : undefined;
  const plans = plansOf(cfg);
  const pages: Record<string, PageResult> = {};
  if (plans) {
    const got = new Map<string, PageResult>();
    for (const f of fetchesOf(plans, cfg.sourceBaseUrl)) {
      let pg = got.get(f.fetchUrl);
      if (!pg) {
        pg = fetchPage(s, f.fetchUrl, cfg);
        got.set(f.fetchUrl, pg);
      }
      pages[f.key] = pg;
    }
  } else for (const d of defs) pages[d.id] = fetchPage(s, pageUrl(d.id, d.url, cfg.sourceBaseUrl), cfg);
  return flattenLogs(parsePages(api(), defs, pages, fx, readAt, plans).logs);
}

export const onCron = (runtime: Runtime<Config>, _payload: CronPayload): string => {
  const cfg = runtime.config;
  const defs = neededSources(api(), cfg.panels);
  const { dayId, slice, readAt } = readAtFor(clockOf(cfg.clock), Math.floor(runtime.now().getTime() / 1000), cfg.skewS);
  const evm = new cre.capabilities.EVMClient(BigInt(cfg.chainSelector));

  const before = readIndex(runtime, evm, cfg, dayId);
  let chain: ChainView | undefined;
  const postedIds = new Set<string>();
  if (before) {
    cfg.panels.forEach((p, i) => hasSlice(before.bits[i], slice) && postedIds.add(p.gpuId.toLowerCase()));
    const posted = cfg.panels.filter((p) => postedIds.has(p.gpuId.toLowerCase())).map((p) => p.gpu);
    chain = { clockOk: clockMatches(before.clock!, cfg), posted };
    runtime.log(`agate index clock ${chain.clockOk ? "matches" : "DIFFERS FROM"} the config; posted this slice: ${JSON.stringify(posted)}`);
    if (postedIds.size === cfg.panels.length) {
      // every GPU already has this writer's reading for the slice: nothing to fetch or write
      const tx = { status: 0, receiverStatus: null, hash: null, error: null };
      return JSON.stringify({ agate: 1, t: readAt, index: cfg.index, dayId, slice, entries: [], sources: [], tx, skipped: "posted", chain });
    }
  }

  const fields = Object.fromEntries(flatFields(defs).map((k) => [k, median])) as never;
  const flat = new cre.capabilities.HTTPClient()
    .sendRequest(runtime, readPages, ConsensusAggregationByFields<Flat>(fields))(cfg, readAt)
    .result();
  const { rows, logs } = unflatten(defs, flat);
  const plans = plansOf(cfg);
  if (plans) {
    const notes = planNotes(plans);
    for (const l of logs) Object.assign(l, notes[l.sourceId] ?? {});
  }
  const entries = buildEntries(api(), cfg.panels, rows, dayId, slice, readAt);
  const valid = Object.fromEntries(
    cfg.panels.map((p) => [p.gpu as GpuModel, entries.find((e) => e.gpuId === p.gpuId)?.values.filter((v) => v > 0).length ?? 0]),
  );
  runtime.log(`agate ${cfg.index} day ${dayId} slice ${slice} readAt ${readAt} valid ${JSON.stringify(valid)}`);

  // a GPU this writer already posted for the slice stays out of the report (the index would skip it anyway)
  const toWrite = entries.filter((e) => !postedIds.has(e.gpuId.toLowerCase()));
  const hex = reportHex(BigInt(cfg.chainSelector), cfg.index, toWrite);
  const report = runtime.report(prepareReportRequest(hex)).result();
  const reply = evm.writeReport(runtime, { receiver: cfg.index, report, gasConfig: { gasLimit: cfg.gasLimit } }).result();
  const tx = {
    status: reply.txStatus,
    receiverStatus: reply.receiverContractExecutionStatus ?? null,
    hash: reply.txHash && reply.txHash.length > 0 ? bytesToHex(reply.txHash) : null,
    error: reply.errorMessage ?? null,
  };
  runtime.log(`agate writeReport ${JSON.stringify(tx)}`);

  // read back: did each written GPU's slice bit land? (a mined tx whose onReport reverted inside the forwarder sets
  // none). A GPU not seen yet is read once more: the RPC node may not have applied the block that mined the write.
  if (chain && tx.hash) {
    const written = cfg.panels.filter((p) => !postedIds.has(p.gpuId.toLowerCase()));
    const landed = landedOf(readIndex(runtime, evm, cfg, dayId, written, false), written, slice);
    const late = landed ? written.filter((p) => landed[p.gpu] === false) : [];
    if (landed && late.length) {
      for (const [gpu, v] of Object.entries(landedOf(readIndex(runtime, evm, cfg, dayId, late, false), late, slice) ?? {})) if (v !== null) landed[gpu] = v;
    }
    if (landed) {
      chain.landed = landed;
      runtime.log(`agate landed ${JSON.stringify(landed)}`);
    }
  }
  return JSON.stringify({ agate: 1, t: readAt, index: cfg.index, dayId, slice, entries: entries.map(entryToJson), sources: logs, tx, ...(chain ? { chain } : {}) });
};

export const initWorkflow = (cfg: Config) => [cre.handler(new cre.capabilities.CronCapability().trigger({ schedule: cfg.schedule }), onCron)];
