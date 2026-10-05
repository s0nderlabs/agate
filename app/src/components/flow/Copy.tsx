"use client";
// Copy a value (an address, the AI apps' link): "Copy", then "Copied" for 2 s. When the browser blocks the clipboard
// the value shows in a read-only field, selected, so it can still be copied by hand.
import { useEffect, useRef, useState } from "react";

export function CopyButton({ text, label = "Copy", className = "ag-textbtn", what }: { text: string; label?: string; className?: string; what?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "blocked">("idle");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state !== "copied") return;
    const id = window.setTimeout(() => setState("idle"), 2_000);
    return () => window.clearTimeout(id);
  }, [state]);
  useEffect(() => {
    if (state === "blocked") field.current?.select();
  }, [state]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("blocked");
    }
  };
  return (
    <>
      <button type="button" className={className} onClick={copy} aria-label={what ? `Copy ${what}` : undefined}>
        <span aria-live="polite">{state === "copied" ? "Copied" : label}</span>
      </button>
      {state === "blocked" && <input ref={field} className="ag-input" readOnly value={text} aria-label={what ?? "Copy this"} onFocus={(e) => e.currentTarget.select()} />}
    </>
  );
}
