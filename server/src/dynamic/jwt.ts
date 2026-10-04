// A person's Dynamic session JWT, verified against Dynamic's JWKS for this environment (RS256). The claims give the
// user id and the wallets Dynamic verified for that user (embedded wallets included), which is how agate knows a
// main wallet or an Assistant really belongs to whoever is calling.
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import type { Address } from "viem";

export type DynamicUser = {
  userId: string;
  email: string | null;
  /** lowercase address -> the wallet's Dynamic id (the walletId webhooks and delegation use), when present */
  wallets: Map<string, { id: string | null; name: string | null; provider: string | null }>;
  scopes: string[];
};

type Credential = { address?: string; chain?: string; id?: string; wallet_name?: string; wallet_provider?: string; format?: string; email?: string };

export function jwtVerifier(environmentId: string, opts: { jwksUrl?: string; now?: () => number } = {}) {
  const jwks = createRemoteJWKSet(new URL(opts.jwksUrl ?? `https://app.dynamicauth.com/api/v0/sdk/${environmentId}/.well-known/jwks`), { cooldownDuration: 60_000, cacheMaxAge: 3_600_000 });
  return async (token: string): Promise<DynamicUser> => {
    const { payload } = await jwtVerify(token, jwks, { algorithms: ["RS256"], currentDate: opts.now ? new Date(opts.now()) : undefined });
    return toUser(payload, environmentId);
  };
}

export function toUser(p: JWTPayload & Record<string, unknown>, environmentId: string): DynamicUser {
  const env = (p.environment_id ?? p.environmentId) as string | undefined;
  if (env && env !== environmentId) throw new Error("token is for another Dynamic environment");
  if (!p.sub) throw new Error("token has no subject");
  const creds = (p.verified_credentials ?? []) as Credential[];
  const wallets = new Map<string, { id: string | null; name: string | null; provider: string | null }>();
  let email: string | null = (p.email as string) ?? null;
  for (const c of creds) {
    if (c.format === "blockchain" && c.address && (c.chain ?? "eip155").toLowerCase().includes("eip155")) {
      wallets.set(c.address.toLowerCase(), { id: c.id ?? null, name: c.wallet_name ?? null, provider: c.wallet_provider ?? null });
    }
    if (c.format === "email" && c.email && !email) email = c.email;
  }
  const scopes = typeof p.scope === "string" ? p.scope.split(" ") : Array.isArray(p.scopes) ? (p.scopes as string[]) : [];
  return { userId: p.sub, email, wallets, scopes };
}

export function owns(u: DynamicUser, address: Address): boolean {
  return u.wallets.has(address.toLowerCase());
}
