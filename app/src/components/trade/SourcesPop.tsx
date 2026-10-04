"use client";
// Supporting data on demand: "5 of 5 clouds" under the index price opens where the price comes from and how it
// sits beside traded prices. Off the overview by default (Oct 3); the full story belongs on the Index page.
import { useEffect, useId, useRef, useState } from "react";
import type { Market } from "@/lib/mock/types";
import { PriceMap } from "./PriceMap";
import s from "./pricemap.module.css";

export function SourcesPop({ market, label, ok }: { market: Market; label: string; ok: boolean }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span ref={wrap} className={s.popWrap}>
      <button className={s.trigger} aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <i data-ok={ok} aria-hidden="true" />
        {label}
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
          <path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open && (
        <div id={id} className={s.pop} role="dialog" aria-label="Where the price comes from">
          <PriceMap market={market} />
          <p className={s.popFoot}>The full method, every day's readings and the history live on the Index page.</p>
        </div>
      )}
    </span>
  );
}
