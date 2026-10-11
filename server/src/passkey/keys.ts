// The key agate signs passkey sign-ins with (Dynamic's Bring Your Own Auth). Once a passkey checks out, agate hands
// the app a JWT that lives two minutes; the app gives it to Dynamic, which checks it against the public key served
// at /.well-known/agate-jwks.json and opens a normal session for that sub. The private key is HOME/byoa-es256.pem,
// made on first use with mode 600 and never printed or logged. Losing it is harmless: the next key is served at the
// same address, and accounts are keyed by sub, not by the key.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { calculateJwkThumbprint, importPKCS8, type JWK, SignJWT } from "jose";
import { ensureHome, HOME } from "../config.ts";

/** what Dynamic's externalAuth settings name as the issuer: a constant, never the server's (changing) host */
export const BYOA_ISS = process.env.AGATE_BYOA_ISS ?? "https://agate.elpabl0.xyz";
export const BYOA_TTL_S = 120;

export type ByoaKeys = {
  jwks(): Promise<{ keys: JWK[] }>;
  /** a sign-in token for sub, or one step-up scope for sub; each with a fresh jti (Dynamic takes each once) */
  sign(sub: string, scope?: string): Promise<{ jwt: string; expiresAt: number }>;
};

function readOrCreate(home: string): string {
  const f = join(home, "byoa-es256.pem");
  if (!existsSync(f)) {
    if (home === HOME) ensureHome();
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    try {
      writeFileSync(f, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
    } catch (e) {
      // two first uses at once: the other one's file wins
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  return readFileSync(f, "utf8");
}

/** `aud`: what Dynamic's externalAuth settings name as the audience (the Dynamic environment id) */
export function byoaKeys(opts: { aud: string; home?: string; pem?: () => string; iss?: string; now?: () => number }): ByoaKeys {
  const now = opts.now ?? Date.now;
  let loaded: Promise<{ key: CryptoKey; jwk: JWK }> | undefined;
  const load = () =>
    (loaded ??= (async () => {
      const pem = opts.pem?.() ?? readOrCreate(opts.home ?? HOME);
      const pub = createPublicKey(createPrivateKey(pem)).export({ format: "jwk" });
      if (pub.kty !== "EC" || pub.crv !== "P-256") throw new Error("the passkey sign-in key is not P-256");
      const jwk: JWK = { kty: "EC", crv: "P-256", x: pub.x, y: pub.y };
      return { key: await importPKCS8(pem, "ES256"), jwk: { ...jwk, kid: await calculateJwkThumbprint(jwk), alg: "ES256", use: "sig" } };
    })().catch((e) => {
      loaded = undefined;
      throw e;
    }));
  return {
    jwks: async () => ({ keys: [(await load()).jwk] }),
    async sign(sub, scope) {
      const { key, jwk } = await load();
      const iat = Math.floor(now() / 1000);
      const jwt = await new SignJWT(scope ? { scope } : {})
        .setProtectedHeader({ alg: "ES256", kid: jwk.kid!, typ: "JWT" })
        .setIssuer(opts.iss ?? BYOA_ISS)
        .setAudience(opts.aud)
        .setSubject(sub)
        .setIssuedAt(iat)
        .setExpirationTime(iat + BYOA_TTL_S)
        .setJti(randomUUID())
        .sign(key);
      return { jwt, expiresAt: (iat + BYOA_TTL_S) * 1000 };
    },
  };
}
