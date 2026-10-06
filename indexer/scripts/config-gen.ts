// config.yaml and src/lib/deployments.generated.ts from a deployments file (BOTS-SPEC 1, 5.3; MS 10.3). Pure: no
// file system, so the drift test renders exactly what gen-config.ts writes. Fails closed on any bad field and names
// the field, never its value.

export interface FactoryEntry {
  name: string;
  index: string;
  dollar: string;
  tag: string;
  factory: string;
  router: string;
  tPend: number;
  startBlock: number;
}
export interface Deployments {
  chainId: number;
  dollar: string;
  kuru: { router: string; marginAccount: string };
  factories: FactoryEntry[];
}
export interface ConfigOptions {
  rpc?: boolean; // RPC sync from ${ENVIO_RPC_URL} (local runs and the fork); default HyperSync
  indexStart?: Record<string, number>; // factory name -> the block its index was deployed at
  source?: string; // the input's name, for the header
  hosted?: boolean; // the hosted indexer's testnet pair (scripts/gen-testnet.ts): its own header
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

function addr(v: unknown, field: string, allowZero = false): string {
  if (typeof v !== "string" || !ADDR.test(v)) throw new Error(`deployments: ${field} is not a 0x-prefixed 40-hex address`);
  const a = v.toLowerCase();
  if (a === ZERO && !allowZero) throw new Error(`deployments: ${field} is the zero address`);
  return a;
}
function uint(v: unknown, field: string, positive = false): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || (positive && v === 0)) {
    throw new Error(`deployments: ${field} is not a ${positive ? "positive" : "nonnegative"} integer`);
  }
  return v;
}

/** Parses and checks a deployments file (MS 10.3's shape). */
export function parseDeployments(raw: unknown, expectChainId?: number): Deployments {
  if (!raw || typeof raw !== "object") throw new Error("deployments: not an object");
  const r = raw as Record<string, unknown>;
  const chainId = uint(r.chainId, "chainId", true);
  if (expectChainId !== undefined && chainId !== expectChainId) throw new Error("deployments: chainId is not the expected chain");
  const dollar = addr(r.dollar, "dollar");
  const k = (r.kuru ?? {}) as Record<string, unknown>;
  const kuru = { router: addr(k.router, "kuru.router", true), marginAccount: addr(k.marginAccount, "kuru.marginAccount", true) };
  if (!r.factories || typeof r.factories !== "object") throw new Error("deployments: factories is missing");
  const factories: FactoryEntry[] = [];
  for (const [name, v] of Object.entries(r.factories as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) throw new Error("deployments: a factory name is not lowercase letters and digits");
    const f = (v ?? {}) as Record<string, unknown>;
    if (typeof f.tag !== "string" || !/^[a-z]{0,8}$/.test(f.tag)) throw new Error(`deployments: factories.${name}.tag is not 0 to 8 letters a to z`);
    factories.push({
      name,
      index: addr(f.index, `factories.${name}.index`),
      dollar: addr(f.dollar, `factories.${name}.dollar`),
      tag: f.tag,
      factory: addr(f.factory, `factories.${name}.factory`),
      router: addr(f.router, `factories.${name}.router`),
      tPend: uint(f.tPend, `factories.${name}.tPend`, true),
      startBlock: uint(f.startBlock, `factories.${name}.startBlock`),
    });
  }
  if (factories.length === 0) throw new Error("deployments: factories is empty");
  const seen = new Set<string>();
  for (const f of factories) {
    if (seen.has(f.factory)) throw new Error(`deployments: factories.${f.name}.factory appears twice`);
    seen.add(f.factory);
  }
  const tPend = new Map<string, number>();
  for (const f of factories) {
    const t = tPend.get(f.index);
    if (t !== undefined && t !== f.tPend) throw new Error(`deployments: factories.${f.name}.tPend differs from another factory on the same index`);
    tPend.set(f.index, f.tPend);
  }
  return { chainId, dollar, kuru, factories };
}

export const CONTRACT_EVENTS: readonly { name: string; abi: string; events: readonly string[] }[] = [
  { name: "AgateFactory", abi: "AgateFactory", events: ["SeriesListed", "MarketRecorded"] },
  {
    name: "AgateSeries",
    abi: "AgateSeries",
    events: ["Minted", "Redeemed", "ShortCredited", "ShortDebited", "PositionOpened", "Claimed", "PositionClosed", "PayoutChanged", "OperatorSet", "Settled", "FixApplied"],
  },
  { name: "AgateToken", abi: "AgateToken", events: ["Transfer"] },
  { name: "AgateDollar", abi: "AgateDollar", events: ["Transfer", "Dripped"] },
  { name: "AgateRouter", abi: "AgateRouter", events: ["Routed"] },
  {
    name: "KuruOrderBook",
    abi: "KuruOrderBook",
    events: ["OrderCreated", "OrderCanceled", "OrdersCanceled", "Trade", "FlipOrderCreated", "FlippedOrderCreated", "FlipOrderUpdated", "FlipOrdersCanceled", "MarketStateUpdated"],
  },
  {
    name: "AgateIndex",
    abi: "IAgateIndex",
    events: [
      "GpuRegistered",
      "DayClosed",
      "Attested",
      "RecordReplaced",
      "Vetoed",
      "FixDropped",
      "DayCarried",
      "DaySkipped",
      "WriterSuspended",
      "ActionQueued",
      "ActionExecuted",
      "ActionCancelled",
      "ReaderSwapQueued",
      "ReaderSwapped",
      "ReaderSwapCancelled",
    ],
  },
];

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}
function addrList(xs: string[], indent: string): string {
  return xs.map((a) => `${indent}- "${a}"`).join("\n");
}

export function renderConfig(d: Deployments, o: ConfigOptions = {}): { yaml: string; ts: string } {
  const factoryStart = Math.min(...d.factories.map((f) => f.startBlock));
  const indexes = uniq(d.factories.map((f) => f.index));
  const starts: number[] = [];
  for (const [name, block] of Object.entries(o.indexStart ?? {})) {
    if (!d.factories.some((f) => f.name === name)) throw new Error(`--index-start: no factory named ${name}`);
    if (!Number.isSafeInteger(block) || block < 0) throw new Error(`--index-start: ${name} is not a block number`);
    starts.push(block);
  }
  const indexStart = starts.length ? Math.min(...starts) : factoryStart;
  const chainStart = Math.min(factoryStart, indexStart);
  const src = o.source ?? "a deployments file";

  const y: string[] = [];
  if (o.hosted) {
    y.push(`# GENERATED by scripts/gen-testnet.ts from ${src}. Do not edit by hand: rerun bun run gen:testnet.`);
    y.push("# The hosted indexer (Envio Cloud: root indexer, this config file, branch main). The handlers find these addresses");
    y.push("# in src/lib/deployments.testnet.generated.ts, which src/lib/deployments.ts merges with the default pair.");
  } else {
    y.push(`# GENERATED by scripts/gen-config.ts from ${src}. Do not edit by hand: rerun bun run gen:config.`);
    y.push("# The committed input is test/fixtures/deployments.test.json (the local test world); the operator's indexer");
    y.push("# (ops/testnet/indexer.sh) renders its own copy from contracts/deployments/10143.json (BOTS-SPEC 5.3).");
  }
  y.push("# yaml-language-server: $schema=./node_modules/envio/evm.schema.json");
  y.push("name: agate");
  y.push("address_format: lowercase");
  y.push("field_selection:");
  y.push("  transaction_fields:");
  y.push("    - hash");
  y.push("    - from");
  y.push("contracts:");
  for (const c of CONTRACT_EVENTS) {
    y.push(`  - name: ${c.name}`);
    y.push(`    abi_file_path: ./abis/${c.abi}.json`);
    y.push("    events:");
    for (const e of c.events) y.push(`      - event: ${e}`);
  }
  y.push("chains:");
  y.push(`  - id: ${d.chainId}`);
  y.push(`    start_block: ${chainStart}`);
  if (o.rpc) {
    y.push("    rpc:");
    y.push('      - url: "${ENVIO_RPC_URL}"');
    y.push("        for: sync");
    y.push("        interval_ceiling: 100");
  }
  y.push("    contracts:");
  y.push("      - name: AgateFactory");
  y.push("        address:");
  y.push(addrList(d.factories.map((f) => f.factory), "          "));
  y.push("      - name: AgateRouter");
  y.push("        address:");
  y.push(addrList(d.factories.map((f) => f.router), "          "));
  y.push("      - name: AgateDollar # the top-level dollar only, never the pilot's (Kuru's USDC)");
  y.push("        address:");
  y.push(addrList([d.dollar], "          "));
  y.push("      - name: AgateIndex");
  y.push("        address:");
  y.push(addrList(indexes, "          "));
  if (indexStart !== chainStart) y.push(`        start_block: ${indexStart}`);
  y.push("      - name: AgateSeries # dynamic: SeriesListed");
  y.push("      - name: AgateToken # dynamic: SeriesListed");
  y.push("      - name: KuruOrderBook # dynamic: MarketRecorded with venue KURU_V1");
  const yaml = `${y.join("\n")}\n`;

  const t: string[] = [];
  t.push(o.hosted ? `// GENERATED by scripts/gen-testnet.ts from ${src}. Do not edit by hand: rerun bun run gen:testnet.` : `// GENERATED by scripts/gen-config.ts from ${src}. Do not edit by hand: rerun bun run gen:config.`);
  t.push("export interface FactoryInfo {");
  t.push("  readonly name: string;");
  t.push("  readonly tag: string;");
  t.push("  readonly index: string;");
  t.push("  readonly dollar: string;");
  t.push("  readonly router: string;");
  t.push("  readonly tPend: number;");
  t.push("  readonly startBlock: number;");
  t.push("}");
  t.push("export interface IndexInfo {");
  t.push("  readonly tPend: number;");
  t.push("  readonly names: readonly string[];");
  t.push("}");
  t.push(`export const CHAIN_ID = ${d.chainId};`);
  t.push("export const FACTORIES: Readonly<Record<string, FactoryInfo>> = {");
  for (const f of d.factories) {
    t.push(
      `  "${f.factory}": { name: "${f.name}", tag: "${f.tag}", index: "${f.index}", dollar: "${f.dollar}", router: "${f.router}", tPend: ${f.tPend}, startBlock: ${f.startBlock} },`,
    );
  }
  t.push("};");
  t.push("export const INDEXES: Readonly<Record<string, IndexInfo>> = {");
  for (const i of indexes) {
    const fs = d.factories.filter((f) => f.index === i);
    t.push(`  "${i}": { tPend: ${fs[0]!.tPend}, names: [${fs.map((f) => `"${f.name}"`).join(", ")}] },`);
  }
  t.push("};");
  const ts = `${t.join("\n")}\n`;
  return { yaml, ts };
}

/** CLI arguments: <deployments.json> [--rpc] [--index-start <name>=<block> ...] [--out config.yaml] */
/** The indexes of d that no --index-start names (through any factory over them): their history before the factories'
 *  start block would be lost (audit M-2). */
export function missingIndexStarts(d: Deployments, indexStart: Record<string, number>): string[] {
  const covered = new Set(Object.keys(indexStart).map((n) => d.factories.find((f) => f.name === n)?.index).filter((x): x is string => !!x));
  return [...new Set(d.factories.map((f) => f.index))].filter((i) => !covered.has(i));
}

/** The test world's deployments file: the only input that may render without --index-start. */
export const TEST_DEPLOYMENTS = "test/fixtures/deployments.test.json";

export function parseArgs(argv: readonly string[]): { input: string; out: string; rpc: boolean; indexStart: Record<string, number>; noIndexStart: boolean } {
  let input = "";
  let out = "config.yaml";
  let rpc = false;
  let noIndexStart = false;
  const indexStart: Record<string, number> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--rpc") rpc = true;
    else if (a === "--no-index-start") noIndexStart = true;
    else if (a === "--out") out = argv[++i] ?? "";
    else if (a === "--index-start") {
      const [name, block] = (argv[++i] ?? "").split("=");
      if (!name || !block || !/^\d+$/.test(block)) throw new Error("--index-start takes <name>=<block>");
      indexStart[name] = Number(block);
    } else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else input = a;
  }
  if (!input) throw new Error("usage: gen-config <deployments.json> [--rpc] [--index-start <name>=<block> ... | --no-index-start] [--out config.yaml]");
  if (!out) throw new Error("--out needs a path");
  if (noIndexStart && Object.keys(indexStart).length > 0) throw new Error("--no-index-start and --index-start exclude each other");
  return { input, out, rpc, indexStart, noIndexStart };
}
