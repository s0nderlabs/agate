"use client";
// The landing's sections, one set of words: each page passes its own classes (c), so the same section reads in that
// page's grammar. A class a page leaves out is simply unstyled there.
import type { ReactNode } from "react";
import { COPY, Cta, GpuPrice, IndexLink, P, type Live } from "./kit";

type C = Record<string, string | undefined>;

export function Why({ c, children }: { c: C; children?: ReactNode }) {
  return (
    <section className={c.why}>
      <div className={c.whyInner}>
        <h2 className={`${c.whyTitle ?? ""} font-display`}>{COPY.why.title}</h2>
        <p className={c.whyText}>{COPY.why.text}</p>
      </div>
      {children}
    </section>
  );
}

export function How({ c, title = "How it works", numbered = true }: { c: C; title?: string; numbered?: boolean }) {
  return (
    <section className={c.how}>
      <h2 className={`${c.howTitle ?? ""} font-display`}>{title}</h2>
      <ol className={c.steps}>
        {COPY.how.map((s, i) => (
          <li key={s.t} className={c.step}>
            {numbered && <span className={c.stepNum}>{i + 1}</span>}
            <h3 className={c.stepTitle}>{s.t}</h3>
            <p className={c.stepText}>{s.d}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Doors({ c, title = "Four ways in", art }: { c: C; title?: string; art?: (i: number) => ReactNode }) {
  return (
    <section className={c.doors}>
      <h2 className={`${c.doorsTitle ?? ""} font-display`}>{title}</h2>
      <ul className={c.doorList}>
        {COPY.doors.map((d, i) => (
          <li key={d.t} className={c.door}>
            {art?.(i)}
            <h3 className={c.doorTitle}>{d.t}</h3>
            <p className={c.doorText}>{d.d}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Gpus({ c, live }: { c: C; live: Live }) {
  return (
    <ul className={c.gpus} aria-label="GPUs priced">
      {live.gpus.map((g) => (
        <li key={g.g} className={c.gpu}>
          <span className={`${c.gpuName ?? ""} font-display`}>{g.g}</span>
          <span className={c.gpuPrice}>
            {g.price ? (
              <>
                <P v={g.price} /> {g.tradable ? "an hour" : "an hour, price only"}
              </>
            ) : (
              "Price soon"
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Clouds({ c, live }: { c: C; live: Live }) {
  return (
    <ol className={c.clouds} aria-label="Today's H100 prices, one per cloud">
      {live.clouds.map((x) => (
        <li key={x.name} className={`${c.cloud ?? ""} ${x.mid ? (c.cloudMid ?? "") : ""}`}>
          <span className={c.cloudName}>{x.name}</span>
          <span className={c.cloudPrice}>
            <P v={x.price} />
          </span>
          {x.mid && <span className={c.cloudNote}>Sets today's price</span>}
        </li>
      ))}
    </ol>
  );
}

export function Proof({ c, live }: { c: C; live: Live }) {
  return (
    <section className={c.proof}>
      <div className={c.proofInner}>
        <h2 className={`${c.proofTitle ?? ""} font-display`}>{COPY.proof.title}</h2>
        <p className={c.proofText}>{COPY.proof.text}</p>
        <IndexLink className={c.proofCta} />
      </div>
      <dl className={c.stats}>
        <div className={c.stat}>
          <dt>H100 today</dt>
          <dd className="font-display">
            <P v={live.price} />
          </dd>
        </div>
        <div className={c.stat}>
          <dt>Clouds counted</dt>
          <dd className="font-display">{live.clouds.length ? `${live.clouds.length} of ${live.clouds.length}` : "5 of 5"}</dd>
        </div>
        <div className={c.stat}>
          <dt>{live.month} settles between</dt>
          <dd className="font-display">{live.floor ? `$${live.floor.toFixed(2)} to $${live.cap.toFixed(2)}` : "$0.00 to $0.00"}</dd>
        </div>
      </dl>
    </section>
  );
}

export function Close({ c }: { c: C }) {
  return (
    <section className={c.close}>
      <h2 className={`${c.closeTitle ?? ""} font-display`}>{COPY.close.title}</h2>
      <p className={c.closeText}>{COPY.close.text}</p>
      <Cta className={c.closeCta} />
    </section>
  );
}
