// A person's wallets straight from Dynamic's management API, for when their session JWT predates a wallet (the JWT
// lists the wallets that existed at sign-in; the Assistant is usually created after).
import { config, requireSecret } from "../config.ts";
import type { DynamicUser } from "./jwt.ts";

type ApiWallet = { id?: string; name?: string; chain?: string; publicKey?: string; provider?: string };

export async function fetchUserWallets(userId: string, fetcher: typeof fetch = fetch): Promise<ApiWallet[]> {
  const r = await fetcher(`${config.dynamicApi}/environments/${config.environmentId}/users/${encodeURIComponent(userId)}`, {
    headers: { authorization: `Bearer ${requireSecret("DYNAMIC_API_KEY", "api.env")}` },
  });
  if (!r.ok) throw new Error(`Dynamic user lookup failed (${r.status})`);
  const j = (await r.json()) as { user?: { id?: string; wallets?: ApiWallet[] } };
  if (j.user?.id !== userId) throw new Error("Dynamic returned another user");
  return j.user?.wallets ?? [];
}

/** Adds the EVM wallets Dynamic knows for this user to `u.wallets` (in place) and returns it. */
export async function refreshWallets(u: DynamicUser, fetcher?: typeof fetch): Promise<DynamicUser> {
  for (const w of await fetchUserWallets(u.userId, fetcher)) {
    if (!w.publicKey || (w.chain && w.chain.toUpperCase() !== "EVM")) continue;
    u.wallets.set(w.publicKey.toLowerCase(), { id: w.id ?? null, name: w.name ?? null, provider: w.provider ?? null });
  }
  return u;
}
