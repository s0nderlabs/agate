"use client";
// Add to an AI's pocket, or take back what is left in it (wallet spec 10.4, screen 11). Adding sends test dollars
// from the main account; taking back is the main wallet, as the pocket's owner, moving the pocket's dollars home. One
// operation each, about 6 s live. The sheet cannot close while it runs.
import { useEffect, useState } from "react";
import { useAccount } from "@/lib/account";
import { useAiBackend, useAiRefresh, usePocket } from "@/lib/account/ai";
import { POCKET_COPY } from "@/lib/account/errors";
import { usd0 } from "@/lib/format";
import { parseAmount } from "@/lib/size";
import { Check, Steps } from "./Steps";

/** Whose pocket: a connected AI's, or one a connect run left funded without a connection. */
export interface PocketTarget {
  pocket: string;
  ai: string;
  /** the AI is no longer connected (ended, disconnected, or the connect run stopped) */
  ended?: boolean;
}

const ADD_CHIPS = [250, 500, 1000] as const;

type Run = { step: "form"; message?: string } | { step: "running"; amount: number } | { step: "done"; amount: number } | { step: "failed"; amount: number; message: string };

export function PocketSheet({ target, mode, onMoved, onClose, onLock }: { target: PocketTarget; mode: "add" | "takeBack"; onMoved?: (dollars: number) => void; onClose: () => void; onLock: (locked: boolean) => void }) {
  const account = useAccount();
  const { backend } = useAiBackend();
  const refresh = useAiRefresh();
  const pocket = usePocket(target.pocket);
  const [text, setText] = useState("500");
  const [run, setRun] = useState<Run>({ step: "form" });
  useEffect(() => onLock(run.step === "running"), [run.step, onLock]);
  const left = pocket.data?.balance ?? null;
  const add = mode === "add";
  const amount = add ? (parseAmount(text) ?? 0) : (left ?? 0);
  const over = add && amount > account.balance;

  const go = async (dollars: number) => {
    setRun({ step: "running", amount: dollars });
    try {
      const moved = add ? (await backend.fund(target.pocket, dollars), dollars) : await backend.takeBack(target.pocket);
      setRun({ step: "done", amount: moved });
      // the page that opened the sheet follows at once (a stopped connect run no longer offers a pocket that is empty)
      onMoved?.(moved);
    } catch {
      setRun({ step: "failed", amount: dollars, message: POCKET_COPY.didntMove });
    } finally {
      refresh();
    }
  };

  if (run.step === "done") {
    return (
      <>
        <Check size={44} />
        <h2>{add ? "Added" : "Taken back"}</h2>
        <p>{add ? `${usd0(run.amount)} is in ${target.ai}'s pocket.` : `${usd0(run.amount)} is back in your account.`}</p>
        <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" onClick={onClose}>
          Done
        </button>
      </>
    );
  }
  if (run.step === "running" || run.step === "failed") {
    return (
      <>
        <h2>{add ? `Adding to ${target.ai}'s pocket` : `Taking back ${usd0(run.amount)}`}</h2>
        <p>Moving {usd0(run.amount)} on Monad. About 6 seconds.</p>
        <Steps rows={[{ key: "monad", label: "Waiting for Monad", mark: run.step === "failed" ? "failed" : "current" }]} />
        <div className="ag-slot">
          {run.step === "failed" && (
            <>
              <p className="ag-err" aria-live="polite">
                {run.message}
              </p>
              <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" onClick={() => go(run.amount)}>
                Try again
              </button>
              <button className="ag-btn ag-btn--quiet" type="button" onClick={onClose}>
                Close
              </button>
            </>
          )}
        </div>
      </>
    );
  }

  if (!add) {
    const empty = left !== null && left <= 0;
    return (
      <>
        <h2>{left === null ? "Take back" : `Take back ${usd0(left)}`}</h2>
        <p>{empty ? `${target.ai}'s pocket is empty. Nothing to take back.` : target.ended ? `Moves what's left in ${target.ai}'s pocket to your account.` : `Moves what's left in ${target.ai}'s pocket to your account. ${target.ai} stays connected but can't trade until you add more.`}</p>
        {pocket.isError && <p className="ag-err">Can't read the pocket right now. Try again in a moment.</p>}
        <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" disabled={left === null || empty} onClick={() => left !== null && go(left)}>
          {left === null ? "Reading the pocket" : `Take back ${usd0(left)}`}
        </button>
        <button className="ag-btn ag-btn--quiet" type="button" onClick={onClose}>
          Cancel
        </button>
      </>
    );
  }

  return (
    <form
      className="grid gap-[18px]"
      onSubmit={(e) => {
        e.preventDefault();
        if (amount > 0 && !over) void go(amount);
      }}
    >
      <h2>Add to {target.ai}'s pocket</h2>
      <p>You have {usd0(account.balance)}. {target.ai}'s limits stay the same.</p>
      <div className="grid gap-2">
        <input
          className="ag-input font-display"
          style={{ fontSize: 28 }}
          inputMode="decimal"
          enterKeyHint="done"
          aria-label="Dollars to add"
          aria-invalid={over || undefined}
          aria-describedby="add-msg"
          value={`$${text}`}
          onChange={(e) => setText(e.target.value.replace(/[^0-9.]/g, ""))}
        />
        <div className="ag-chips" role="group" aria-label="Amount">
          {ADD_CHIPS.map((c) => (
            <button key={c} type="button" aria-pressed={amount === c} onClick={() => setText(String(c))}>
              {usd0(c)}
            </button>
          ))}
        </div>
        <p id="add-msg" className="ag-err" aria-live="polite">
          {over ? POCKET_COPY.over(account.balance) : ""}
        </p>
      </div>
      <button className="ag-btn ag-btn--primary ag-btn--lg" type="submit" disabled={!(amount > 0) || over}>
        Move {usd0(amount)}
      </button>
      <button className="ag-btn ag-btn--quiet" type="button" onClick={onClose}>
        Cancel
      </button>
    </form>
  );
}
