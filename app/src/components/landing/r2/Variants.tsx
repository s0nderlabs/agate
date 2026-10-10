"use client";
// The five round-2 landings. Same core line, same live numbers,
// same headline that changes per person; what differs is the method of telling what, why and how.
import { useLayoutEffect, useRef, useState } from "react";
import { AgentFlow } from "@/components/lab/AgentFlow";
import { ContractObject } from "@/components/lab/ContractObject";
import { GlassColumns } from "@/components/lab/GlassColumns";
import { HoursField } from "@/components/lab/HoursField";
import ls from "@/components/lab/lab.module.css";
import { PriceBoard } from "@/components/lab/PriceBoard";
import { Staged } from "@/components/lab/Staged";
import { usd } from "@/lib/format";
import { useMock } from "@/lib/mock/store";
import { Close, Core, example, Foot, Go, Jump, Nav, PriceChip, Rotator, Safe, sides, Steps, useR2, Who, type R2 } from "./parts";
import { PinnedMonth } from "./PinnedMonth";
import s from "./r2.module.css";

function useDark() {
  return useMock().config.theme === "dark";
}

/** The real app on a laptop and a phone, scaled to the column. */
function Stage() {
  const dark = useDark();
  const ref = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setK(Math.min(1, (el.clientWidth - 16) / 1000)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className={s.stageWrap}>
      {/* the 1000px stage sits out of flow, centred by hand: in flow it widened the grid track and drifted right on a phone */}
      <div ref={ref} style={{ height: 640 * k, width: "100%", position: "relative" }}>
        <div className={ls.stage} style={{ transform: `scale(${k})`, position: "absolute", top: 0, left: "50%", marginLeft: -500 }}>
          <Staged theme={dark ? "dark" : "light"} />
        </div>
      </div>
    </div>
  );
}

function Head({ h, p, center = false }: { h: string; p?: string; center?: boolean }) {
  return (
    <div className={`${s.head} ${center ? s.center : ""}`}>
      <h2>{h}</h2>
      {p && <p>{p}</p>}
    </div>
  );
}

/* 1. Agate's story (mine): what (hero + the real app), why (prices jump), how (the pinned month), open price, safety,
   AI, live proof, close with the one 3D object. */
export function Story() {
  const r = useR2();
  const dark = useDark();
  return (
    <div className={s.page}>
      <Nav />
      <section className={s.hero} aria-label="Hero">
        <Rotator r={r} align="center" />
        <Core center />
        <div className={`${s.row} ${s.center}`}>
          <Go />
          <Go soft href="/gpu-index">
            See today&apos;s prices
          </Go>
        </div>
        <PriceChip r={r} />
      </section>
      <Stage />
      <section className={s.sec} aria-label="Why">
        <Head h="GPU prices jump." p="Until now there was no open way to lock one in." center />
        <Jump r={r} />
      </section>
      <PinnedMonth r={r} />
      <section className={s.sec} aria-label="One open price">
        <Head h="One open price." p="Five clouds, read every day, published onchain for anyone to check or build on." center />
        <div className={s.panel}>
          <PriceBoard data={r.gpus} />
        </div>
      </section>
      <section className={s.sec} aria-label="Safety">
        <Safe />
      </section>
      <section className={`tone-dark ${s.band}`} aria-label="AI">
        <Head h="Your AI. Your limits." p="Let Claude or any AI trade for you, from its own pocket, within limits you set." center />
        <div className={s.flowBox}>{r.m && <AgentFlow g={r.h} />}</div>
      </section>
      <section className={s.sec} aria-label="Live">
        <div className={s.panel}>
          <HoursField data={r.gpus} dark={dark} />
        </div>
      </section>
      <section className={s.closeSec} aria-label="Start">
        <div className={s.glass}>
          <GlassColumns data={r.gpus} dark={dark} />
        </div>
        <Close />
      </section>
      <Foot />
    </div>
  );
}

/* 2. The simple one: one screen. The changing headline, the core line, then what, why and how in three columns. */
export function Simple() {
  const r = useR2();
  const m = r.m;
  return (
    <div className={`${s.page} ${s.simple}`}>
      <Nav />
      <section className={s.simpleHero} aria-label="Hero">
        <Rotator r={r} align="center" />
        <Core center />
        <div className={`${s.row} ${s.center}`}>
          <Go />
        </div>
      </section>
      <section className={s.three} aria-label="What, why, how">
        <div>
          <h2>What</h2>
          <p>One open price for an hour of GPU time, and a market to trade it.</p>
          <PriceChip r={r} />
        </div>
        <div>
          <h2>Why</h2>
          <p>GPU prices jump. Locking one in protects what you pay or what you earn.</p>
          <Jump r={r} compact />
        </div>
        <div>
          <h2>How</h2>
          <p>Pick a month, go Long or Short, and get paid as each day settles.</p>
          <div className={s.sidesArt}>
            <span data-side="long">Long {m ? usd(m.long) : ""}</span>
            <span data-side="short">Short {m ? usd(m.short) : ""}</span>
          </div>
        </div>
      </section>
      <Foot />
    </div>
  );
}

/* 3. What, why, how: the questions a new category has to answer, asked out loud, one picture each. */
export function Questions() {
  const r = useR2();
  return (
    <div className={s.page}>
      <Nav />
      <section className={`${s.hero} ${s.heroLeft}`} aria-label="Hero">
        <Rotator r={r} />
        <Core />
        <div className={s.row}>
          <Go />
          <Go soft href="/gpu-index">
            See today&apos;s prices
          </Go>
        </div>
      </section>
      <section className={s.qa} aria-label="What is Agate?">
        <Head h="What is Agate?" p="A market for the price of compute: one open price for an hour of GPU time, and a way to go long or short on it." />
        <Stage />
      </section>
      <section className={s.qa} aria-label="Why does it matter?">
        <Head h="Why does it matter?" p="GPU prices move fast and differ from cloud to cloud. If you pay for GPUs or rent them out, every move hits your margin." />
        <Jump r={r} />
      </section>
      <section className={s.qa} aria-label="How does it work?">
        <Head h="How does it work?" />
        <Steps r={r} />
      </section>
      <section className={s.qa} aria-label="Who is it for?">
        <Head h="Who is it for?" />
        <Who r={r} />
      </section>
      <section className={s.qa} aria-label="Is it safe?">
        <Head h="Is it safe?" p="Every trade is fully backed. The most you can lose is what you put in. No margin calls, no liquidations." />
      </section>
      <section className={s.closeSec} aria-label="Start">
        <Close />
      </section>
      <Foot />
    </div>
  );
}

/* 4. Pick your side: the headline and a tab row move together; each side gets a worked example in live numbers. */
export function SidesPage() {
  const r = useR2();
  const list = sides(r);
  const [tab, setTab] = useState(0);
  const [held, setHeld] = useState(false);
  const m = r.m;
  const lx = example(r, "long"), sx = example(r, "short");
  useLayoutEffect(() => {
    if (held) return;
    if (typeof window !== "undefined" && window.location.search.includes("still=1")) return;
    const t = window.setInterval(() => setTab((x) => (x + 1) % list.length), 4200);
    return () => window.clearInterval(t);
  }, [held, list.length]);
  const pick = (i: number) => {
    setHeld(true);
    setTab(i);
  };
  const key = list[tab].key;
  return (
    <div className={s.page}>
      <Nav />
      <section className={s.hero} aria-label="Hero">
        <Rotator r={r} align="center" index={tab} />
        <Core center />
        <div className={s.tabs} role="tablist" aria-label="Who you are">
          {["Paying for GPUs", "Renting out GPUs", "Trading", "Building with AI"].map((t, i) => (
            <button key={t} role="tab" aria-selected={tab === i} className={tab === i ? s.pillOn : s.pill} onClick={() => pick(i)}>
              {t}
            </button>
          ))}
        </div>
      </section>
      <section className={s.side} aria-label="Your side">
        {key === "pay" && m && lx && (
          <>
            <div className={s.sideText}>
              <h2>Your GPU bill, locked.</h2>
              <p>
                You rent H100s for {m.name}. Go Long at {usd(m.long)} an hour. If {m.name} averages {usd(lx.at)}, your Long pays you {usd(lx.gain)} an hour back.
              </p>
              <p className={s.sideBig}>You still pay {usd(lx.lock)}.</p>
              <Go />
            </div>
            <ContractObject g={r.h} focus="long" />
          </>
        )}
        {key === "earn" && m && sx && (
          <>
            <div className={s.sideText}>
              <h2>Your GPU income, locked.</h2>
              <p>
                You rent out H100s. Go Short at {usd(m.short)} an hour. If {m.name} averages {usd(sx.at)}, your Short pays you {usd(sx.gain)} an hour.
              </p>
              <p className={s.sideBig}>You still earn {usd(sx.lock)}.</p>
              <Go />
            </div>
            <ContractObject g={r.h} focus="short" />
          </>
        )}
        {key === "trade" && (
          <>
            <div className={s.sideText}>
              <h2>Trade the price of compute.</h2>
              <p>Think GPUs will cost more next month? Go Long. Less? Go Short. Close any time before the month ends.</p>
              <Go />
            </div>
            <div className={s.panel}>
              <PriceBoard data={r.gpus} />
            </div>
          </>
        )}
        {key === "ai" && (
          <>
            <div className={s.sideText}>
              <h2>Your AI. Your limits.</h2>
              <p>Connect Claude or any AI. It trades from its own pocket and asks you before it goes over its limit.</p>
              <Go />
            </div>
            <div className={s.flowBox}>{m && <AgentFlow g={r.h} />}</div>
          </>
        )}
      </section>
      <section className={s.sec} aria-label="How it works">
        <Head h="How it works" center />
        <Steps r={r} />
      </section>
      <section className={s.sec} aria-label="Safety">
        <Safe />
      </section>
      <section className={s.closeSec} aria-label="Start">
        <Close />
      </section>
      <Foot />
    </div>
  );
}

/* 5. The market first: the live November market is the hero object (Kalshi and Ornn put the product on top); the
   explanation follows in short steps. */
export function MarketFirst() {
  const r = useR2();
  return (
    <div className={s.page}>
      <Nav />
      <section className={s.split} aria-label="Hero">
        <div className={s.splitText}>
          <Rotator r={r} size="lg" />
          <Core />
          <div className={s.row}>
            <Go />
            <Go soft href="/gpu-index">
              See today&apos;s prices
            </Go>
          </div>
        </div>
        <ContractObject g={r.h} />
      </section>
      <Ticker r={r} />
      <section className={s.sec} aria-label="Why">
        <div className={s.why2}>
          <Head h="Why lock a GPU price?" p="Because it moves. If you pay for GPUs, a jump eats your margin. If you rent them out, a drop does." />
          <Jump r={r} />
        </div>
      </section>
      <section className={s.sec} aria-label="How it works">
        <Head h="How it works" center />
        <Steps r={r} />
      </section>
      <section className={`tone-dark ${s.band}`} aria-label="AI">
        <Head h="Your AI. Your limits." p="Let Claude or any AI trade for you, within limits you set." center />
        <div className={s.flowBox}>{r.m && <AgentFlow g={r.h} />}</div>
      </section>
      <section className={s.sec} aria-label="Safety">
        <Safe />
      </section>
      <section className={s.closeSec} aria-label="Start">
        <Close />
      </section>
      <Foot />
    </div>
  );
}

function Ticker({ r }: { r: R2 }) {
  return (
    <div className={s.ticker} aria-label="Today's prices">
      {r.gpus
        .filter((g) => g.price > 0)
        .map((g) => (
          <span key={g.gpu}>
            {g.gpu} <b>{usd(g.price)}</b>
          </span>
        ))}
      <span>
        <b>{Math.round(r.open).toLocaleString("en-US")}</b> GPU-hours open
      </span>
    </div>
  );
}
