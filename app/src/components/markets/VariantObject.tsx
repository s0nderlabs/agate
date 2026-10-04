"use client";
// Variant B, Plasma One's grammar: one physical object per scene (the month token as an onyx slab),
// segment pills on one side, a giant numeral with a small qualifier on the other; scenes alternate light and dark.
import { Stone } from "@/components/brand/Logo";
import { useMock } from "@/lib/mock/store";
import type { Market } from "@/lib/mock/types";
import { int, usd, usd0 } from "@/lib/format";
import { useFlow } from "./Flow";
import { AppNav, Compare, GpuSwitch, SourceStrip, carriedNote, priceChange } from "./Parts";
import { PriceChart, monthName } from "./PriceChart";
import { useTrade } from "./useTrade";
import s from "./VariantObject.module.css";

export function VariantObject({ market }: { market: Market }) {
  const { config } = useMock();
  const { submit } = useFlow();
  const trade = useTrade(market);
  const { n } = trade;
  const L = n.side === "long";
  const m = monthName(n.series.month);
  const ch = priceChange(market);
  const carried = carriedNote(market);
  return (
    <div className={`${s.root} ${config.data === "loading" ? "is-loading" : ""}`}>
      <AppNav />
      <div className={s.top}>
        <GpuSwitch />
      </div>

      <section className={s.scene}>
        <div className={s.pills} role="group" aria-label="Side">
          <button aria-pressed={L} onClick={() => trade.setSide("long")}>
            Long
          </button>
          <button aria-pressed={!L} onClick={() => trade.setSide("short")}>
            Short
          </button>
          <button aria-pressed={trade.daily} onClick={() => trade.setDaily(!trade.daily)}>
            Pay me daily
          </button>
        </div>

        <div className={s.object}>
          <div className={s.slab}>
            <div className={s.slabTop}>
              <span>agate</span>
              <span>{n.series.symbol}</span>
            </div>
            <div className={s.slabStone}>
              <Stone size="100%" outer="#ebe8e0" mid="#8b8a86" core="#121214" />
            </div>
            <div className={s.slabBottom}>
              <span>
                {L ? "Long" : "Short"}, {m} 2026
              </span>
              <b className="font-display ag-skel">{usd(n.price)}</b>
              <span>per GPU-hour{trade.daily ? ", paid daily" : ""}</span>
            </div>
          </div>
          <div className={s.contact} />
        </div>

        <div className={s.numeral}>
          <span className={s.kicker}>Today</span>
          <b className="font-display ag-skel">{usd(market.price)}</b>
          <span className={s.qual}>
            per {market.gpu} hour, the middle price of {market.sources.filter((x) => x.live).length} clouds
          </span>
          <span className={s.qual} style={{ color: carried ? "var(--mute)" : ch.cls === "text-down" ? "var(--down)" : ch.cls ? "var(--up)" : "var(--mute)" }}>
            {carried ?? ch.text}
          </span>
          <button className="ag-btn ag-btn--primary ag-btn--lg" onClick={() => submit(n)}>
            {L ? "Long" : "Short"} at {usd(n.price)}
          </button>
        </div>
      </section>

      <section className={s.size}>
        <h2 className={s.h2}>Size it in GPUs</h2>
        <div className={s.stepper}>
          <button aria-label="Fewer GPUs" onClick={() => trade.setGpus(trade.gpus - 1)}>
            −
          </button>
          <span>
            <b className="font-display">{trade.gpus}</b> GPUs for all of {m}
          </span>
          <button aria-label="More GPUs" onClick={() => trade.setGpus(trade.gpus + 1)}>
            +
          </button>
        </div>
        <p className={s.hours}>
          {int(n.hours)} GPU-hours at {usd(n.price)}
        </p>
        <dl className={s.stats}>
          <div>
            <dt>{L ? "You pay" : "You put up"}</dt>
            <dd className="font-display">{usd0(n.outlay)}</dd>
          </div>
          <div>
            <dt>{n.daily && L ? "Back right away" : "Paid out"}</dt>
            <dd className="font-display">{n.daily ? (L ? usd0(n.backNow) : "Daily") : `After ${m.slice(0, 3)}`}</dd>
          </div>
          <div>
            <dt>Most you can lose</dt>
            <dd className="font-display">{usd0(n.maxLoss)}</dd>
          </div>
          <div>
            <dt>Most you can make</dt>
            <dd className="font-display">{usd0(n.maxGain)}</dd>
          </div>
        </dl>
        <p className={s.copy}>
          {L ? `Long pays you ${m}'s average ${market.gpu} price, between ${usd(n.series.floor)} and ${usd(n.series.cap)}.` : `Short pays you ${usd(n.series.cap)} minus ${m}'s average, so you gain when it comes in below ${usd(n.price)}.`}{" "}
          {trade.daily ? "Pay me daily sends a share every morning and locks the market rate." : `Paid once, after ${m} ends.`}
        </p>
        <button className={`ag-btn ag-btn--primary ag-btn--lg ${s.wide}`} onClick={() => submit(n)}>
          {L ? "Long" : "Short"} at {usd(n.price)}
        </button>
      </section>

      <section className={`${s.dark} tone-dark`}>
        <div className={s.darkInner}>
          <h2 className={s.h2}>Where today's price comes from</h2>
          <div className={s.darkGrid}>
            <div className={s.panel}>
              <PriceChart market={market} series={n.series} height="clamp(210px, 24vw, 300px)" />
              <p style={{ color: "var(--mute)", fontSize: 15, marginTop: 12 }}>History before Sep 30 is example data.</p>
            </div>
            <div className={s.panel}>
              <SourceStrip market={market} />
            </div>
          </div>
          <Compare market={market} big={40} />
        </div>
      </section>
    </div>
  );
}
