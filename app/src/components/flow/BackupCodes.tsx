"use client";
// A passkey account's backup codes: ten one-time codes, each a way back in if the passkey is lost (the sign-in sheet's
// "Use a backup code" makes a new passkey with one). Shown once, as they are made, with Copy, Download and "I saved
// them"; Agate keeps only their hashes, so a code lost here is gone and the answer is a new set.
import { useEffect, useRef, useState } from "react";
import { useAccount } from "@/lib/account";
import { agatePasskeyCode } from "@/lib/account/errors";
import { copyText } from "@/lib/ui/clipboard";
import s from "./backupCodes.module.css";

/** The codes as a text file to keep: what they are and how to use one, then the codes. */
function codesFile(codes: string[], at: Date) {
  const day = at.toISOString().slice(0, 10);
  return [
    "Agate backup codes",
    `Made ${day}. Each code works once.`,
    `If you lose your passkey: open ${window.location.origin}, Sign in, then "Lost your passkey? Use a backup code".`,
    "",
    ...codes,
    "",
  ].join("\n");
}

/** Makes a new set as it shows (at "You're set", or when the Account sheet asks for new ones). onDone: "I saved
 *  them". primary: that button is the way on (at "You're set", so nobody leaves before the codes are saved);
 *  onFailedChange: whether there are no codes to show right now, so the place showing them offers its own way on.
 *  onCancel: a way out when they couldn't be made. */
export function BackupCodes({ onDone, primary = false, onFailedChange, onCancel }: { onDone?: () => void; primary?: boolean; onFailedChange?: (failed: boolean) => void; onCancel?: () => void }) {
  const account = useAccount();
  const [codes, setCodes] = useState<string[] | null>(null);
  // why the codes weren't made: the passkey that confirms a new set was not used (the old codes still work), or
  // anything else
  const [failed, setFailed] = useState<"cancelled" | "other" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const asked = useRef(false);
  // one request at a time: a second set would replace the first, so "Try again" waits for a slow one to settle
  const [busy, setBusy] = useState(false);
  const slow = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(slow.current), []);
  const fail = (why: "cancelled" | "other") => {
    setFailed(why);
    onFailedChange?.(true);
  };
  const make = () => {
    setFailed(null);
    setBusy(true);
    // the way on never waits on a hung request: past 20 s it reads as not made (codes that land later still show)
    if (primary) slow.current = window.setTimeout(() => fail("other"), 20_000);
    account.makeBackupCodes().then(
      (c) => {
        window.clearTimeout(slow.current);
        setBusy(false);
        setFailed(null);
        setCodes(c);
        onFailedChange?.(false);
      },
      (e) => {
        window.clearTimeout(slow.current);
        setBusy(false);
        fail(agatePasskeyCode(e) === "cancelled" ? "cancelled" : "other");
      },
    );
  };
  // a closed passkey dialog leaves the old codes as they were, if there are any
  const left = account.backupCodes?.left;
  // once per showing: a second set would quietly replace the first
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    make();
  }, []);

  if (saved)
    return (
      <p className="ag-fine" role="status">
        Backup codes saved. You can make new ones from your account.
      </p>
    );
  if (failed)
    return (
      <div className={s.box}>
        <p className="ag-err" role="alert">
          {failed === "other"
            ? "Your backup codes couldn't be made right now."
            : (left ?? 0) > 0
              ? "Your passkey didn't confirm it, so your old codes still work."
              : "Your passkey didn't confirm it, so no new codes were made."}
        </p>
        <div className={s.acts}>
          <button className="ag-btn ag-btn--ghost" type="button" disabled={busy} onClick={make}>
            Try again
          </button>
          {onCancel && (
            <button className="ag-btn ag-btn--quiet" type="button" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </div>
    );
  if (!codes)
    return (
      <div className={s.box} aria-busy="true">
        <ol className={s.list} aria-hidden="true">
          {Array.from({ length: 10 }, (_, i) => (
            <li key={i}>
              <span className="ag-skel ag-skel-on">XXXX-XXXX</span>
            </li>
          ))}
        </ol>
      </div>
    );

  const say = (text: string) => {
    setNote(text);
    window.setTimeout(() => setNote((n) => (n === text ? null : n)), 2_000);
  };
  const copy = async () => say((await copyText(codes.join("\n"))) ? "Copied" : "Couldn't copy. Select them instead.");
  const download = () => {
    const url = URL.createObjectURL(new Blob([codesFile(codes, new Date())], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "agate-backup-codes.txt";
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    say("Downloaded");
  };
  return (
    <div className={s.box}>
      <ol className={s.list} aria-label="Your backup codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ol>
      <div className={s.acts}>
        <button className="ag-btn ag-btn--ghost" type="button" onClick={() => void copy()}>
          Copy
        </button>
        <button className="ag-btn ag-btn--ghost" type="button" onClick={download}>
          Download
        </button>
        <span className={s.note} role="status">
          {note}
        </span>
      </div>
      <button
        className={primary ? "ag-btn ag-btn--primary ag-btn--lg" : "ag-btn ag-btn--quiet"}
        type="button"
        onClick={() => {
          setSaved(true);
          onDone?.();
        }}
      >
        I saved them
      </button>
    </div>
  );
}
