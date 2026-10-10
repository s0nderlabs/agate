"use client";
// Supporting data on demand: "5 of 5 clouds" under the index price opens where the price comes from and how it
// sits beside traded prices. Off the overview by default (Oct 3); the full story belongs on the Index page.
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useInfoSheet } from "@/components/markets/Flow";
import { useLinkQuery } from "@/lib/mock/store";
import type { Market } from "@/lib/mock/types";
import { usd } from "@/lib/format";
import { PriceMap } from "./PriceMap";
import s from "./pricemap.module.css";

export function SourcesPop({ market, label, ok }: { market: Market; label: string; ok: boolean }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const id = useId();
  const linkQuery = useLinkQuery();
  const info = useInfoSheet();
  // on a phone or tablet the anchored panel would hang off the screen, so the same contents open as a sheet
  const foot = (
    <p className={s.popFoot}>
      The full method, every day's readings and the history live on the <Link href={`/app/gpu-index${linkQuery}#today`}>Index page</Link>.
    </p>
  );
  const toggle = () => {
    const body = (
      <div className={s.sheetMap}>
        <PriceMap market={market} />
        {foot}
      </div>
    );
    if (info(market.priceDate === null ? "Where the index comes from" : `Where ${usd(market.price)} comes from`, body, { wide: true })) return;
    setOpen((v) => !v);
  };
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
      <button className={s.trigger} aria-expanded={open} aria-controls={id} onClick={toggle}>
        <i data-ok={ok} aria-hidden="true" />
        {label}
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
          <path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open && (
        <div id={id} className={s.pop} role="dialog" aria-label="Where the price comes from">
          <PriceMap market={market} />
          {foot}
        </div>
      )}
    </span>
  );
}
