// Read-only chain access for the repair agent (BUILD-SPEC 15.2): readerHistory and queuedEta over HTTP. It never
// builds a wallet client and never sends anything. Endpoints come from AGATE_RPC_URLS_CMD (13.6); every URL is
// treated as secret and never printed.
import { createPublicClient, encodeAbiParameters, http, keccak256, parseAbi, type PublicClient } from "viem";
import type { Hex } from "@agate/report/types";
import { READER_SWAP_TAG } from "@agate/report/types";

export interface HistoryEntry {
  fromDay: number;
  executedAt: number;
  readerHash: Hex;
  url: string;
  parserVersion: string;
  reason: string;
}

export interface ChainView {
  readerHistory(gpuId: Hex, slot: number): Promise<HistoryEntry[]>;
  queuedEta(id: Hex): Promise<number>;
}

const ABI = parseAbi([
  "function readerHistory(bytes32 gpuId, uint8 slot) view returns ((uint32 fromDay, uint64 executedAt, bytes32 readerHash, string url, string parserVersion, string reason)[])",
  "function queuedEta(bytes32 id) view returns (uint64)",
]);

/** readerHash = keccak256(abi.encode(url, parserVersion)) (4.15). */
export function readerHash(url: string, parserVersion: string): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }], [url, parserVersion]));
}

/** id = keccak256(abi.encode(READER_SWAP_TAG, gpuId, slot, readerHash)) (4.15). */
export function readerSwapId(gpuId: Hex, slot: number, url: string, parserVersion: string): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }, { type: "bytes32" }], [READER_SWAP_TAG, gpuId, slot, readerHash(url, parserVersion)]));
}

/** A read-only view over the HTTP endpoints in order (the next one on any error). */
export function viemChain(index: Hex, urls: readonly string[], timeoutMs = 10_000): ChainView {
  const clients: PublicClient[] = urls.map((u) => createPublicClient({ transport: http(u, { timeout: timeoutMs, retryCount: 0 }) }) as PublicClient);
  const first = async <T>(f: (c: PublicClient) => Promise<T>): Promise<T> => {
    let last: unknown;
    for (const c of clients) {
      try {
        return await f(c);
      } catch (e) {
        last = e;
      }
    }
    // never the URL: viem's messages embed it
    throw new Error(`every RPC endpoint failed (${(last as { shortMessage?: string })?.shortMessage?.split("\n")[0]?.replace(/https?:\/\/\S+/g, "<url>") ?? "error"})`);
  };
  return {
    async readerHistory(gpuId, slot) {
      const rows = (await first((c) => c.readContract({ address: index, abi: ABI, functionName: "readerHistory", args: [gpuId, slot] }))) as readonly { fromDay: number; executedAt: bigint; readerHash: Hex; url: string; parserVersion: string; reason: string }[];
      return rows.map((r) => ({ fromDay: Number(r.fromDay), executedAt: Number(r.executedAt), readerHash: r.readerHash, url: r.url, parserVersion: r.parserVersion, reason: r.reason }));
    },
    async queuedEta(id) {
      return Number(await first((c) => c.readContract({ address: index, abi: ABI, functionName: "queuedEta", args: [id] })));
    },
  };
}
