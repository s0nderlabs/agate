// Reads or sets Dynamic's Transaction Review config for this environment through the management API, with secrets
// read from AGATE_DYNAMIC_HOME (never printed). Prints only the non-secret fields of the result.
// bun run scripts/review-config.ts get
// bun run scripts/review-config.ts set <publicBase> [DENY|ALLOW]
// bun run scripts/review-config.ts test <scenario>   (Dynamic sends a synthetic request to our endpoint)
import { config, readHomeFile, requireSecret, secret } from "../src/config.ts";

// the admin token (Environment Settings - Write) when saved, else the runtime token (read-only for settings)
const token = () => secret("DYNAMIC_ADMIN_TOKEN", "admin.env") ?? requireSecret("DYNAMIC_API_KEY", "api.env");
const base = `${config.dynamicApi}/environments/${config.environmentId}/waas/transactionReviewConfig`;

function safe(v: unknown): unknown {
  if (!v || typeof v !== "object") return v;
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = /secret/i.test(k) ? (x ? "<set>" : x) : safe(x);
  return o;
}

async function call(method: string, url: string, body?: unknown) {
  const r = await fetch(url, { method, headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j: unknown = t;
  try {
    j = JSON.parse(t);
  } catch {
    // text
  }
  console.log(method, r.status, JSON.stringify(safe(j)).slice(0, 1200));
  return r.ok;
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "get") await call("GET", base);
else if (cmd === "set") {
  if (!a) throw new Error("usage: set <publicBase> [DENY|ALLOW]");
  await call("PUT", base, {
    enabled: true,
    webhookUrl: `${a.replace(/\/$/, "")}/dynamic/review`,
    webhookFailurePolicy: b ?? "DENY",
    webhookSecret: requireSecret("DYNAMIC_REVIEW_SECRET", "review.env"),
    webhookPublicKey: readHomeFile("review-ed25519.pub.pem"),
    webhookTimeoutMs: 5000,
  });
} else if (cmd === "test") await call("POST", `${base}/test`, { scenario: a ?? "evmUserOperation" });
else console.log("usage: get | set <publicBase> [DENY|ALLOW] | test <scenario>");
