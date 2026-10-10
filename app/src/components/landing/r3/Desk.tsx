"use client";
// Round 3, variant "Ornn". ornn.com's grammar from the
// Oct 7 deep walk, in Agate's own materials: always dark; a grotesk headline beside the LIVE H100 price set like a
// headline on a thick rule; the five clouds named where Ornn names its customers; a statement that lights word by word;
// real app screens on a lace plinth beside ruled columns; the six GPUs as one board; a photo band to close.
import { useRef } from "react";
import { AppFrame, Count, Foot3, Go, k, Nav3, Phone, Rotator, usd, useMotion, useR3 } from "./kit";
import { AgentCard, Split, Statement, Ticker } from "./market";
import d from "./desk.module.css";

const P = "/landing/r3/";

export function DeskPage() {
  const r = useR3();
  const root = useRef<HTMLDivElement>(null);
  useMotion(root);
  const m = r.m;
  const clouds = r.h.clouds.map((c) => c.name);
  return (
    <div ref={root} className={`${k.r3} ${d.page} tone-dark`}>
      <section className={d.hero} aria-label="Agate">
        <div className={d.heroImg}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${P}aisle-navy.jpg`} alt="" />
        </div>
        <Nav3 onDark className={d.heroNav} />
        <div className={d.heroGrid}>
          <Rotator sides={r.sides} className={d.h1} />
          <div className={d.priceCol}>
            <div className={d.priceRow}>
              <span className={d.price}>{r.h.price ? <Count n={r.h.price} fmt="usd" /> : "…"}</span>
              <span className={d.priceNote}>An hour of H100 today</span>
            </div>
            <p className={d.heroLead}>Agate makes the price of compute tradable. Lock in what you pay or earn for GPU time, or trade where it goes.</p>
            <div>
              <Go kind="paper">Get started</Go>
            </div>
          </div>
        </div>
        {clouds.length > 0 && (
          <div className={d.clouds}>
            <p className={d.cloudsLine}>Read every morning from what these clouds charge</p>
            <div className={d.cloudRow} data-rv="set">
              {clouds.map((n) => (
                <span key={n} className={d.cloudName}>
                  {n}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>
      <Ticker r={r} />

      <div className={k.sp} />
      <section className={k.wrap} aria-label="Why">
        <Statement>GPU prices jump. Nebius raised its H100 hour 17% overnight on October 1. Until now there was no open way to lock a price in.</Statement>
      </section>
      <div className={k.sp} />

      <section className={k.wrap} aria-label="The market">
        <Split
          screen={<AppFrame crop={{ x: 0, y: 0, w: 1440, h: 860 }} theme="dark" title="Agate's market page, live" />}
          title={`H100, ${r.month}`}
          body="Today's open price beside the month you can trade. Long gains when GPU hours cost more. Short gains when they cost less."
          foot={<Go kind="paper">Start trading</Go>}
        />
      </section>
      <div className={k.sp} />

      <section className={k.wrap} aria-label="Six GPUs">
        <div className={d.boardHead}>
          <h2 className={d.boardTitle} data-rv="fade">
            Six GPUs. One open price each.
          </h2>
          <Go kind="paper" href="/gpu-index">
            See today&apos;s prices
          </Go>
        </div>
        <div className={k.spS} />
        <div className={d.board} data-rv="set">
          {r.gpus.map((g) => (
            <div key={g.gpu} className={d.cell}>
              <span className={d.cellGpu}>{g.gpu}</span>
              <span className={d.cellPrice}>{g.price > 0 ? usd(g.price) : "…"}</span>
              <span className={d.cellNote}>
                {g.clouds.length} clouds{g.month ? `, ${g.month.name} open` : ""}
              </span>
            </div>
          ))}
        </div>
      </section>
      <div className={k.sp} />

      <section className={k.wrap} aria-label="Fully backed">
        <Split
          flip
          bare
          screen={<Phone width={250} theme="dark" />}
          title="Fully backed."
          body={m ? `Every trade is backed in full the moment you open it, and ${m.name} settles inside a fixed range. You can only lose what you put in. No margin calls, no liquidations.` : "Every trade is backed in full the moment you open it. You can only lose what you put in. No margin calls, no liquidations."}
        />
      </section>
      <div className={k.sp} />

      <section className={k.wrap} aria-label="Your AI">
        <Split
          bare
          screen={<AgentCard r={r} />}
          title="Your AI, within your limits."
          body="Connect Claude or any AI. It trades from its own pocket and asks you before it goes past the limit you set."
          foot={
            <Go kind="paper" href="/ai">
              Connect your AI
            </Go>
          }
        />
      </section>
      <div className={k.sp} />

      <section className={d.band} data-close aria-label="Start">
        <div className={d.bandImg}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${P}cables-navy.jpg`} alt="" loading="lazy" />
        </div>
        <div className={d.bandCopy}>
          <h2 className={d.bandHead} data-rv="fade">
            The market for compute, open to everyone.
          </h2>
          <Go kind="paper">Get started</Go>
        </div>
      </section>
      <Foot3 />
    </div>
  );
}
