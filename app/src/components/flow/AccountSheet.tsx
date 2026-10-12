"use client";
// The Account sheet (wallet spec 5.2, screen 4) and its parts, which the phone's More sheet reuses as its signed-in
// head: the balance, the day's test dollars, the main account's address (never the sign-in wallet or the AIs' key),
// the connected AIs, a passkey for next time, who can sign, and Sign out.
import Link from "next/link";
import { useState } from "react";
import { useAccount } from "@/lib/account";
import { useGrants } from "@/lib/account/ai";
import { explorerAddress, isLive, shortAddress } from "@/lib/account/aiView";
import { addPasskeyProblemOf, codeProblemOf, codeProblemText, SIGNIN_COPY } from "@/lib/account/errors";
import { isCode } from "@/lib/account/machine";
import { usd0 } from "@/lib/format";
import { useLinkQuery } from "@/lib/mock/store";
import { usePasskeySupport } from "@/lib/ui/hooks";
import { Num } from "@/components/num/Num";
import { CopyButton } from "./Copy";
import { BackupCodes } from "./BackupCodes";
import { DripButton } from "./DripButton";

export function AccountHead() {
  const account = useAccount();
  return (
    <>
      <h2>{usd0(account.balance)}</h2>
      <p>{account.email ? `Test dollars, signed in as ${account.email}.` : account.passkeyAccount ? "Test dollars, signed in with your passkey." : "Test dollars."}</p>
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

/** Adding a passkey (the browser's own dialog), shared by the Account sheet's row and the offer at "You're set". When
 *  Dynamic first wants "Confirm it's you" (after Google, a passkey, or a while after the code), a code goes to the
 *  email and `phase` turns to "code" until it is entered. */
export function usePasskeyAdd() {
  const account = useAccount();
  const [phase, setPhase] = useState<"idle" | "adding" | "code" | "checking">("idle");
  const [code, setCode] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const add = async (withCode?: string) => {
    setPhase(withCode === undefined ? "adding" : "checking");
    setNote(null);
    try {
      if ((await account.addPasskey(withCode)) === "code") {
        setCode("");
        setPhase("code");
        return;
      }
      setNote({ ok: true, text: PASSKEY_ADDED });
      setPhase("idle");
    } catch (e) {
      const refused = (e as Error)?.name === "PasskeyCodeError";
      // a refused code keeps the code step; anything else goes back to the row (a code already used is not asked again)
      setNote({ ok: false, text: refused ? codeProblemText(codeProblemOf((e as Error).cause)) : SIGNIN_COPY[addPasskeyProblemOf(e)] });
      setPhase(refused ? "code" : "idle");
    }
  };
  const cancel = () => {
    setPhase("idle");
    setNote(null);
  };
  return { phase, code, setCode, note, add, cancel, busy: phase === "adding" || phase === "checking" };
}

/** Said once a passkey is added: how to use it, and the way out if it is ever lost (a lost passkey has no reset here). */
export const PASSKEY_ADDED = "Passkey added. Next time, choose Sign in with a passkey. If you ever lose it, ask us to reset your account.";

/** The code Dynamic asks for before a passkey can be added. */
export function PasskeyCodeForm({ adder }: { adder: ReturnType<typeof usePasskeyAdd> }) {
  const account = useAccount();
  const { code, setCode, note, add, cancel, busy } = adder;
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (isCode(code) && !busy) void add(code);
      }}
    >
      <p className="ag-fine">To add a passkey, enter the 6-digit code we just sent to {account.email}.</p>
      <input
        className="ag-input ag-code"
        aria-label="6-digit code"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="one-time-code"
        enterKeyHint="done"
        readOnly={busy}
        aria-invalid={(!!note && !note.ok) || undefined}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
      />
      {note && (
        <p className="ag-err" role="status">
          {note.text}
        </p>
      )}
      <button className="ag-btn ag-btn--primary" type="submit" disabled={busy || !isCode(code)}>
        {busy ? (
          <>
            <span className="ag-spinner" aria-hidden="true" />
            Adding
          </>
        ) : (
          "Add passkey"
        )}
      </button>
      <button className="ag-btn ag-btn--quiet" type="button" disabled={busy} onClick={cancel}>
        Cancel
      </button>
    </form>
  );
}

/** "Passkey": add one so "Sign in with a passkey" works next time, or Added. The code Dynamic may ask for first goes
 *  under the rows. Nothing where the browser has no passkeys. The row goes in the rows and its note under them, so
 *  they come back apart. */
export function usePasskeyRow() {
  const account = useAccount();
  const supported = usePasskeySupport();
  const adder = usePasskeyAdd();
  // backup codes (a passkey account's): closed, asking before new ones replace the old, or showing a new set
  const [codes, setCodes] = useState<"closed" | "confirm" | "new">("closed");
  if (!supported || !account.ready) return { row: null, note: null };
  // an account made with a passkey: that passkey is its way in, and Dynamic's own passkeys are not added to it; its
  // backup codes are the way back in if the passkey is lost
  if (account.passkeyAccount) {
    const b = account.backupCodes;
    // codes that may still work (or a count that couldn't be read): replacing them asks first, the passkey confirms it
    const made = !!b && (b.left === null || b.left > 0);
    const passkeyRow = (
      <div>
        <span>Passkey</span>
        <span>Your way in</span>
      </div>
    );
    if (!account.backupCodesOn) return { row: passkeyRow, note: null };
    const value =
      b === null ? (
        <span className="ag-skel ag-skel-on">8 left</span>
      ) : (
        <span className="ag-val">
          {b.left === null ? "Couldn't check" : made ? `${b.left} left` : "None"}
          {codes === "closed" && (
            <button className="ag-textbtn" type="button" onClick={() => setCodes(made ? "confirm" : "new")}>
              {made ? "Make new codes" : "Make backup codes"}
            </button>
          )}
        </span>
      );
    return {
      row: (
        <>
          {passkeyRow}
          <div>
            <span>Backup codes</span>
            {value}
          </div>
        </>
      ),
      note:
        codes === "confirm" ? (
          <div className="grid gap-2" role="group" aria-label="Make new backup codes">
            <p>New codes replace your old ones, and the old ones stop working. Your passkey confirms it.</p>
            <div className="flex flex-wrap gap-2">
              <button className="ag-btn ag-btn--ghost" type="button" onClick={() => setCodes("new")}>
                Make new codes
              </button>
              <button className="ag-btn ag-btn--quiet" type="button" onClick={() => setCodes("closed")}>
                Cancel
              </button>
            </div>
          </div>
        ) : codes === "new" ? (
          <BackupCodes onDone={() => setCodes("closed")} onCancel={() => setCodes("closed")} />
        ) : null,
    };
  }
  const { phase, note, add, busy } = adder;
  const n = account.passkeys;
  if (phase === "code" || phase === "checking") {
    return {
      row: (
        <div>
          <span>Passkey</span>
          <span>Confirm it's you</span>
        </div>
      ),
      note: <PasskeyCodeForm adder={adder} />,
    };
  }
  const value = busy ? (
    <button className="ag-textbtn" type="button" disabled>
      <span className="ag-spinner" aria-hidden="true" />
      Adding
    </button>
  ) : n === null ? (
    <span className="ag-skel ag-skel-on">Added</span>
  ) : n > 0 ? (
    // a passkey lives on one device (or one password manager): another device needs its own
    <span className="ag-val">
      Added
      <button className="ag-textbtn" type="button" onClick={() => void add()}>
        Add another
      </button>
    </span>
  ) : (
    <button className="ag-textbtn" type="button" onClick={() => void add()}>
      Add a passkey
    </button>
  );
  return {
    row: (
      <div>
        <span>Passkey</span>
        {value}
      </div>
    ),
    note: note && (
      <p className={note.ok ? "ag-fine" : "ag-err"} role="status">
        {note.text}
      </p>
    ),
  };
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
    <Link href={`/app/ai${q}`} onClick={onGo}>
      <span>Connected AIs</span>
      <span>
        <span className={ai.loading ? "ag-skel ag-skel-on" : undefined}>{ai.loading ? "None yet" : ai.text}</span>
        <Chevron />
      </span>
    </Link>
  );
}

/** One of More's links on phones and tablets, for the places their top bar has no room for (Docs, How it works). */
export function PlaceRow({ href, label, onGo }: { href: string; label: string; onGo?: () => void }) {
  const q = useLinkQuery();
  return (
    <Link href={`${href}${q}`} onClick={onGo}>
      <span>{label}</span>
      <span>
        <Chevron />
      </span>
    </Link>
  );
}

/** "Docs": More's way to the docs. */
export const DocsRow = ({ onGo }: { onGo?: () => void }) => <PlaceRow href="/docs" label="Docs" onGo={onGo} />;

export const SECURED = "Secured by Dynamic. Your account runs on Monad's test network.";
export const SIGN_OUT_NOTE = "Signing out doesn't stop your AIs. Disconnect them in Connected AIs.";

export function AccountSheet({ onClose }: { onClose: () => void }) {
  const account = useAccount();
  const ai = useAiSummary();
  const passkey = usePasskeyRow();
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
        {passkey.row}
        <div>
          <span>Network fees</span>
          <span>Paid by Agate</span>
        </div>
        <div>
          <span>Who can sign</span>
          <span>{ai.active > 0 ? "You, and your AIs inside their pockets" : "Only you"}</span>
        </div>
      </div>
      {passkey.note}
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
