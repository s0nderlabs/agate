// agate's Dynamic environment as code. The file ops/dynamic/sandbox.json holds the environment's settings, providers,
// webhook, Transaction Review config and allowed origins, with the server's public base written as ${PUBLIC_BASE}
// (it changes with every tunnel). Nothing secret is in the file: the webhook and review secrets stay in
// AGATE_DYNAMIC_HOME and are never read back from Dynamic.
//
//   bun run scripts/env.ts export           write the file from the live environment
//   bun run scripts/env.ts diff             what differs between the file and the live environment
//   bun run scripts/env.ts apply            point the webhook and Transaction Review at AGATE_PUBLIC_BASE, as the file says
//   bun run scripts/env.ts apply --settings also PUT the file's settings (providers are kept as they are live)
//
// AGATE_PUBLIC_BASE must be set for diff and apply (and for export, to template the URLs). Uses the admin token.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, readHomeFile, requireSecret } from "../src/config.ts";

const FILE = join(import.meta.dir, "..", "..", "ops", "dynamic", "sandbox.json");
const ENV = `${config.dynamicApi}/environments/${config.environmentId}`;
const tok = () => requireSecret("DYNAMIC_ADMIN_TOKEN", "admin.env");
const base = () => {
  const b = process.env.AGATE_PUBLIC_BASE?.replace(/\/$/, "");
  if (!b) throw new Error("set AGATE_PUBLIC_BASE (the server's public HTTPS base)");
  return b;
};

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const r = await fetch(`${ENV}${path}`, { method, headers: { authorization: `Bearer ${tok()}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path || "/"} ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}

type Settings = Record<string, unknown> & { providers?: { provider: string; enabledAt?: string | null }[] };
type Hook = { webhookId: string; url: string; events: string[]; isEnabled: boolean; version?: string };
type Review = { enabled: boolean; webhookUrl: string | null; webhookFailurePolicy: string; webhookTimeoutMs: number };
type Doc = {
  note: string;
  environmentId: string;
  settings: Record<string, unknown>;
  providers: string[];
  webhooks: { url: string; events: string[]; isEnabled: boolean }[];
  transactionReview: { enabled: boolean; webhookUrl: string | null; webhookFailurePolicy: string; webhookTimeoutMs: number };
  origins: unknown[];
};

// whole-key matches only ("pricingProviderTokenId" is a price feed id, not a secret)
const SECRETISH = /(secret|password|private_?key|api_?key|access_?token|auth_?token|^token)$/i;
const MASK = "<secret, not exported>";
/** keys sorted, secret-looking values masked, the public base templated */
function clean(v: unknown, b: string, key = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => clean(x, b));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = clean((v as Record<string, unknown>)[k], b, k);
    return o;
  }
  if (typeof v === "string") {
    if (SECRETISH.test(key) && v) return MASK;
    return b ? v.split(b).join("${PUBLIC_BASE}") : v;
  }
  return v;
}

async function live(b: string): Promise<{ doc: Doc; settings: Settings; hooks: Hook[] }> {
  const env = (await api("GET", "")) as { settings: Settings };
  const hooks = ((await api("GET", "/webhooks")) as { data: Hook[] }).data;
  const tr = (await api("GET", "/waas/transactionReviewConfig")) as Review;
  const origins = ((await api("GET", "/origins")) as { origins: unknown[] }).origins;
  const { providers = [], ...settings } = env.settings;
  // read-only and returned only some of the time (seen Oct 4): never part of the file or a diff
  delete ((settings.security as Record<string, unknown> | undefined)?.mfa as Record<string, unknown> | undefined)?.availableMethods;
  const doc: Doc = {
    note: "agate's Dynamic sandbox environment as code: bun run server/scripts/env.ts export | diff | apply. ${PUBLIC_BASE} is the server's public HTTPS base (AGATE_PUBLIC_BASE). No secrets here.",
    environmentId: config.environmentId,
    settings: clean(settings, b) as Record<string, unknown>,
    providers: providers.filter((p) => p.enabledAt).map((p) => p.provider).sort(),
    webhooks: hooks.map((h) => ({ url: clean(h.url, b) as string, events: [...h.events].sort(), isEnabled: h.isEnabled })),
    transactionReview: { enabled: tr.enabled, webhookUrl: tr.webhookUrl ? (clean(tr.webhookUrl, b) as string) : null, webhookFailurePolicy: tr.webhookFailurePolicy, webhookTimeoutMs: tr.webhookTimeoutMs },
    origins,
  };
  return { doc, settings: env.settings, hooks };
}

function diffs(a: unknown, b: unknown, p = ""): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    return [...keys].flatMap((k) => diffs((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${p}.${k}`));
  }
  const show = (x: unknown) => (x === undefined ? "(none)" : JSON.stringify(x).slice(0, 120));
  return [`${p || "."}: file ${show(a)} | live ${show(b)}`];
}

const fileDoc = (): Doc => {
  if (!existsSync(FILE)) throw new Error(`no ${FILE}: run export first`);
  return JSON.parse(readFileSync(FILE, "utf8")) as Doc;
};
const fill = (s: string | null, b: string) => (s ? s.split("${PUBLIC_BASE}").join(b) : s);

const [cmd, flag] = process.argv.slice(2);
if (cmd === "export") {
  const b = process.env.AGATE_PUBLIC_BASE?.replace(/\/$/, "") ?? "";
  const { doc } = await live(b);
  writeFileSync(FILE, JSON.stringify(doc, null, 2) + "\n");
  console.log(`wrote ${FILE}: ${Object.keys(doc.settings).length} settings groups, providers ${doc.providers.join(", ")}, ${doc.webhooks.length} webhook(s), review ${doc.transactionReview.enabled ? "on" : "off"}`);
} else if (cmd === "diff" || cmd === "apply") {
  const b = base();
  const want = fileDoc();
  const { doc, settings, hooks } = await live(b);
  const d = diffs(want, { ...doc, note: want.note });
  console.log(d.length ? d.join("\n") : "no differences");
  if (cmd === "apply") {
    // webhook: the one pointing at /dynamic/webhook follows the file (url with the current base, events, enabled)
    for (const w of want.webhooks) {
      const url = fill(w.url, b)!;
      const h = hooks.find((x) => x.url.endsWith("/dynamic/webhook")) ?? null;
      if (!h) {
        console.log("no live webhook for /dynamic/webhook: create it in the dashboard once (its secret goes to webhook.env)");
        continue;
      }
      if (h.url !== url || h.isEnabled !== w.isEnabled || JSON.stringify([...h.events].sort()) !== JSON.stringify(w.events)) {
        await api("PUT", `/webhooks/${h.webhookId}`, { url, isEnabled: w.isEnabled, events: w.events });
        console.log(`webhook -> ${url}`);
      }
    }
    // Transaction Review: the file's switch, policy and timeout, the URL on the current base, our secret and key
    const t = want.transactionReview;
    const tr = (await api("GET", "/waas/transactionReviewConfig")) as Review;
    const url = fill(t.webhookUrl, b);
    if (tr.enabled !== t.enabled || tr.webhookUrl !== url || tr.webhookFailurePolicy !== t.webhookFailurePolicy || tr.webhookTimeoutMs !== t.webhookTimeoutMs) {
      await api("PUT", "/waas/transactionReviewConfig", {
        enabled: t.enabled,
        webhookUrl: url,
        webhookFailurePolicy: t.webhookFailurePolicy,
        webhookTimeoutMs: t.webhookTimeoutMs,
        webhookSecret: requireSecret("DYNAMIC_REVIEW_SECRET", "review.env"),
        webhookPublicKey: readHomeFile("review-ed25519.pub.pem"),
      });
      console.log(`transaction review -> ${t.enabled ? "on" : "off"} ${t.webhookFailurePolicy} ${url}`);
    }
    // settings: only on request, and only when they differ; live providers are sent back unchanged
    if (flag === "--settings") {
      const sd = diffs(want.settings, doc.settings);
      if (sd.length) {
        const text = JSON.stringify(want.settings);
        if (text.includes(MASK)) throw new Error("the file's settings hold a masked secret: set it in the dashboard, not through this file");
        const body = { ...(JSON.parse(text.split("${PUBLIC_BASE}").join(b)) as object), providers: settings.providers };
        await api("PUT", "", body);
        console.log(`settings: ${sd.length} difference(s) applied`);
      } else console.log("settings: already as the file says");
    }
  }
} else {
  console.log("usage: export | diff | apply [--settings]");
}
process.exit(0);
