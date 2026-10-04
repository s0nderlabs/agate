// Read-only: the sign-in credentials on a Dynamic user (format and provider only; emails shown as domain only).
// bun run scripts/user-creds.ts <userId>
import { config, requireSecret } from "../src/config.ts";

const id = process.argv[2];
const r = await fetch(`${config.dynamicApi}/environments/${config.environmentId}/users/${id}`, { headers: { authorization: `Bearer ${requireSecret("DYNAMIC_API_KEY", "api.env")}` } });
const j = (await r.json().catch(() => ({}))) as Record<string, any>;
const u = j.user ?? j;
const dom = (e: unknown) => (typeof e === "string" && e.includes("@") ? `*@${e.split("@")[1]}` : e);
console.log(r.status, "email", dom(u.email));
for (const c of (u.verifiedCredentials ?? []) as Record<string, unknown>[]) console.log(c.format, c.oauthProvider ?? c.walletProvider ?? "", dom(c.email ?? c.oauthEmails ?? ""), c.lastSelectedAt ? "last used" : "");
process.exit(0);
