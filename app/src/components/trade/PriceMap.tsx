"use client";
// Header context, two lines, low to high: the clouds' list prices (the middle one marked as the index) and what
// rentals actually traded at on Ornn and Akash (their marks, credit, display only). A dot plot needed four label
// rows to fit eight names in the header and pushed the trade button below the fold; two ordered lines say the
// same in a third of the height.
import { AkashMark, OrnnMark } from "@/components/brand/Peers";
import { median, peersFor } from "@/lib/mock/data";
import type { Market } from "@/lib/mock/types";
import { usd } from "@/lib/format";
import s from "./pricemap.module.css";

export function PriceMap({ market }: { market: Market }) {
  const clouds = [...market.sources].sort((a, b) => Number(b.live) - Number(a.live) || a.price - b.price);
  const live = clouds.filter((x) => x.live);
  const mid = median(live.map((x) => x.price));
  const traded = peersFor(market.gpu).sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9));
  return (
    <div className={s.map}>
      <span className={s.title}>Where {usd(market.price)} comes from</span>
      <div className={s.rows}>
        <span className={s.rowLabel}>List prices</span>
        <ul className={s.items}>
          {clouds.map((x) => {
            const isMid = x.live && Math.abs(x.price - mid) < 0.005;
            return (
              <li key={x.family} data-kind={!x.live ? "reserve" : isMid ? "index" : "cloud"}>
                <i aria-hidden="true" />
                <span>{x.family}</span>
                <b>{x.live ? usd(x.price) : "not counted"}</b>
                {isMid && <em>the index</em>}
              </li>
            );
          })}
        </ul>
        {traded.length > 0 && (
          <>
            <span className={s.rowLabel}>Traded</span>
            <ul className={s.items}>
              {traded.map((c) => (
                <li key={c.name} data-kind={c.price === null ? "none" : "traded"} title={`${c.note} As of ${c.asOf}.`}>
                  {c.kind === "traded-private" ? <OrnnMark size={13} /> : <AkashMark size={13} />}
                  <a href={c.kind === "traded-private" ? "https://ornn.com" : "https://akash.network"} target="_blank" rel="noreferrer">
                    {c.name}
                  </a>
                  <b>{c.price === null ? "no trades yet" : usd(c.price)}</b>
                </li>
              ))}
              <li data-kind="note">display only</li>
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
