// The payer bot's Dynamic server wallet (label "payer", TSS-MPC 2-of-2 with Dynamic): create it once, then export
// our half to the file the payer reads with AGATE_PAYER_SIGNER=dynamic (wall/packages/market/src/dynamic-signer.ts).
// The file is mode 600 under AGATE_DYNAMIC_HOME and useless without Dynamic's half and the API token. Prints only
// the address.
//   bun run scripts/payer-wallet.ts create
//   bun run scripts/payer-wallet.ts export [file]      default ~/.agate-dynamic/payer-wallet.json
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, ensureHome, HOME } from "../src/config.ts";
import { createServerWallet } from "../src/dynamic/serverWallet.ts";
import { Store } from "../src/store.ts";

const LABEL = "payer";
const store = new Store();
const [cmd, fileArg] = process.argv.slice(2);

if (cmd === "create") {
  const had = store.serverWallet(LABEL);
  const w = had ? { address: had.address, existed: true } : { ...(await createServerWallet(store, LABEL)), existed: false };
  console.log(JSON.stringify({ label: LABEL, address: w.address, existed: w.existed }));
} else if (cmd === "export") {
  const w = store.serverWallet(LABEL);
  if (!w) throw new Error(`no server wallet ${LABEL}: run create first`);
  const m = w.materials as { walletMetadata: Record<string, unknown>; externalServerKeyShares: unknown[] };
  ensureHome();
  const file = fileArg ?? join(HOME, "payer-wallet.json");
  writeFileSync(file, JSON.stringify({ environmentId: config.environmentId, walletId: w.walletId, address: w.address, walletMetadata: m.walletMetadata, externalServerKeyShares: m.externalServerKeyShares }), { mode: 0o600 });
  chmodSync(file, 0o600); // an existing file keeps its old mode on write
  console.log(JSON.stringify({ label: LABEL, address: w.address, file }));
} else {
  console.log("usage: payer-wallet.ts create | export [file]");
}
