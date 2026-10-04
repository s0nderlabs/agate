// Node worker for Dynamic server-wallet MPC (the SDK needs Node's native addons; under bun keygen hangs).
// Reads one JSON request on stdin, writes one JSON result on stdout. Secrets travel only over these pipes; the bun
// side seals them in the store. Never run it by hand with real materials on a terminal.
//   { op: "create" }                                     -> { walletMetadata, externalServerKeyShares, ms }
//   { op: "signTransaction", walletMetadata, externalServerKeyShares, transaction, context } -> { signed, ms }
//   { op: "signMessage", walletMetadata, externalServerKeyShares, message, context } -> { signature, ms }
//     (message is a string or { raw: "0x..." }, signed with the EIP-191 prefix, as viem's signMessage does)
import { DynamicEvmWalletClient } from "@dynamic-labs-wallet/node-evm";
import { ThresholdSignatureScheme } from "@dynamic-labs-wallet/node";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const req = JSON.parse(Buffer.concat(chunks).toString("utf8"), (_, v) => (v && typeof v === "object" && v.__bigint ? BigInt(v.__bigint) : v));
const c = new DynamicEvmWalletClient({ environmentId: req.environmentId });
await c.authenticateApiToken(req.apiKey);
const t0 = performance.now();
let out;
if (req.op === "create") {
  const r = await c.createWalletAccount({ thresholdSignatureScheme: ThresholdSignatureScheme.TWO_OF_TWO, backUpToDynamic: false });
  out = { walletMetadata: r.walletMetadata, externalServerKeyShares: r.externalServerKeyShares };
} else if (req.op === "signTransaction") {
  const signed = await c.signTransaction({ walletMetadata: req.walletMetadata, transaction: req.transaction, externalServerKeyShares: req.externalServerKeyShares, context: req.context });
  out = { signed };
} else if (req.op === "signMessage") {
  const signature = await c.signMessage({ walletMetadata: req.walletMetadata, message: req.message, externalServerKeyShares: req.externalServerKeyShares, context: req.context });
  out = { signature };
} else throw new Error(`unknown op ${req.op}`);
out.ms = Math.round(performance.now() - t0);
process.stdout.write(JSON.stringify(out, (_, v) => (typeof v === "bigint" ? { __bigint: v.toString() } : v)));
process.exit(0);
