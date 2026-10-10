"use client";
// Plasma's grammar: a full-bleed material (a smoky velvet in agate's tones, code-built), one centered statement and
// one button, the phone rising out of it. Below, the four ways in as Plasma's card tiers: an object on a grey well,
// a name, a line, a full-width button.
import Link from "next/link";
import { Close, How, Proof } from "../blocks";
import { COPY, Cta, Footer, LNav, P, PhoneApp, useLinkQueryHref, useLive } from "../kit";
import s from "./velvet.module.css";

export function PlasmaVelvet() {
  const live = useLive();
  const href = useLinkQueryHref();
  const wells = [
    <div key="b" className={s.objBrowser}>
      <span className={s.objDots} />
      <span className={s.objBig}>
        <P v={live.price} />
      </span>
      <span className={s.objPill}>Long {live.month}</span>
    </div>,
    <div key="a" className={s.objChat}>
      <span className={s.bubble}>Hedge next month's H100s for me.</span>
      <span className={s.bubbleMe}>Long 720 GPU-hours of {live.month}? It needs your OK.</span>
    </div>,
    <div key="d" className={s.objCode}>
      <span>H100 today</span>
      <span className={s.objBig}>
        <P v={live.price} />
      </span>
      <span>{live.clouds.length || 5} clouds, middle price</span>
    </div>,
    <div key="c" className={s.objChain}>
      <span className={s.objRing} />
      <span className={s.objRing} />
      <span className={s.objRing} />
    </div>,
  ];
  const acts = [
    ["Open the market", href("/")],
    ["Connect an AI", href("/ai")],
    ["See the data", href("/gpu-index")],
    ["See the contract", href("/gpu-index")],
  ];
  return (
    <div className={s.page}>
      <section className={`tone-dark ${s.scene}`}>
        <div className={s.velvet} aria-hidden="true" />
        <LNav float />
        <div className={s.heroCopy}>
          <h1 className={s.title}>{COPY.title}</h1>
          <Cta />
        </div>
        <PhoneApp live={live} className={s.phone} />
      </section>
      <section className={s.tiers}>
        <h2 className={s.tiersTitle}>Four ways in</h2>
        <ul className={s.tierList}>
          {COPY.doors.map((d, i) => (
            <li key={d.t} className={s.tier}>
              <div className={s.well}>{wells[i]}</div>
              <div className={s.tierBody}>
                <h3>{d.t}</h3>
                <p>{d.d}</p>
                <Link className={`ag-btn ag-btn--primary ${s.tierBtn}`} href={acts[i][1]}>
                  {acts[i][0]}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section className={s.facts}>
        <div>
          <span className={s.factBig}>{live.clouds.length || 5}</span>
          <span>clouds read every hour</span>
        </div>
        <div>
          <span className={s.factBig}>1</span>
          <span>open price a day, onchain</span>
        </div>
        <div>
          <span className={s.factBig}>0</span>
          <span>liquidations: both sides pay in full</span>
        </div>
      </section>
      <How c={s} />
      <div className={`tone-dark ${s.dark}`}>
        <Proof c={s} live={live} />
      </div>
      <Close c={s} />
      <Footer />
    </div>
  );
}
