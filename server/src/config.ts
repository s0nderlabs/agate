// The server's settings. Everything secret lives in AGATE_DYNAMIC_HOME (default ~/.agate-dynamic, mode 700), one
// KEY=value file per concern, read here and never printed or logged. Public facts (chain, contract addresses) come
// from @agate/client so the server and the app always agree on them.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import { PUBLIC_RPC, TESTNET_DEPLOYMENTS } from "@agate/client";

export const HOME = process.env.AGATE_DYNAMIC_HOME ?? join(homedir(), ".agate-dynamic");

export function ensureHome(): void {
  if (!existsSync(HOME)) mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const mode = statSync(HOME).mode & 0o777;
  if (mode & 0o077) throw new Error(`${HOME} is readable by others (mode ${mode.toString(8)}): chmod 700 it first`);
}

/** KEY=value lines of HOME/<file>, without echoing them. Missing file: empty. */
export function envFile(file: string): Record<string, string> {
  const f = join(HOME, file);
  if (!existsSync(f)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

/** A secret from the environment or HOME/<file>; undefined when neither has it. */
export function secret(name: string, file: string): string | undefined {
  return process.env[name] ?? envFile(file)[name];
}

export function requireSecret(name: string, file: string): string {
  const v = secret(name, file);
  if (!v) throw new Error(`${name} missing: put it in ${join(HOME, file)} (never in chat or the repo)`);
  return v;
}

export function readHomeFile(file: string): string | undefined {
  const f = join(HOME, file);
  return existsSync(f) ? readFileSync(f, "utf8") : undefined;
}

const real = TESTNET_DEPLOYMENTS.factories.real!;

export const config = {
  port: Number(process.env.AGATE_SERVER_PORT ?? 5191),
  host: process.env.AGATE_SERVER_HOST ?? "127.0.0.1",
  /** the public base URL (the tunnel or the host): used in OAuth metadata and links */
  publicBase: process.env.AGATE_PUBLIC_BASE ?? "",
  environmentId: process.env.DYNAMIC_ENVIRONMENT_ID ?? "db2880bd-e52a-4f00-aa83-2c3ec77281cb",
  dynamicApi: "https://app.dynamicauth.com/api/v0",
  chainId: 10143,
  /** one RPC URL or a comma list, tried in order (the next one when a call fails, a 429 included) */
  rpcUrl: process.env.MONAD_RPC_URL ?? PUBLIC_RPC,
  dollar: TESTNET_DEPLOYMENTS.dollar as Address,
  router: real.router as Address,
  /** every router a pocket may use: the real factory's, plus a running demo session's (AGATE_EXTRA_ROUTERS) */
  routers: [real.router, ...(process.env.AGATE_EXTRA_ROUTERS ?? "").split(",").filter(Boolean)] as Address[],
  factory: real.factory as Address,
  /** an intent (an operation the server built and is about to sign) is honoured by Transaction Review this long */
  intentTtlMs: 90_000,
  /** answer Transaction Review within this budget (Dynamic waits 5 s by default) */
  reviewBudgetMs: 3_000,
};

export type Config = typeof config;
