// A local anvil fork of Monad testnet for the client's end-to-end run, started only through the repo's
// wall/scripts/anvil-safe.sh (pruned history, a private home deleted on exit, a watchdog, refused under 30 GB free).
// Block time moves only when the harness warps it (anvil's timestamp interval 0). Every helper refuses a URL that is
// not a loopback anvil fork: nothing here can reach the public network except the fork's own read-only upstream.
import { redactUrl as redactOne, scrubSecrets } from "../../wall/packages/report/src/env.ts";
import { spawnAnvil } from "../../wall/scripts/anvil.ts";

export const UPSTREAM = "https://testnet-rpc.monad.xyz";
export const MIN_FREE_GB = Number(process.env.AGATE_ANVIL_MIN_FREE_GB ?? 30);

/** Whether an http(s) URL names this machine, in any spelling the URL parser normalizes: localhost and *.localhost (any
 *  case, trailing dots, percent-encoded), 127.0.0.0/8 (also written in decimal, hex, octal or short, e.g. 2130706433,
 *  0x7f000001, 0177.0.0.1, 127.1), 0.0.0.0 (also 0), ::1, ::, and the IPv4-mapped or IPv4-compatible forms of
 *  127.0.0.0/8 and 0.0.0.0 ([::ffff:127.0.0.1] reads [::ffff:7f00:1]). Not an http(s) URL: false. A name that only
 *  resolves to this machine (a DNS entry) is not caught here: the testnet mode also asks the node itself. */
export function isLoopback(u: string): boolean {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  while (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "::" || host === "0.0.0.0" || host === "::ffff:0:0") return true;
  if (/^::(ffff:)?7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return v4 !== null && v4[1] === "127";
}

/** "https://monad-testnet.g.alchemy.com/v2/<key>" -> "https://monad-testnet.g.alchemy.com/...": the wall's redactUrl
 *  (scheme, host and port only; "<url>" for what does not parse), entry by entry for a comma-separated list. */
export function redactUrl(u: string): string {
  return u.includes(",") ? u.split(",").map(redactOne).join(",") : redactOne(u);
}

/** `s` with each of `urls`, and each long path segment, query value, user-info part or fragment of them, scrubbed by the
 *  wall's own rule (scrubSecrets, BUILD-SPEC 13.6): one redaction policy for the wall and the e2e. */
export function scrubUrls(s: string, urls: readonly string[]): string {
  return scrubSecrets(s, { http: [...urls], ws: [] });
}

/** `df -Pk /`: free GB of the root volume (house rule: no anvil under 30 GB). */
export function freeGb(): number {
  const r = Bun.spawnSync(["df", "-Pk", "/"], { stdout: "pipe" });
  const line = r.stdout.toString().trim().split("\n")[1] ?? "";
  return Math.floor(Number(line.split(/\s+/)[3] ?? 0) / 1_048_576);
}
export function dfLine(): string {
  return Bun.spawnSync(["df", "-h", "/"], { stdout: "pipe" }).stdout.toString().trim().split("\n")[1] ?? "";
}
export function anvilTmp(): string {
  const r = Bun.spawnSync(["du", "-sh", `${process.env.HOME}/.foundry/anvil/tmp`], { stdout: "pipe", stderr: "ignore" });
  return r.stdout.toString().trim().split(/\s+/)[0] ?? "none";
}

export async function rpcCall(rpc: string, method: string, params: unknown[] = []): Promise<unknown> {
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

/** Fails unless `rpc` is a loopback anvil fork of chain 10143. */
export async function assertFork(rpc: string): Promise<{ forkBlock: number }> {
  if (!isLoopback(rpc)) throw new Error(`${rpc} is not a loopback URL: the e2e sends transactions only to a local fork`);
  const id = Number(BigInt((await rpcCall(rpc, "eth_chainId")) as string));
  if (id !== 10143) throw new Error(`the fork answers chain ${id}, not 10143`);
  const info = (await rpcCall(rpc, "anvil_nodeInfo").catch(() => null)) as { forkConfig?: { forkBlockNumber?: number } } | null;
  if (!info) throw new Error(`${rpc} is not an anvil node`);
  const fb = info.forkConfig?.forkBlockNumber;
  if (!fb) throw new Error(`${rpc} is not a fork (anvil_nodeInfo names no fork block)`);
  return { forkBlock: Number(fb) };
}

export class Fork {
  private constructor(
    readonly rpc: string,
    readonly proc: Bun.Subprocess,
    readonly forkBlock: number,
  ) {}

  static async start(): Promise<Fork> {
    const gb = freeGb();
    if (gb < MIN_FREE_GB) throw new Error(`only ${gb} GB free (floor ${MIN_FREE_GB} GB): not starting anvil`);
    const a = await spawnAnvil(["--fork-url", UPSTREAM, "--code-size-limit", "131072", "--silent", "--slots-in-an-epoch", "1"], { timeoutMs: 180_000 });
    const { forkBlock } = await assertFork(a.rpc);
    await rpcCall(a.rpc, "anvil_setBlockTimestampInterval", [0]);
    return new Fork(a.rpc, a.proc, forkBlock);
  }

  call(method: string, params: unknown[] = []): Promise<unknown> {
    return rpcCall(this.rpc, method, params);
  }
  async time(): Promise<bigint> {
    const b = (await this.call("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
    return BigInt(b.timestamp);
  }
  async block(): Promise<bigint> {
    return BigInt((await this.call("eth_blockNumber")) as string);
  }
  /** Block time to t (forward only), mined. */
  async warp(t: bigint): Promise<void> {
    if (t > (await this.time())) await this.call("evm_setNextBlockTimestamp", [Number(t)]);
    await this.call("evm_mine");
  }
  async setBalance(a: string, mon: bigint): Promise<void> {
    await this.call("anvil_setBalance", [a, `0x${(mon * 10n ** 18n).toString(16)}`]);
  }
  /** Fork only: a plain account (an EIP-7702 delegation some testnet addresses carry is removed on the fork). */
  async clearCode(a: string): Promise<void> {
    await this.call("anvil_setCode", [a, "0x"]);
  }
  /** A transaction from an impersonated address (no key exists for it here), waited for. */
  async sendAs(from: string, to: string, data: string, gas = 3_000_000n): Promise<string> {
    await this.call("anvil_impersonateAccount", [from]);
    const hash = (await this.call("eth_sendTransaction", [{ from, to, data, gas: `0x${gas.toString(16)}` }])) as string;
    for (let i = 0; i < 600; i++) {
      const rc = (await this.call("eth_getTransactionReceipt", [hash])) as { status: string } | null;
      if (rc) {
        if (rc.status !== "0x1") throw new Error(`a transaction from ${from} reverted (${hash})`);
        return hash;
      }
      await Bun.sleep(50);
    }
    throw new Error(`no receipt for ${hash}`);
  }

  async stop(): Promise<void> {
    this.proc.kill();
    await this.proc.exited;
  }
}
