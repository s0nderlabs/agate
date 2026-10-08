"use client";
// The account seam (wallet spec 2.1): AccountProvider picks the implementation from the Mock controls' data source
// (example: the pretend account over the example wallet; live, and every build without Mock controls: the real
// account on Dynamic and the Kernel main account), and useAccount() is the only way a screen reads a wallet fact (signed in, email, address, balance, positions,
// drips) or acts on one. Nothing reads useMock().wallet directly; only the pretend account wraps it.
import { createContext, useContext } from "react";
import { useMock } from "@/lib/mock/store";
import { usePretendAccount } from "./pretend";
import { useRealAccount } from "./real";
import type { Account } from "./types";

export * from "./types";

const AccountCtx = createContext<Account | null>(null);

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const { config } = useMock();
  // both run every render (hooks cannot be picked by a branch), so switching the source never remounts the screens;
  // the real one stays inert (no SDK, no reads) while the source is example
  const live = config.source === "live";
  const pretend = usePretendAccount();
  // the real account reads its resting orders on Kuru only while Pro is on (Simple never shows them)
  const real = useRealAccount(live, config.mode === "pro");
  const account = live ? real : pretend;
  return <AccountCtx.Provider value={account}>{children}</AccountCtx.Provider>;
}

export function useAccount(): Account {
  const a = useContext(AccountCtx);
  if (!a) throw new Error("useAccount outside AccountProvider");
  return a;
}
