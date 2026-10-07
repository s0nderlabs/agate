"use client";
// The page's signature: today's clouds as dots on one price line, the middle one filled and marked "This is the
// price" (Computable's dot strip, in Agate's calm form: no axis, no caps), and under it a row per cloud with its
// price, the page it is read from and when. A row and its dot answer each other: point at either, or tap a row, and
// both light up, so a name on the list is always one glance from its place on the line.
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Num } from "@/components/num/Num";
import { readTodayText } from "@/components/trade/States";
import { countWord } from "@/lib/data/derive";
import { usd } from "@/lib/format";
import type { Market } from "@/lib/mock/types";
import { pageLabel } from "./pages";
import { cloudRows, lineScale, middleOf, placeLabels, readText, type CloudRow } from "./view";
import s from "./indexnew.module.css";

/** Apfel Grotezk at 15 px runs about 8 px a character: enough to keep labels apart without measuring each one. */
const labelWidth = (r: CloudRow) => Math.max(r.family.length, (r.counted ? usd(r.price ?? 0) : "not counted today").length) * 8 + 6;
/** One row of labels under the line: a name over a price, and the space before the next row. */
const ROW_H = 42;

function mark(r: CloudRow) {
  return r.middle ? "index" : r.counted ? "cloud" : "out";
}

export function PriceLine({ market }: { market: Market }) {
  const rows = useMemo(() => cloudRows(market), [market]);
  const priced = rows.filter((r) => r.price !== null);
  const mid = middleOf(market);
  const { lo, hi } = lineScale(priced.map((r) => r.price!));
  const at = (p: number) => (p - lo) / (hi - lo);
  const [on, setOn] = useState<string | null>(null);
  // the line's width, for where labels fit (a desktop guess on the server, measured before the first paint here)
  const lineRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const hasLine = priced.length > 0;
  useLayoutEffect(() => {
    const el = lineRef.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasLine]);
  // rows of labels: two on a phone, three where there is room; the index's cloud is placed first, a cloud not counted
  // last, and a name that fits in none waits for its row's hover
  const maxRows = width < 520 ? 2 : 3;
  const widths = priced.map(labelWidth);
  const slots = placeLabels(
    priced.map((r) => at(r.price!) * width),
    widths,
    width,
    maxRows,
    12,
    priced.map((r) => (r.middle ? 0 : r.counted ? 1 : 2)),
  );
  const used = Math.max(1, ...slots.map((r) => r + 1));
  // a single counted cloud at the middle is the index; with an even count the middle falls between two of them
  const midIsCloud = rows.some((r) => r.middle);
  const counted = rows.filter((r) => r.counted && r.price !== null).length;
  const before = market.priceDate === null;
  const reserves = rows.filter((r) => r.reserve).map((r) => r.family);
  // the hover side of the interaction: a mouse leaving clears it; a tap keeps it until another tap
  const hover = (family: string) => ({
    onPointerEnter: (e: React.PointerEvent) => e.pointerType === "mouse" && setOn(family),
    onPointerLeave: (e: React.PointerEvent) => e.pointerType === "mouse" && setOn((v) => (v === family ? null : v)),
  });
  const pct = (v: number) => `${Math.max(0, Math.min(100, v * 100))}%`;
  // "This is the price" is about 130 px wide: near an end it hangs inward instead of past the line
  const midPx = mid === null ? 0 : at(mid) * width;
  const midEdge = mid === null ? undefined : midPx < 70 ? "start" : width - midPx < 70 ? "end" : undefined;
  return (
    <div className={s.sig}>
      <p className={s.lead}>
        {before
          ? readTodayText(market)
          : `Each cloud's own on-demand ${market.gpu} price, read every hour from its public page. The middle of the ${countWord(counted)} counted becomes the day's index, so one cloud far above or below cannot move it.${reserves.length ? ` ${reserves.join(" and ")} ${reserves.length > 1 ? "wait" : "waits"} as the reserve.` : ""}`}
      </p>
      {hasLine && (
        <div
          ref={lineRef}
          className={s.pl}
          style={{ height: 58 + used * ROW_H }}
          role="img"
          aria-label={`${priced.map((r) => `${r.family} ${usd(r.price!)}${r.counted ? "" : ", not counted today"}`).join("; ")}. The middle price, ${mid === null ? "" : usd(mid)}, is the index.`}
        >
          <span className={s.plRule} aria-hidden="true" />
          {mid !== null && (
            <>
              <span className={s.plCallout} style={{ left: pct(at(mid)) }} data-edge={midEdge} aria-hidden="true">
                This is the price
              </span>
              <span className={s.plStem} style={{ left: pct(at(mid)) }} data-cloud={midIsCloud} aria-hidden="true" />
            </>
          )}
          {priced.map((r, i) => {
            const x = at(r.price!);
            const row = slots[i];
            // a label with no room shows only while its cloud is pointed at, over its neighbours
            const show = row >= 0 || on === r.family;
            const left = Math.max(0, Math.min(width - widths[i], x * width - widths[i] / 2));
            return (
              <span key={r.family} aria-hidden="true">
                <span className={s.plDot} style={{ left: pct(x) }} data-kind={mark(r)} data-on={on === r.family || undefined} {...hover(r.family)} />
                {show && (
                  <span
                    className={s.plLabel}
                    style={{ left: `${(left / width) * 100}%`, top: 58 + Math.max(0, row) * ROW_H, width: widths[i] }}
                    data-kind={mark(r)}
                    data-on={on === r.family || undefined}
                    data-float={row < 0 || undefined}
                    data-align={x * width < widths[i] / 2 ? "start" : x * width > width - widths[i] / 2 ? "end" : undefined}
                  >
                    <span>{r.family}</span>
                    <b>{r.counted ? <Num>{usd(r.price!)}</Num> : "not counted today"}</b>
                  </span>
                )}
              </span>
            );
          })}
        </div>
      )}
      <ul className={s.clouds}>
        <li className={s.cloudsHead} aria-hidden="true">
          <span />
          <span>Cloud</span>
          <span className={s.r}>Price</span>
          <span>Read from</span>
          <span>When</span>
        </li>
        {rows.map((r) => (
          <li
            key={r.family}
            data-kind={mark(r)}
            data-on={on === r.family || undefined}
            {...hover(r.family)}
            onPointerDown={(e) => e.pointerType !== "mouse" && setOn((v) => (v === r.family ? null : r.family))}
            onFocus={() => setOn(r.family)}
            onBlur={() => setOn((v) => (v === r.family ? null : v))}
          >
            <i aria-hidden="true" />
            <span className={s.cName}>
              {r.family}
              {r.middle && <em>the index</em>}
              {!r.counted && r.price !== null && <em>not counted today</em>}
              {r.reserve && r.price === null && <em>reserve</em>}
            </span>
            <b className={s.cPrice}>{r.price !== null ? <Num>{usd(r.price)}</Num> : before ? "no price yet" : "not read"}</b>
            <span className={s.cPage}>
              {r.url && (
                <a href={r.url} target="_blank" rel="noreferrer">
                  {pageLabel(r.url)}
                </a>
              )}
            </span>
            <span className={s.cRead}>{readText(r, market)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
