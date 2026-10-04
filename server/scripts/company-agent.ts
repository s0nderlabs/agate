// The AI company agent (src/company/agent.ts), run by hand or in a tmux loop. Uses the server's market env
// (AGATE_FACTORY, AGATE_DEPLOYMENTS_FILE) and its sealed store.
//   bun run scripts/company-agent.ts create                 make its Dynamic server wallet (label company-agent)
//   bun run scripts/company-agent.ts whoami                 its wallet and smart account
//   bun run scripts/company-agent.ts step [gpu target max ceiling]   one decision (default H100 2 10 9)
//   bun run scripts/company-agent.ts loop [gpu target max ceiling] [minutes]
//   bun run scripts/company-agent.ts journal [n]
import { existsSync, readFileSync } from "node:fs";
import type { Gpu } from "@agate/client";
import type { PublicClient } from "viem";
import { logger, marketClient } from "../src/app.ts";
import { agentAccount, type HedgeRule, hedgeStep, journalFile } from "../src/company/agent.ts";
import { createServerWallet } from "../src/dynamic/serverWallet.ts";
import { Store } from "../src/store.ts";

const LABEL = "company-agent";
const store = new Store();
const [cmd = "whoami", ...rest] = process.argv.slice(2);
const rule = (a: string[]): HedgeRule => ({ gpu: (a[0] ?? "H100") as Gpu, target: Number(a[1] ?? 2), maxPerTrade: Number(a[2] ?? 10), ceiling: Number(a[3] ?? 9) });
const log = logger();

if (cmd === "create") {
  const w = store.serverWallet(LABEL) ? { address: store.serverWallet(LABEL)!.address, existed: true } : { ...(await createServerWallet(store, LABEL)), existed: false };
  console.log(JSON.stringify(w));
} else if (cmd === "whoami") {
  const w = store.serverWallet(LABEL);
  if (!w) throw new Error("no wallet yet: run create");
  const { account } = await agentAccount(store, LABEL, marketClient().pub as PublicClient);
  console.log(JSON.stringify({ serverWallet: w.address, walletId: w.walletId, account: account.address }));
} else if (cmd === "step") {
  const t = performance.now();
  const d = await hedgeStep(store, LABEL, marketClient(), rule(rest), { log });
  console.log(JSON.stringify({ ...d, ms: Math.round(performance.now() - t) }));
} else if (cmd === "loop") {
  const every = Number(rest[4] ?? 10) * 60_000;
  for (;;) {
    try {
      const d = await hedgeStep(store, LABEL, marketClient(), rule(rest), { log });
      log({ event: "company_agent.step", action: d.action, reason: d.reason, txHash: d.txHash ?? null });
    } catch (e) {
      log({ event: "company_agent.error", error: (e as Error).message.slice(0, 300) });
    }
    await new Promise((r) => setTimeout(r, every));
  }
} else if (cmd === "journal") {
  const f = journalFile();
  const lines = existsSync(f) ? readFileSync(f, "utf8").trim().split("\n") : [];
  for (const l of lines.slice(-Number(rest[0] ?? 10))) console.log(l);
} else console.log("usage: create | whoami | step [gpu target max ceiling] | loop [... minutes] | journal [n]");
process.exit(0);
