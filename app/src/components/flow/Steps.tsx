"use client";
// The step list (wallet spec 4.5) shared by setting up an account, placing an order, connecting an AI, the pocket
// sheet and disconnecting: one row per real call, its mark from the machine (machine.ts StepMark). The current row's
// label is read out as it changes.
import type { StepMark } from "@/lib/account/machine";

export interface StepRow {
  key: string;
  label: string;
  hint?: string;
  mark: StepMark;
}

export function Check({ size = 20 }: { size?: number }) {
  return (
    <svg className="ag-done" viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <circle cx="24" cy="24" r="22" />
      <path d="M14 24.5l7 7 13-14" />
    </svg>
  );
}

const SPOKEN: Record<StepMark, string> = { done: "done", current: "now", waiting: "next", skipped: "already set up", failed: "stopped" };

export function Steps({ rows, label }: { rows: StepRow[]; label?: string }) {
  // the step running now is read out; a stopped row only when nothing runs, the latest one (a disconnect goes on
  // past a missed stop, and may stop again later)
  const now = rows.find((r) => r.mark === "current") ?? [...rows].reverse().find((r) => r.mark === "failed");
  return (
    <>
      <ol className="ag-steps" aria-label={label}>
        {rows.map((r) => (
          <li key={r.key} data-mark={r.mark}>
            <span className="ag-steps__icon">
              {r.mark === "done" || r.mark === "skipped" ? (
                <Check />
              ) : r.mark === "current" ? (
                <span className="ag-spinner" />
              ) : r.mark === "failed" ? (
                <svg className="ag-steps__x" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
                </svg>
              ) : (
                <span className="ag-steps__dot" />
              )}
            </span>
            <span className="ag-steps__label">
              {r.label}
              <span className="sr-only">, {SPOKEN[r.mark]}</span>
            </span>
            {(r.mark === "skipped" || r.hint) && <span className="ag-steps__hint">{r.mark === "skipped" ? "Already set up" : r.hint}</span>}
          </li>
        ))}
      </ol>
      <p className="sr-only" aria-live="polite">
        {now ? `${now.label}${now.mark === "failed" ? ", stopped" : ""}` : ""}
      </p>
    </>
  );
}
