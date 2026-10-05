"use client";
// "Get 10,000 test dollars" (wallet spec 5.4), shared by the Account sheet, More, the Positions head and the AI pages:
// busy while the drip runs, and once today's is taken, disabled with the next time in UTC and how long until then.
// The balance changes only when the drip lands (no optimistic number). useDrip is the same run for the other ways in
// (the notice bar, the Pro account box, the Get test dollars sheet): it checks the day's drip, waits for it to land
// and says why when it doesn't.
import { useCallback, useRef, useState } from "react";
import { useAccount } from "@/lib/account";
import { COPY, dripRefusal } from "@/lib/account/errors";
import { DRIP } from "@/lib/account/types";
import { countdown } from "@/lib/data/derive";
import { int } from "@/lib/format";
import { useNow } from "@/lib/ui/useNow";

/** Whether the day's drip is open now: the account's own flag, or its next time already passed (a flag read a while
 *  ago goes stale while the page stays open). */
export function dripOpen(a: { canDrip: boolean; nextDrip: string | null }, now = Date.now()) {
  return a.canDrip || (a.nextDrip !== null && now >= Date.parse(a.nextDrip));
}

/** One drip: refused before it is sent when today's is taken, awaited, and its refusal in plain words. */
export function useDrip() {
  const account = useAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const run = useCallback(async (): Promise<boolean> => {
    if (running.current) return false;
    if (!dripOpen(account)) {
      setError(account.nextDrip ? COPY.dripArrive(account.nextDrip) : "Your next test dollars aren't ready yet.");
      return false;
    }
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await account.drip();
      return true;
    } catch (e) {
      setError(dripRefusal(e).message);
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [account]);
  return { run, busy, error };
}

export function DripButton({ lg = true, className = "", onLanded }: { lg?: boolean; className?: string; onLanded?: () => void }) {
  const account = useAccount();
  const { run: drip, busy, error } = useDrip();
  const later = !account.canDrip && !!account.nextDrip;
  const now = useNow(30_000, later);
  // the wait is over once the next time passes, even before the account reads its flag again
  const waiting = later && !dripOpen(account, now);
  const size = lg ? "ag-btn--lg" : "";
  if (waiting) {
    const left = countdown(account.nextDrip, now);
    return (
      <div className={`grid gap-1.5 ${className}`}>
        <button type="button" className={`ag-btn ag-btn--primary ${size}`} disabled>
          {COPY.dripNext(account.nextDrip!)}
        </button>
        <p className="ag-fine">{left ? `In ${left}.` : "Any minute now."}</p>
      </div>
    );
  }
  const run = async () => {
    if (await drip()) onLanded?.();
  };
  return (
    <div className={`grid gap-1.5 ${className}`}>
      <button type="button" className={`ag-btn ag-btn--primary ${size}`} onClick={run} disabled={busy || !account.ready}>
        {busy ? (
          <>
            <span className="ag-spinner" aria-hidden="true" />
            Getting your test dollars
          </>
        ) : (
          `Get ${int(DRIP)} test dollars`
        )}
      </button>
      {error && (
        <p className="ag-err" aria-live="polite">
          {error}
        </p>
      )}
    </div>
  );
}
