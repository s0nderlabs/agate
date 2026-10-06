// The hosted indexer's testnet pair (config.testnet.yaml and src/lib/deployments.testnet.generated.ts), rendered from
// the deployments file and the index records. Pure, so test/drift.test.ts can check the committed pair is current.
import { missingIndexStarts, parseDeployments, renderConfig } from "./config-gen.ts";

export const TESTNET_CONFIG = "config.testnet.yaml";
export const TESTNET_TS = "src/lib/deployments.testnet.generated.ts";
const SOURCE = "contracts/deployments/10143.json";

interface IndexRecord {
  index?: string;
  deployBlock?: number | null;
}

/** Each factory's index deploy block from the records: the first record naming its index, in the order production,
 *  demo, then demoHistory; a factory whose first match has no deploy block gets none. The only copy of this rule:
 *  ops/testnet/indexer.sh reads it through scripts/index-starts.ts. */
export function indexStarts(deployments: { factories: Record<string, { index: string }> }, records: { production?: IndexRecord; demo?: IndexRecord; demoHistory?: IndexRecord[] }): Record<string, number> {
  const recs = [records.production, records.demo, ...(records.demoHistory ?? [])].filter((r): r is IndexRecord => !!r);
  const starts: Record<string, number> = {};
  for (const [name, f] of Object.entries(deployments.factories)) {
    const r = recs.find((x) => (x.index ?? "").toLowerCase() === f.index.toLowerCase());
    if (typeof r?.deployBlock === "number") starts[name] = r.deployBlock;
  }
  return starts;
}

export function testnetPair(rawDeployments: unknown, records: Parameters<typeof indexStarts>[1]): { yaml: string; ts: string; starts: Record<string, number> } {
  const d = parseDeployments(rawDeployments, 10143);
  const starts = indexStarts(rawDeployments as Parameters<typeof indexStarts>[0], records);
  const missing = missingIndexStarts(d, starts);
  if (missing.length > 0) throw new Error(`no deploy block in 10143-indexes.json for index(es) ${missing.join(", ")}`);
  const { yaml, ts } = renderConfig(d, { rpc: false, indexStart: starts, source: SOURCE, hosted: true });
  return { yaml, ts, starts };
}
