// Reads config for the agent scripts. Secrets come only from the environment (agent/.env.local,
// which bun loads automatically and .gitignore excludes). Never printed.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const here = import.meta.dir;

function readJson(path: string): Record<string, unknown> {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const idsPath = resolve(here, "../../shared/ids.json");
export const policyPath = resolve(here, "policy.json");

export function appId(): string {
  const v = process.env.PRIVY_APP_ID || (readJson(idsPath).privyAppId as string | undefined) || "";
  if (!v) fail("PRIVY_APP_ID missing: set it in agent/.env.local or add privyAppId to spikes/login/shared/ids.json");
  return v;
}

export function secret(name: "PRIVY_APP_SECRET" | "PRIVY_AUTHORIZATION_PRIVATE_KEY"): string {
  const v = process.env[name];
  if (!v) fail(`${name} missing: copy agent/.env.example to agent/.env.local and fill it from the Privy dashboard`);
  return v!;
}

export function savedPolicy(): { policyId?: string; signerId?: string; expiry?: number } {
  return readJson(policyPath) as { policyId?: string; signerId?: string; expiry?: number };
}

export function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
export const flag = (name: string) => process.argv.includes(`--${name}`);
