"use client";
// Hero 6, "One line" (Apple Card's single Daily Cash line running off both edges): pure white, a serif headline, and
// the price of H100 for next month as people trade it on Agate, hour by hour since it listed, as one line drawn across
// the whole width. Now is the dot at its end, with the last price. (The index itself moves only when a cloud reprices,
// so its daily line is mostly flat; the traded month is the price that moves.)
import { useEffect, useRef, useState } from "react";
import { frontMonth } from "@/lib/data/derive";
import { useCandles, useMarkets, useNow } from "@/lib/data/hooks";
import { CLAIM, Cta, Nav, Rotator, k, smoothPath, useHero, useSide, usd } from "./kit";
import s from "./h06.module.css";

export function H06Line() {
  const r = useHero();
  const i = useSide(r.sides.length);
  const { markets } = useMarkets();
  const now = useNow();
  const h100 = markets?.find((x) => x.gpu === "H100");
  const series = h100?.tradable ? frontMonth(h100, now) : undefined;
  const { candles } = useCandles(series);
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [h, setH] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setW(el.clientWidth);
      setH(el.clientHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // the traded month, hour by hour (closes); the index's days only if the month has no trades yet
  const traded = candles.filter((c) => c.c > 0);
  const useTraded = traded.length >= 12;
  const days = useTraded ? traded.map((c) => ({ date: c.t, price: c.c })) : r.hist.slice(-90);
  const vals = days.map((d) => d.price);
  const last = vals[vals.length - 1] ?? r.h.price;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.35 || 0.2;
  // the line runs in from beyond the left edge and stops a little before the right one, so today's label has room
  const endX = w > 700 ? w * 0.86 : w * 0.78;
  const { d, pts } = w && h ? smoothPath(vals, endX + 40, h, { t: h * 0.18, b: h * 0.16, l: -40, r: 40 }, [lo - pad, hi + pad]) : { d: "", pts: [] };
  const end = pts[pts.length - 1];
  // a hollow ring at the start of each day (traded) or month (index), as Apple marks its points
  const firsts = days.map((x, n) => (useTraded ? x.date.slice(11, 13) === "00" : x.date.endsWith("-01")) ? n : -1).filter((n) => n > 0 && n < days.length - 3);
  return (
    <section className={`${k.hero} ${s.hero}`}>
      <Nav />
      <div className={s.body}>
        <div className={s.copy}>
          <h1 className={s.h1}>{CLAIM}</h1>
          <div className={s.side}>
            <Rotator as="p" sides={r.sides} index={i} className={s.sub} qClass={s.q} />
            <Cta />
          </div>
        </div>
        <div ref={box} className={s.chart}>
          {d && (
            <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-label={useTraded ? `H100 ${r.month} as traded on Agate since it listed, ${usd(last)} last` : `H100's price over the last ${days.length} days, ${usd(r.h.price)} today`}>
              <defs>
                {/* in page units: a box-relative gradient vanishes when the line is level */}
                <linearGradient id="h06stroke" gradientUnits="userSpaceOnUse" x1="0" x2={w} y1="0" y2="0">
                  <stop offset="0" stopColor="#9fb3d9" stopOpacity="0" />
                  <stop offset=".18" stopColor="#9fb3d9" />
                  <stop offset=".7" stopColor="#3d4f8f" />
                  <stop offset="1" stopColor="#1d2152" />
                </linearGradient>
                <linearGradient id="h06fill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor="#c9d5ea" stopOpacity=".35" />
                  <stop offset="1" stopColor="#c9d5ea" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={`${d} L${end[0]},${h} L-40,${h} Z`} fill="url(#h06fill)" className={s.area} />
              <path d={d} className={s.line} stroke="url(#h06stroke)" pathLength={1} />
              {firsts.map((n) => (
                <circle key={n} cx={pts[n][0]} cy={pts[n][1]} r="6" className={s.ring} />
              ))}
              {end && (
                <g>
                  <line x1={end[0]} x2={end[0]} y1={end[1] + 14} y2={h} className={s.drop} />
                  <circle cx={end[0]} cy={end[1]} r="18" className={s.halo} />
                  <circle cx={end[0]} cy={end[1]} r="7" className={s.dot} />
                </g>
              )}
            </svg>
          )}
          {end && (
            <div className={s.tag} style={{ left: end[0], top: end[1] }}>
              <b>{usd(useTraded ? last : r.h.price)}</b>
              <span>{useTraded ? `H100 ${r.month}, last trade` : "H100, an hour today"}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
