"use client";
// The GPU switch across the top of the Index page: one small card per GPU the index prices, with its price and its
// last 30 days as a step sparkline (Computable's and Silicon Data's switchers), the one on screen picked. The
// price-only GPUs say so, as the market row does ("Index only"); before a GPU's first price, the day it lands.
import { Num } from "@/components/num/Num";
import { useMarkets } from "@/lib/data/hooks";
import { dateText } from "@/lib/data/derive";
import { usd } from "@/lib/format";
import { ALL_GPUS } from "@/lib/mock/data";
import { useMock } from "@/lib/mock/store";
import { sparkPath } from "./view";
import s from "./indexnew.module.css";

export function GpuCards() {
  const { config, setConfig } = useMock();
  const { markets, loading } = useMarkets();
  return (
    <div className={s.cards} role="tablist" aria-label="GPU">
      {ALL_GPUS.map((g) => {
        const m = markets?.find((x) => x.gpu === g);
        const path = m ? sparkPath(m.history, 100, 24) : "";
        return (
          <button key={g} type="button" role="tab" aria-selected={config.gpu === g} className={s.card} onClick={() => setConfig({ gpu: g })}>
            <span className={s.cardTop}>
              <b>{g}</b>
              {m && !m.tradable && <span>Index only</span>}
            </span>
            {/* nothing read yet: a skeleton while the read is on its way, blank when it failed (the Notice bar says why) */}
            {!m ? (
              <span className={`${s.cardPrice} ag-skel`} aria-hidden="true">
                {loading ? "$0.00" : " "}
              </span>
            ) : m.priceDate === null ? (
              <span className={s.cardFirst}>First price {dateText(m.nextUpdateAt)}</span>
            ) : (
              <span className={s.cardPrice}>
                <Num>{usd(m.price)}</Num>
              </span>
            )}
            <svg className={s.spark} viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
              {/* fewer than two days: no line at all, never a flat one that would read as a steady price */}
              {path && <path d={path} />}
            </svg>
          </button>
        );
      })}
    </div>
  );
}
