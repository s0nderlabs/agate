"use client";
// The account seam (wallet spec 2.1): AccountProvider picks the implementation from the Mock controls' data source,
// and useAccount() is the only way a screen reads a wallet fact (signed in, email, address, balance, positions,
// drips) or acts on one. Nothing reads useMock().wallet directly; only the pretend account wraps it.
import { createContext, useContext } from "react";
import { useMock } from "@/lib/mock/store";
import { usePretendAccount } from "./pretend";
import type { Account } from "./types";

export * from "./types";

const AccountCtx = createContext<Account | null>(null);

// ===== SEAM: the real account (build step 5) =====
// The live source's account. Once the wallet packages land (@agate/wallet and the Dynamic SDK, through
// lib/account/dynamic.ts and main.ts), this becomes the real account: useRealAccount(active), inert while the source
// is example (no SDK download, no queries), driving the same sign-in machine against Dynamic and the Kernel main
// account. Until then live uses the pretend account too, over live's own practice wallet (store.tsx keys the two
// wallets apart, so example and live never mix).
function useLiveAccount(pretend: Account): Account {
  return pretend;
}

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const { config } = useMock();
  // both run every render (hooks cannot be picked by a branch), so switching the source never remounts the screens
  const pretend = usePretendAccount();
  const live = useLiveAccount(pretend);
  const account = config.source === "live" ? live : pretend;
  return <AccountCtx.Provider value={account}>{children}</AccountCtx.Provider>;
}

export function useAccount(): Account {
  const a = useContext(AccountCtx);
  if (!a) throw new Error("useAccount outside AccountProvider");
  return a;
}
