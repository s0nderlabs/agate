"use client";
// The pictures in the docs' chapters (components/explain/figures): each placed under one section's first paragraph,
// found by the section's heading words, so the chapters' markdown stays text only. A chapter that loses or renames
// the heading simply shows no picture there.
import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AccountFigure, BackedFigure, CloseFigure, CloudsFigure, DailyFigure, MonthFigure, PayoffFigure, PocketFigure } from "@/components/explain/figures";
import s from "./docs.module.css";

type Place = { heading: string; fig: () => ReactNode };

const FIGURES: Record<string, Place[]> = {
  "the-price": [
    { heading: "a day's price", fig: () => <CloudsFigure /> },
    { heading: "what a month pays", fig: () => <MonthFigure /> },
  ],
  "the-market": [
    { heading: "long and short", fig: () => <PayoffFigure /> },
    { heading: "what backs a token", fig: () => <BackedFigure /> },
    { heading: "pay me daily", fig: () => <DailyFigure /> },
    { heading: "closing early", fig: () => <CloseFigure /> },
  ],
  accounts: [{ heading: "who holds what", fig: () => <AccountFigure /> }],
  "ai-pockets": [{ heading: "the limits you set", fig: () => <PocketFigure /> }],
};

/** Puts the chapter's pictures into its text once the text is in the page, and takes them out when it changes. */
export function DocFigures({ slug, root, html }: { slug: string; root: React.RefObject<HTMLDivElement | null>; html: string }) {
  const [slots, setSlots] = useState<{ el: HTMLElement; place: Place }[]>([]);
  useLayoutEffect(() => {
    const box = root.current;
    const places = FIGURES[slug];
    if (!box || !places) {
      setSlots([]);
      return;
    }
    const heads = Array.from(box.querySelectorAll("h2"));
    const made: { el: HTMLElement; place: Place }[] = [];
    for (const place of places) {
      const h = heads.find((x) => (x.textContent ?? "").toLowerCase().includes(place.heading));
      if (!h) continue;
      const next = h.nextElementSibling;
      const after = next && next.tagName === "P" ? next : h;
      const el = document.createElement("div");
      el.className = s.figSlot;
      after.after(el);
      made.push({ el, place });
    }
    setSlots(made);
    return () => made.forEach((m) => m.el.remove());
  }, [slug, root, html]);
  return <>{slots.map((x, i) => createPortal(x.place.fig(), x.el, `${slug}-${i}`))}</>;
}
