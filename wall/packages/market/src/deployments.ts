// BOTS-SPEC 1: the deployments file (MS 10.3), read fail closed. Every error names the field, never its value.
import { readFileSync } from "node:fs";
import type { Address } from "viem";
import type { Deployments, FactoryEntry } from "./types.ts";

export class DeploymentsError extends Error {}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/;

export interface LoadOptions {
  /** the RPC's chain id: the file's chainId must equal it */
  chainId?: number;
  /** "optional": kuru.marginAccount may be absent or zero (the payer never uses it; a local MockKuruRouter has none) */
  marginAccount?: "required" | "optional";
}

function bad(field: string, why = "is missing or malformed"): never {
  throw new DeploymentsError(`deployments file: ${field} ${why}`);
}

function addr(v: unknown, field: string, zeroOk = false): Address {
  if (typeof v !== "string" || !ADDR.test(v)) bad(field, "is not a 0x-prefixed 40-hex address");
  if (!zeroOk && ZERO.test(v)) bad(field, "is the zero address");
  return v as Address;
}

function intField(v: unknown, field: string, min: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) bad(field, `is not an integer >= ${min}`);
  return v;
}

/** Parses an already-read deployments JSON (tests). */
export function parseDeployments(text: string, o: LoadOptions = {}): Deployments {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    bad("(the whole file)", "is not JSON");
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) bad("(the whole file)", "is not an object");
  const r = j as Record<string, unknown>;
  const chainId = intField(r.chainId, "chainId", 1);
  if (o.chainId !== undefined && chainId !== o.chainId) bad("chainId", "does not match the RPC's chain id");
  const dollar = addr(r.dollar, "dollar");
  const k = r.kuru;
  if (!k || typeof k !== "object" || Array.isArray(k)) bad("kuru");
  const kr = k as Record<string, unknown>;
  const router = addr(kr.router, "kuru.router", true); // zero: a chain without Kuru
  let marginAccount: Address = "0x0000000000000000000000000000000000000000";
  if (kr.marginAccount !== undefined || o.marginAccount === "required") {
    marginAccount = addr(kr.marginAccount, "kuru.marginAccount", o.marginAccount !== "required");
  }
  const fs = r.factories;
  if (!fs || typeof fs !== "object" || Array.isArray(fs)) bad("factories");
  const factories: Record<string, FactoryEntry> = {};
  const names = Object.keys(fs as object);
  if (names.length === 0) bad("factories", "is empty");
  for (const name of names) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) bad(`factories.<name>`, "has a name that is not lowercase letters, digits, - or _");
    const e = (fs as Record<string, unknown>)[name];
    const f = `factories.${name}`;
    if (!e || typeof e !== "object" || Array.isArray(e)) bad(f);
    const x = e as Record<string, unknown>;
    if (typeof x.tag !== "string" || !/^([a-z]{1,8})?$/.test(x.tag)) bad(`${f}.tag`, "is not empty or 1 to 8 letters a to z");
    const sb = x.startBlock;
    if (!(typeof sb === "number" && Number.isSafeInteger(sb) && sb >= 0) && !(typeof sb === "string" && /^[0-9]{1,20}$/.test(sb))) bad(`${f}.startBlock`, "is not a block number");
    factories[name] = {
      name,
      index: addr(x.index, `${f}.index`),
      dollar: addr(x.dollar, `${f}.dollar`),
      tag: x.tag,
      factory: addr(x.factory, `${f}.factory`),
      router: addr(x.router, `${f}.router`),
      tPend: intField(x.tPend, `${f}.tPend`, 1),
      startBlock: BigInt(sb as number | string),
    };
  }
  return { chainId, dollar, kuru: { router, marginAccount }, factories };
}

/** BOTS-SPEC 1: loadDeployments(path) fails closed; the process stops with the field's name. */
export function loadDeployments(path: string, o: LoadOptions = {}): Deployments {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new DeploymentsError("deployments file: cannot be read (AGATE_DEPLOYMENTS)");
  }
  return parseDeployments(text, o);
}

/** The smallest startBlock over the given factories (the scanner's first block). */
export function firstBlock(d: Deployments, names?: readonly string[]): bigint {
  const es = Object.values(d.factories).filter((e) => !names || names.includes(e.name));
  if (es.length === 0) throw new DeploymentsError("deployments file: no factory selected");
  return es.reduce((m, e) => (e.startBlock < m ? e.startBlock : m), es[0]!.startBlock);
}
