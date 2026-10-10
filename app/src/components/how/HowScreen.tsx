"use client";
// How Agate works (/app/how): the whole market in twelve short parts, plain words first, each with its worked example
// on the live H100 month (the next full month the trade screen opens on). The words follow the written explainer of
// Oct 8 (what you trade, where the price comes from, a month, Long, Short, the floor and the ceiling, why it's safe,
// pay me daily, closing early, the month's end, if something goes wrong, test money); the numbers are read live and
// fall back together to that day's market (H100 November: floor $1.95, ceiling $8.00, 30 days, bid $3.95, ask $4.03,
// index $3.99), said as an example, while no listed month with a two-sided book is read. The market page's frame: a header, the parts, and on the right the numbers they use.
import Link from "next/link";
import { useEffect } from "react";
import { NavBar, Notice } from "@/components/shell/Shell";
import { BottomDock } from "@/components/shell/Dock";
import { monthName } from "@/components/markets/PriceChart";
import { Num } from "@/components/num/Num";
import { useMarkets, useNow } from "@/lib/data/hooks";
import { frontMonth } from "@/lib/data/derive";
import { usd, usd0 } from "@/lib/format";
import { groundFor } from "@/lib/mock/config";
import { useLinkQuery, useMock } from "@/lib/mock/store";
import { useThemeColor } from "@/lib/ui/hooks";
import t from "@/components/trade/trade.module.css";
import s from "./how.module.css";

/** The H100 month the parts are worked on: live when read, else the Oct 8 market they were written on. */
function useWorked() {
  const { markets } = useMarkets();
  const now = useNow();
  const m = markets?.find((x) => x.gpu === "H100");
  const f = m ? frontMonth(m, now) : undefined;
  const live = !!f && f.phase !== "upcoming" && f.cap > 0 && !!f.quote && f.quote.ask > 0 && f.quote.bid > 0;
  return {
    live,
    month: live ? monthName(f!.month) : "November",
    floor: live ? f!.floor : 1.95,
    cap: live ? f!.cap : 8,
    days: live ? f!.n : 30,
    ask: live ? f!.quote!.ask : 4.03,
    bid: live ? f!.quote!.bid : 3.95,
    // one set: the live index only beside the live month, else the day the example was written
    index: live && m && m.price > 0 ? m.price : 3.99,
  };
}

const H = 100;
/** two round averages either side of the price: what the examples settle at */
const HIGH = 4.5;
const LOW = 3.5;

const signed = (x: number) => `${x >= 0 ? "+" : "−"}${usd0(Math.abs(x))}`;
const tone = (x: number) => (x >= 0 ? t.up : t.down);

/** One worked line: the average, what comes back, and the gain or loss. */
function Outcome({ avg, back, gain }: { avg: string; back: number; gain: number }) {
  return (
    <div className={s.row}>
      <span>{avg}</span>
      <span>
        you get <Num>{usd0(back)}</Num>
      </span>
      <b className={tone(gain)}>
        <Num>{signed(gain)}</Num>
      </b>
    </div>
  );
}

export function HowScreen() {
  const { config } = useMock();
  const q = useLinkQuery();
  useEffect(() => {
    document.documentElement.style.background = groundFor(config);
  }, [config]);
  useThemeColor(config.theme);
  const w = useWorked();
  const M = w.month;
  const cost = w.ask * H;
  const shortIn = (w.cap - w.bid) * H;
  const dailyLong = ((w.index - w.floor) / w.days) * H;
  const dailyShort = ((w.cap - w.index) / w.days) * H;

  const parts: { id: string; title: string; lead: string; body: React.ReactNode }[] = [
    {
      id: "what",
      title: "What you're trading",
      lead: "One number: what it costs to rent a GPU for an hour.",
      body: <p>Clouds rent out GPUs by the hour, and that price moves. Agate turns it into something you can lock in or bet on. No GPU changes hands: you trade the price, and you're paid in dollars.</p>,
    },
    {
      id: "price",
      title: "Where the price comes from",
      lead: "The clouds' own price pages, every hour.",
      body: (
        <>
          <p>Agate reads what each cloud charges for an H100 on its own public page, and takes the middle price across the companies. Every source is shown next to the price, so you can check it yourself.</p>
          <p>A day's price becomes final about six hours after the day ends. If it changed, a second, independent reader has to agree before it counts.</p>
          <p>
            <Link className={s.inline} href={`/app/gpu-index${q}`}>
              See today's sources on the Index page
            </Link>
          </p>
        </>
      ),
    },
    {
      id: "month",
      title: "A month",
      lead: "Each month has its own market.",
      body: <p>{`You trade ${M}'s average price: the average of its ${w.days} daily prices. Two months are open at a time: this month and the next.`}</p>,
    },
    {
      id: "long",
      title: "Long",
      lead: "Long locks in the price you pay.",
      body: (
        <>
          <p>{`You buy at today's market price and get ${M}'s average back. Good for anyone who rents GPUs and doesn't want next month's bill to surprise them.`}</p>
          <div className={s.example}>
            <p className={s.exHead}>
              Long {H} GPU-hours at <Num>{usd(w.ask)}</Num> costs <Num>{usd0(cost)}</Num>.
            </p>
            <Outcome avg={`${M} averages ${usd(HIGH)}`} back={HIGH * H} gain={HIGH * H - cost} />
            <Outcome avg={`${M} averages ${usd(LOW)}`} back={LOW * H} gain={LOW * H - cost} />
          </div>
        </>
      ),
    },
    {
      id: "short",
      title: "Short",
      lead: "Short locks in the price you earn.",
      body: (
        <>
          <p>{`You put up the ceiling (${usd(w.cap)} an hour) and sell at today's market price. At the end you get the ceiling minus ${M}'s average. Good for anyone who rents out GPUs and wants next month's income fixed.`}</p>
          <div className={s.example}>
            <p className={s.exHead}>
              Short {H} GPU-hours: you put up <Num>{usd0(w.cap * H)}</Num> and get <Num>{usd0(w.bid * H)}</Num> back at once (at <Num>{usd(w.bid)}</Num>), so <Num>{usd0(shortIn)}</Num> is in.
            </p>
            <Outcome avg={`${M} averages ${usd(LOW)}`} back={(w.cap - LOW) * H} gain={(w.cap - LOW) * H - shortIn} />
            <Outcome avg={`${M} averages ${usd(HIGH)}`} back={(w.cap - HIGH) * H} gain={(w.cap - HIGH) * H - shortIn} />
            <p className={s.exFoot}>
              Either way you earned <Num>{usd(w.bid)}</Num> an hour.
            </p>
          </div>
        </>
      ),
    },
    {
      id: "range",
      title: "The floor and the ceiling",
      lead: `Every month has a range: ${usd(w.floor)} to ${usd(w.cap)} for H100 in ${M}.`,
      body: (
        <>
          <p>The average used for payment is kept inside it. That's what lets every trade be paid for in full up front.</p>
          <div className={s.example}>
            <div className={s.row}>
              <span>Most a Long can lose</span>
              <span>
                <Num>{usd(w.ask)}</Num> − <Num>{usd(w.floor)}</Num>
              </span>
              <b>
                <Num>{usd(w.ask - w.floor)}</Num> an hour
              </b>
            </div>
            <div className={s.row}>
              <span>Most a Short can lose</span>
              <span>
                <Num>{usd(w.cap)}</Num> − <Num>{usd(w.bid)}</Num>
              </span>
              <b>
                <Num>{usd(w.cap - w.bid)}</Num> an hour
              </b>
            </div>
          </div>
          <p>If the real price ever goes outside the range, the hedge covers it only up to the edge.</p>
        </>
      ),
    },
    {
      id: "safe",
      title: "Why it's safe to hold",
      lead: "Every dollar you can be paid is already locked.",
      body: (
        <>
          <p>A token is a claim on the month's average price, not a GPU-hour held anywhere, and it is never made out of thin air: it only exists when someone puts up the ceiling in dollars.</p>
          <p>That one deposit pays both sides. The Long gets the average, the Short gets the ceiling minus the average, and together they add up to exactly the ceiling. So there are no margin calls, no liquidations, and nobody can owe more than they put in.</p>
        </>
      ),
    },
    {
      id: "daily",
      title: "Pay me daily",
      lead: "Get paid as the month goes, instead of all at the end.",
      body: (
        <>
          <p>Tick Pay me daily and each day of the month pays its share as soon as that day's price is final. Over the whole month it adds up to the same as waiting until the end.</p>
          <div className={s.example}>
            <p className={s.exHead}>
              At today's <Num>{usd(w.index)}</Num>, on {H} GPU-hours:
            </p>
            <div className={s.row}>
              <span>Long, paid daily</span>
              <span>
                the floor back at once (<Num>{usd(w.floor)}</Num> an hour), then each day
              </span>
              <b>
                <Num>{usd(dailyLong)}</Num> a day
              </b>
            </div>
            <div className={s.row}>
              <span>Short, paid daily</span>
              <span>each day pays the ceiling minus that day's price, divided by {w.days}</span>
              <b>
                <Num>{usd(dailyShort)}</Num> a day
              </b>
            </div>
          </div>
          <p>An order that waits in the book (a limit that doesn't fill at once) is paid at the month's end, not daily.</p>
        </>
      ),
    },
    {
      id: "close",
      title: "Closing early",
      lead: "You can close any time before the month ends.",
      body: <p>Closing a Long sells it at the market price; closing a Short buys it back. Your gain or loss is the difference from where you opened. Holding to the end pays the month's average instead.</p>,
    },
    {
      id: "end",
      title: "When the month ends",
      lead: "Trading stops on the month's last day. Then the month pays out.",
      body: (
        <>
          <ol className={s.steps}>
            <li>The last day's price becomes final about six hours after the month ends.</li>
            <li>The month's average is fixed.</li>
            <li>A plain Long collects the average; a plain Short collects the ceiling minus the average. Daily positions are already paid.</li>
          </ol>
          <p>The next month is already open, so a hedge can roll straight on. An AI on autopilot does this for you.</p>
        </>
      ),
    },
    {
      id: "wrong",
      title: "If something goes wrong",
      lead: "The rules are fixed before anything happens.",
      body: (
        <ul className={s.list}>
          <li>
            <b>A cloud's page changes or goes down:</b> the other sources still make the price, and a held-back source can step in.
          </li>
          <li>
            <b>A day has no new price:</b> the day before is carried and marked carried, unverified.
          </li>
          <li>
            <b>Something looks wrong:</b> a person can pause the price, and every change to how a page is read is announced 48 hours before it takes effect.
          </li>
          <li>
            <b>The price stops for good:</b> the month still ends on fixed rules, so money is never stuck.
          </li>
        </ul>
      ),
    },
    {
      id: "test",
      title: "Test money",
      lead: "Everything here uses free test dollars on Monad's test network.",
      body: <p>You get 10,000 test dollars a day. They have no real value, so try anything.</p>,
    },
  ];

  return (
    <div className={`${t.screen} ${config.theme === "dark" ? "tone-dark" : "tone-light"}`} data-phone={config.phone}>
      <Notice />
      <NavBar active="how" />
      <main className={t.main}>
        <div className={s.frame}>
          <header className={`${t.panel} ${s.head}`}>
            <h1 className={`${s.h1} font-display`}>How Agate works</h1>
            <p className={s.lead}>An open price for renting a GPU, traded by the month. Twelve short parts, each worked on the real H100 market.</p>
            <nav className={s.toc} aria-label="The parts">
              {parts.map((p, i) => (
                <a key={p.id} href={`#${p.id}`}>
                  <span className={s.tocN}>{i + 1}</span>
                  {p.title}
                </a>
              ))}
            </nav>
          </header>
          <div className={s.parts}>
            {parts.map((p, i) => (
              <section key={p.id} id={p.id} className={`${t.panel} ${s.part}`} aria-labelledby={`${p.id}-h`}>
                <span className={`${s.n} font-display`} aria-hidden="true">
                  {i + 1}
                </span>
                <div className={s.partBody}>
                  <h2 id={`${p.id}-h`} className={s.h2}>
                    {p.title}
                  </h2>
                  <p className={s.partLead}>{p.lead}</p>
                  {p.body}
                </div>
              </section>
            ))}
          </div>
          <aside className={`${t.panel} ${s.rail}`} aria-labelledby="how-nums-h">
            <div className={s.railInner}>
              <h2 id="how-nums-h" className={s.h2}>
                The numbers used here
              </h2>
              <p className={s.quiet}>{w.live ? `H100 ${M}, read live.` : `An example: H100 ${M} as it traded on Oct 8. The live month shows here once its market is read.`}</p>
              <div className="ag-rows">
                <div>
                  <span>H100 index today</span>
                  <span>
                    <Num>{usd(w.index)}</Num>
                  </span>
                </div>
                <div>
                  <span>Buy {M} (ask)</span>
                  <span>
                    <Num>{usd(w.ask)}</Num>
                  </span>
                </div>
                <div>
                  <span>Sell {M} (bid)</span>
                  <span>
                    <Num>{usd(w.bid)}</Num>
                  </span>
                </div>
                <div>
                  <span>Floor and ceiling</span>
                  <span>
                    <Num>{usd(w.floor)}</Num> to <Num>{usd(w.cap)}</Num>
                  </span>
                </div>
                <div>
                  <span>Days in {M}</span>
                  <span>
                    <Num>{String(w.days)}</Num>
                  </span>
                </div>
              </div>
              <Link className="ag-btn ag-btn--primary ag-btn--lg" href={`/app${q}`}>
                {w.live ? `Trade H100 ${M}` : "Go to the market"}
              </Link>
              <Link className="ag-btn ag-btn--ghost" href={`/docs${q}`}>
                Read the docs
              </Link>
            </div>
          </aside>
        </div>
      </main>
      {config.phone === "new" && <BottomDock active={null} />}
    </div>
  );
}
