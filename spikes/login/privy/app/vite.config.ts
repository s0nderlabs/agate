import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));

function readJson(path: string): Record<string, unknown> {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Client-side ids only (no secrets). Order: app/.env.local VITE_* overrides, then shared/ids.json
// (written by the setup step), then agent/policy.json (written by `bun run policy` in agent/).
// Read when the dev server starts or the build runs: restart `bun run dev` after either file changes.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, here, "VITE_");
  const ids = readJson(resolve(here, "../../shared/ids.json"));
  const policy = readJson(resolve(here, "../agent/policy.json"));
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const resolved = {
    privyAppId: env.VITE_PRIVY_APP_ID || str(ids.privyAppId),
    privyClientId: env.VITE_PRIVY_CLIENT_ID || str(ids.privyClientId),
    signerId: env.VITE_PRIVY_SIGNER_ID || str(policy.signerId),
    policyId: env.VITE_PRIVY_AGENT_POLICY_ID || str(policy.policyId),
    policyExpiry: typeof policy.expiry === "number" ? policy.expiry : null,
  };
  if (!resolved.privyAppId) {
    console.warn(
      "\n[privy spike] privyAppId is missing: shared/ids.json has no privyAppId and VITE_PRIVY_APP_ID is unset. " +
        "The page will build and load but show a setup error until it is provided.\n",
    );
  }
  if (!resolved.signerId || !resolved.policyId) {
    console.warn("[privy spike] agent signer or policy id missing: run `bun run policy` in ../agent (step 4 stays disabled).\n");
  }
  return {
    plugins: [react()],
    define: { __SPIKE_IDS__: JSON.stringify(resolved) },
    server: { port: 5172, strictPort: true, host: "localhost", fs: { allow: [resolve(here, "../..")] } },
    preview: { port: 5172, strictPort: true, host: "localhost" },
  };
});
