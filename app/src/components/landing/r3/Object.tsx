"use client";
// Round 3, variant 2: "One object", the Plasma One grammar (measured Oct 8) in Agate's skin. A photo hero with a centred
// statement and the live app rising from its edge; then ONE object (the app on a phone) pinned at the centre while
// four sides scroll past: a stepper on the left, one huge live number on the right, a ring on the part of the screen
// that number lives in. Then a centred statement with the glass columns, slow price marquees and three big numbers.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { GlassColumns } from "@/components/lab/GlassColumns";
import { Foot3, Go, Head, k, Nav3, Phone, Rotator, Sticky, usd, useDark, useMotion, useR3 } from "./kit";
import o from "./object.module.css";

const P = "/landing/r3/";

export function OneObject() {
  const r = useR3();
  const dark = useDark();
  const root = useRef<HTMLDivElement>(null);
  useMotion(root);
  const m = r.m;
  const open = Math.round(r.open).toLocaleString("en-US");
  const steps = [
    { key: "pay", pill: "Paying for GPUs", n: m ? usd(m.long) : "…", line: `An hour of H100, locked for ${r.month}.`, go: "Lock in a price", ring: { l: 4, t: 86.6, w: 45.5, h: 7 } },
    { key: "earn", pill: "Renting them out", n: m ? usd(m.short) : "…", line: `What an hour of your GPUs earns, locked for ${r.month}.`, go: "Lock in your income", ring: { l: 50.5, t: 86.6, w: 45.5, h: 7 } },
    { key: "trade", pill: "Trading", n: open, line: `GPU-hours already open on ${r.month}. Go long or short.`, go: "Start trading", ring: { l: 3, t: 20.5, w: 94, h: 8.8 } },
    { key: "ai", pill: "Building with AI", n: "$500", line: "The most your AI spends on one trade before it asks you.", go: "Connect your AI", ring: null },
  ] as const;
  const pin = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  useEffect(() => {
    const onScroll = () => {
      const el = pin.current;
      if (!el || innerWidth <= 900) return;
      const r0 = el.getBoundingClientRect();
      const span = el.offsetHeight - innerHeight;
      const p = Math.max(0, Math.min(0.999, -r0.top / span));
      setStep(Math.floor(p * 4));
    };
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, []);
  const goStep = (i: number) => {
    const el = pin.current;
    if (!el || innerWidth <= 900) return setStep(i);
    const span = el.offsetHeight - innerHeight;
    scrollTo({ top: el.offsetTop + (span * (i + 0.5)) / 4, behavior: "smooth" });
  };
  const ring = steps[step].ring;
  return (
    <div ref={root} className={k.r3}>
      <section className={o.hero} aria-label="Agate">
        <div className={o.heroImg}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${P}cables-navy.jpg`} alt="" />
        </div>
        <Nav3 onDark />
        <div className={o.heroCopy}>
          <Rotator sides={r.sides} className={`${k.d1} ${o.heroH}`} />
          <p className={`${k.lead} ${o.heroLead}`}>Agate makes the price of compute tradable.</p>
          <Go kind="paper">Get started</Go>
        </div>
        <Phone width={300} className={o.heroPhone} />
      </section>
      <div style={{ height: 200 }} />

      <section ref={pin} className={o.pin} aria-label="What Agate does for you">
        <div className={o.pinStage}>
          <div className={o.pills} role="tablist" aria-label="Who you are">
            {steps.map((st, i) => (
              <button key={st.key} role="tab" aria-selected={step === i} className={`${o.pill} ${step === i ? o.pillOn : ""}`} onClick={() => goStep(i)}>
                {st.pill}
              </button>
            ))}
          </div>
          <div className={o.phoneWrap}>
            <Phone width={300} />
            <span className={`${o.ring} ${ring ? o.ringOn : ""}`} style={ring ? ({ left: `calc(10.5px + ${ring.l}% * .93)`, top: `calc(10.5px + ${ring.t}% * .975)`, width: `calc(${ring.w}% * .93)`, height: `calc(${ring.h}% * .975)` } as CSSProperties) : undefined} />
          </div>
          <div className={o.claims}>
            {steps.map((st, i) => (
              <div key={st.key} className={`${o.claim} ${step === i ? o.claimOn : ""}`} aria-hidden={step !== i}>
                <span className={o.claimN}>{st.n}</span>
                <p className={o.claimL}>{st.line}</p>
                <div>
                  <Go kind="ink" href={st.key === "ai" ? "/ai" : "/"}>
                    {st.go}
                  </Go>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className={k.paper2} aria-label="One open price">
        <div className={k.sp} />
        <div className={`${k.wrap} ${o.statement}`}>
          <Head className={k.d2}>One open price for an hour of compute.</Head>
          <p className={k.lead} data-rv="fade" style={{ textAlign: "center" }}>
            Read from the clouds every morning and published onchain. Each column is one GPU, as tall as its price today.
          </p>
        </div>
        <div className={k.spS} />
        <div className={o.glass} data-rv="media">
          <GlassColumns data={r.gpus} dark={dark} />
        </div>
        <div className={k.sp} />
      </section>

      <section aria-label="Today's prices">
        <div className={k.sp} />
        <Marquee r={r} />
        <Marquee r={r} reverse />
        <div className={k.sp} />
      </section>

      <section className={k.wrap} aria-label="Why it is safe">
        <div className={o.three} data-rv="set">
          <div className={o.big}>
            <span className={o.bigN}>0</span>
            <p className={o.bigL}>Liquidations. Every trade is fully backed when you open it.</p>
          </div>
          <div className={o.big}>
            <span className={o.bigN}>5</span>
            <p className={o.bigL}>Clouds read every morning for each GPU&apos;s price.</p>
          </div>
          <div className={o.big}>
            <span className={o.bigN}>{m?.days ?? 30}</span>
            <p className={o.bigL}>Days in {r.month}, each settled on its own price. Paid every morning if you like.</p>
          </div>
        </div>
      </section>
      <div className={k.sp} />

      <section className={`${k.ink} tone-dark`} data-close aria-label="Start">
        <div className={k.sp} />
        <div className={`${k.wrap} ${o.closeSec}`}>
          <Head className={k.d2}>Make your first trade in a minute.</Head>
          <p className={k.lead} data-rv="fade" style={{ color: "var(--on-ink-2)" }}>
            Sign in with email, Google or a passkey. No wallet needed.
          </p>
          <Go kind="paper">Get started</Go>
        </div>
        <div className={k.sp} />
      </section>
      <Foot3 />
      <Sticky />
    </div>
  );
}

function Marquee({ r, reverse = false }: { r: ReturnType<typeof useR3>; reverse?: boolean }) {
  const items = r.gpus.filter((g) => g.price > 0);
  const row = items.map((g) => (
    <span key={g.gpu} className={o.item}>
      {g.gpu} <span>{usd(g.price)}</span>
    </span>
  ));
  return (
    <div className={o.marquee} aria-hidden={reverse}>
      <div className={`${o.track} ${reverse ? o.track2 : ""}`}>
        {row}
        {row}
        {row}
        {row}
      </div>
    </div>
  );
}
