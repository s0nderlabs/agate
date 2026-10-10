"use client";
// Round 3, variant "Public". public.com's grammar from the Oct 7 deep walk: a serif headline on white, the real app staged big on a dark
// set, a live ticker, grey panels that hold the product cut off by their bottom edge, and one black section with three
// ruled columns before the close. Every number is live from the testnet.
import Link from "next/link";
import { useRef } from "react";
import { useHref } from "../r2/parts";
import { AppFrame, Foot3, Go, k, Nav3, Phone, Rotator, useMotion, useR3 } from "./kit";
import { AgentCard, Band, CloudTable, MonthGrid, Stage, Statement, Ticker } from "./market";
import p from "./public.module.css";

export function PublicPage() {
  const r = useR3();
  const to = useHref();
  const root = useRef<HTMLDivElement>(null);
  useMotion(root);
  const m = r.m;
  return (
    <div ref={root} className={k.r3}>
      <Nav3 />
      <section className={`${k.wrap} ${p.hero}`} aria-label="Agate">
        <Rotator sides={r.sides} className={p.h1} />
        <div className={p.heroRow}>
          <ul className={p.facts}>
            <li>Six GPUs, one open price each</li>
            <li>Fully backed</li>
            <li>Your AI, within your limits</li>
          </ul>
          <div className={p.heroCta}>
            <p className={p.heroLine}>Agate makes the price of compute tradable.</p>
            <Go kind="ink">Get started</Go>
          </div>
        </div>
        <Stage />
      </section>
      <Ticker r={r} className={p.ticker} />

      <div className={k.sp} />
      <section className={k.wrap} aria-label="Why">
        <Statement>GPU prices jump. Nebius raised its H100 hour 17% overnight on October 1. Until now there was no open way to lock a price in.</Statement>
      </section>
      <div className={k.sp} />

      <section className={`${k.wrap} ${p.panels}`} aria-label="How it works">
        <div className={p.panel}>
          <h2 className={p.panelTitle} data-rv="fade">
            Pick a month. Pick a side.
          </h2>
          <p className={p.panelBody} data-rv="fade">
            Long gains when GPU hours cost more. Short gains when they cost less. {m ? `${m.name} is open now.` : ""}
          </p>
          <Link href={to("/")} className={p.panelLink} data-rv="fade">
            Open the market <span aria-hidden>→</span>
          </Link>
          <div className={p.shot} data-rv="media">
            <AppFrame crop={{ x: 0, y: 0, w: 1440, h: 640 }} title="Agate's market page, live" />
          </div>
        </div>
        <div className={p.panel}>
          <h2 className={p.panelTitle} data-rv="fade">
            Your AI. Your limits.
          </h2>
          <p className={p.panelBody} data-rv="fade">
            Connect Claude or any AI. It trades from its own pocket and asks you before it goes past the limit you set.
          </p>
          <Link href={to("/ai")} className={p.panelLink} data-rv="fade">
            Connect your AI <span aria-hidden>→</span>
          </Link>
          <div className={p.shotAgent} data-rv="media">
            <AgentCard r={r} />
          </div>
        </div>
      </section>
      <div className={k.sp} />

      <section className={`${p.black} tone-dark`} aria-label="Open and backed">
        <div className={k.sp} />
        <div className={k.wrap}>
          <h2 className={p.blackHead} data-rv="fade">
            Open to check. Safe to hold.
          </h2>
          <div className={k.spS} />
          <div className={p.cols}>
            <div className={p.col}>
              <h3>Read from five clouds</h3>
              <p>Every morning Agate reads what five clouds charge for an H100 hour. The middle price goes onchain for anyone to check.</p>
              <div className={p.colArt}>
                <CloudTable r={r} />
              </div>
            </div>
            <div className={p.col}>
              <h3>Only lose what you put in</h3>
              <p>{m ? `${m.name} settles inside a fixed range. Every trade is fully backed when you open it. No margin calls, no liquidations.` : "Every trade is fully backed when you open it. No margin calls, no liquidations."}</p>
              <div className={p.colArt}>
                <Band r={r} />
              </div>
            </div>
            <div className={p.col}>
              <h3>Paid every morning</h3>
              <p>Each day settles on that day&apos;s price. Choose daily pay and it lands the next morning.</p>
              <div className={p.colArt}>
                <MonthGrid r={r} />
              </div>
            </div>
          </div>
        </div>
        <div className={k.sp} />
        <div className={`${k.wrap} ${p.close}`} data-close>
          <div data-rv="fade">
            <h2 className={p.closeHead}>Make your first trade in a minute.</h2>
            <p className={p.closeBody}>Sign in with email, Google or a passkey. No wallet needed.</p>
            <Go kind="paper">Get started</Go>
          </div>
          <div className={p.closePhone} data-rv="media">
            <Phone width={280} />
          </div>
        </div>
        <div className={k.sp} />
      </section>
      <Foot3 />
    </div>
  );
}
