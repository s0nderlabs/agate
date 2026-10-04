"use client";
// Below the chart: where today's price comes from, and how it sits beside other prices. Flat, hairline-split,
// radius from the shared tokens, so it reads as part of the screen instead of a set of floating cards.
import { Stone } from "@/components/brand/Logo";
import { AkashMark, OrnnMark } from "@/components/brand/Peers";
import { Num } from "@/components/num/Num";
import { median, peersFor } from "@/lib/peers";
import type { Market } from "@/lib/mock/types";
import { usd } from "@/lib/format";
import { dateText, panelCount, timeText } from "@/lib/data/derive";
import s from "./insight.module.css";

const WORDS: Record<number, string> = { 3: "Three", 4: "Four", 5: "Five", 6: "Six", 7: "Seven" };

/** Each cloud is a dot on one price line, labelled where it sits. The filled dot is the middle price: the index. */
export function Sources({ market }: { market: Market }) {
  const all = [...market.sources].sort((a, b) => a.price - b.price);
  const live = all.filter((x) => x.live);
  const mid = median(live.map((x) => x.price));
  const lo = Math.floor(Math.min(...all.map((x) => x.price)) * 2) / 2 - 0.25;
  const hi = Math.ceil(Math.max(...all.map((x) => x.price)) * 2) / 2 + 0.25;
  const pos = (p: number) => ((p - lo) / (hi - lo)) * 100;
  const midIsSource = live.some((x) => Math.abs(x.price - mid) < 0.005);
  return (
    <div className={s.sources}>
      <p className={s.lead}>
        {WORDS[live.length] ?? live.length} clouds post an on-demand {market.gpu} price. The middle one, filled, becomes today's index.
      </p>
      <div className={s.line} role="img" aria-label={`${all.map((x) => `${x.family} ${usd(x.price)}${x.live ? "" : " not counted"}`).join(", ")}. Index ${usd(mid)}.`}>
        <span className={s.rule} aria-hidden="true" />
        {!midIsSource && <span className={s.midTick} style={{ left: `${pos(mid)}%` }} aria-hidden="true" />}
        {all.map((x, i) => {
          const isMid = x.live && Math.abs(x.price - mid) < 0.005;
          const p = pos(x.price);
          return (
            <div key={x.family} className={s.src} style={{ left: `${p}%` }} data-side={i % 2 ? "below" : "above"} data-edge={p < 10 ? "start" : p > 90 ? "end" : undefined} data-mid={isMid} data-live={x.live} aria-hidden="true">
              <i />
              <span className={s.label}>
                <span>{x.family}</span>
                <b>{x.live ? <Num>{usd(x.price)}</Num> : "not counted"}</b>
              </span>
            </div>
          );
        })}
      </div>
      {/* narrow screens: the same readings as a list, since labels on the line would collide */}
      <ul className={s.list}>
        {all.map((x) => (
          <li key={x.family} data-live={x.live} data-mid={x.live && Math.abs(x.price - mid) < 0.005}>
            <span>{x.family}</span>
            <b>{x.live ? <Num>{usd(x.price)}</Num> : "not counted"}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Our posted price beside two traded ones, with how far each sits from ours. */
export function Beside({ market }: { market: Market }) {
  const peers = peersFor(market.gpu);
  const before = market.priceDate === null;
  const panel = panelCount(market);
  const word = (n: number) => (WORDS[n] ?? String(n)).toLowerCase();
  // how many clouds today's price came from: all of them, or "four of five" when one was not counted
  const from = !before && market.liveCount < panel ? `${word(market.liveCount)} of ${word(panel)} clouds today` : `${word(panel)} clouds`;
  return (
    <div className={s.beside}>
      {/* a price-only GPU has no traded price beside it (Ornn and Akash list none for it) */}
      <p className={s.lead}>{peers.length ? "Ours is the price clouds list. Ornn and Akash track rentals that actually traded." : "No traded price to compare with yet."}</p>
      <div className={s.cols}>
        <div className={s.col} data-ours="true">
          <span className={s.name}>
            <Stone size={16} />
            Agate index
          </span>
          <span className={`${s.price} font-display`}>{before ? dateText(market.nextUpdateAt) : usd(market.price)}</span>
          {/* before the first price, the date above is when it lands; nothing pays on a GPU without a monthly market */}
          <span className={s.gap}>{before ? `First price about ${timeText(market.nextUpdateAt)}` : market.tradable ? "The one that pays" : "Price only for now"}</span>
          <span className={s.note}>Posted prices from {from}, onchain on Monad.</span>
        </div>
        {peers.map((c) => {
          const gap = c.price === null ? null : c.price - market.price;
          return (
            <div key={c.name} className={s.col} data-ours="false">
              <span className={s.name}>
                {c.kind === "traded-private" ? <OrnnMark size={15} /> : <AkashMark size={15} />}
                <a href={c.kind === "traded-private" ? "https://ornn.com" : "https://akash.network"} target="_blank" rel="noreferrer">
                  {c.name}
                </a>
              </span>
              <span className={`${s.price} font-display`}>{c.price === null ? "None" : usd(c.price)}</span>
              <span className={s.gap}>{gap === null ? "No trades yet" : market.priceDate === null ? "Ours has no price yet" : `${usd(Math.abs(gap))} ${gap < 0 ? "below" : "above"} ours`}</span>
              <span className={s.note}>
                {c.note} As of {c.asOf}.
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
