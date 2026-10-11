"use client";
// Pictures that explain Agate, shared by How Agate works and the docs: each draws one idea on real numbers (the live
// H100 month and its clouds when read, else the Oct 8 market the words were written on, said as an example), flat, in
// the docs' hairlines, both themes from the app's tokens. Text is HTML over the drawings, so it never shrinks below
// the page's 15 px on a phone.
import { useMemo, useState, type ReactNode } from "react";
import { back, counted, daily, EXAMPLE_CLOUDS, gain, H, later, middle, putIn, signed0, startAvg, type Book, type Side } from "@/components/how/play";
import { useWorked, type Worked } from "@/components/how/worked";
import { useMarkets } from "@/lib/data/hooks";
import { usd, usd0 } from "@/lib/format";
import f from "./figures.module.css";

/** the slider's steps per dollar: 5 cents each */
const STEPS = 20;
const EPS = 1e-9;
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;
const bookOf = (w: Worked): Book => ({ floor: w.floor, cap: w.cap, ask: w.ask, bid: w.bid, days: w.days });

/** A figure: the drawing on its card, a short caption under it. */
export function Fig({ caption, label, children }: { caption?: ReactNode; label: string; children: ReactNode }) {
  return (
    <figure className={f.fig}>
      <div className={f.box} role="group" aria-label={label}>
        {children}
      </div>
      {caption && <figcaption className={f.cap}>{caption}</figcaption>}
    </figure>
  );
}

/* ------------------------------------------------------------------ the price: five clouds, the middle one */

/** Each cloud's own price for an H100 hour on one line, the middle one marked: that is Agate's price. */
export function CloudsFigure() {
  const w = useWorked();
  const { markets } = useMarkets();
  const set = useMemo(() => {
    const m = markets?.find((x) => x.gpu === "H100");
    const got = (m?.sources ?? []).filter((s) => s.live && s.price > 0).map((s) => ({ name: s.family, price: s.price }));
    // one set: the live clouds only beside the live month, else the day the example was written
    const live = w.live && got.length >= 3;
    return { live, list: [...(live ? got : EXAMPLE_CLOUDS)].sort((a, b) => a.price - b.price) };
  }, [markets, w.live]);
  const { list } = set;
  const mid = middle(list.map((c) => c.price));
  const lo = Math.floor(list[0].price * 2) / 2 - 0.5;
  const hi = Math.ceil(list[list.length - 1].price * 2) / 2 + 0.5;
  const x = (v: number) => (v - lo) / (hi - lo);
  const told = `${list.map((c) => `${c.name} ${usd(c.price)}`).join(", ")}. The middle, ${usd(mid.value)}, is Agate's price.`;
  return (
    <Fig label={told} caption={set.live ? "Each cloud's price for one H100 hour today." : "Each cloud's price for one H100 hour on Oct 8, as an example."}>
      <div className={f.clouds} style={{ ["--mid" as string]: pct(x(mid.value)) }} aria-hidden="true">
        {list.map((c, i) => {
          const isMid = mid.at.includes(i);
          return (
            <div key={`${c.name}-${i}`} className={f.cloud} data-mid={isMid ? "" : undefined}>
              <span className={f.cloudName}>{c.name}</span>
              <span className={f.track}>
                <i style={{ left: pct(x(c.price)) }} />
              </span>
              <b className={f.cloudPrice}>{usd(c.price)}</b>
            </div>
          );
        })}
        {/* the middle runs as a line down every row's track and is named under them */}
        <div className={f.cloud} data-total="">
          <span className={f.cloudName}>Agate</span>
          <span className={f.track}>
            <em>The middle one</em>
          </span>
          <b className={f.cloudPrice}>{usd(mid.value)}</b>
        </div>
      </div>
    </Fig>
  );
}

/* ------------------------------------------------------------------ a month: its days and their average */

/** This month's H100 price day by day so far, with the average of those days: what a month's market pays. */
export function MonthFigure() {
  const { markets } = useMarkets();
  const days = useMemo(() => {
    const m = markets?.find((x) => x.gpu === "H100");
    const all = [...(m?.prelaunch ?? []), ...(m?.history ?? [])].filter((d) => d.price > 0);
    if (!all.length) return null;
    const month = all[all.length - 1].date.slice(0, 7);
    return { month, list: all.filter((d) => d.date.startsWith(month)) };
  }, [markets]);
  if (!days || days.list.length < 2) return null;
  const { list } = days;
  const [y, mo] = days.month.split("-").map(Number);
  const inMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const name = new Date(Date.UTC(y, mo - 1, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const avg = list.reduce((a, d) => a + d.price, 0) / list.length;
  const prices = list.map((d) => d.price);
  // at least 60 cents tall, so a quiet month reads as quiet instead of as a cliff
  const span = Math.max(0.6, Math.max(...prices) - Math.min(...prices) + 0.16);
  const centre = (Math.max(...prices) + Math.min(...prices)) / 2;
  const lo = centre - span / 2;
  const hi = centre + span / 2;
  // the whole month across, so the days still to come show as room on the right
  const px = (i: number) => (i + 0.5) / inMonth;
  const py = (v: number) => 1 - (v - lo) / (hi - lo);
  const path = list.map((d, i) => `${i ? "L" : "M"}${(px(i) * 1000).toFixed(1)},${(py(d.price) * 200).toFixed(1)}`).join("");
  const example = list.some((d) => d.example);
  return (
    <Fig
      label={`${name}'s H100 price for its first ${list.length} days, from ${usd(list[0].price)} to ${usd(list[list.length - 1].price)}. Their average is ${usd(avg)}.`}
      caption={`${name}'s H100 price${example ? " (example days)" : ""}, one point a day. A month's market pays the average of all ${inMonth} days.`}
    >
      <div className={f.month} aria-hidden="true">
        <div className={f.monthPlot}>
          <svg viewBox="0 0 1000 200" preserveAspectRatio="none" className={f.monthSvg}>
            <path d={path} className={f.monthLine} vectorEffect="non-scaling-stroke" />
            <line x1="0" x2={px(list.length - 1) * 1000} y1={py(avg) * 200} y2={py(avg) * 200} className={f.avgLine} vectorEffect="non-scaling-stroke" />
          </svg>
          {list.map((d, i) => (
            <i key={d.date} className={f.monthDot} style={{ left: pct(px(i)), top: pct(py(d.price)) }} />
          ))}
          <span className={f.avgTag} style={{ top: pct(py(avg)), left: pct(px(list.length - 1)) }}>
            Average so far <b>{usd(avg)}</b>
          </span>
        </div>
        <div className={f.days}>
          {Array.from({ length: inMonth }, (_, i) => (
            <span key={i} data-on={i < list.length ? "" : undefined} />
          ))}
        </div>
        <div className={f.daysKey}>
          <span>
            Day {list.length} of {inMonth}
          </span>
          <span>{inMonth - list.length} to go</span>
        </div>
      </div>
    </Fig>
  );
}

/* ------------------------------------------------------------------ Long or Short: what comes back */

/** A trade of 100 GPU-hours on the month: what comes back for each average the month can land on, for one side at a
 *  time. Drag (or use the arrow keys on) the slider to move the average. */
export function PayoffFigure() {
  const w = useWorked();
  const b = bookOf(w);
  const [side, setSide] = useState<Side>("long");
  // the slider moves in 5-cent steps on whole multiples, so its value and the readout always agree; until it is moved
  // the average follows the book, which turns from the example into the live month when the market is read
  const lo = Math.ceil(b.floor * STEPS - EPS);
  const hi = Math.floor(b.cap * STEPS + EPS);
  const [picked, setPicked] = useState<number | null>(null);
  const step = Math.min(hi, Math.max(lo, picked ?? Math.round(startAvg(b) * STEPS)));
  const a = step / STEPS;
  const long = side === "long";
  const c = counted(b, a);
  const top = b.cap * H;
  const xs = (v: number) => (v - b.floor) / (b.cap - b.floor);
  const ys = (v: number) => 1 - v / top;
  const paid = putIn(b, side);
  const got = back(b, side, a);
  const g = gain(b, side, a);
  const cross = long ? b.ask : b.bid;
  // the line of what comes back, and the triangles between it and what was put in: gain one colour, loss the other
  const at = (v: number) => (long ? v * H : (b.cap - v) * H);
  const P = (v: number, d: number) => `${(xs(v) * 1000).toFixed(1)},${(ys(d) * 300).toFixed(1)}`;
  const winPoly = long ? `${P(cross, paid)} ${P(b.cap, at(b.cap))} ${P(b.cap, paid)}` : `${P(b.floor, at(b.floor))} ${P(cross, paid)} ${P(b.floor, paid)}`;
  const losePoly = long ? `${P(b.floor, at(b.floor))} ${P(cross, paid)} ${P(b.floor, paid)}` : `${P(cross, paid)} ${P(b.cap, at(b.cap))} ${P(b.cap, paid)}`;
  const tone = g > 0 ? "up" : g < 0 ? "down" : "even";
  return (
    <Fig
      label={`${long ? "Long" : "Short"}, 100 GPU-hours of H100 ${w.month}. If ${w.month} averages ${usd(a)}, you put in ${usd0(paid)} and get back ${usd0(got)}.`}
      caption={`Drag across the chart to move ${w.month}'s average. 100 GPU-hours of H100 ${w.month}${w.live ? "" : " as of Oct 8"}.`}
    >
      <div className={f.payoff} data-side={side}>
        <div className={f.payHead}>
          <div className={f.seg} role="group" aria-label="Side">
            <button type="button" aria-pressed={long} data-side="long" onClick={() => setSide("long")}>
              Long
            </button>
            <button type="button" aria-pressed={!long} data-side="short" onClick={() => setSide("short")}>
              Short
            </button>
          </div>
          <p className={f.payWho}>{long ? `Gains if ${w.month} averages above ${usd(b.ask)}.` : `Gains if ${w.month} averages below ${usd(b.bid)}.`}</p>
        </div>
        <div className={f.payPlot}>
          <svg aria-hidden="true" viewBox="0 0 1000 300" preserveAspectRatio="none" className={f.paySvg}>
            <polygon points={winPoly} className={f.win} />
            <polygon points={losePoly} className={f.lose} />
            <line x1="0" x2="1000" y1={ys(paid) * 300} y2={ys(paid) * 300} className={f.paidLine} vectorEffect="non-scaling-stroke" />
            <line x1="0" y1={ys(at(b.floor)) * 300} x2="1000" y2={ys(at(b.cap)) * 300} className={f.backLine} vectorEffect="non-scaling-stroke" />
            <line x1={xs(c) * 1000} x2={xs(c) * 1000} y1="0" y2="300" className={f.nowLine} vectorEffect="non-scaling-stroke" />
          </svg>
          <span className={f.paidTag} style={{ top: pct(ys(paid)) }} data-low={ys(paid) > 0.7 ? "" : undefined} aria-hidden="true">
            You put in <b>{usd0(paid)}</b>
          </span>
          {/* the whole plot is the slider: drag anywhere across it, or use the arrow keys; the handle is drawn */}
          <input
            className={f.range}
            type="range"
            min={lo}
            max={hi}
            step={1}
            value={step}
            onChange={(e) => setPicked(Number(e.target.value))}
            aria-label={`Where ${w.month} averages`}
            aria-valuetext={`${usd(a)}: you get back ${usd0(got)}`}
          />
          <i className={f.nowDot} data-tone={tone} style={{ left: pct(xs(c)), top: pct(ys(at(c))) }} aria-hidden="true" />
          <i className={f.knob} style={{ left: pct(xs(c)) }} aria-hidden="true" />
        </div>
        <div className={f.payAxis} aria-hidden="true">
          <span>{usd(b.floor)}</span>
          <span>{w.month}&rsquo;s average</span>
          <span>{usd(b.cap)}</span>
        </div>
        <dl className={f.payRead}>
          <div>
            <dt>If {w.month} averages</dt>
            <dd>{usd(a)}</dd>
          </div>
          <div>
            <dt>You get back</dt>
            <dd>{usd0(got)}</dd>
          </div>
          <div>
            <dt>{g < 0 ? "Your loss" : "Your gain"}</dt>
            <dd data-tone={tone}>{signed0(g)}</dd>
          </div>
        </dl>
      </div>
    </Fig>
  );
}

/* ------------------------------------------------------------------ fully backed: the highest price, held */

/** One GPU-hour of the month as the highest its average counts, held in full from the start: the Long's share is the
 *  average, the Short's share is the rest. So nobody can lose more than they put in. */
export function BackedFigure() {
  const w = useWorked();
  const b = bookOf(w);
  const a = startAvg(b);
  const share = counted(b, a) / b.cap;
  const longLoss = putIn(b, "long") - Math.round(b.floor * H);
  const shortLoss = putIn(b, "short");
  return (
    <Fig
      label={`Each GPU-hour is backed by ${usd(b.cap)} held until ${w.month} ends. If it averages ${usd(a)}, the Long gets ${usd(a)} and the Short gets ${usd(b.cap - a)}.`}
      caption={`For example, if ${w.month} averages ${usd(a)}. Nothing is borrowed, so nothing is owed later.`}
    >
      <div className={f.backed} aria-hidden="true">
        <div className={f.backedHead}>
          <span>Held for each GPU-hour until {w.month} ends</span>
          <b>{usd(b.cap)}</b>
        </div>
        <div className={f.bar}>
          <span className={f.barLong} style={{ width: pct(share) }}>
            <em>Long gets the average</em>
            <b>{usd(a)}</b>
          </span>
          <span className={f.barShort}>
            <em>Short gets the rest</em>
            <b>{usd(b.cap - a)}</b>
          </span>
        </div>
        <ul className={f.losses}>
          <li>
            <span>Most a Long can lose</span>
            <b>{usd0(longLoss)}</b>
            <small>{usd0(b.floor * H)} always comes back</small>
          </li>
          <li>
            <span>Most a Short can lose</span>
            <b>{usd0(shortLoss)}</b>
            <small>what it put in, never more</small>
          </li>
        </ul>
      </div>
    </Fig>
  );
}

/* ------------------------------------------------------------------ paid every day */

/** Pay me daily on the same Long: some back at once, then every day of the month its share. */
export function DailyFigure() {
  const w = useWorked();
  const b = bookOf(w);
  const a = startAvg(b);
  const d = daily(b, "long", a);
  return (
    <Fig
      label={`Long, 100 GPU-hours, ${w.month} averaging ${usd(a)}: ${usd0(d.now)} back at once, about ${usd(d.perDay)} each day, ${usd0(d.total)} in all.`}
      caption={`Long, 100 GPU-hours, if ${w.month} averages ${usd(a)}. Weekends pay too.`}
    >
      <div className={f.daily} aria-hidden="true">
        <div className={f.dailyRows}>
          <div>
            <span>Back at once</span>
            <b>{usd0(d.now)}</b>
          </div>
          <div>
            <span>An average day</span>
            <b className={f.upText}>+{usd(d.perDay)}</b>
          </div>
        </div>
        <div className={f.cal} style={{ gridTemplateColumns: `repeat(${Math.min(10, b.days)}, minmax(0, 1fr))` }}>
          {Array.from({ length: b.days }, (_, i) => (
            <span key={i}>{i + 1}</span>
          ))}
        </div>
        <div className={f.dailyTotal}>
          <span>In all, the same as waiting</span>
          <b>{usd0(d.total)}</b>
        </div>
      </div>
    </Fig>
  );
}

/* ------------------------------------------------------------------ close any time */

/** Closing a Long before the month ends: sold at the going price, the difference kept at once. */
export function CloseFigure() {
  const w = useWorked();
  const b = bookOf(w);
  const l = later(b, "long");
  return (
    <Fig label={`Opened a Long at ${usd(b.ask)}, sold later at ${usd(l.at)}: you keep ${signed0(l.keep)}, paid out at once.`} caption="Long, 100 GPU-hours, closed before the month ends.">
      <div className={f.close} aria-hidden="true">
        <div>
          <span>Opened at</span>
          <b>{usd(b.ask)}</b>
        </div>
        <div>
          <span>Sold later at</span>
          <b>{usd(l.at)}</b>
        </div>
        <div className={f.closeKeep}>
          <span>You keep</span>
          <b className={f.upText}>{signed0(l.keep)}</b>
        </div>
        <p className={f.closeNote}>Paid out at once, to your account.</p>
      </div>
    </Fig>
  );
}

/* ------------------------------------------------------------------ for the docs: an account, an AI's pocket */

/** Where money moves when an AI trades: your account fills its pocket, it trades only from the pocket, and payouts go
 *  back to your account. */
export function PocketFigure() {
  return (
    <Fig label="Your account fills the AI's pocket. The AI trades from the pocket only, inside the limits you set. Payouts and closes come back to your account." caption="An AI never holds your account: only its pocket, and only for the days you chose.">
      <div className={f.flow} aria-hidden="true">
        <div className={f.node}>
          <b>Your account</b>
          <span>Signed in by you</span>
        </div>
        <div className={f.arrow}>
          <span>Budget you set</span>
        </div>
        <div className={f.node}>
          <b>The AI&rsquo;s pocket</b>
          <span>Limits per trade and per day</span>
        </div>
        <div className={f.arrow}>
          <span>Trades</span>
        </div>
        <div className={f.node}>
          <b>Markets</b>
          <span>Long, Short, close</span>
        </div>
        <div className={f.returnLine}>
          <span>Payouts and closes always come back to your account</span>
        </div>
      </div>
    </Fig>
  );
}

/** What signing in makes: an account that needs no wallet, with network fees paid for you. */
export function AccountFigure() {
  return (
    <Fig label="Sign in with Google, email or a passkey. Agate makes you an account onchain and pays its network fees. You get test dollars to trade with." caption="No wallet to install and no gas to pay.">
      <div className={f.flow} aria-hidden="true">
        <div className={f.node}>
          <b>Sign in</b>
          <span>Google, email or a passkey</span>
        </div>
        <div className={f.arrow}>
          <span>Made for you</span>
        </div>
        <div className={f.node}>
          <b>Your account</b>
          <span>Onchain, fees paid by Agate</span>
        </div>
        <div className={f.arrow}>
          <span>Free each day</span>
        </div>
        <div className={f.node}>
          <b>10,000 test dollars</b>
          <span>To trade with</span>
        </div>
      </div>
    </Fig>
  );
}
