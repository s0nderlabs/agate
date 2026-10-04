// HMAC-SHA256 checks for Dynamic's two signed request kinds. Both sign the raw body bytes with a shared secret:
// event webhooks send `x-dynamic-signature-256: sha256=<hex>`, Transaction Review sends `x-dynamic-signature: <hex>`.
import { createHmac, createPrivateKey, sign, timingSafeEqual, type KeyObject } from "node:crypto";

export type SigCheck = "ok" | "bad" | "no-secret" | "no-header";

export function checkHmac(raw: string, header: string | null | undefined, secret: string | undefined): SigCheck {
  if (!secret) return "no-secret";
  if (!header) return "no-header";
  const want = Buffer.from(createHmac("sha256", secret).update(raw).digest("hex"), "hex");
  const got = Buffer.from(header.replace(/^sha256=/, "").trim(), "hex");
  return got.length === want.length && timingSafeEqual(got, want) ? "ok" : "bad";
}

/** Ed25519 response signing for Transaction Review (Dynamic checks it when a verification key is configured). */
export function ed25519Signer(pem: string | undefined): ((body: string) => string) | null {
  if (!pem) return null;
  const key: KeyObject = createPrivateKey(pem);
  return (body) => sign(null, Buffer.from(body), key).toString("base64");
}
