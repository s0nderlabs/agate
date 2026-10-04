// One-time: creates the Transaction Review request secret (HMAC) and the response-signing key pair (Ed25519) in
// AGATE_DYNAMIC_HOME. Writes the secrets straight to mode-600 files and prints ONLY the public key (it goes into
// Dynamic's "Response Verification Key"). Refuses to overwrite existing files.
// bun run scripts/review-keys.ts
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHome, HOME } from "../src/config.ts";

ensureHome();
const secretFile = join(HOME, "review.env");
const keyFile = join(HOME, "review-ed25519.pem");
const pubFile = join(HOME, "review-ed25519.pub.pem");

if (!existsSync(secretFile)) {
  writeFileSync(secretFile, `DYNAMIC_REVIEW_SECRET=${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  console.log(`wrote ${secretFile} (mode 600)`);
} else console.log(`${secretFile} exists, kept`);

if (!existsSync(keyFile)) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
  writeFileSync(pubFile, publicKey.export({ type: "spki", format: "pem" }).toString(), { mode: 0o644 });
  console.log(`wrote ${keyFile} (mode 600)`);
} else console.log(`${keyFile} exists, kept`);

console.log(`public key for Dynamic:\n${existsSync(pubFile) ? await Bun.file(pubFile).text() : "(missing)"}`);
