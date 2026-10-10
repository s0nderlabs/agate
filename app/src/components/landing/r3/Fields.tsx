"use client";
// Round 3, variant 3: "Film and fields", the Robinhood grammar (measured Oct 8) in Agate's skin. Two voices (Erode serif
// statements, grotesk for the rest), the stone's lace blue used as whole fields, a slow-drifting photo hero with glass
// price chips running off both edges, one phone with the live app, glass columns on black, a line-art trio for safety.
import { useRef } from "react";
import { GlassColumns } from "@/components/lab/GlassColumns";
import { Foot3, Go, Head, k, Nav3, Phone, Photo, Rotator, Sticky, usd, useDark, useMotion, useR3, type R3 } from "./kit";
import f from "./fields.module.css";

const P = "/landing/r3/";

export function Fields() {
  const r = useR3();
  const dark = useDark();
  const root = useRef<HTMLDivElement>(null);
  useMotion(root);
  const m = r.m;
  return (
    <div ref={root} className={k.r3}>
      {m && (
        <div className={f.bar}>
          <b>{r.month} is open.</b> An hour of H100 at {usd(m.long)} to Long, {usd(m.short)} to Short.
        </div>
      )}
      <div className={f.navWrap}>
        <Nav3 onDark />
      </div>
      <section className={f.hero} aria-label="Agate">
        <div className={f.heroImg}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${P}aisle-black.jpg`} alt="" />
        </div>
        <div className={f.heroCopy}>
          <Rotator sides={r.sides} className={`${f.s1} ${f.heroH}`} />
          <p className={`${k.lead} ${f.heroLead}`}>Agate makes the price of compute tradable.</p>
        </div>
        <div style={{ position: "relative", zIndex: 2, width: "100vw", display: "flex", justifyContent: "center", overflow: "visible" }}>
          <Chips r={r} />
        </div>
      </section>

      {/* lace field: the payer */}
      <section className={`${k.laceField} ${f.field}`} aria-label="Lock in what you pay">
        <div className={f.split}>
          <div className={f.splitText}>
            <Head className={f.s2}>Your GPU bill, locked.</Head>
            <p className={k.lead} data-rv="fade">
              {m
                ? `Renting H100s for ${r.month}? Go Long at ${usd(m.long)} an hour. If prices rise, your Long pays the difference.`
                : "Renting GPUs next month? Go Long. If prices rise, your Long pays the difference."}
            </p>
            <Go kind="ink">Lock in a price</Go>
          </div>
          <div className={f.phoneCol} data-rv="media">
            <Phone width={290} />
          </div>
        </div>
      </section>

      {/* paper: the owner */}
      <section className={f.field} aria-label="Lock in what you earn">
        <div className={f.split}>
          <Photo src={`${P}office-night.jpg`} alt="An office tower at night, every floor lit" ratio="4 / 5" className={f.photoCol} px />
          <div className={f.splitText}>
            <Head className={f.s2}>Your GPU income, locked.</Head>
            <p className={k.lead} data-rv="fade">
              {m
                ? `Renting GPUs out? Go Short at ${usd(m.short)} an hour. If prices fall, your Short makes up the difference.`
                : "Renting GPUs out? Go Short. If prices fall, your Short makes up the difference."}
            </p>
            <Go kind="line">Lock in your income</Go>
          </div>
        </div>
      </section>

      {/* black: the trader, glass columns as the object */}
      <section className={`${f.black} ${f.field} tone-dark`} aria-label="Trade the price of compute">
        <div className={f.center}>
          <Head className={f.s2}>Trade the price of compute.</Head>
          <p className={k.lead} data-rv="fade" style={{ color: "var(--on-ink-2)", textAlign: "center" }}>
            Six GPUs, one open price each, read from the clouds every morning. Go long or short on any month.
          </p>
        </div>
        <div className={k.spS} />
        <div className={k.wrap} data-rv="media">
          <GlassColumns data={r.gpus} dark />
        </div>
      </section>

      {/* warm black: safety, line art */}
      <section className={`${f.warm} ${f.field}`} aria-label="Safety">
        <div className={f.center}>
          <Head className={f.s2}>Only lose what you put in.</Head>
        </div>
        <div className={k.sp} />
        <div className={f.trio} data-rv="set">
          <div className={f.trioItem}>
            <svg viewBox="0 0 120 120" aria-hidden>
              <rect x="22" y="30" width="76" height="62" rx="10" />
              <circle cx="60" cy="61" r="15" />
              <path d="M60 46v-6M60 82v-6M45 61h-6M81 61h-6" />
              <path d="M34 92v8M86 92v8" />
            </svg>
            <p>Fully backed the moment you open it.</p>
          </div>
          <div className={f.trioItem}>
            <svg viewBox="0 0 120 120" aria-hidden>
              <rect x="20" y="26" width="80" height="72" rx="10" />
              <path d="M20 44h80M42 18v14M78 18v14" />
              <path d="M34 58h8M50 58h8M66 58h8M82 58h4M34 72h8M50 72h8M66 72h8M34 86h8M50 86h8" />
            </svg>
            <p>Settled every day on that day&apos;s price.</p>
          </div>
          <div className={f.trioItem}>
            <svg viewBox="0 0 120 120" aria-hidden>
              <path d="M60 16 96 30v28c0 22-15 38-36 46C39 96 24 80 24 58V30z" />
              <path d="m44 60 11 11 22-24" />
            </svg>
            <p>No margin calls, no liquidations.</p>
          </div>
        </div>
      </section>

      {/* lace close */}
      <section className={`${k.laceField} ${f.field}`} data-close aria-label="Start">
        <div className={f.center}>
          <Head className={f.s2}>Make your first trade in a minute.</Head>
          <div className={f.closeCard} data-rv="fade">
            <b>Sign in with email, Google or a passkey.</b>
            <span>No wallet needed. Your AI can join later, within the limits you set.</span>
          </div>
          <Go kind="ink">Get started</Go>
        </div>
      </section>
      <Foot3 />
      <Sticky onDark={!dark} />
    </div>
  );
}

function Chips({ r }: { r: R3 }) {
  const gs = r.gpus.filter((g) => g.price > 0);
  const left = gs.slice(0, 3);
  const right = gs.slice(3, 6);
  const chip = (g: R3["gpus"][number], i: number, n: number) => {
    const lo = g.clouds[0]?.price ?? g.price;
    const hi = g.clouds[g.clouds.length - 1]?.price ?? g.price;
    const at = hi > lo ? ((g.price - lo) / (hi - lo)) * 100 : 50;
    const edge = i === 0 || i === n - 1;
    return (
      <div key={g.gpu} className={`${f.chip} ${edge ? f.chipFade : ""}`}>
        <span className={f.chipGpu}>{g.gpu}</span>
        <span className={f.chipPrice}>{usd(g.price)}</span>
        <span className={f.chipRange} aria-label={`${g.clouds.length} clouds from ${usd(lo)} to ${usd(hi)}`}>
          <i style={{ left: `${at}%` }} />
        </span>
      </div>
    );
  };
  return (
    <div className={f.chips} data-rv="set">
      {left.map((g, i) => chip(g, i, 7))}
      <div className={`${f.chip} ${f.chipCenter}`}>
        <Go kind="paper">Get started</Go>
      </div>
      {right.map((g, i) => chip(g, i + 4, 7))}
    </div>
  );
}
