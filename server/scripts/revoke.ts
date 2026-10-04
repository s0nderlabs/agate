// agate's server-side kill switch (live test 6): revoke one delegated wallet through Dynamic's management API
// (DELETE /environments/{env}/waas/{walletId}/delegatedAccess, admin token), then watch for the
// wallet.delegation.revoked webhook and the grants it ends.
// bun run scripts/revoke.ts <walletId>
import { config, requireSecret } from "../src/config.ts";
import { Store } from "../src/store.ts";

const walletId = process.argv[2];
if (!walletId) throw new Error("usage: revoke.ts <walletId>");
const store = new Store();
const t0 = performance.now();
// "developers revoke their own delegated access": try the delegation's own wallet API key first, then our tokens
const tokens: [string, string | undefined][] = [
  ["delegation walletApiKey", store.materials(walletId)?.walletApiKey],
  ["runtime API token", requireSecret("DYNAMIC_API_KEY", "api.env")],
  ["admin API token", requireSecret("DYNAMIC_ADMIN_TOKEN", "admin.env")],
];
for (const [name, tok] of tokens) {
  if (!tok) continue;
  const r = await fetch(`${config.dynamicApi}/environments/${config.environmentId}/waas/${walletId}/delegatedAccess`, { method: "DELETE", headers: { authorization: `Bearer ${tok}` } });
  console.log("DELETE with", name, r.status, (await r.text()).slice(0, 200).replace(/[A-Za-z0-9_-]{40,}/g, "<long>"), Math.round(performance.now() - t0), "ms");
  if (r.ok) break;
}
for (let i = 0; i < 30; i++) {
  const d = store.delegation(walletId);
  if (d?.status === "revoked") {
    console.log("webhook processed after", Math.round(performance.now() - t0), "ms; grants:", JSON.stringify(store.grantsOfAssistant(walletId).map((g) => ({ id: g.id.slice(0, 8), status: g.status }))));
    process.exit(0);
  }
  await Bun.sleep(1000);
}
console.log("no revoked webhook within 30 s");
process.exit(0);
