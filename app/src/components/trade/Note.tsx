"use client";
// A label that explains itself: the same markup as before (a button, then its note as a tooltip), so hover and
// keyboard focus behave exactly as they did on desktop. On a phone or tablet in the new layout a tap opens the note
// as a sheet instead, since a floating note clips or covers the screen there.
import { useId, type ReactNode } from "react";
import { useInfoSheet } from "@/components/markets/Flow";
import { InfoIcon } from "./MarketStats";
import s from "./trade.module.css";

export function Note({ label, note, title }: { label: ReactNode; note: ReactNode; title?: string }) {
  const id = useId();
  const info = useInfoSheet();
  return (
    <>
      <button type="button" className={s.tipBtn} aria-describedby={id} onClick={() => info(title ?? String(label), note)}>
        {label}
        <InfoIcon />
      </button>
      <span role="tooltip" id={id} className={s.tip}>
        {note}
      </span>
    </>
  );
}
