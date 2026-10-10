"use client";
// The lab's numbers, all from the one markets read the app makes (live testnet in the lab by default): each GPU's
// index price, the clouds read for it today, and the next month's market. Nothing here is invented; a GPU with no
// read yet has price 0 and the assets draw it as waiting.
import { useMemo } from "react";
import { dateText, frontMonth, monthLong } from "@/lib/data/derive";
import { useMarkets, useNow } from "@/lib/data/hooks";
import type { Gpu } from "@/lib/mock/types";

export const LAB_GPUS: Gpu[] = ["H100", "H200", "B200", "B300", "A100", "L40S"];

export interface LabCloud {
  name: string;
  price: number;
}

export interface LabMonth {
  /** "November" */
  name: string;
  /** "2026-11" */
  month: string;
  floor: number;
  cap: number;
  /** best ask (what a Long costs now), best bid (what a Short gets), last trade */
  long: number;
  short: number;
  last: number;
  /** GPU-hours open */
  open: number;
  days: number;
}

export interface LabGpu {
  gpu: Gpu;
  price: number;
  /** today's price minus the final day before it */
  change: number;
  /** "Oct 6" */
  date: string;
  /** live clouds, cheapest first */
  clouds: LabCloud[];
  /** registered slots, the reserve included */
  panelSize: number;
  month: LabMonth | null;
}

export function useLabData(): { ready: boolean; gpus: LabGpu[]; byGpu: (g: Gpu) => LabGpu | undefined } {
  const { markets } = useMarkets();
  const now = useNow();
  return useMemo(() => {
    const gpus: LabGpu[] = LAB_GPUS.map((g) => {
      const m = markets?.find((x) => x.gpu === g);
      const slots = m?.panel?.length ? m.panel.map((p) => ({ name: p.family, price: p.price ?? 0, live: p.live })) : (m?.sources ?? []).map((s) => ({ name: s.family, price: s.price, live: s.live }));
      const clouds = slots.filter((s) => s.live && s.price > 0).map(({ name, price }) => ({ name, price })).sort((a, b) => a.price - b.price);
      const s = m?.tradable ? frontMonth(m, now) : undefined;
      const month: LabMonth | null =
        s && s.floor > 0
          ? {
              name: monthLong(s.month),
              month: s.month,
              floor: s.floor,
              cap: s.cap,
              long: s.quote?.ask ?? 0,
              short: s.quote?.bid ?? 0,
              last: s.quote?.last ?? 0,
              open: s.openInterest,
              days: s.n,
            }
          : null;
      return { gpu: g, price: m && m.price > 0 ? m.price : 0, change: m && m.price > 0 ? m.price - m.prevPrice : 0, date: m?.priceDate ? dateText(m.priceDate) : "", clouds, panelSize: m?.panelSize ?? slots.length, month };
    });
    return { ready: gpus.some((x) => x.price > 0), gpus, byGpu: (g: Gpu) => gpus.find((x) => x.gpu === g) };
  }, [markets, now]);
}

/** Reads a CSS custom property off an element (canvases draw in the page's own tokens, so light and dark follow it). */
export function token(el: Element, name: string, fallback: string) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

/** Draw the finished frame instead of animating: reduced motion, or a render check's ?still=1 (a background tab runs
 *  no animation frames, so a check would otherwise capture the first one). */
export function stillMode() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches || window.location.search.includes("still=1");
}
