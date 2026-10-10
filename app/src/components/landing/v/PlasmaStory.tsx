"use client";
// Plasma's pinned story: pills on the left, one physical object in the middle (the agate slice, lit), a giant numeral
// on the right with a short line and one button; the pills change the numeral. Then the three markets as Plasma's
// card tiers (object on a well, a 3-up stat box, a full-width button).
import Link from "next/link";
import { useState } from "react";
import { Close, Doors, Proof } from "../blocks";
import { AgateSlice, COPY, Cta, Footer, LNav, P, useLinkQueryHref, useLive } from "../kit";
import s from "./story.module.css";

type Beat = "long" | "short" | "daily";

export function PlasmaStory() {
  const live = useLive();
  const href = useLinkQueryHref();
  const [beat, setBeat] = useState<Beat>("long");
  const beats: Record<Beat, { pill: string; num: number; line: string }> = {
    long: { pill: "Go Long", num: live.long, line: `Gains if ${live.month}'s average ends above it` },
    short: { pill: "Go Short", num: live.short, line: `Gains if ${live.month}'s average ends below it` },
    daily: { pill: "Pay me daily", num: live.floor, line: "The floor back now, then a share of each day" },
  };
  const b = beats[beat];
  return (
    <div className={s.page}>
      <LNav />
      <section className={s.intro}>
        <h1 className={s.title}>{COPY.title}</h1>
        <p className={s.lead}>{COPY.lead}</p>
      </section>
      <section className={s.story} aria-label={`H100 ${live.month}`}>
        <div className={s.pills} role="tablist" aria-label="Ways to hold it">
          {(Object.keys(beats) as Beat[]).map((k) => (
            <button key={k} role="tab" aria-selected={beat === k} className={s.pill} onClick={() => setBeat(k)}>
              {beats[k].pill}
            </button>
          ))}
        </div>
        <div className={s.object}>
          <AgateSlice className={s.slice} />
          <div className={s.shadow} aria-hidden="true" />
        </div>
        <div className={s.numeral}>
          <span className={s.qual}>H100, {live.month}</span>
          <span className={s.big}>
            <P v={b.num} />
          </span>
          <span className={s.line}>{b.line}</span>
          <Cta />
        </div>
      </section>
      <section className={s.tiers}>
        <h2 className={s.tiersTitle}>Three markets, every month</h2>
        <ul className={s.tierList}>
          {live.gpus
            .filter((g) => g.tradable)
            .map((g, i) => (
              <li key={g.g} className={s.tier}>
                <div className={s.well}>
                  <AgateSlice className={s.wellSlice} tone={i === 1 ? "night" : "day"} lit={i !== 1} style={{ transform: `rotate(${[-8, 6, -2][i]}deg)` }} />
                </div>
                <div className={s.tierBody}>
                  <h3>{g.g}</h3>
                  <p>{["The workhorse of AI training.", "More memory, same family.", "The newest generation."][i]}</p>
                  <dl className={s.box}>
                    <div>
                      <dd>
                        <P v={g.price} />
                      </dd>
                      <dt>Today</dt>
                    </div>
                    <div>
                      <dd>{live.month.slice(0, 3)}</dd>
                      <dt>Next month</dt>
                    </div>
                    <div>
                      <dd>$0</dd>
                      <dt>Fees on testnet</dt>
                    </div>
                  </dl>
                  <Link className={`ag-btn ag-btn--primary ${s.tierBtn}`} href={href("/")}>
                    Trade {g.g}
                  </Link>
                </div>
              </li>
            ))}
        </ul>
      </section>
      <section className={s.how}>
        <h2 className={s.howTitle}>How it works</h2>
        <ol className={s.howList}>
          {COPY.how.map((h) => (
            <li key={h.t}>
              <h3>{h.t}</h3>
              <p>{h.d}</p>
            </li>
          ))}
        </ol>
      </section>
      <Doors c={s} />
      <div className={`tone-dark ${s.dark}`}>
        <Proof c={s} live={live} />
      </div>
      <Close c={s} />
      <Footer />
    </div>
  );
}
