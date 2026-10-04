"use client";
// Header context, two lines, low to high: the clouds' list prices (the middle one marked as the index) and what
// rentals actually traded at on Ornn and Akash (their marks, credit, display only). A dot plot needed four label
// rows to fit eight names in the header and pushed the trade button below the fold; two ordered lines say the
// same in a third of the height.
import { AkashMark, OrnnMark } from "@/components/brand/Peers";
import { median, peersFor } from "@/lib/peers";
import type { Market } from "@/lib/mock/types";
import { usd } from "@/lib/format";
import { readTodayText } from "./States";
import s from "./pricemap.module.css";

export function PriceMap({ market }: { market: Market }) {
  // today's readings, plus every panel slot without one (live data never lists the reserve, and before the first
  // final day nothing has a price yet), so the panel always shows whole
  const read = market.sources.map((x) => ({ family: x.family, price: x.price as number | null, live: x.live }));
  const rest = market.panel.filter((p) => !read.some((x) => x.family === p.family)).map((p) => ({ family: p.family, price: null, live: p.live && !p.reserve }));
  const clouds = [...read, ...rest].sort((a, b) => Number(b.live) - Number(a.live) || (a.price ?? 1e9) - (b.price ?? 1e9));
  const live = clouds.filter((x) => x.live && x.price !== null);
  const mid = median(live.map((x) => x.price!));
  const traded = peersFor(market.gpu).sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9));
  // the traded prices are fixed readings, not today's: their date shows in the text (a hover title never reaches a
  // touch screen). One date for all of them goes once, after "display only"; otherwise beside each price
  const dates = [...new Set(traded.filter((c) => c.price !== null).map((c) => c.asOf))];
  const asOf = dates.length === 1 ? dates[0] : null;
  // before the first final day: who is read today, in a sentence (the list below then shows "no price yet")
  const before = market.priceDate === null ? readTodayText(market) : null;
  return (
    <div className={s.map}>
      <span className={s.title}>Where {market.priceDate === null ? "the index" : usd(market.price)} comes from</span>
      {before && <p className={s.lead}>{before}</p>}
      <div className={s.rows}>
        <span className={s.rowLabel}>List prices</span>
        <ul className={s.items}>
          {clouds.map((x) => {
            const isMid = x.live && x.price !== null && Math.abs(x.price - mid) < 0.005;
            return (
              <li key={x.family} data-kind={!x.live ? "reserve" : isMid ? "index" : "cloud"}>
                <i aria-hidden="true" />
                <span>{x.family}</span>
                <b>{!x.live ? "not counted" : x.price === null ? "no price yet" : usd(x.price)}</b>
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
                  {c.price !== null && !asOf && <em>as of {c.asOf}</em>}
                </li>
              ))}
              <li data-kind="note">display only{asOf ? `, as of ${asOf}` : ""}</li>
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
