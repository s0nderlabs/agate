// Dynamic's event webhooks (one endpoint, every event this environment subscribes to). Verified by HMAC
// (x-dynamic-signature-256) before anything is parsed; deliveries are idempotent by messageId (Dynamic retries).
//  - wallet.delegation.created: decrypt the delegated key share + wallet API key with our RSA key and keep them
//    sealed in the store. Nothing about them is ever logged.
//  - wallet.delegation.revoked: drop the materials and end every AI permission that relied on that wallet.
//  - wallet.delegation.signature: Dynamic's own audit record of each delegated signature, kept for the activity feed.
//  - waas.transaction.review.approved / denied and anything else: kept as events (names and ids only).
import { decryptDelegatedWebhookData } from "@dynamic-labs-wallet/node";
import type { Address } from "viem";
import { endGrant } from "../grants.ts";
import type { Store } from "../store.ts";
import { checkHmac } from "./hmac.ts";

export type WebhookDeps = {
  store: Store;
  secret: () => string | undefined;
  rsaPrivateKeyPem: () => string | undefined;
  log: (entry: Record<string, unknown>) => void;
};

export type WebhookResult = { status: number; body: Record<string, unknown> };

export function handleWebhook(raw: string, signature: string | null, d: WebhookDeps): WebhookResult {
  const sig = checkHmac(raw, signature, d.secret());
  if (sig !== "ok") {
    // no secret configured is a setup error, not an open door
    d.log({ event: "webhook.rejected", sig, bytes: raw.length });
    return { status: 401, body: { error: "bad signature" } };
  }
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: "bad json" } };
  }
  const name: string = body.eventName ?? body.event ?? "unknown";
  const data = body.data ?? {};
  const userId: string | null = body.userId ?? data.userId ?? null;
  const walletId: string | null = data.walletId ?? null;
  const address: string | undefined = data.publicKey ?? data.accountAddress ?? data.address;
  const meta = { event: name, messageId: body.messageId, userId, walletId, address, chain: data.chain };

  if (!d.store.firstSight(body.messageId)) {
    d.log({ ...meta, duplicate: true });
    return { status: 200, body: { ok: true, duplicate: true } };
  }

  const handleEvent = (): WebhookResult => {
    switch (name) {
      case "wallet.delegation.created": {
        const pem = d.rsaPrivateKeyPem();
        if (!pem) {
          d.log({ ...meta, decrypted: false, error: "no RSA private key" });
          return { status: 500, body: { error: "not configured" } };
        }
        try {
          const { decryptedDelegatedShare, decryptedWalletApiKey } = decryptDelegatedWebhookData({
            privateKeyPem: pem,
            encryptedDelegatedKeyShare: data.encryptedDelegatedShare,
            encryptedWalletApiKey: data.encryptedWalletApiKey,
          });
          d.store.putDelegation(
            { walletId: data.walletId, userId, address: address as Address, chain: data.chain ?? null, shareSetId: data.shareSetId ?? null },
            { walletApiKey: decryptedWalletApiKey, keyShare: decryptedDelegatedShare },
          );
          d.store.event({ source: "dynamic", name, userId, walletId, detail: { address, chain: data.chain, shareSetId: data.shareSetId } });
          d.log({ ...meta, decrypted: true });
        } catch (e) {
          d.log({ ...meta, decrypted: false, error: (e as Error).message });
          return { status: 500, body: { error: "decrypt failed" } };
        }
        break;
      }
      case "wallet.delegation.revoked": {
        const had = walletId ? d.store.revokeDelegation(walletId) : false;
        const ended: string[] = [];
        if (walletId) {
          for (const g of d.store.grantsOfAssistant(walletId)) {
            if (g.status === "active" || g.status === "pending") {
              endGrant(d.store, g.id);
              ended.push(g.id);
            }
          }
        }
        d.store.event({ source: "dynamic", name, userId, walletId, detail: { address, hadMaterials: had, grantsEnded: ended } });
        d.log({ ...meta, hadMaterials: had, grantsEnded: ended.length });
        break;
      }
      case "wallet.delegation.signature": {
        const ctx = data.context ?? null;
        d.store.event({
          source: "dynamic",
          name,
          userId,
          walletId,
          detail: { address, message: typeof data.message === "string" ? data.message : null, contextKinds: ctx && typeof ctx === "object" ? Object.keys(ctx) : [] },
        });
        d.log({ ...meta, contextKinds: ctx && typeof ctx === "object" ? Object.keys(ctx) : [] });
        break;
      }
      default:
        d.store.event({ source: "dynamic", name, userId, walletId, detail: { dataKeys: Object.keys(data) } });
        d.log({ ...meta, dataKeys: Object.keys(data) });
    }
    return { status: 200, body: { ok: true } };
  };

  let r: WebhookResult;
  try {
    r = handleEvent();
  } catch (e) {
    d.log({ ...meta, error: (e as Error).message });
    r = { status: 500, body: { error: "handling failed" } };
  }
  // a failed delivery is not "seen": Dynamic retries it with the same messageId, and that retry must be handled
  if (r.status !== 200) d.store.forgetSight(body.messageId);
  return r;
}
