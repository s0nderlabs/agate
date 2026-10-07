"use client";
// The onchain proof beside the chart (Chainlink's facts column): how many clouds were read, a live countdown to the
// next price, when the last one turned final, the network and the index contract, then the check anyone can redo:
// the middle of today's readings against the price the contract holds.
import { CopyButton } from "@/components/flow/Copy";
import { Num } from "@/components/num/Num";
import { explorerAddress, shortAddress } from "@/lib/account/aiView";
import { dateText, listText, panelCount, timeText, whenText } from "@/lib/data/derive";
import { usd } from "@/lib/format";
import type { Market } from "@/lib/mock/types";
import { useHydrated, useNow as useClock } from "@/lib/ui/useNow";
import { INDEX_CONTRACT } from "./pages";
import { countdownLong, middleCheck, nextPriceText } from "./view";
import s from "./indexnew.module.css";

/** The ticking part on its own, so only it re-renders each second. Before the page hydrates (and on the server) it
 *  shows the expected time instead, so both renders agree. */
function NextIn({ at }: { at: string }) {
  const hydrated = useHydrated();
  const now = useClock(1_000, hydrated);
  if (!hydrated) return <b>about {timeText(at)}</b>;
  const left = countdownLong(at, now);
  return <b>{left ? <Num>{left}</Num> : "Any minute now"}</b>;
}

export function Facts({ market }: { market: Market }) {
  const before = market.priceDate === null;
  const panel = panelCount(market);
  const check = middleCheck(market);
  // the counted clouds that gave no price today, or were read and left out (never the reserve: it waits by design)
  const out = market.panel.filter((p) => !p.reserve && !market.sources.some((x) => x.family === p.family && x.live)).map((p) => p.family);
  const counted = before ? panel : market.liveCount;
  return (
    <div className={s.facts}>
      <dl className={s.factList}>
        <div>
          <dt>Price sources</dt>
          <dd>
            <b className={s.factBig}>
              <Num>{`${counted} / ${panel}`}</Num>
            </b>
            {before ? "clouds being read" : counted < panel ? "clouds counted today" : "clouds read"}
            {!before && out.length > 0 && <span className={s.factSub}>{listText(out)} not counted today</span>}
          </dd>
        </div>
        <div>
          <dt>{before ? "First price in" : "Next price in"}</dt>
          <dd>
            <NextIn at={market.nextUpdateAt} />
            <span className={s.factSub}>{nextPriceText(market)}</span>
          </dd>
        </div>
        <div>
          <dt>Last price turned final</dt>
          <dd>
            {before || !market.updatedAt ? (
              "None yet"
            ) : (
              <>
                {whenText(market.updatedAt)}
                <span className={s.factSub}>The price for {dateText(market.priceDate)}</span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>Monad testnet</dd>
        </div>
        <div>
          <dt>Index contract</dt>
          <dd className={s.factAddr}>
            <Num>{shortAddress(INDEX_CONTRACT)}</Num>
            <CopyButton text={INDEX_CONTRACT} what="the index contract's address" />
            <a className="ag-textbtn" href={explorerAddress(INDEX_CONTRACT)} target="_blank" rel="noreferrer">
              Explorer
            </a>
          </dd>
        </div>
      </dl>
      {check && (
        <p className={s.check} data-same={check.same}>
          {check.same ? (
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M4 8h8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
            </svg>
          )}
          <span>
            Middle of these {check.count} = <Num>{usd(check.mid)}</Num> · onchain = <Num>{usd(check.onchain)}</Num>
            {!check.same && (check.carried ? ". Today's price was carried from the day before, unverified." : ". They differ: the onchain price is the one that pays.")}
          </span>
        </p>
      )}
    </div>
  );
}
