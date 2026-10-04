// Live probe of Transaction Review on a real delegated signature: registers a "test" intent for the Assistant wallet,
// asks Dynamic to sign its hash, and reports whether Dynamic signed (and our endpoint saw the request) or refused.
// bun run scripts/tr-probe.ts <walletId> [match|nomatch]
import { randomUUID } from "node:crypto";
import { keccak256, toHex, type Hex } from "viem";
import { config } from "../src/config.ts";
import { delegatedAccount } from "../src/dynamic/signer.ts";
import { Store } from "../src/store.ts";

const [walletId, mode = "match"] = process.argv.slice(2);
if (!walletId) throw new Error("usage: tr-probe.ts <walletId> [match|nomatch]");
const store = new Store();
const hash = keccak256(toHex(`agate tr probe ${Date.now()}`)) as Hex;
const del = store.delegation(walletId);
if (!del) throw new Error("no delegation for that wallet");
if (mode === "match") {
  const now = Date.now();
  store.putIntent({ id: randomUUID(), kind: "test", walletId, account: del.address, hash, callData: "0x", grantId: null, createdAt: now, expiresAt: now + config.intentTtlMs });
}
const acct = delegatedAccount(store, walletId, {}, () => Date.now() + 30_000);
const t0 = performance.now();
try {
  const sig = await acct.signMessage({ message: { raw: hash } });
  console.log(JSON.stringify({ mode, signed: true, sigBytes: (sig.length - 2) / 2, ms: Math.round(performance.now() - t0) }));
} catch (e) {
  console.log(JSON.stringify({ mode, signed: false, ms: Math.round(performance.now() - t0), error: (e as Error).message.slice(0, 300) }));
}
console.log("last reviews:", JSON.stringify(store.reviews(3).map((r) => ({ at: new Date(r.at).toISOString().slice(11, 19), type: r.shareSetType, ctx: r.contextKind, proceed: r.proceed, reason: r.reason, ms: r.ms }))));
process.exit(0);
