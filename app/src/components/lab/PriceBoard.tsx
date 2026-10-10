"use client";
// "What an hour costs, everywhere" (asset lab, round 2): the six GPUs on one dollar scale. Each dot is one cloud's price
// today, the bar is Agate's index for that GPU. The spread is the point: the same hour costs twice as much at one cloud
// as at another, and the index is the one number in the middle. After Silicon Data's index tiles, Metronome's rate card
// and Kalshi's ladder.
import { useEffect, useRef, useState } from "react";
import { usd } from "@/lib/format";
import type { LabGpu } from "./data";
import { stillMode } from "./data";
import s from "./lab.module.css";

export function PriceBoard({ data }: { data: LabGpu[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stillMode()) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setShown(true), { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const top = Math.max(2, ...data.flatMap((g) => g.clouds.map((c) => c.price)));
  const max = Math.ceil(top / 2) * 2;
  const pct = (v: number) => `${(v / max) * 100}%`;
  const ticks = Array.from({ length: max / 2 + 1 }, (_, i) => i * 2);
  return (
    <div ref={ref} className={`${s.board} ${shown ? s.boardOn : ""}`}>
      <div className={s.legend}>
        <span>
          <i className={s.legendDot} /> One cloud&apos;s price today
        </span>
        <span>
          <i className={s.legendTick} /> Agate&apos;s index
        </span>
      </div>
      {data.map((g, gi) => {
        const lo = g.clouds[0]?.price ?? 0, hi = g.clouds[g.clouds.length - 1]?.price ?? 0;
        return (
          <div key={g.gpu} className={s.row}>
            <span className={s.rowGpu}>{g.gpu}</span>
            <div className={s.track}>
              {ticks.map((t) => (
                <i key={t} className={s.grid} style={{ left: pct(t) }} />
              ))}
              {hi > lo && <i className={s.range} style={{ left: pct(lo), width: `${((hi - lo) / max) * 100}%`, transitionDelay: `${gi * 70}ms` }} />}
              {g.clouds.map((c, ci) => (
                <i
                  key={c.name}
                  className={s.dot}
                  title={`${c.name} ${usd(c.price)}`}
                  style={{ left: shown ? pct(c.price) : pct(g.price), transitionDelay: `${gi * 70 + ci * 40}ms` }}
                />
              ))}
              {g.price > 0 && <i className={s.tick} style={{ left: pct(g.price) }} />}
            </div>
            <span className={s.rowPrice}>{g.price ? usd(g.price) : "Soon"}</span>
            <span className={s.rowSpread}>{g.clouds.length > 1 ? `${usd(lo)} to ${usd(hi)}` : ""}</span>
          </div>
        );
      })}
      <div className={s.axis}>
        <span />
        <div className={s.axisTrack}>
          {ticks.map((t) => (
            <span key={t} style={{ left: pct(t) }}>
              ${t}
            </span>
          ))}
        </div>
        <span />
        <span />
      </div>
    </div>
  );
}
