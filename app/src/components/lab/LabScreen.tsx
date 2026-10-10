"use client";
// Asset lab, round 2. Seven assets taken from a deep
// walk of 41 reference sites (brand-20261007/ref-deep/), each made from Agate's own product: today's cloud prices,
// the six GPUs, the November market, the GPU-hours open, the AI approval flow and the real app. Live testnet data by
// default; light and dark from Mock controls. Nothing generated.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useScreenTheme } from "@/components/ai/AisScreen";
import { usd } from "@/lib/format";
import { useMock } from "@/lib/mock/store";
import { AgentFlow } from "./AgentFlow";
import { CloudsToOne } from "./CloudsToOne";
import { ContractObject } from "./ContractObject";
import { useLabData, type LabGpu } from "./data";
import { GlassColumns } from "./GlassColumns";
import { HoursField } from "./HoursField";
import { PriceBoard } from "./PriceBoard";
import { Staged } from "./Staged";
import s from "./lab.module.css";

function Cap({ n, title, after, children }: { n: number; title: string; after: string; children: React.ReactNode }) {
  return (
    <div className={s.cap}>
      <span className={s.n}>{n}</span>
      <h2>{title}</h2>
      <p>{children}</p>
      <p className={s.after}>After {after}</p>
    </div>
  );
}

/** The staged laptop and phone are drawn at a fixed 1000 px; narrower screens scale the whole stage. */
function Fit({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setK(Math.min(1, (el.clientWidth - 24) / 1000)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ height: 640 * k }}>
      <div className={s.stage} style={{ transform: `scale(${k})` }}>
        {children}
      </div>
    </div>
  );
}

function Strip({ data }: { data: LabGpu[] }) {
  const open = data.reduce((a, g) => a + (g.month?.open ?? 0), 0);
  return (
    <div className={s.strip}>
      {data
        .filter((g) => g.price > 0)
        .map((g) => (
          <span key={g.gpu}>
            {g.gpu} <b>{usd(g.price)}</b>
          </span>
        ))}
      <span>
        <b>{Math.round(open).toLocaleString("en-US")}</b> GPU-hours open
      </span>
    </div>
  );
}

export function LabScreen() {
  const { config } = useMock();
  const tone = useScreenTheme();
  const { gpus } = useLabData();
  const dark = config.theme === "dark";
  const h100 = gpus.find((g) => g.gpu === "H100")!;
  useEffect(() => {
    document.title = "Agate · Asset lab";
  }, []);
  return (
    <div className={`${tone} ${s.page}`}>
      <header className={s.head}>
        <h1>Asset lab, round 2</h1>
        <p>Seven assets made from the product itself, the way the references do it: today&apos;s real prices from the live testnet, the market, the GPU-hours, the AI flow and the real app. All made in code; nothing generated, nothing from the logo.</p>
      </header>

      <section className={s.sec} aria-label="Clouds in, one price out">
        <div className={`tone-dark ${s.darkStage}`}>
          <CloudsToOne data={gpus} dark />
        </div>
        <Cap n={1} title="Five clouds in, one price out" after="Public's prediction-market lines, Stripe's transaction fan, Computable's one number">
          What Agate does, drawn from today&apos;s reads. Each cloud that priced the GPU today is a stream starting at its own price; they meet at the index, the middle of them. Pick another GPU and the streams re-form.
        </Cap>
      </section>

      <section className={s.sec} aria-label="What an hour costs">
        <div className={s.panel}>
          <PriceBoard data={gpus} />
        </div>
        <Cap n={2} title="What an hour costs, everywhere" after="Silicon Data's index tiles, Metronome's rate card, Kalshi's ladder">
          The six GPUs on one dollar scale. Each dot is one cloud today, the bar is Agate&apos;s index. The same hour can cost twice as much at one cloud as at another; the index is the one number in the middle.
        </Cap>
      </section>

      <section className={s.sec} aria-label="Six GPUs as glass">
        <div className={s.glassStage}>
          <GlassColumns data={gpus} dark={dark} />
        </div>
        <Cap n={3} title="Six GPUs, one open price, as glass" after="Wealthsimple's glass candlesticks, Robinhood Legend's chrome candles">
          Today&apos;s index for each GPU as a column of frosted glass, cheapest to dearest, rising to its price as it comes into view. The data&apos;s own shape made into a material, in WebGL.
        </Cap>
      </section>

      <section className={s.sec} aria-label="The real product, staged">
        <div className={s.stageWrap}>
          <Fit>
            <Staged theme={dark ? "dark" : "light"} />
          </Fit>
        </div>
        <Cap n={4} title="The real app, on a lit stage" after="Public's devices on a plinth, Mercury's film that ends on the dashboard">
          Not a mockup: the live market page and the phone layout running inside a laptop and a phone. The most common move in every reference group.
        </Cap>
      </section>

      <section className={s.sec} aria-label="One month as one object">
        <div className={s.contractStage}>{h100.month && <ContractObject g={h100} />}</div>
        <Cap n={5} title="One month of H100, as one object" after="Apple Card's interest wheel: one real component promoted to the hero">
          The November market at a glance: the band it settles in, today&apos;s index, what a Long and a Short cost now, and the thirty days that pay it out.
        </Cap>
      </section>

      <section className={s.sec} aria-label="Every GPU-hour, counted">
        <div className={s.panel}>
          <HoursField data={gpus} dark={dark} />
        </div>
        <Cap n={6} title="Every GPU-hour, counted" after="Modal's compute-unit glyphs, SF Compute's GPU-hour grid, Ornn's used and resold squares">
          The GPU-hours open on next month in each market, read right now, as a field of squares. The product&apos;s own unit as the image; it grows as people trade.
        </Cap>
      </section>

      <section className={s.sec} aria-label="Your AI trades">
        <div className={s.flowStage}>{h100.month && <AgentFlow g={h100} />}</div>
        <Cap n={7} title="Your AI trades, you hold the limit" after="Public's agent pipeline, Kraken's agent terminal, Linear's agent inside the issue">
          One real flow from the product&apos;s own pieces: the AI asks over Agate&apos;s connection, its pocket shows the limit it works within, the trade goes over it, and your approval decides. Live price, the app&apos;s own words.
        </Cap>
      </section>

      <section className={s.sec} aria-label="How they combine">
        <div className={`tone-dark ${s.combo}`}>
          <div className={s.comboCopy}>
            <h3>The price of compute, made tradable.</h3>
            <span className={s.comboLine}>Five clouds, one open price, every day. Go Long or Short on next month.</span>
          </div>
          <div className={s.comboArt}>
            <CloudsToOne data={gpus} dark compact />
          </div>
          <Strip data={gpus} />
        </div>
        <Cap n={8} title="How they combine" after="Ornn's live price as the headline, Ramp's live strip">
          One example of a first screen built from these parts: a headline, the streams meeting at today&apos;s price, and a strip of live numbers. About 20 words; the rest is the product.
        </Cap>
      </section>
    </div>
  );
}
