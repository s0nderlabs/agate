"use client";
// The landing as a site (Oct 10). Oct 9: the chip dive stays, the rest of the story goes;
// Oct 10: the page explains a compute market, not chips, on the
// plan built from Public's prediction markets page (a page that brings a new kind of market to people, with no device
// on it). So: the hero and the dive stay one pinned moment (Story, site mode, about 2.75 screens); the dive lets go on
// the turn ("Every GPU hour has a price. Now you can trade it."); then an ordinary page in Public's order, each section its own
// shape and one piece of the product: what makes Agate different, your AI, five clouds one price, paid every day,
// build on the price, questions, the close and the footer. One straight edge to paper after the AI, one back to dark
// for the close. Motion is local only: a quiet rise as a section comes in, a tab or a switch the reader moves.
// Oct 10: one nav, the
// hero's (the product bar is gone), and one system for the whole page with the hero (site.module.css, THE SYSTEM): the
// page takes the hero's corner setting, the Buttons row, so the hero and every section below it share one corner.
// Oct 10: square is the app's panel grid (site.module.css, SQUARE): rails, hairlines that meet them with a mark,
// product on a dotted stage, two dark panels like the trade screen's chart and ticket, no shadows. Round keeps the
// page before it. Same day: the problem comes right after
// the dive as a number ("+17%", one cloud, one night), no head repeats the grey second line, and the heads change shape
// section to section (number, split, centred, stacked, panel, centred close) instead of one head-left, text-right row.
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Lockup } from "@/components/brand/Logo";
import { stillMode } from "@/components/lab/data";
import { usd0 } from "@/lib/format";
import { useMock } from "@/lib/mock/store";
import { useHero, useHref, usd } from "../hero/kit";
import { CLOUDS_THEN, JUMP, POCKET, Story } from "../story/Story";
import s from "./site.module.css";

/** H100 November when the month has not come in (docs, The monthly market: floor $1.95, ceiling $8.00, 30 days) */
const MONTH_THEN = { name: "November", month: "2026-11", floor: 1.95, cap: 8, days: 30 };

const Arrow = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 8h10M9 4l4 4-4 4" />
  </svg>
);
const Check = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);
const CopyIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
    <path d="M9 9h11v11H9z" />
    <path d="M5 15H4V4h11v1" />
  </svg>
);
const Spark = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
  </svg>
);

/** Long or Short, as the app's ticket switches it */
function Sides({ side, set, label }: { side: "long" | "short"; set: (v: "long" | "short") => void; label: string }) {
  return (
    <div className={s.seg} role="group" aria-label={label}>
      <button type="button" aria-pressed={side === "long"} data-side="long" onClick={() => set("long")}>
        Long
      </button>
      <button type="button" aria-pressed={side === "short"} data-side="short" onClick={() => set("short")}>
        Short
      </button>
    </div>
  );
}

type Money = { index: number; ask: number; bid: number; floor: number; cap: number; days: number; month: string; mon: string; ym: string; clouds: number };

export function Site({ hero, turnAt = "beside" }: { hero: ReactNode; turnAt?: "beside" | "under" }) {
  const { config } = useMock();
  const tone = config.theme === "dark" ? "dark" : "light";
  const r = useHero();
  const to = useHref();
  const clouds = useMemo(() => {
    const live = (r.h.clouds ?? []).filter((c) => c.price > 0);
    return live.length >= 3 ? live : CLOUDS_THEN;
  }, [r.h.clouds]);
  const index = r.h.price > 0 ? r.h.price : clouds[Math.floor(clouds.length / 2)].price;
  const m = r.m;
  const M: Money = {
    index,
    ask: m && m.long > 0 ? m.long : index,
    bid: m && m.short > 0 ? m.short : index,
    floor: m && m.floor > 0 ? m.floor : MONTH_THEN.floor,
    cap: m && m.cap > 0 ? m.cap : MONTH_THEN.cap,
    days: m && m.days > 0 ? m.days : MONTH_THEN.days,
    month: m?.name ?? MONTH_THEN.name,
    mon: (m?.name ?? MONTH_THEN.name).slice(0, 3),
    ym: m?.month ?? MONTH_THEN.month,
    clouds: clouds.length,
  };
  const n = clouds.length;

  const root = useRef<HTMLDivElement>(null);

  // a quiet rise as each part comes in (all at once in a still check or with reduced motion)
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const items = [...el.querySelectorAll<HTMLElement>("[data-rv]")];
    if (stillMode() || typeof IntersectionObserver === "undefined") {
      // no fade in a still: a background tab never runs the transition, so a capture would catch it at 0
      items.forEach((i) => {
        i.style.transition = "none";
        i.setAttribute("data-in", "");
      });
      return;
    }
    const io = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (e.isIntersecting) {
            e.target.setAttribute("data-in", "");
            io.unobserve(e.target);
          }
        }),
      { rootMargin: "0px 0px -10% 0px" },
    );
    items.forEach((i) => io.observe(i));
    return () => io.disconnect();
    // a switch that swaps a part in (the AI section's layout, the close, the payout piece) brings unseen ones
  }, [config.aiUi, config.closeArt, config.payUi]);

  const turn = (
    <>
      <h2 className={s.turnH}>
        <span data-l>Every GPU hour has a price.</span>
        <span data-l className={s.turnTail}>
          Now you can trade it.
        </span>
      </h2>
      <p className={s.turnLine} data-l>
        Lock in what you pay, protect what you earn, or trade where it goes next.
      </p>
      <div className={s.turnPrice} data-l>
        <b>{usd(index)}</b>
        <span>
          What an H100 hour costs today, across {n} clouds
        </span>
      </div>
      <div className={s.turnActs} data-l>
        <Link href={to("/app")} className={s.turnCta}>
          Trade H100
          <Arrow />
        </Link>
        <Link href={to("/docs/the-price")} className={s.turnGhost}>
          How it&rsquo;s priced
        </Link>
      </div>
    </>
  );

  return (
    <div ref={root} className={s.site} data-tone={tone} data-corners={config.corners} data-sq={config.corners === "round" ? undefined : ""}>
      <Story hero={hero} site turnAt={turnAt} turn={turn} />

      <Jump />
      <Different M={M} to={to} />
      <YourAi M={M} held={config.aiUi === "held"} to={to} />
      <Clouds clouds={clouds} index={index} date={r.h.date} to={to} />
      <Daily M={M} grid={config.payUi === "grid"} to={to} />
      <Build index={index} to={to} />
      <Questions to={to} />
      <Close to={to} art={config.closeArt} />
    </div>
  );
}

type To = (path: string) => string;

/* ------------------------------------------------------------------ 3. why it matters: the price jumps (the number is the head) */
function Jump() {
  const rise = Math.round((JUMP.to / JUMP.from - 1) * 100);
  return (
    <section className={s.sec} data-g="dark" data-rule="" aria-labelledby="s-jump">
      <div className={`${s.wrap} ${s.jump}`}>
        <h2 id="s-jump" className={`${s.jumpH} ${s.rv}`} data-rv>
          <span className={s.jumpN}>+{rise}%</span>
          <span className={s.jumpCap}>in one night, on one cloud.</span>
        </h2>
        <div className={`${s.jumpR} ${s.rv}`} data-rv data-d="1">
          <div className={s.jumpRows}>
            <div className={s.pieceHead}>
              <b>{JUMP.cloud}, one H100 hour</b>
            </div>
            <div className={s.row}>
              <span>{JUMP.before}</span>
              <b>{usd(JUMP.from)}</b>
            </div>
            <div className={s.row}>
              <span>{JUMP.after}</span>
              <b>{usd(JUMP.to)}</b>
            </div>
          </div>
          <p className={s.src}>
            From Nebius&rsquo;s public price list,{" "}
            <a href={JUMP.proof} target="_blank" rel="noopener noreferrer">
              as the Internet Archive saved it on {JUMP.after}
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                <path d="M5 11 11 5M6 5h5v5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </a>
          </p>
          <p className={s.lede}>GPU prices jump like this without warning. Until now, there was no open way to lock one in.</p>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ 4. what makes Agate different */
function Different({ M, to }: { M: Money; to: To }) {
  const [side, setSide] = useState<"long" | "short">("long");
  const long = side === "long";
  return (
    <section className={s.sec} data-g="dark" data-rule="" aria-labelledby="s-diff">
      <div className={s.wrap}>
        <div className={`${s.capRow} ${s.rv}`} data-rv>
          <h2 id="s-diff" className={s.h2}>
            An open market for GPU hours.
          </h2>
          <p className={s.lede}>No GPU changes hands. You trade what an hour of one costs, in dollars, and you can never lose more than you put in.</p>
        </div>
        <div className={`${s.frame3} ${s.bleed} ${s.reg} ${s.rv}`} data-rv data-d="1">
          <article className={s.col}>
            <h3 className={s.h3}>Go Long or Short</h3>
            <div className={s.stage}>
            <div className={s.piece}>
              <div className={s.pieceHead}>
                <b>H100, {M.month}</b>
                <span>100 GPU-hours</span>
              </div>
              <Sides side={side} set={setSide} label="Side" />
              <div className={s.rows}>
                {long ? (
                  <>
                    <div className={s.row}>
                      <span>You pay</span>
                      <b>{usd(100 * M.ask)}</b>
                    </div>
                    <div className={s.row}>
                      <span>Most you can lose</span>
                      <b>{usd(100 * (M.ask - M.floor))}</b>
                    </div>
                  </>
                ) : (
                  <>
                    <div className={s.row}>
                      <span>You put up</span>
                      <b>{usd(100 * (M.cap - M.bid))}</b>
                    </div>
                    <div className={s.row}>
                      <span>Most you can make</span>
                      <b>{usd(100 * (M.bid - M.floor))}</b>
                    </div>
                  </>
                )}
              </div>
            </div>
            </div>
            <p className={s.body}>Renting GPUs? Go Long and lock in what you pay. Renting them out? Go Short and lock in what you earn.</p>
            <Link href={to("/app")} className={s.link}>
              Open the market
            </Link>
          </article>
          <article className={s.col}>
            <h3 className={s.h3}>Let your AI trade</h3>
            <div className={s.stage}>
            <div className={s.piece}>
              <div className={s.pieceHead}>
                <b>Your AI&rsquo;s budget</b>
                <span>{usd0(POCKET.budget)}</span>
              </div>
              <div className={s.rows}>
                <div className={s.row}>
                  <span>Per trade, up to</span>
                  <b>{usd0(POCKET.cap)}</b>
                </div>
                <div className={s.row}>
                  <span>Trades per day</span>
                  <b>{POCKET.perDay}</b>
                </div>
              </div>
              <div className={s.ok}>
                <Check />
                Checked against your limits, every time
              </div>
            </div>
            </div>
            <p className={s.body}>Connect any AI. It trades from a budget you set, and nothing beyond it.</p>
            <Link href={to("/docs/connect-an-ai")} className={s.link}>
              Connect your AI
            </Link>
          </article>
          <article className={s.col}>
            <h3 className={s.h3}>Build on the price</h3>
            <div className={s.stage}>
            <div className={s.piece}>
              <div className={s.pieceHead}>
                <b>H100, one hour</b>
                <span>updated daily</span>
              </div>
              <div className={s.big}>{usd(M.index)}</div>
              <div className={s.rows}>
                <div className={s.row}>
                  <span>Sources</span>
                  <b>{M.clouds} clouds</b>
                </div>
                <div className={s.row}>
                  <span>Every source</span>
                  <b>shown</b>
                </div>
              </div>
            </div>
            </div>
            <p className={s.body}>One open price per GPU, every day. Use it in your app, your contract or your models.</p>
            <Link href={to("/app/gpu-index")} className={s.link}>
              See the index
            </Link>
          </article>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ 5. your AI, inside your limits */
const AI_STEPS = [
  { t: "Set the budget", d: "Choose how much it can spend, per trade and per day, and when it stops." },
  { t: "It trades on its own", d: "Inside your rules, it just goes. Every trade is checked twice." },
  { t: "It asks before going bigger", d: "Anything over the limit comes to you. Approve it or decline it." },
];

function AiCard({ step, M }: { step: number; M: Money }) {
  const [said, setSaid] = useState<"" | "yes" | "no">("");
  const small = 50 * M.ask, big = 100 * M.ask;
  if (step === 0)
    return (
      <div className={s.aiCard}>
        <div className={s.aiTop}>
          <span className={s.aiMark}>
            <Spark />
          </span>
          Your AI&rsquo;s budget
        </div>
        <div className={s.big}>{usd0(POCKET.budget)}</div>
        <div className={s.rows}>
          <div className={s.row}>
            <span>Per trade, up to</span>
            <b>{usd0(POCKET.cap)}</b>
          </div>
          <div className={s.row}>
            <span>Trades per day</span>
            <b>{POCKET.perDay}</b>
          </div>
          <div className={s.row}>
            <span>Ends</span>
            <b>
              {M.mon} {M.days}
            </b>
          </div>
        </div>
      </div>
    );
  if (step === 1)
    return (
      <div className={s.aiCard}>
        <div className={s.aiTop}>
          <span className={s.aiMark}>
            <Spark />
          </span>
          Your AI made a trade
        </div>
        <p className={s.aiAsk}>
          Bought <b>50 GPU-hours</b> of H100 for {M.month} at <b>{usd(M.ask)}</b>
        </p>
        <div className={s.meter}>
          <div className={s.meterRow}>
            <span>{usd(small)} of its limit</span>
            <span>{usd0(POCKET.cap)}</span>
          </div>
          <div className={s.meterBar}>
            <i style={{ width: `${Math.min(100, (small / POCKET.cap) * 100).toFixed(1)}%` }} />
          </div>
        </div>
        <div className={s.ok}>
          <Check />
          Paid from its own budget. 1 of {POCKET.perDay} trades today.
        </div>
      </div>
    );
  return (
    <div className={s.aiCard}>
      <div className={s.aiTop}>
        <span className={s.aiMark}>
          <Spark />
        </span>
        Your AI needs your OK
      </div>
      <p className={s.aiAsk}>
        Buy <b>100 GPU-hours</b> of H100 for {M.month} at <b>{usd(M.ask)}</b>
      </p>
      <p className={s.aiWhy}>
        That&rsquo;s {usd0(big)}, over its {usd0(POCKET.cap)} limit per trade.
      </p>
      <div className={s.aiActs}>
        <button type="button" className={s.aiNo} onClick={() => setSaid(said === "no" ? "" : "no")}>
          {said === "no" ? "Declined" : "Decline"}
        </button>
        <button type="button" className={s.aiYes} onClick={() => setSaid(said === "yes" ? "" : "yes")}>
          {said === "yes" ? (
            <>
              <Check />
              Approved
            </>
          ) : (
            "Approve"
          )}
        </button>
      </div>
    </div>
  );
}

/** what the person told their AI, wired to the card */
function Told({ M }: { M: Money }) {
  return (
    <div className={s.told}>
      <span>You</span>
      <p>Keep our {M.month} GPU costs locked in. Stay within budget.</p>
    </div>
  );
}

function YourAi({ M, held, to }: { M: Money; held: boolean; to: To }) {
  const [step, setStep] = useState(0);
  const blocks = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(() => {
    if (!held || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (e.isIntersecting) setStep(Number((e.target as HTMLElement).dataset.k));
        }),
      { rootMargin: "-45% 0px -45% 0px" },
    );
    blocks.current.forEach((b) => b && io.observe(b));
    return () => io.disconnect();
  }, [held]);
  const head = (
    <div className={`${s.capRow} ${s.rv}`} data-rv data-lay="center">
      <h2 id="s-ai" className={s.h2}>
        Hand the trading to your AI.
      </h2>
      <div>
        <p className={s.lede}>Set a budget and a few rules. Your AI trades inside them, and asks you before anything bigger.</p>
        <Link href={to("/docs/ai-pockets")} className={s.link}>
          How AI trading works
        </Link>
      </div>
    </div>
  );
  return (
    <section className={s.sec} data-g="dark" data-cont="" data-rule="" aria-labelledby="s-ai">
      <div className={s.wrap}>
        {head}
        {held ? (
          <div className={s.held}>
            <div className={s.heldWords}>
              {AI_STEPS.map((x, k) => (
                <div key={x.t} ref={(e) => void (blocks.current[k] = e)} data-k={k} className={s.heldBlock} data-on={step === k ? "1" : "0"}>
                  <h3 className={s.h3}>{x.t}</h3>
                  <p className={s.body}>{x.d}</p>
                </div>
              ))}
            </div>
            <div className={s.heldCard}>
              <div className={s.panel}>
                <AiCard key={step} step={step} M={M} />
              </div>
            </div>
          </div>
        ) : (
          <div className={`${s.aiGroup} ${s.bleed} ${s.reg} ${s.rv}`} data-rv data-d="1">
            <div className={s.panel} id="ai-panel" role="tabpanel" aria-labelledby={`ai-tab-${step}`}>
              <div className={s.flow}>
                <Told M={M} />
                <i className={s.wire} aria-hidden />
                <AiCard key={step} step={step} M={M} />
              </div>
            </div>
            <div className={s.tabs3} role="tablist" aria-label="Your AI">
              {AI_STEPS.map((x, k) => (
                <button
                  key={x.t}
                  id={`ai-tab-${k}`}
                  type="button"
                  role="tab"
                  aria-selected={step === k}
                  aria-controls="ai-panel"
                  className={s.tab}
                  onClick={() => setStep(k)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                      e.preventDefault();
                      const nx = (k + (e.key === "ArrowRight" ? 1 : 2)) % 3;
                      setStep(nx);
                      document.getElementById(`ai-tab-${nx}`)?.focus();
                    }
                  }}
                  tabIndex={step === k ? 0 : -1}
                >
                  <b>{x.t}</b>
                  <span>{x.d}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ 6. five clouds, one price */
function Clouds({ clouds, index, date, to }: { clouds: { name: string; price: number }[]; index: number; date: string; to: To }) {
  const sorted = [...clouds].sort((a, b) => a.price - b.price);
  const lo = Math.floor(Math.min(...sorted.map((c) => c.price), index) * 2) / 2 - 0.5;
  const hi = Math.ceil(Math.max(...sorted.map((c) => c.price), index) * 2) / 2 + 0.5;
  const x = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo); v <= hi; v += 1) ticks.push(v);
  // the cloud the price sits on (the middle one)
  const mid = sorted.reduce((b, c, i) => (Math.abs(c.price - index) < Math.abs(sorted[b].price - index) ? i : b), 0);
  const n = sorted.length;
  return (
    <section className={s.sec} data-g="paper" aria-labelledby="s-clouds">
      <div className={s.wrap}>
        <div className={`${s.capRow} ${s.rv}`} data-rv data-lay="price">
          <div>
            <h2 id="s-clouds" className={s.h2}>
              See where the price comes from.
            </h2>
            <p className={s.lede}>
              Every cloud sets its own price for an H100 hour, and they rarely agree. Agate checks them all every hour and takes the middle, so no single cloud can move it.
            </p>
            <Link href={to("/docs/the-price")} className={s.link}>
              How the price is made
            </Link>
          </div>
          <div className={s.live}>
            <b>{usd(index)}</b>
            <span>
              Agate&rsquo;s H100 price today, the middle of {n} clouds
            </span>
          </div>
        </div>
        <figure className={`${s.fig} ${s.bleed} ${s.reg} ${s.rv}`} data-rv data-d="1">
          <div className={s.figTop}>
            <span>What an H100 hour costs on each cloud</span>
            <span>{date ? `Checked ${date}` : "Checked today"}</span>
          </div>
          <div className={s.plot} role="img" aria-label={`${sorted.map((c) => `${c.name} ${usd(c.price)}`).join(", ")}. The middle, ${usd(index)}, is Agate's price.`}>
            <div className={s.axisLine} />
            {ticks.map((v) => (
              <span key={v} className={s.tick} style={{ left: `${x(v)}%` }}>
                ${v}
              </span>
            ))}
            {sorted.map((c, i) => (
              <div key={c.name}>
                <i className={s.dot} style={{ left: `${x(c.price)}%` }} data-mid={i === mid ? "" : undefined} />
                <div className={s.lab} style={{ left: `${x(c.price)}%` }} data-side={i % 2 ? "down" : "up"}>
                  {i % 2 ? (
                    <>
                      <b>{usd(c.price)}</b>
                      <span>{i === mid ? `${c.name}, the middle` : c.name}</span>
                    </>
                  ) : (
                    <>
                      <span>{i === mid ? `${c.name}, the middle` : c.name}</span>
                      <b>{usd(c.price)}</b>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className={s.plotRows} role="img" aria-label={`${sorted.map((c) => `${c.name} ${usd(c.price)}`).join(", ")}. The middle, ${usd(index)}, is Agate's price.`}>
            {sorted.map((c, i) => (
              <div key={c.name} className={s.prow} data-mid={i === mid ? "" : undefined}>
                <span>{c.name}</span>
                <div className={s.ptrack}>
                  <u style={{ left: `${x(index)}%` }} />
                  <i style={{ left: `${x(c.price)}%` }} />
                </div>
                <b>{usd(c.price)}</b>
              </div>
            ))}
          </div>
          <figcaption className={s.figFoot}>
            <span>From each cloud&rsquo;s own public price page</span>
            <Link href={to("/app/gpu-index")} className={s.link}>
              See every source
            </Link>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ 7. paid every day */
function Daily({ M, grid, to }: { M: Money; grid: boolean; to: To }) {
  const [side, setSide] = useState<"long" | "short">("long");
  const long = side === "long";
  // a day's share on 100 GPU-hours (docs, Pay me daily): Long (price - floor) / days, Short (ceiling - price) / days
  const perDay = long ? (100 * (M.index - M.floor)) / M.days : (100 * (M.cap - M.index)) / M.days;
  const first = useMemo(() => {
    const [y, mo] = M.ym.split("-").map(Number);
    return new Date(Date.UTC(y, (mo || 11) - 1, 1)).getUTCDay();
  }, [M.ym]);
  return (
    <section className={s.sec} data-g="paper" data-cont="" data-rule="" data-split="" aria-labelledby="s-daily">
      <div className={s.wrap}>
        <div className={s.split}>
          <div className={`${s.words} ${s.rv}`} data-rv>
            <h2 id="s-daily" className={s.h2}>
              Get paid every day. Weekends too.
            </h2>
            <p className={s.lede}>
              Turn on Pay me daily and your share arrives every morning, once the day&rsquo;s price is set. By the end of the month, it adds up to the same.
            </p>
            <Link href={to("/docs/the-market")} className={s.link}>
              How payouts work
            </Link>
          </div>
          <div className={`${s.dark} ${s.rv}`} data-rv data-d="1">
            <div className={s.pieceHead}>
              <b>
                100 GPU-hours of H100, {M.month}
              </b>
            </div>
            <Sides side={side} set={setSide} label="Side" />
            {grid ? (
              <>
              <div className={s.row} style={{ borderTop: 0, paddingBlock: 0 }}>
                <span>Every day, at today&rsquo;s {usd(M.index)}</span>
                <b className={s.up}>+{usd(perDay)}</b>
              </div>
              <div className={s.month}>
                {["S", "M", "T", "W", "T", "F", "S"].map((d, k) => (
                  <span key={k}>{d}</span>
                ))}
                {Array.from({ length: first }, (_, k) => (
                  <div key={`b${k}`} className={s.day} data-blank="" />
                ))}
                {Array.from({ length: M.days }, (_, k) => (
                  <div key={k} className={s.day}>
                    <b>{k + 1}</b>
                  </div>
                ))}
              </div>
              <div className={`${s.row} ${s.total}`}>
                <span>Over {M.days} days</span>
                <b>{usd(perDay * M.days)}</b>
              </div>
              </>
            ) : (
              <div className={`${s.rows} ${s.ledger}`}>
                {long ? (
                  <div className={s.row}>
                    <span>Back right away</span>
                    <b>{usd(100 * M.floor)}</b>
                  </div>
                ) : (
                  <>
                    <div className={s.row}>
                      <span>You put in</span>
                      <b>{usd(100 * M.cap)}</b>
                    </div>
                    <div className={s.row}>
                      <span>Back right away</span>
                      <b>{usd(100 * M.bid)}</b>
                    </div>
                  </>
                )}
                <div className={s.row}>
                  <span>Every day, at today&rsquo;s {usd(M.index)}</span>
                  <b className={s.up}>+{usd(perDay)}</b>
                </div>
                <div className={s.row}>
                  <span>Over {M.days} days</span>
                  <b>{usd(perDay * M.days)}</b>
                </div>
                <div className={`${s.row} ${s.total}`}>
                  <span>In total</span>
                  <b>{usd(long ? 100 * M.floor + perDay * M.days : 100 * M.bid + perDay * M.days)}</b>
                </div>
              </div>
            )}
            <p className={s.note}>
              Assuming every day in {M.month} stays at today&rsquo;s {usd(M.index)}. Real days pay at their own price.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ 8. build on the price */
function Build({ index, to }: { index: number; to: To }) {
  const [copied, setCopied] = useState(false);
  // the open API, no key (the SDK's npm name is not published yet, docs/site/10-sdk.md)
  const cmd = "curl https://agate.elpabl0.xyz/api/v1/prices";
  const copy = () => {
    navigator.clipboard
      ?.writeText(cmd)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {});
  };
  return (
    <section className={s.sec} data-g="paper" data-cont="" data-rule="" data-split="" aria-labelledby="s-build">
      <div className={s.wrap}>
        <div className={s.split} data-flip="">
          <div className={`${s.words} ${s.rv}`} data-rv>
            <h2 id="s-build" className={s.h2}>
              Plug the price into anything.
            </h2>
            <p className={s.lede}>
              The price is open. Pull it into your app, contract or agent with a few lines of code, and check every source behind it.
            </p>
            <div className={s.install}>
              <code>
                <i aria-hidden>$</i>
                {cmd}
              </code>
              <button type="button" onClick={copy}>
                {copied ? <Check /> : <CopyIcon />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className={s.links}>
              <Link href={to("/docs/api")} className={s.link}>
                API docs
              </Link>
              <Link href={to("/docs/sdk")} className={s.link}>
                SDK docs
              </Link>
              <Link href={to("/docs/onchain")} className={s.link}>
                Price feeds
              </Link>
            </div>
          </div>
          <div className={`${s.code} ${s.rv}`} data-rv data-d="1">
            <div className={s.codeTop} aria-hidden>
              <i />
              <i />
              <i />
              <span>price.ts</span>
            </div>
            <pre>
              <code>
                {[
                  <>
                    <span className={s.k}>const</span> api = <span className={s.s}>&quot;https://agate.elpabl0.xyz/api&quot;</span>;
                  </>,
                  null,
                  <>
                    <span className={s.k}>const</span> res = <span className={s.k}>await</span> <span className={s.f}>fetch</span>(<span className={s.s}>{"`${api}/v1/prices/h100`"}</span>);
                  </>,
                  <>
                    <span className={s.k}>const</span> h100 = <span className={s.k}>await</span> res.<span className={s.f}>json</span>();
                  </>,
                  null,
                  <>
                    h100.price; <span className={s.c}>{"// what an H100 hour costs today"}</span>
                  </>,
                ].map((line, k) => (
                  <span key={k}>
                    <span className={s.ln} aria-hidden>
                      {k + 1}
                    </span>
                    {line}
                    {"\n"}
                  </span>
                ))}
              </code>
            </pre>
            <div className={s.run}>
              <span>
                <i aria-hidden>$</i> node price.ts
              </span>
              <b>{index.toFixed(2)}</b>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ 9. questions */
function Questions({ to }: { to: To }) {
  const QS: { q: string; a: ReactNode }[] = [
    {
      q: "What am I actually trading?",
      a: (
        <>
          The price of renting a GPU for an hour, not the GPU itself. Each month has its own market, and it pays out that month&rsquo;s average price, in dollars.{" "}
          <Link href={to("/docs/the-market")}>How the market works</Link>
        </>
      ),
    },
    {
      q: "Where does the price come from?",
      a: (
        <>
          From the clouds&rsquo; own public price pages, checked every hour. The daily price is the middle of them all, published with every source next to it.{" "}
          <Link href={to("/docs/the-price")}>How the price is made</Link>
        </>
      ),
    },
    {
      q: "How much can I lose?",
      a: (
        <>
          Never more than you put in. Every trade is paid for up front, so there are no margin calls and nobody can owe more.{" "}
          <Link href={to("/docs/the-market")}>Why it&rsquo;s capped</Link>
        </>
      ),
    },
    {
      q: "When do I get paid?",
      a: (
        <>
          At the end of the month, or every day if you turn on Pay me daily. Each day pays out once its price is set, around 07:00 UTC the next morning.{" "}
          <Link href={to("/docs/the-market")}>Pay me daily</Link>
        </>
      ),
    },
    {
      q: "Can my AI trade for me?",
      a: (
        <>
          Yes. Give it a budget and a few rules. It trades on its own inside them, and asks you before anything bigger.{" "}
          <Link href={to("/docs/ai-pockets")}>How AI trading works</Link>
        </>
      ),
    },
    {
      q: "Who is it for?",
      a: (
        <>
          Teams that rent GPUs and want a steady cost, clouds that rent them out and want steady income, and anyone with a view on where compute prices go.{" "}
          <Link href={to("/app")}>Open the market</Link>
        </>
      ),
    },
  ];
  return (
    <section className={s.sec} data-g="paper" data-cont="" data-rule="" aria-labelledby="s-q">
      <div className={`${s.wrap} ${s.faq}`}>
        <div className={s.rv} data-rv>
          <h2 id="s-q" className={s.h2}>
            Common questions
          </h2>
          <p className={s.lede}>Straight answers. The details are in the docs.</p>
          <Link href={to("/docs")} className={s.link}>
            Read the docs
          </Link>
        </div>
        <div className={`${s.qs} ${s.rv}`} data-rv data-d="1">
          {QS.map((x, k) => (
            <details key={x.q} className={s.q} open={k === 0}>
              <summary>
                {x.q}
                <i aria-hidden />
              </summary>
              <p>{x.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ 10. the close and the footer */
function Close({ to, art }: { to: To; art: "type" | "aisle" | "chip" }) {
  // the picture under the centred words: the rendered server aisle (Oct 10) or the H100 at rest (before)
  const img = art === "aisle" ? "aisle" : "close";
  const acts = (
    <div className={s.acts}>
      <Link href={to("/app")} className={s.cta}>
        Start trading
        <Arrow />
      </Link>
      <Link href={to("/docs")} className={s.ghost}>
        Read the docs
      </Link>
    </div>
  );
  // Oct 10: the type is the picture. The headline at the full width of
  // the rails, then a ruled band (the page's hairlines, marked where they meet the rails) with the one line that earns
  // "in a minute" and the buttons
  if (art === "type")
    return (
      <section className={`${s.sec} ${s.close}`} data-g="dark" data-art="type" aria-labelledby="s-close">
        <div className={s.wrap}>
          <div className={`${s.closeType} ${s.rv}`} data-rv>
            <h2 id="s-close" className={s.closeBig}>
              Make your first trade in a minute.
            </h2>
            <div className={`${s.closeRow} ${s.bleed} ${s.reg}`}>
              <p>Sign in with email, Google or a passkey. No wallet to set up.</p>
              {acts}
            </div>
          </div>
          <Foot to={to} />
        </div>
      </section>
    );
  return (
    <section className={`${s.sec} ${s.close}`} data-g="dark" aria-labelledby="s-close">
      <div className={s.wrap}>
        <div className={`${s.closeIn} ${s.rv}`} data-rv>
          <h2 id="s-close" className={s.closeH}>
            Make your first trade in a minute.
          </h2>
          {acts}
        </div>
        {/* the picture under the words: the rendered server aisle (aisle_dark_flat), or the bookend, the H100 the page dove
            into, at rest (close_dark, cropped to 3:1 around the package). Both 3:1, edges exactly
            the ground. Lossless WebP: every lossy setting (and 10-bit AVIF) rang in the near-black glow; 1440 and 2160
            wide, lazy, at the end */}
        <div className={s.closeArt} aria-hidden>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/landing/${img}-1440.webp`}
            srcSet={`/landing/${img}-1440.webp 1440w, /landing/${img}-2160.webp 2160w`}
            sizes="(max-width: 1440px) 100vw, 1440px"
            width={2880}
            height={960}
            alt=""
            loading="lazy"
            decoding="async"
          />
        </div>
        <Foot to={to} />
      </div>
    </section>
  );
}

/** the footer, under either close */
function Foot({ to }: { to: To }) {
  return (
    <footer className={s.foot}>
      <div>
        <Lockup height={26} wcase="title" />
        <p>The open price of compute, for anyone to trade or build on.</p>
      </div>
      <div>
        <h3>Market</h3>
        <Link href={to("/app")}>Markets</Link>
        <Link href={to("/app/gpu-index")}>Index</Link>
        <Link href={to("/app/positions")}>Positions</Link>
      </div>
      <div>
        <h3>AI</h3>
        <Link href={to("/docs/connect-an-ai")}>Connect your AI</Link>
        <Link href={to("/app/ai")}>Your AIs</Link>
        <Link href={to("/docs/ai-pockets")}>Budgets and limits</Link>
      </div>
      <div>
        <h3>Build</h3>
        <Link href={to("/docs")}>Docs</Link>
        <Link href={to("/docs/sdk")}>SDK</Link>
        <Link href={to("/docs/api")}>API</Link>
        <a href="/llms.txt">llms.txt</a>
      </div>
      <div>
        <h3>Agate</h3>
        <Link href={to("/docs/the-price")}>How it&rsquo;s priced</Link>
        <Link href={to("/docs/limits")}>What comes next</Link>
        <Link href={to("/privacy")}>Privacy</Link>
      </div>
    </footer>
  );
}
