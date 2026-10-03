// A scriptable JSON-RPC endpoint on localhost for the scanner and sender tests, so the real viem clients and the
// wall's RpcPool run unchanged: logs with range and address rules, block tags, eth_call / estimateGas scripts, raw
// transactions and receipts. Local only; no chain behind it.
import { type Hex, keccak256 } from "viem";

export interface RawLogJson {
  address: string;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  logIndex: Hex;
  transactionHash: Hex;
  blockHash: Hex;
  transactionIndex: Hex;
  removed: boolean;
}

export interface CallScript {
  /** a result for eth_call (hex), or an error with revert data */
  result?: Hex;
  revert?: Hex;
}

export class FakeRpc {
  chainId = 10143;
  latest = 1_000n;
  /** null: the node refuses the `finalized` tag */
  finalizedLag: number | null = 2;
  logs: RawLogJson[] = [];
  /** eth_getLogs refuses a range wider than this */
  maxRange = 100_000;
  refuseNoAddress = false;
  call: (params: { to: string; data: Hex; from?: string }, tag: string) => CallScript = () => ({ result: "0x" });
  estimate: (params: { to: string; data: Hex }) => bigint | { revert: Hex } = () => 100_000n;
  baseFee = 50_000_000_000n;
  priorityFee = 2_000_000_000n;
  nonce = 0;
  raws: Hex[] = [];
  /** receipts by hash; a sent raw gets a success receipt unless noReceipt */
  noReceipt = false;
  effectiveGasPrice = 52_000_000_000n;
  receiptLogs: RawLogJson[] = [];
  readonly seen: { method: string; params: unknown[] }[] = [];
  private server: ReturnType<typeof Bun.serve> | null = null;
  private hashes = new Map<string, Hex>();

  get url(): string {
    return `http://127.0.0.1:${this.server!.port}`;
  }
  get url2(): string {
    return `http://localhost:${this.server!.port}`;
  }

  start(): this {
    this.server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
        const one = (b: { id: number; method: string; params: unknown[] }) => {
          this.seen.push({ method: b.method, params: b.params });
          try {
            return { jsonrpc: "2.0", id: b.id, result: this.handle(b.method, b.params) };
          } catch (e) {
            const x = e as { code?: number; message: string; data?: Hex };
            return { jsonrpc: "2.0", id: b.id, error: { code: x.code ?? -32000, message: x.message, ...(x.data ? { data: x.data } : {}) } };
          }
        };
        return Response.json(Array.isArray(body) ? body.map(one) : one(body));
      },
    });
    return this;
  }

  stop(): void {
    this.server?.stop(true);
  }

  count(method: string): number {
    return this.seen.filter((s) => s.method === method).length;
  }

  private block(n: bigint) {
    return {
      number: `0x${n.toString(16)}`,
      hash: `0x${n.toString(16).padStart(64, "0")}`,
      parentHash: `0x${"0".repeat(64)}`,
      timestamp: `0x${(1_900_000_000n + n).toString(16)}`,
      baseFeePerGas: `0x${this.baseFee.toString(16)}`,
      gasLimit: "0x1c9c380",
      gasUsed: "0x0",
      miner: `0x${"0".repeat(40)}`,
      extraData: "0x",
      logsBloom: `0x${"0".repeat(512)}`,
      transactions: [],
      difficulty: "0x0",
      nonce: "0x0000000000000000",
      sha3Uncles: `0x${"0".repeat(64)}`,
      size: "0x0",
      stateRoot: `0x${"0".repeat(64)}`,
      receiptsRoot: `0x${"0".repeat(64)}`,
      transactionsRoot: `0x${"0".repeat(64)}`,
      uncles: [],
      mixHash: `0x${"0".repeat(64)}`,
      totalDifficulty: "0x0",
    };
  }

  private handle(method: string, params: unknown[]): unknown {
    switch (method) {
      case "eth_chainId":
        return `0x${this.chainId.toString(16)}`;
      case "eth_blockNumber":
        return `0x${this.latest.toString(16)}`;
      case "eth_getBlockByNumber": {
        const tag = params[0] as string;
        if (tag === "finalized") {
          if (this.finalizedLag === null) throw { code: -32602, message: "unsupported block tag finalized" };
          return this.block(this.latest - BigInt(this.finalizedLag));
        }
        if (tag === "latest" || tag === "pending") return this.block(this.latest);
        return this.block(BigInt(tag));
      }
      case "eth_getLogs": {
        const f = params[0] as { fromBlock: Hex; toBlock: Hex; address?: string | string[]; topics?: (Hex | Hex[] | null)[] };
        const from = BigInt(f.fromBlock);
        const to = BigInt(f.toBlock);
        if (to - from + 1n > BigInt(this.maxRange)) throw { code: -32602, message: `block range too large: max ${this.maxRange} blocks` };
        if (this.refuseNoAddress && (f.address === undefined || (Array.isArray(f.address) && f.address.length === 0))) throw { code: -32602, message: "address is required for this filter" };
        const addrs = f.address === undefined ? null : (Array.isArray(f.address) ? f.address : [f.address]).map((a) => a.toLowerCase());
        const t0 = f.topics?.[0];
        const t0s = t0 === undefined || t0 === null ? null : (Array.isArray(t0) ? t0 : [t0]).map((x) => x.toLowerCase());
        return this.logs.filter((l) => {
          const b = BigInt(l.blockNumber);
          return b >= from && b <= to && (!addrs || addrs.includes(l.address.toLowerCase())) && (!t0s || t0s.includes(l.topics[0]!.toLowerCase()));
        });
      }
      case "eth_call": {
        const [p, tag] = params as [{ to: string; data: Hex; from?: string }, string];
        const r = this.call(p, tag);
        if (r.revert !== undefined) throw { code: 3, message: "execution reverted", data: r.revert };
        return r.result ?? "0x";
      }
      case "eth_estimateGas": {
        const r = this.estimate(params[0] as { to: string; data: Hex });
        if (typeof r === "object") throw { code: 3, message: "execution reverted", data: r.revert };
        return `0x${r.toString(16)}`;
      }
      case "eth_maxPriorityFeePerGas":
        return `0x${this.priorityFee.toString(16)}`;
      case "eth_gasPrice":
        return `0x${(this.baseFee + this.priorityFee).toString(16)}`;
      case "eth_getTransactionCount":
        return `0x${this.nonce.toString(16)}`;
      case "eth_getCode":
        return "0x";
      case "eth_getBalance":
        return `0x${(10n ** 21n).toString(16)}`;
      case "eth_sendRawTransaction": {
        const raw = params[0] as Hex;
        this.raws.push(raw);
        const hash = keccak256(raw);
        this.hashes.set(hash, raw);
        this.nonce++;
        return hash;
      }
      case "eth_getTransactionReceipt": {
        const h = params[0] as Hex;
        if (this.noReceipt || !this.hashes.has(h)) return null;
        return {
          transactionHash: h,
          transactionIndex: "0x0",
          blockHash: `0x${"1".padStart(64, "0")}`,
          blockNumber: `0x${this.latest.toString(16)}`,
          from: `0x${"0".repeat(40)}`,
          to: `0x${"0".repeat(40)}`,
          cumulativeGasUsed: "0x5208",
          gasUsed: "0x5208",
          effectiveGasPrice: `0x${this.effectiveGasPrice.toString(16)}`,
          contractAddress: null,
          logs: this.receiptLogs,
          logsBloom: `0x${"0".repeat(512)}`,
          status: "0x1",
          type: "0x2",
        };
      }
      default:
        throw { code: -32601, message: `method ${method} not supported` };
    }
  }
}
