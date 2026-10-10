"use client";
// Round 3, variant 4: "Close-up", the Mercury grammar (measured Oct 8) in Agate's skin. A cinematic photo hero, then a
// calm dark field where the real app is shown as giant macro crops with a depth-of-field blur, a slow marquee of the
// clouds Agate reads, one quiet centred statement, and a start section with the glass columns.
import { useRef } from "react";
import { GlassColumns } from "@/components/lab/GlassColumns";
import { AppFrame, Foot3, Go, Head, k, Nav3, Rotator, Sticky, useMotion, useR3, type R3 } from "./kit";
import u from "./closeup.module.css";

const P = "/landing/r3/";

export function Closeup() {
  const r = useR3();
  const root = useRef<HTMLDivElement>(null);
  useMotion(root);
  return (
    <div ref={root} className={k.r3}>
      <section className={u.hero} aria-label="Agate">
        <div className={u.heroImg}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${P}tower-sky.jpg`} alt="" />
        </div>
        <Nav3 onDark />
        <div className={u.heroCopy}>
          <Rotator sides={r.sides} className={`${k.d1} ${u.heroH}`} />
          <p className={`${k.lead} ${u.heroLead}`}>Agate makes the price of compute tradable.</p>
          <div className={k.row} style={{ justifyContent: "center" }}>
            <Go kind="paper">Get started</Go>
            <Go kind="ghost" href="/gpu-index">
              See today&apos;s prices
            </Go>
          </div>
        </div>
      </section>

      <section className={`${u.dark} tone-dark`} aria-label="The product, close up">
        <div className={k.sp} />
        <div className={`${k.wrap} ${u.center}`}>
          <Head className={k.d3}>Read from the clouds that rent GPUs, every morning.</Head>
        </div>
        <div className={k.spS} />
        <CloudMarquee r={r} />
        <div className={k.sp} />

        <div className={k.wrap}>
          <div data-rv="media">
            <AppFrame className={u.macro} crop={{ x: 0, y: 150, w: 1040, h: 560 }} dof focus={[22, 22]} title="Agate's market screen, live" />
          </div>
          <div className={u.cap} data-rv="fade">
            <h3>One open price, and the month you can trade.</h3>
            <p>Today&apos;s index for an hour of H100 next to {r.month}&apos;s market, live from the testnet.</p>
          </div>
          <div className={k.sp} />
          <div className={u.pair}>
            <div>
              <div data-rv="media">
                <AppFrame className={u.macro} crop={{ x: 1048, y: 160, w: 384, h: 400 }} dof focus={[50, 30]} title="Agate's trade ticket, live" />
              </div>
              <div className={u.cap} data-rv="fade">
                <h3>Go long or short</h3>
                <p>Long gains when GPU hours cost more. Short gains when they cost less.</p>
              </div>
            </div>
            <div>
              <div data-rv="media">
                <AppFrame className={u.macro} crop={{ x: 0, y: 380, w: 760, h: 792 }} dof focus={[60, 45]} title="Agate's price chart, live" />
              </div>
              <div className={u.cap} data-rv="fade">
                <h3>Settled every day</h3>
                <p>Each day settles on that day&apos;s price. Choose daily pay and it lands the next morning.</p>
              </div>
            </div>
          </div>
        </div>
        <div className={k.sp} />
      </section>

      <section aria-label="Live">
        <div className={k.sp} />
        <div className={k.wrap}>
          <p className={u.statement} data-rv="fade">
            Every number on this page was read live from the testnet the moment you opened it.
          </p>
        </div>
        <div className={k.sp} />
      </section>

      <section className={k.wrap} aria-label="Start">
        <div className={u.start}>
          <div>
            <Head className={k.d3}>Start in a minute.</Head>
            <div className={u.steps} data-rv="set">
              <div className={u.stepRow}>
                <span className={u.stepN}>1</span>
                <span className={u.stepT}>Sign in with email, Google or a passkey. No wallet needed.</span>
              </div>
              <div className={u.stepRow}>
                <span className={u.stepN}>2</span>
                <span className={u.stepT}>Pick a GPU and a month, then go Long or Short.</span>
              </div>
              <div className={u.stepRow}>
                <span className={u.stepN}>3</span>
                <span className={u.stepT}>Get paid as each day settles, or close any time.</span>
              </div>
            </div>
            <div style={{ marginTop: 32 }}>
              <Go kind="ink">Get started</Go>
            </div>
          </div>
          <div className={u.glassPanel} data-rv="media">
            <GlassColumns data={r.gpus} dark />
          </div>
        </div>
      </section>
      <div className={k.sp} />

      <section className={`${u.dark} tone-dark`} data-close aria-label="Close">
        <div className={k.sp} />
        <div className={`${k.wrap} ${u.center}`}>
          <Head className={k.d2}>The price of compute, made tradable.</Head>
          <Go kind="paper">Get started</Go>
        </div>
        <div className={k.sp} />
      </section>
      <Foot3 />
      <Sticky />
    </div>
  );
}

function CloudMarquee({ r }: { r: R3 }) {
  const names = Array.from(new Set(r.gpus.flatMap((g) => g.clouds.map((c) => c.name))));
  const list = names.length ? names : ["Lambda", "Nebius", "CoreWeave", "Civo", "Verda"];
  const row = list.map((n) => (
    <span key={n} className={u.cloudName}>
      {n}
    </span>
  ));
  return (
    <div className={u.marquee} aria-label={`Clouds Agate reads: ${list.join(", ")}`}>
      <div className={u.track}>
        {row}
        {row}
        {row}
      </div>
    </div>
  );
}
