// Simulated events that are real ABI encodings (BOTS-SPEC 5.7 item 3): each event is encoded into a raw log with
// viem (encodeEventTopics, encodeAbiParameters) from the contract's own ABI in abis/, decoded back with
// decodeEventLog, and handed to Envio's simulate with its srcAddress, block and logIndex.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Abi, type AbiEvent, type AbiParameter, type Hex, decodeEventLog, encodeAbiParameters, encodeEventTopics } from "viem";

export const CONTRACT_ABI = {
  AgateFactory: "AgateFactory",
  AgateSeries: "AgateSeries",
  AgateToken: "AgateToken",
  AgateDollar: "AgateDollar",
  AgateRouter: "AgateRouter",
  KuruOrderBook: "KuruOrderBook",
  AgateIndex: "IAgateIndex",
} as const;
export type ContractName = keyof typeof CONTRACT_ABI;

const cache = new Map<string, Abi>();
export function abiOf(contract: ContractName): Abi {
  const file = CONTRACT_ABI[contract];
  let abi = cache.get(file);
  if (!abi) {
    abi = JSON.parse(readFileSync(join(import.meta.dirname, "../abis", `${file}.json`), "utf8")) as Abi;
    cache.set(file, abi);
  }
  return abi;
}
export function eventAbi(contract: ContractName, name: string): AbiEvent {
  const e = abiOf(contract).find((x): x is AbiEvent => x.type === "event" && x.name === name);
  if (!e) throw new Error(`${contract} has no event ${name}`);
  return e;
}

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
  timestamp: number;
  from: string;
}

/** The raw log of one event: topics for the indexed inputs, data for the rest. */
export function encodeLog(contract: ContractName, name: string, args: Record<string, unknown>): { topics: Hex[]; data: Hex } {
  const e = eventAbi(contract, name);
  const indexed: Record<string, unknown> = {};
  for (const i of e.inputs) if (i.indexed) indexed[i.name!] = args[i.name!];
  const topics = encodeEventTopics({ abi: [e], eventName: name, args: indexed } as never) as Hex[];
  const rest = e.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(rest, rest.map((i) => args[i.name!]));
  return { topics, data };
}

/** viem's decoded value to the shape Envio hands a handler: every integer a bigint, addresses and bytes lowercase. */
function toEnvio(v: unknown, p: AbiParameter): unknown {
  const t = p.type;
  if (t.endsWith("]")) {
    const inner = { ...p, type: t.slice(0, t.lastIndexOf("[")) } as AbiParameter;
    return (v as unknown[]).map((x) => toEnvio(x, inner));
  }
  if (t === "tuple") {
    const comps = (p as { components: readonly AbiParameter[] }).components;
    const out: Record<string, unknown> = {};
    for (const c of comps) out[c.name!] = toEnvio((v as Record<string, unknown>)[c.name!], c);
    return out;
  }
  if (t.startsWith("uint") || t.startsWith("int")) return BigInt(v as number | bigint);
  if (t === "address" || t.startsWith("bytes")) return (v as string).toLowerCase();
  return v;
}

export interface Meta {
  src: string;
  block: number;
  ts: number;
  logIndex?: number;
  tx?: string;
  from?: string;
}

/** One Envio simulate item from a raw log of `contract`. */
export function itemFromLog(contract: ContractName, log: Omit<RawLog, "transactionHash" | "from"> & { transactionHash?: string; from?: string }) {
  const d = decodeEventLog({ abi: abiOf(contract), data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
  const e = eventAbi(contract, d.eventName!);
  const params: Record<string, unknown> = {};
  for (const i of e.inputs) params[i.name!] = toEnvio((d.args as unknown as Record<string, unknown>)[i.name!], i);
  return {
    contract,
    event: d.eventName!,
    srcAddress: log.address.toLowerCase() as `0x${string}`,
    logIndex: log.logIndex,
    block: { number: log.blockNumber, timestamp: log.timestamp, hash: `0x${log.blockNumber.toString(16).padStart(64, "0")}` },
    transaction: {
      hash: log.transactionHash ?? `0x${(log.blockNumber * 1000 + log.logIndex).toString(16).padStart(64, "0")}`,
      from: (log.from ?? "0x00000000000000000000000000000000000000f0").toLowerCase() as `0x${string}`,
    },
    params,
  };
}

let autoLog = 0;
/** Encodes `args` as `contract`'s event `name`, decodes it back, and returns the simulate item. */
export function ev(contract: ContractName, name: string, args: Record<string, unknown>, m: Meta) {
  const { topics, data } = encodeLog(contract, name, args);
  return itemFromLog(contract, {
    address: m.src,
    topics,
    data,
    blockNumber: m.block,
    logIndex: m.logIndex ?? autoLog++,
    timestamp: m.ts,
    transactionHash: m.tx,
    from: m.from,
  });
}

/** JSON with bigints as strings, for readable assertion messages. */
export const show = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
