// Dynamic's sign-in providers for this environment, through the management API (admin token).
//   bun run scripts/providers.ts urls                   the OAuth redirect URLs Dynamic gives each provider
//   bun run scripts/providers.ts list                   providers (secrets never printed)
//   bun run scripts/providers.ts on <providerId>        switch a provider on
//   bun run scripts/providers.ts google <secrets-file>  create or update Google from GOOGLE_CLIENT_ID and
//                                                       GOOGLE_CLIENT_SECRET in that file, then switch it on
import { readFileSync } from "node:fs";
import { config, requireSecret } from "../src/config.ts";

const base = `${config.dynamicApi}/environments/${config.environmentId}/settings/providers`;
// update and switching on/off live outside the environment path
const byId = `${config.dynamicApi}/settings/providers`;
const h = { authorization: `Bearer ${requireSecret("DYNAMIC_ADMIN_TOKEN", "admin.env")}`, "content-type": "application/json" };
const mask = (t: string) => t.replace(/[A-Za-z0-9_-]{24,}/g, (m) => `${m.slice(0, 6)}...(${m.length})`);
const call = async (method: string, path: string, body?: unknown, root = base) => {
  const r = await fetch(`${root}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, text: t, json: (() => { try { return JSON.parse(t); } catch { return null; } })() };
};
const switchOn = async (id: string) => {
  const e = await call("PUT", `/${id}/enable`, undefined, byId);
  console.log("on", e.status, mask(e.text).slice(0, 200));
};

const [cmd, arg] = process.argv.slice(2);
if (cmd === "urls") {
  const r = await call("GET", "/urls");
  console.log(r.status, mask(r.text).slice(0, 2000));
} else if (cmd === "list") {
  const r = await call("GET", "");
  const list = (r.json?.providers ?? r.json ?? []) as Record<string, unknown>[];
  for (const p of Array.isArray(list) ? list : []) console.log(p.provider, p.id, p.enabledAt ? "enabled" : "off", p.clientId ? `clientId ${String(p.clientId).slice(0, 12)}...` : "", p.redirectUrl ?? "");
  if (!Array.isArray(list)) console.log(r.status, mask(r.text).slice(0, 600));
} else if (cmd === "on" && arg) {
  await switchOn(arg);
} else if (cmd === "google") {
  if (!arg) throw new Error("usage: google <secrets-file>");
  const env = Object.fromEntries(readFileSync(arg, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("the file needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  const all = await call("GET", "");
  const list = ((all.json?.providers ?? all.json ?? []) as { provider: string; id: string }[]) ?? [];
  const existing = Array.isArray(list) ? list.find((p) => p.provider === "google") : undefined;
  const r = existing ? await call("PUT", `/${existing.id}`, { provider: "google", clientId, clientSecret }, byId) : await call("POST", "", { provider: "google", clientId, clientSecret });
  console.log(existing ? "updated" : "created", r.status, mask(r.text).slice(0, 300));
  const id = existing?.id ?? (r.json?.provider?.id ?? r.json?.id);
  if (id) await switchOn(id);
}
process.exit(0);
