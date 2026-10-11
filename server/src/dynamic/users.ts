// A person's wallets and passkey account straight from Dynamic's management API: the session JWT the app holds is the
// minified one, without verified credentials, and lists only the wallets that existed at sign-in (the Assistant is
// usually created after).
import { config, requireSecret } from "../config.ts";
import type { DynamicUser } from "./jwt.ts";

type ApiWallet = { id?: string; name?: string; chain?: string; publicKey?: string; provider?: string };
type ApiCredential = { format?: string; public_identifier?: string };
type ApiUser = { id?: string; wallets?: ApiWallet[]; verifiedCredentials?: ApiCredential[] };

async function fetchUser(userId: string, fetcher: typeof fetch): Promise<ApiUser> {
  const r = await fetcher(`${config.dynamicApi}/environments/${config.environmentId}/users/${encodeURIComponent(userId)}`, {
    headers: { authorization: `Bearer ${requireSecret("DYNAMIC_API_KEY", "api.env")}` },
    // a person waits on this at "Confirm it's you"
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`Dynamic user lookup failed (${r.status})`);
  const j = (await r.json()) as { user?: ApiUser };
  if (!j.user || j.user.id !== userId) throw new Error("Dynamic returned another user");
  return j.user;
}

export async function fetchUserWallets(userId: string, fetcher: typeof fetch = fetch): Promise<ApiWallet[]> {
  return (await fetchUser(userId, fetcher)).wallets ?? [];
}

/** The passkey account's sub (its externalUser credential), or null for an email or Google account. */
export async function fetchExternalSub(userId: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  return (await fetchUser(userId, fetcher)).verifiedCredentials?.find((c) => c.format === "externalUser")?.public_identifier ?? null;
}

/** Adds the EVM wallets Dynamic knows for this user to `u.wallets` (in place) and returns it. */
export async function refreshWallets(u: DynamicUser, fetcher?: typeof fetch): Promise<DynamicUser> {
  for (const w of await fetchUserWallets(u.userId, fetcher)) {
    if (!w.publicKey || (w.chain && w.chain.toUpperCase() !== "EVM")) continue;
    u.wallets.set(w.publicKey.toLowerCase(), { id: w.id ?? null, name: w.name ?? null, provider: w.provider ?? null });
  }
  return u;
}
