"use client";
// Positions, reworked (Oct 6 mock; Mock controls "Positions page": New). One number first, what everything held is
// worth now with its change since bought and what is ready to collect (Plasma One's hero); then each month as a
// section that says where it stands, each holding a two-line card (Kalshi: side and size over cost, worth and change
// over what it pays), and beside them from 1100 px "Paid to you" for pay me daily (Plasma's "You're earning") and the
// AIs (Mercury's two columns). Holdings in a connected AI's pocket show too, marked with its name, behind a
// You / AI filter. Signed out or holding nothing, a faded example card shows what the page becomes (Lighter).
// No activity ledger yet: the account carries no dated events (bought, paid out, collected) to list.
import Link from "next/link";
import { useEffect, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useFlow } from "@/components/markets/Flow";
import { monthName } from "@/components/markets/PriceChart";
import { NavBar, Notice } from "@/components/shell/Shell";
import { BottomDock } from "@/components/shell/Dock";
import { YourAis } from "@/components/ai/YourAis";
import { closeOrder } from "@/components/flow/CloseSheet";
import { dripOpen, useDrip } from "@/components/flow/DripButton";
import { Num } from "@/components/num/Num";
import { useAccount } from "@/lib/account";
import { useAiBackend, useGrants } from "@/lib/account/ai";
import { isLive } from "@/lib/account/aiView";
import type { Grant } from "@/lib/account/api";
import { DEFAULT_CONFIG, groundFor } from "@/lib/mock/config";
import { ALL_GPUS } from "@/lib/mock/data";
import { useDataStatus, useLastFor, useMarkets, useNow, useSeriesFor } from "@/lib/data/hooks";
import { dateText, frontMonth, monthLong, monthOpen, monthStage, statusLine } from "@/lib/data/derive";
import { useLinkQuery, useMock } from "@/lib/mock/store";
import type { Day, Position, Series } from "@/lib/mock/types";
import { useThemeColor } from "@/lib/ui/hooks";
import { usd, usd0 } from "@/lib/format";
import { fmtHours } from "@/lib/size";
import { changeText, changeTone, dailyShares, holdingView, monthLine, paysText, shareLine, sharesByDay, sideText, stageRank, type HoldingView } from "./view";
import s from "./new.module.css";

/** A holding on screen: the position, whose pocket holds it (null: the person's own), its month and its numbers. */
export interface Holding {
  p: Position;
  by: Grant | null;
  series: Series | undefined;
  v: HoldingView;
}

/** An AI's pocket as this page reads it: its holdings, and whether the read is on its way or failed. */
export interface PocketRead {
  grant: Grant;
  positions: Position[];
  pending: boolean;
  error: boolean;
}

/** "all", "you", or a connected AI's grant id. */
type Scope = string;

/** Within a month: pay me daily first, then a plain Long, then a Short. */
export const sideRank = (p: Position) => (p.side === "short" ? 2 : p.daily ? 0 : 1);

/** The market page of a GPU, keeping what is being judged (the Simple ticket trades its next full month). */
export function marketHref(query: string, gpu: string) {
  const sp = new URLSearchParams(query);
  if (gpu === DEFAULT_CONFIG.gpu) sp.delete("gpu");
  else sp.set("gpu", gpu);
  const q = sp.toString();
  return `/${q ? `?${q}` : ""}`;
}

/** Each AI's pocket and what it holds, from the reads the AI pages share (same keys as usePocket, so one cache): the
 *  connected AIs, and an ended or disconnected one whose pocket still holds something (it keeps paying the account).
 *  `reading`: the connections or a pocket are still on their way. */
export function usePocketHoldings(): { pockets: PocketRead[]; reading: boolean } {
  const { backend, enabled } = useAiBackend();
  const grants = useGrants();
  const list = grants.data ?? [];
  const reads = useQueries({
    queries: list.map((g) => ({
      queryKey: ["live", "pocket", backend.key, g.pocket],
      queryFn: () => backend.pocket(g.pocket),
      enabled: enabled && !!g.pocket,
      refetchInterval: 60_000,
      staleTime: 10_000,
      retry: 1,
      retryDelay: 2_000,
    })),
  });
  const pockets = list
    .map((g, i) => ({ grant: g, positions: reads[i]?.data?.positions ?? [], pending: !!reads[i]?.isLoading, error: !!reads[i]?.isError }))
    .filter((x) => isLive(x.grant) || x.positions.length > 0);
  return { pockets, reading: grants.isLoading || reads.some((r) => r.isLoading) };
}

export function PositionsNew() {
  const { config } = useMock();
  const account = useAccount();
  const dark = config.theme === "dark";
  useEffect(() => {
    document.documentElement.style.background = groundFor(config);
  }, [config.theme]);
  useThemeColor(config.theme);
  const st = useDataStatus();
  const { markets } = useMarkets();

  // a session on its way (restoring, its first wallet read, or the example's sign-in from the link): the page's
  // shape, never a "Sign in" flash before the holdings arrive
  const waiting = account.status === "restoring" || (account.ready && !!account.walletLoading) || (config.source === "example" && config.auth === "in" && !account.ready);

  return (
    <div className={`${s.screen} ${dark ? "tone-dark" : "tone-light"}`} data-phone={config.phone}>
      <Notice status={statusLine(st, !!markets)} />
      <NavBar active="positions" />
      <main className={s.main}>{waiting ? <Loading /> : account.ready ? <Held /> : <Outside />}</main>
      {config.phone === "new" && <BottomDock active="positions" />}
    </div>
  );
}

/** Signed in: the hero, the months, "Paid to you" and the AIs. */
function Held() {
  const account = useAccount();
  const lastFor = useLastFor();
  const seriesFor = useSeriesFor();
  const now = useNow();
  const { pockets, reading } = usePocketHoldings();
  const [picked, setScope] = useState<Scope>("all");

  const holding = (p: Position, by: Grant | null): Holding => {
    const series = seriesFor(p.gpu, p.month);
    return { p, by, series, v: holdingView(p, series, lastFor(p), now) };
  };
  const all = [...account.positions.map((p) => holding(p, null)), ...pockets.flatMap((x) => x.positions.map((p) => holding(p, x.grant)))];
  // nothing held anywhere: the empty page, once the AIs' pockets are read (never "Nothing held" before they are)
  if (!all.length) return reading ? <Loading /> : <Nothing unread={pockets.filter((x) => x.error)} />;

  // a scope whose AI is gone (disconnected and emptied) falls back to everything
  const scope = picked === "all" || picked === "you" || pockets.some((x) => x.grant.id === picked) ? picked : "all";
  const inScope = pockets.filter((x) => scope === "all" || x.grant.id === scope);
  const ai = pockets.find((x) => x.grant.id === scope) ?? null;
  const list = scope === "all" ? all : scope === "you" ? all.filter((h) => !h.by) : all.filter((h) => h.by?.id === scope);
  const daily = list.filter((h) => h.p.daily);
  return (
    <>
      <h1 className="sr-only">Your positions</h1>
      {/* one column below 1100 px in the order read and tabbed: filter, hero, months, then "Paid to you" and the AIs */}
      <div className={s.layout}>
        <div className={s.col}>
          {pockets.length > 0 && (
            <div className={s.filterRow}>
              <div className={`ag-seg ag-seg--tall ${s.filter}`} role="group" aria-label="Whose holdings">
                {[["all", "All"] as const, ["you", "You"] as const, ...pockets.map((x) => [x.grant.id, x.grant.label] as const)].map(([k, label]) => (
                  <button key={k} type="button" aria-pressed={scope === k} onClick={() => setScope(k)}>
                    {label}
                  </button>
                ))}
              </div>
              <PocketNotes pockets={inScope} />
            </div>
          )}
          <Hero list={list} scope={scope} ai={ai?.grant ?? null} reading={inScope.some((x) => x.pending)} />
          {list.length ? <Months list={list} now={now} /> : <NoneHere ai={ai} />}
        </div>
        <div className={s.col}>
          {daily.length > 0 && <PaidCard daily={daily} now={now} />}
          <YourAis className={s.ais} titleClass={s.h2} />
        </div>
      </div>
    </>
  );
}

/** A quiet line for each pocket still on its way or that could not be read. */
function PocketNotes({ pockets }: { pockets: PocketRead[] }) {
  return (
    <>
      {pockets.map((x) =>
        x.error ? (
          <p key={x.grant.id} className={s.quiet}>
            Can't read {x.grant.label}'s pocket right now. Trying again.
          </p>
        ) : x.pending ? (
          <p key={x.grant.id} className={s.quiet} aria-live="polite">
            Reading {x.grant.label}'s pocket.
          </p>
        ) : null,
      )}
    </>
  );
}

/** The hero: what the holdings in view are worth now, their change since bought, what is ready to collect, and the
 *  two things to do next (Collect when something is ready, else Trade; Trade, or Get test dollars while today's are
 *  there to take, beside it). `reading`: a pocket in view is still on its way, so an empty view is not yet "$0". */
function Hero({ list, scope, ai, reading }: { list: Holding[]; scope: Scope; ai: Grant | null; reading: boolean }) {
  const account = useAccount();
  const q = useLinkQuery();
  const drip = useDrip();
  const [collecting, setCollecting] = useState(false);
  const open = list.filter((h) => !h.v.done);
  const valued = open.filter((h) => h.v.worth !== null);
  const worth = valued.reduce((a, h) => a + h.v.worth!, 0);
  const changes = open.filter((h) => h.v.change !== null);
  const change = changes.reduce((a, h) => a + h.v.change!, 0);
  const unpriced = open.length - valued.length;
  // only what the account itself holds is collected from here (an AI's pocket collects for itself)
  const ready = list.filter((h) => !h.by && h.v.ready > 0);
  const readyTotal = ready.reduce((a, h) => a + h.v.ready, 0);
  const canCollect = readyTotal > 0 && !!account.collect;
  const tone = changeTone(changes.length ? change : null);
  const label = ai ? `Held by ${ai.label}, worth now` : scope === "you" ? "Yours, worth now" : "Worth now";

  const collectAll = async () => {
    setCollecting(true);
    try {
      for (const h of ready) await account.collect?.(h.p);
    } finally {
      setCollecting(false);
    }
  };
  const trade = (cls: string) => (
    <Link className={`ag-btn ${cls}`} href={`/${q}`}>
      Trade
    </Link>
  );

  // nothing in view yet while a pocket in it is read: its shape, never a $0 that is about to change
  if (!open.length && reading) return <HeroSkeleton label={label} />;

  return (
    <section className={s.hero} aria-label="What you hold">
      <span className={s.heroLabel}>{label}</span>
      {/* nothing open has a price yet (the first read on its way, or Monad unreachable): never a bare $0 */}
      {open.length > 0 && !valued.length ? (
        <span className={`${s.heroNum} ${s.heroNone} font-display`}>No price yet</span>
      ) : (
        <span className={`${s.heroNum} font-display`}>
          <Num>{usd0(worth)}</Num>
        </span>
      )}
      <p className={s.heroChange}>
        {!open.length ? (
          <span>Nothing open right now.</span>
        ) : changes.length ? (
          <span className={s.change} data-tone={tone}>
            {tone && <Arrow up={tone === "up"} />}
            <Num>{changeText(change)}</Num>
            <span className={s.changeWords}>since bought</span>
          </span>
        ) : (
          <span>No price to compare yet.</span>
        )}
        {unpriced > 0 && (
          <span className={s.heroQuiet}>
            {unpriced === 1 ? "One holding has" : `${unpriced} holdings have`} no price yet, so {unpriced === 1 ? "it isn't" : "they aren't"} counted.
          </span>
        )}
      </p>
      {readyTotal > 0 && (
        <span className={s.readyPill}>
          <span className={s.readyDot} aria-hidden="true" />
          Ready to collect <Num>{usd0(readyTotal)}</Num>
        </span>
      )}
      <div className={s.heroActs}>
        {ai ? (
          <>
            <Link className="ag-btn ag-btn--primary" href={`/ai/${encodeURIComponent(ai.id)}${q}`}>
              See {ai.label}'s pocket
            </Link>
            {trade("ag-btn--soft")}
          </>
        ) : canCollect ? (
          <>
            <button type="button" className="ag-btn ag-btn--primary" disabled={collecting} onClick={collectAll}>
              {collecting ? (
                <>
                  <span className="ag-spinner" aria-hidden="true" />
                  Collecting
                </>
              ) : (
                `Collect ${usd0(readyTotal)}`
              )}
            </button>
            {trade("ag-btn--soft")}
          </>
        ) : (
          <>
            {trade("ag-btn--primary")}
            {/* only while today's test dollars are there to take, never a button that can only refuse */}
            {(dripOpen(account) || drip.busy) && (
              <button type="button" className="ag-btn ag-btn--soft" disabled={drip.busy} onClick={() => void drip.run()}>
                {drip.busy ? (
                  <>
                    <span className="ag-spinner" aria-hidden="true" />
                    Getting test dollars
                  </>
                ) : (
                  "Get test dollars"
                )}
              </button>
            )}
          </>
        )}
      </div>
      {drip.error && (
        <p className="ag-fine" aria-live="polite">
          {drip.error}
        </p>
      )}
    </section>
  );
}

function Arrow({ up }: { up: boolean }) {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" className={s.arrow}>
      <path d={up ? "M5 1.5L9 8H1z" : "M5 8.5L1 2h8z"} fill="currentColor" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path d="M4.5 2.5l3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    </svg>
  );
}

/** Months in order, the open ones first; a month that is final with everything collected goes last. */
function Months({ list, now }: { list: Holding[]; now: number }) {
  const months = [...new Set(list.map((h) => h.p.month))].map((month) => {
    const hs = list
      .filter((h) => h.p.month === month)
      .sort((a, b) => ALL_GPUS.indexOf(a.p.gpu) - ALL_GPUS.indexOf(b.p.gpu) || Number(!!a.by) - Number(!!b.by) || sideRank(a.p) - sideRank(b.p));
    return { month, hs, done: hs.every((h) => h.v.done) };
  });
  months.sort((a, b) => Number(a.done) - Number(b.done) || (a.month < b.month ? -1 : 1));
  return (
    <div className={s.months}>
      {months.map((m) => (
        <MonthSection key={m.month} month={m.month} hs={m.hs} now={now} />
      ))}
    </div>
  );
}

function MonthSection({ month, hs, now }: { month: string; hs: Holding[]; now: number }) {
  // the month's dates are the same for every GPU; its first known series speaks for it
  const series = hs.find((h) => h.series)?.series;
  const stage = series ? monthStage(series, now) : null;
  const id = `m-${month}`;
  const showDays = !!series && (stage === "paying" || stage === "lastDay" || stage === "closed");
  return (
    <section className={s.month} aria-labelledby={id}>
      <div className={s.monthHead}>
        <h2 id={id} className={`${s.monthTitle} font-display`}>
          {monthName(month)}
        </h2>
        {series && stage && (
          <p className={s.monthLine} data-stage={stage}>
            {monthLine(
              series,
              stage,
              hs.filter((h) => !h.by).map((h) => h.v),
            )}
          </p>
        )}
      </div>
      {showDays && (
        // the month's days priced so far
        <div className={s.days} role="img" aria-label={`${series!.k} of ${series!.n} days priced`}>
          <span style={{ width: `${(Math.min(series!.k, series!.n) / series!.n) * 100}%` }} />
        </div>
      )}
      <ul className={s.cards}>
        {hs.map((h) => (
          <HoldingCard key={`${h.by?.id ?? "you"}-${h.p.id}`} h={h} now={now} />
        ))}
      </ul>
    </section>
  );
}

/** One holding, two lines: the side and size over what it cost; what it is worth with its change over what it pays.
 *  Its one action sits in the card's head: Close (a Long) or Buy back (a Short) while the month trades, Collect once
 *  something is ready (outlined: the hero's Collect, which takes everything ready at once, is the page's one dark
 *  button). An AI's holding is the AI's to close. */
function HoldingCard({ h, now }: { h: Holding; now: number }) {
  const account = useAccount();
  const { openClose } = useFlow();
  const q = useLinkQuery();
  const [collecting, setCollecting] = useState(false);
  const { p, v, series, by } = h;
  const mine = !by;
  const canClose = mine && !v.done && !!series && monthOpen(series, now) && account.ready && !!closeOrder(p);
  const canCollect = mine && v.ready > 0 && !!account.collect;
  const pays = paysText(p, v);
  return (
    <li className={s.card} data-done={v.done || undefined}>
      <div className={s.cardHead}>
        <div className={s.cardWho}>
          <Link className={s.gpu} href={marketHref(q, p.gpu)} aria-label={`${p.gpu} ${monthName(p.month)}, open its market`}>
            {p.gpu}
            <Chevron />
          </Link>
          {by && <span className={s.by}>Held by {by.label}</span>}
        </div>
        {(canClose || canCollect) && (
          <div className={s.cardActs}>
            {canCollect && (
              <button
                type="button"
                className="ag-btn ag-btn--ghost"
                disabled={collecting}
                onClick={async () => {
                  setCollecting(true);
                  try {
                    await account.collect?.(p);
                  } finally {
                    setCollecting(false);
                  }
                }}
              >
                {collecting ? (
                  <>
                    <span className="ag-spinner" aria-hidden="true" />
                    <span className="sr-only">Collecting</span>
                  </>
                ) : (
                  `Collect ${usd0(v.ready)}`
                )}
              </button>
            )}
            {canClose && (
              <button type="button" className="ag-btn ag-btn--ghost" onClick={() => openClose(p)}>
                {v.long ? "Close" : "Buy back"}
              </button>
            )}
          </div>
        )}
      </div>
      <div className={s.cardBody}>
        <span className={s.what}>
          {sideText(p)} · <Num>{fmtHours(p.q)}</Num> GPU-hours
        </span>
        <span className={s.worth}>
          <span>
            {v.worth === null ? (
              "No price yet"
            ) : v.done ? (
              <>
                Paid out <Num>{usd0(p.paid)}</Num>
              </>
            ) : (
              <>
                Worth <Num>{usd0(v.worth)}</Num>
              </>
            )}
          </span>
          {v.change !== null && <Change value={v.change} />}
        </span>
        <span className={s.cost}>
          {v.cost === null ? (
            "Cost not known yet"
          ) : (
            <>
              Cost <Num>{usd0(v.cost)}</Num>
            </>
          )}
        </span>
        <span className={s.pays}>
          {pays.words}
          {pays.dollars !== null && (
            <>
              {" "}
              <Num>{usd0(pays.dollars)}</Num>
            </>
          )}
        </span>
      </div>
    </li>
  );
}

function Change({ value }: { value: number }) {
  const tone = changeTone(value);
  return (
    <span className={s.change} data-tone={tone}>
      {tone && <Arrow up={tone === "up"} />}
      <Num>{changeText(value)}</Num>
    </span>
  );
}

/** "Paid to you" (pay me daily): the total paid so far, when the next share comes, the month's days as a strip
 *  (paid, paid at once, still to come) and the latest days, newest first. A day is listed only when dailyShares can
 *  check it against the month's own record; otherwise the card keeps to the total, which the chain itself reports. */
function PaidCard({ daily, now }: { daily: Holding[]; now: number }) {
  const { markets } = useMarkets();
  const [all, setAll] = useState(false);
  const historyFor = (gpu: string): Day[] | undefined => markets?.find((m) => m.gpu === gpu)?.history;
  const total = daily.reduce((a, h) => a + h.p.paid, 0);
  const waiting = daily.filter((h) => !h.by).reduce((a, h) => a + h.v.ready, 0);
  const checked = daily.map((h) => ({ h, sh: dailyShares(h.p, h.series, historyFor(h.p.gpu)) }));
  const ok = checked.every((x) => x.sh !== null);
  const rows = ok ? sharesByDay(checked.map((x) => x.sh!.days)) : [];
  const atOnce = ok ? checked.reduce((a, x) => a + x.sh!.atOnce, 0) : 0;
  // the strip and the next share follow the month paying now, else the next to start, else the latest
  const focus = [...daily].sort((a, b) => stageRank(a.v.stage) - stageRank(b.v.stage) || (a.p.month < b.p.month ? 1 : -1))[0];
  const fs = focus.series;
  const stage = fs ? monthStage(fs, now) : null;

  const one = daily.length === 1;
  const fromWhom = (h: Holding) => (h.by ? `${h.by.label}'s` : "your");
  const from = one
    ? `From ${fromWhom(focus)} pay me daily ${focus.v.long ? "Long" : "Short"} on ${focus.p.gpu} ${monthName(focus.p.month)}.`
    : `From ${daily.length} pay me daily holdings.`;
  const next = fs && stage ? shareLine(fs, stage, now) : "";

  // the strip: one bar per day of the focus month, the paid days as tall as their share
  const focusShares = ok ? sharesByDay(checked.filter((x) => x.h.p.month === focus.p.month).map((x) => x.sh!.days)) : [];
  const byDate = new Map(focusShares.map((d) => [d.date, d.amount]));
  const top = Math.max(0, ...focusShares.map((d) => d.amount));
  const strip =
    fs && ok && fs.n > 0
      ? Array.from({ length: fs.n }, (_, i) => {
          const date = `${fs.month}-${String(i + 1).padStart(2, "0")}`;
          const amount = byDate.get(date);
          if (amount !== undefined) return { date, kind: "paid" as const, h: top > 0 ? 0.3 + 0.7 * (amount / top) : 0.6 };
          // priced before the position opened: paid with what it paid at once
          if (i < fs.k) return { date, kind: "atOnce" as const, h: 0.3 };
          return { date, kind: "ahead" as const, h: 0.14 };
        })
      : null;
  const shown = all ? rows : rows.slice(0, 5);

  return (
    <section className={s.paid} aria-labelledby="paid-h">
      <h2 id="paid-h" className={s.paidTitle}>
        Paid to you
      </h2>
      <span className={`${s.paidNum} font-display`}>
        <Num>{usd0(total)}</Num>
      </span>
      <p className={s.paidLine}>
        {from} {next}
      </p>
      {waiting > 0 && (
        <p className={s.paidLine}>
          Another <Num>{usd0(waiting)}</Num> is ready to collect.
        </p>
      )}
      {strip && (
        <div className={s.strip} role="img" aria-label={`${focusShares.length} of ${fs!.n} days of ${monthName(fs!.month)} paid to you`}>
          {strip.map((d) => (
            <span key={d.date} data-k={d.kind} style={{ height: `${Math.round(d.h * 100)}%` }} />
          ))}
        </div>
      )}
      {(shown.length > 0 || atOnce > 0) && (
        <ul className={s.dayRows}>
          {shown.map((d) => (
            <li key={d.date}>
              <span>
                {dateText(d.date)}
                {d.price !== null && (
                  <span className={s.dayPrice}>
                    , priced at <Num>{usd(d.price)}</Num>
                  </span>
                )}
              </span>
              <span className={s.dayAmt}>
                <Num>{`+${usd(d.amount)}`}</Num>
              </span>
            </li>
          ))}
          {atOnce > 0 && (
            <li>
              <span>Paid when bought</span>
              <span className={s.dayAmt}>
                <Num>{`+${usd(atOnce)}`}</Num>
              </span>
            </li>
          )}
          {rows.length > 5 && (
            <li>
              <button type="button" className="ag-textbtn" onClick={() => setAll((x) => !x)} aria-expanded={all}>
                {all ? "Show the latest five" : `Show all ${rows.length} days`}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/** A scope with nothing in it: the person's own holdings while only an AI holds something, or an AI's empty pocket
 *  (said only once its pocket is read; the hero above already offers Trade). */
function NoneHere({ ai }: { ai: PocketRead | null }) {
  if (ai) return ai.pending || ai.error ? null : <p className={s.lineCopy}>{ai.grant.label} hasn't opened any positions yet.</p>;
  return <p className={s.lineCopy}>You hold nothing yourself yet. A position shows here with what it's worth and what it pays.</p>;
}

/** The month the trade screen opens on (its next full month), for "Trade November"; null while nothing is read. */
export function useNextMonth() {
  const { config } = useMock();
  const { markets } = useMarkets();
  const now = useNow();
  const m = markets?.find((x) => x.gpu === config.gpu) ?? markets?.find((x) => x.tradable);
  const f = m ? frontMonth(m, now) : undefined;
  return f && f.phase !== "upcoming" ? f : null;
}

/** What a holding looks like, faded (an illustration, hidden from screen readers): signed out and empty show it. */
function Preview() {
  const next = useNextMonth();
  return (
    <div className={s.preview} aria-hidden="true">
      <div className={s.monthHead}>
        <span className={`${s.monthTitle} font-display`}>{next ? monthLong(next.month) : "November"}</span>
        <span className={s.monthLine}>12 of {next?.n || 30} days priced</span>
      </div>
      <div className={s.card}>
        <div className={s.cardHead}>
          <div className={s.cardWho}>
            <span className={s.gpu}>
              H100
              <Chevron />
            </span>
          </div>
        </div>
        <div className={s.cardBody}>
          <span className={s.what}>Long, paid daily · 720 GPU-hours</span>
          <span className={s.worth}>
            <span>Worth $1,498</span>
            <span className={s.change} data-tone="up">
              <Arrow up />
              +$29
            </span>
          </span>
          <span className={s.cost}>Cost $2,938</span>
          <span className={s.pays}>Paid so far $1,469</span>
        </div>
      </div>
    </div>
  );
}

/** Signed in, nothing held anywhere (no AI pocket either): the faded card, one line, and the next month to trade.
 *  `unread`: pockets that could not be read, said so, since they may hold something. */
function Nothing({ unread }: { unread: PocketRead[] }) {
  const q = useLinkQuery();
  const next = useNextMonth();
  return (
    <div className={s.outsideWrap}>
      <div className={s.outside}>
        <h1 className={`${s.title} font-display`}>Your positions</h1>
        <Preview />
        <p className={s.lineCopy}>Nothing held yet. A position shows here with what it's worth and what it pays.</p>
        <PocketNotes pockets={unread} />
        <div className={s.heroActs}>
          <Link className="ag-btn ag-btn--primary" href={`/${q}`}>
            {next ? `Trade ${monthLong(next.month)}` : "Go to Markets"}
          </Link>
        </div>
      </div>
      <YourAis className={s.ais} titleClass={s.h2} />
    </div>
  );
}

/** Signed out: the same faded card and one way in. */
function Outside() {
  const { openSignIn } = useFlow();
  return (
    <div className={s.outsideWrap}>
      <div className={s.outside}>
        <h1 className={`${s.title} font-display`}>Your positions</h1>
        <Preview />
        <p className={s.lineCopy}>Sign in to see what you hold.</p>
        <div className={s.heroActs}>
          <button type="button" className="ag-btn ag-btn--primary" onClick={openSignIn}>
            Sign in
          </button>
        </div>
      </div>
    </div>
  );
}

/** The hero's shape with its figures masked (and kept from screen readers: they are placeholders, not numbers). */
function HeroSkeleton({ label }: { label: string }) {
  return (
    <section className={s.hero} aria-label="Loading what you hold" aria-busy="true">
      <span className={s.heroLabel}>{label}</span>
      <span className={`${s.heroNum} font-display ag-skel ag-skel-on`} aria-hidden="true">
        $0,000
      </span>
      <span className={`${s.heroChange} ag-skel ag-skel-on`} aria-hidden="true">
        +$00 since bought
      </span>
    </section>
  );
}

/** The page's shape while the account arrives: masked figures, never numbers. */
function Loading() {
  return (
    <div className={s.layout} aria-busy="true">
      <div className={s.col}>
        <HeroSkeleton label="Worth now" />
        <div className={s.cards} aria-hidden="true">
          <div className={`${s.skelCard} ag-skel ag-skel-on`} />
          <div className={`${s.skelCard} ag-skel ag-skel-on`} />
        </div>
      </div>
    </div>
  );
}
