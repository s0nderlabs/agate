"use client";
// The Account sheet (wallet spec 5.2, screen 4) and its parts, which the phone's More sheet reuses as its signed-in
// head: the balance, the day's test dollars, the main account's address (never the sign-in wallet or the AIs' key),
// the connected AIs, who can sign, and Sign out.
import Link from "next/link";
import { useAccount } from "@/lib/account";
import { useGrants } from "@/lib/account/ai";
import { explorerAddress, isLive, shortAddress } from "@/lib/account/aiView";
import { usd0 } from "@/lib/format";
import { useLinkQuery } from "@/lib/mock/store";
import { Num } from "@/components/num/Num";
import { CopyButton } from "./Copy";
import { DripButton } from "./DripButton";

export function AccountHead() {
  const account = useAccount();
  return (
    <>
      <h2>{usd0(account.balance)}</h2>
      <p>Test dollars, signed in as {account.email}.</p>
      <DripButton />
    </>
  );
}

/** "Your address": the main account, short, with Copy and Monad's explorer. */
export function AddressRow({ label = "Your address" }: { label?: string }) {
  const { address } = useAccount();
  if (!address) return null;
  return (
    <div>
      <span>{label}</span>
      <span className="ag-val">
        <Num>{shortAddress(address)}</Num>
        <CopyButton text={address} what="your address" />
        <a href={explorerAddress(address)} target="_blank" rel="noreferrer">
          Explorer
        </a>
      </span>
    </div>
  );
}

/** The connected AIs in a few words: "Claude", "Claude and ChatGPT", "3 AIs", "None yet". */
export function useAiSummary() {
  const grants = useGrants();
  const live = (grants.data ?? []).filter((g) => isLive(g));
  const names = live.map((g) => g.label);
  const text = grants.isError && !grants.data ? "Can't check right now" : grants.isPending ? "" : names.length === 0 ? "None yet" : names.length <= 2 ? names.join(" and ") : `${names.length} AIs`;
  return { text, active: live.length, loading: grants.isPending };
}

function Chevron() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path d="M4.5 2.5l3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    </svg>
  );
}

/** "Connected AIs": the whole row leads to /ai. */
export function AisRow({ onGo }: { onGo?: () => void }) {
  const q = useLinkQuery();
  const ai = useAiSummary();
  return (
    <Link href={`/ai${q}`} onClick={onGo}>
      <span>Connected AIs</span>
      <span>
        <span className={ai.loading ? "ag-skel ag-skel-on" : undefined}>{ai.loading ? "None yet" : ai.text}</span>
        <Chevron />
      </span>
    </Link>
  );
}

export const SECURED = "Secured by Dynamic. Your account runs on Monad's test network.";
export const SIGN_OUT_NOTE = "Signing out doesn't stop your AIs. Disconnect them in Connected AIs.";

export function AccountSheet({ onClose }: { onClose: () => void }) {
  const account = useAccount();
  const ai = useAiSummary();
  return (
    <>
      <AccountHead />
      <div className="ag-rows" data-tall>
        <AddressRow />
        <div>
          <span>Open positions</span>
          <span>{account.positions.length}</span>
        </div>
        <AisRow onGo={onClose} />
        <div>
          <span>Network fees</span>
          <span>Paid by Agate</span>
        </div>
        <div>
          <span>Who can sign</span>
          <span>{ai.active > 0 ? "You, and your AIs inside their pockets" : "Only you"}</span>
        </div>
      </div>
      <p className="ag-fine">{SECURED}</p>
      {ai.active > 0 && <p className="ag-fine">{SIGN_OUT_NOTE}</p>}
      <button
        className="ag-btn ag-btn--ghost"
        type="button"
        onClick={() => {
          void account.signOut();
          onClose();
        }}
      >
        Sign out
      </button>
      <button className="ag-btn ag-btn--quiet" type="button" onClick={onClose}>
        Close
      </button>
    </>
  );
}
