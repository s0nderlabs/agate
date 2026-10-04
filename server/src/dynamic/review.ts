// Transaction Review: Dynamic asks us before it signs anything in this environment (every embedded wallet, every
// share set), and blocks the signature when we say no (or when we cannot be reached, under failure policy DENY).
//
// The rules:
// - rootUser (a person signing in their own browser): allowed. Their own wallet, their own consent; the browser's
//   smart-account user operations arrive as a bare hash anyway (no Dynamic SDK attaches evmUserOperation context).
// - delegated (agate signing with a user's delegated Assistant wallet): allowed ONLY when it matches an intent the
//   server registered moments before (same wallet, same hash; and when Dynamic forwards the user operation, the same
//   sender and callData, which must also pass the pocket's allowed-call list again), for a grant that is still
//   alive. Everything else, including any plain message, is denied.
// - server (agate's own server wallets, e.g. the payer): allowed only against a registered intent.
// - anything else: denied.
// The decision never depends on request-controlled text being echoed back: reasons are fixed strings.
import { type Address, type Hex, hashMessage, isHex } from "viem";
import { checkPocketCalls, decodeKernelCalls, type PocketLimits } from "@agate/wallet/allowed";
import type { GrantRow, IntentRow, Store } from "../store.ts";

export type ReviewRequest = {
  environmentId?: string;
  walletId?: string;
  userId?: string;
  shareSetType?: string;
  message?: string;
  context?: {
    evmTransaction?: { chainId?: number | string; to?: string; data?: string; value?: string };
    evmUserOperation?: { chainId?: number | string; sender?: string; callData?: string; entryPoint?: string; operation?: unknown };
    evmTypedData?: unknown;
    evmMessage?: unknown;
    [k: string]: unknown;
  };
};

export type Decision = { proceed: boolean; reason: string; intentId: string | null; contextKind: string | null };

export type ReviewDeps = {
  store: Store;
  environmentId: string;
  chainId: number;
  /** the pocket limits of a grant (from config + grant row) */
  limitsOf: (g: GrantRow) => PocketLimits;
  /** wallet ids of agate's own server wallets */
  serverWallets: () => Set<string>;
  now?: () => number;
};

const lower = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : "");

/** The forms a signed userOp hash can take in `message`: the hash itself, its EIP-191 digest, or its hex text. */
export function messageMatches(message: string | undefined, hash: Hex): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  const h = hash.toLowerCase() as Hex;
  if (m === h || m === h.slice(2)) return true;
  if (m === hashMessage({ raw: h }).toLowerCase()) return true;
  // the hash passed as text and hex-encoded
  if (isHex(m) && m.length === 2 + 66 * 2) {
    try {
      if (Buffer.from(m.slice(2), "hex").toString("utf8").toLowerCase() === h) return true;
    } catch {
      // not text
    }
  }
  return false;
}

function contextKind(req: ReviewRequest): string | null {
  const c = req.context;
  if (!c || typeof c !== "object") return null;
  const k = Object.keys(c).filter((x) => (c as Record<string, unknown>)[x] != null);
  return k.length ? k.join(",") : null;
}

export function decide(req: ReviewRequest, d: ReviewDeps): Decision {
  const now = d.now?.() ?? Date.now();
  const kind = contextKind(req);
  const deny = (reason: string, intentId: string | null = null): Decision => ({ proceed: false, reason, intentId, contextKind: kind });
  const allow = (reason: string, intentId: string | null = null): Decision => ({ proceed: true, reason, intentId, contextKind: kind });

  if (req.environmentId && req.environmentId !== d.environmentId) return deny("wrong environment");
  const chain = req.context?.evmUserOperation?.chainId ?? req.context?.evmTransaction?.chainId;
  if (chain !== undefined && Number(chain) !== d.chainId) {
    // only agate's own signers are bound to Monad testnet; a person may sign elsewhere
    if (req.shareSetType !== "rootUser") return deny("agate signs only on Monad testnet");
  }

  switch (req.shareSetType) {
    case "rootUser":
      return allow("the user's own signature");
    case "delegated":
      return delegated(req, d, now, allow, deny);
    case "server": {
      if (!req.walletId || !d.serverWallets().has(req.walletId)) return deny("not an agate server wallet");
      return matchIntent(req, d, now, null, allow, deny);
    }
    default:
      return deny("signer type not allowed");
  }
}

function delegated(req: ReviewRequest, d: ReviewDeps, now: number, allow: (r: string, i?: string | null) => Decision, deny: (r: string, i?: string | null) => Decision): Decision {
  if (!req.walletId) return deny("no wallet id");
  const del = d.store.delegation(req.walletId);
  if (!del || del.status !== "active") return deny("no active delegation for this wallet");
  return matchIntent(req, d, now, del.address, allow, deny);
}

function matchIntent(
  req: ReviewRequest,
  d: ReviewDeps,
  now: number,
  _signer: Address | null,
  allow: (r: string, i?: string | null) => Decision,
  deny: (r: string, i?: string | null) => Decision,
): Decision {
  const intents = d.store.liveIntents(req.walletId!, now);
  const hit: IntentRow | undefined = intents.find((i) => messageMatches(req.message, i.hash));
  if (!hit) return deny(intents.length ? "signature does not match what agate built" : "nothing pending for this wallet");

  const op = req.context?.evmUserOperation;
  if (op) {
    // Dynamic's own test payload nests sender and callData under `operation`; its docs show them top level
    const inner = (op.operation ?? {}) as { sender?: string; callData?: string };
    const sender = op.sender ?? inner.sender;
    const callData = op.callData ?? inner.callData;
    if (sender && lower(sender) !== lower(hit.account)) return deny("user operation sender differs from what agate built", hit.id);
    if (callData && lower(callData) !== lower(hit.callData)) return deny("user operation calls differ from what agate built", hit.id);
  }
  const tx = req.context?.evmTransaction;
  if (tx?.data && lower(tx.data) !== lower(hit.callData)) return deny("transaction data differs from what agate built", hit.id);

  if (hit.grantId) {
    const g = d.store.grant(hit.grantId);
    if (!g || g.status !== "active") return deny("the AI's permission is no longer active", hit.id);
    if (g.expiresAt <= now) return deny("the AI's permission has expired", hit.id);
    if (hit.kind === "pocket-trade") {
      const calls = decodeKernelCalls(hit.callData);
      if (!calls) return deny("not a plain call or batch", hit.id);
      const c = checkPocketCalls(calls, d.limitsOf(g));
      if (!c.ok) return deny(`outside the pocket's limits: ${c.rule}`, hit.id);
    }
  }
  d.store.markReviewed(hit.id);
  return allow(`matches ${hit.kind}`, hit.id);
}
