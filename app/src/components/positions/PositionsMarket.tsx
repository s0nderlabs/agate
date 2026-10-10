"use client";
// Positions in the market page's frame (Oct 7, round 2; Mock controls "Positions page": Market). The market page's
// structure with the account in place of a market: a strip of tabs (everything, yours, each AI's pocket) with what
// each is worth, a header with the two big figures (worth now, paid to you) and four hairline-split stats, the value
// chart (hour by hour from the held months' real candles), the holdings list grouped by month, and on the right, the
// full-height column with the one holding picked: its timeline and its close. Each number is said once. Round 1's
// reads and words (PositionsNew.tsx, view.ts) are reused as they are.
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import { useFlow } from "@/components/markets/Flow";
import { monthName } from "@/components/markets/PriceChart";
import { NavBar, Notice } from "@/components/shell/Shell";
import { BottomDock } from "@/components/shell/Dock";
import { YourAis } from "@/components/ai/YourAis";
import { closeOrder } from "@/components/flow/CloseSheet";
import { dripOpen, useDrip } from "@/components/flow/DripButton";
import { Num } from "@/components/num/Num";
import { Note } from "@/components/trade/Note";
import { NoData, StateBox } from "@/components/trade/States";
import { CloseForm } from "@/components/trade/ClosePanel";
import { useAccount } from "@/lib/account";
import type { Grant } from "@/lib/account/api";
import { groundFor } from "@/lib/mock/config";
import { ALL_GPUS } from "@/lib/mock/data";
import { useSource } from "@/lib/data/context";
import { useDataStatus, useIndexer, useLastFor, useMarkets, useNow, useSeriesFor } from "@/lib/data/hooks";
import { dateText, monthLong, monthOpen, monthStage, statusLine, type MonthStage } from "@/lib/data/derive";
import { useLinkQuery, useMock } from "@/lib/mock/store";
import type { Candle, Day, Position, Series } from "@/lib/mock/types";
import { reducedMotion, useThemeColor } from "@/lib/ui/hooks";
import { usd, usd0 } from "@/lib/format";
import { showHours } from "@/lib/size";
import { changeText, changeTone, dailyShares, holdingView, monthLine, shareLine, sharesByDay, sideText, stageRank, type DayPaid } from "./view";
import { barText, clipRange, closesStat, closeWhy, countText, dayBars, frontHeld, nextShareStat, paidLine, paysCell, payOutStat, spanHours, steps, valueLine, type Stat, type ValueInput } from "./frame";
import { marketHref, sideRank, useNextMonth, usePocketHoldings, type Holding, type PocketRead } from "./PositionsNew";
import { ExampleLine, ValueChart } from "./ValueChart";
import t from "@/components/trade/trade.module.css";
import c from "@/components/trade/close.module.css";
import sh from "@/components/shell/shell.module.css";
import m from "./posmarket.module.css";

/** "all", "you", or a connected AI's grant id. */
type Scope = string;
type Range = "1W" | "1M" | "ALL";
const RANGE_HOURS: Record<Range, number | null> = { "1W": 168, "1M": 720, ALL: null };

const keyOf = (h: Holding) => `${h.by?.id ?? "you"}-${h.p.id}`;

export function PositionsMarket() {
  const { config } = useMock();
  const account = useAccount();
  const dark = config.theme === "dark";
  useEffect(() => {
    document.documentElement.style.background = groundFor(config);
  }, [config.theme]);
  useThemeColor(config.theme);
  const st = useDataStatus();
  const { markets } = useMarkets();
  // a session on its way (restoring, its first wallet read, or the example's sign-in from the link): the frame with
  // its figures masked, never a "Sign in" or "Nothing held" flash before the holdings arrive (round 1's rule)
  const waiting = account.status === "restoring" || (account.ready && !!account.walletLoading) || (config.source === "example" && config.auth === "in" && !account.ready);
  return (
    <div className={`${t.screen} ${dark ? "tone-dark" : "tone-light"}`} data-phone={config.phone}>
      <Notice status={statusLine(st, !!markets)} />
      <NavBar active="positions" />
      <h1 className="sr-only">Your positions</h1>
      {waiting ? <Waiting /> : account.ready ? <Held /> : <Empty out />}
      {config.phone === "new" && <BottomDock active="positions" />}
    </div>
  );
}

/** A re-render every 30 s, so the live countdowns ("in 15h") move. */
function useTick() {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((x) => x + 1), 30_000);
    return () => clearInterval(id);
  }, []);
}

/** Signed in: the holdings in every pocket, the scope picked in the strip and the holding picked in the list. */
function Held() {
  const account = useAccount();
  const lastFor = useLastFor();
  const seriesFor = useSeriesFor();
  const now = useNow();
  useTick();
  const { markets, loading } = useMarkets();
  const { openClose } = useFlow();
  const { pockets, reading } = usePocketHoldings();
  const [picked, setScope] = useState<Scope>("all");
  const [selKey, setSelKey] = useState<string | null>(null);
  const railRef = useRef<HTMLElement>(null);

  const holding = (p: Position, by: Grant | null): Holding => {
    const series = seriesFor(p.gpu, p.month);
    return { p, by, series, v: holdingView(p, series, lastFor(p), now) };
  };
  const all = [...account.positions.map((p) => holding(p, null)), ...pockets.flatMap((x) => x.positions.map((p) => holding(p, x.grant)))];
  // nothing held anywhere: the empty frame, once the AIs' pockets are read (never "Nothing held" before they are)
  if (!all.length) return reading ? <Waiting /> : <Empty unread={pockets.filter((x) => x.error)} />;

  // a scope whose AI is gone (disconnected and emptied) falls back to everything; with no AI pocket there is one tab
  const scope = picked === "all" || picked === "you" || pockets.some((x) => x.grant.id === picked) ? picked : "all";
  const inScope = (s: Scope) => (s === "all" ? all : s === "you" ? all.filter((h) => !h.by) : all.filter((h) => h.by?.id === s));
  const list = inScope(scope);
  const ai = pockets.find((x) => x.grant.id === scope) ?? null;
  const tabs: Tab[] = pockets.length
    ? [{ key: "all", label: "All", list: all }, { key: "you", label: "You", list: inScope("you") }, ...pockets.map((x) => ({ key: x.grant.id, label: x.grant.label, list: inScope(x.grant.id), pocket: x }))]
    : [{ key: "all", label: "You", list: all }];
  const groups = grouped(list, now);
  const ordered = groups.flatMap((g) => g.hs);
  // the holding picked: the one clicked while it is in view, else the first of your own still open (then your own, then
  // the first)
  const sel = ordered.find((h) => keyOf(h) === selKey) ?? ordered.find((h) => !h.by && !h.v.done) ?? ordered.find((h) => !h.by) ?? ordered[0] ?? null;
  const nodata = !markets && !loading;

  const select = (h: Holding, from: "pointer" | "key") => {
    setSelKey(keyOf(h));
    // stacked (below 1100 px) the rail sits under the list: a tap brings it into view
    if (from === "pointer" && window.matchMedia("(max-width: 1099.98px)").matches)
      requestAnimationFrame(() => railRef.current?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" }));
  };
  const close = (h: Holding, how: "rail" | "sheet") => {
    setSelKey(keyOf(h));
    // phones: round 1's close sheet; wider: the close form in the rail, scrolled to and announced
    if (how === "sheet") return openClose(h.p);
    requestAnimationFrame(() => {
      const head = document.getElementById("rail-close-h");
      head?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "nearest" });
      head?.focus({ preventScroll: true });
    });
  };

  return (
    <>
      <ScopeStrip tabs={tabs} scope={scope} onScope={setScope} loading={loading} />
      {/* the page loads its figures (the prices on their way): skeletons, the market page's way */}
      <main className={`${t.main}${loading ? " is-loading" : ""}`} aria-busy={loading || undefined}>
        {list.length ? (
          <div className={m.grid}>
            <HeadPanel list={list} scope={scope} ai={ai?.grant ?? null} now={now} loading={loading} />
            <ChartPanel list={list} now={now} nodata={nodata} />
            <ListPanel groups={groups} sel={sel} now={now} onSelect={select} onClose={close} />
            <aside ref={railRef} className={`${t.panel} ${m.rail}`} aria-label={sel ? `${monthName(sel.p.month)} ${sel.p.gpu}` : "Your AIs"}>
              <div className={m.railInner}>
                {sel && <Picked key={keyOf(sel)} h={sel} now={now} loading={loading} />}
                <YourAis className={m.ais} titleClass={m.h2} />
              </div>
            </aside>
          </div>
        ) : ai && (ai.pending || ai.error) ? (
          // an AI's pocket still on its way (or failed): its shape, never a "nothing" that is about to change
          ai.pending ? (
            <WaitingGrid />
          ) : (
            <EmptyPanels label={`Held by ${ai.grant.label}`} title="Not read yet" text={`Can't read ${ai.grant.label}'s pocket right now. Trying again.`} />
          )
        ) : (
          <EmptyPanels
            label={ai ? `Held by ${ai.grant.label}` : "Yours, worth now"}
            title="Nothing held yet"
            text={ai ? `${ai.grant.label} hasn't opened any positions yet.` : "You hold nothing yourself yet. Your first trade shows up here, with what it's worth and what it pays you."}
            acts={ai ? <PocketLink grant={ai.grant} /> : <TradeActs />}
          />
        )}
      </main>
    </>
  );
}

// ------------------------------------------------------------------ the strip

interface Tab {
  key: Scope;
  label: string;
  list: Holding[];
  pocket?: PocketRead;
}

/** What a list of holdings is worth now, from what is still open: the figure, and the change since bought. */
function worthOf(list: Holding[]) {
  const open = list.filter((h) => !h.v.done);
  const valued = open.filter((h) => h.v.worth !== null);
  const changes = open.filter((h) => h.v.change !== null);
  return {
    open,
    worth: valued.reduce((a, h) => a + h.v.worth!, 0),
    priced: valued.length > 0,
    unpriced: open.length - valued.length,
    change: changes.length ? changes.reduce((a, h) => a + h.v.change!, 0) : null,
  };
}

/** One tab per scope, its name and how many it holds ("All  3 holdings"); what the scope is worth is the header's
 *  big figure, said once. */
function ScopeStrip({ tabs, scope, onScope, loading }: { tabs: Tab[]; scope: Scope; onScope: (s: Scope) => void; loading: boolean }) {
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((x) => x.key === scope);
    const next = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i + tabs.length - 1) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    onScope(tabs[next].key);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div className={`${sh.strip} ${m.scopes}`} role="tablist" aria-label="Whose holdings" style={{ "--tabs": tabs.length } as CSSProperties} onKeyDown={onKey}>
      {tabs.map((tab) => {
        const w = worthOf(tab.list);
        // the prices on their way (the strip sits outside the page's skeleton scope), or an AI's pocket still read
        const pending = (!!tab.pocket?.pending && !tab.list.length) || (loading && tab.list.length > 0);
        const failed = !!tab.pocket?.error && !tab.list.length;
        const on = tab.key === scope;
        return (
          <button key={tab.key} type="button" role="tab" aria-selected={on} tabIndex={on ? 0 : -1} className={sh.market} onClick={() => onScope(tab.key)}>
            <b>{tab.label}</b>
            {pending ? (
              <span className={`${sh.mSub} ag-skel ag-skel-on`} aria-hidden="true">
                {countText(tab.list.length || 1, !!tab.pocket)}
              </span>
            ) : (
              <span className={sh.mSub}>{failed ? "can't read its pocket" : countText(tab.list.length, !!tab.pocket)}</span>
            )}
          </button>
        );
      })}
      <span className={sh.stripNote}>Valued at each month's last traded price.</span>
    </div>
  );
}

// ------------------------------------------------------------------ the header

/** Pay me daily in view: what it has paid, the month "Paid to you" follows (paying now first), and its days, listed
 *  only when the chain's record backs them (dailyShares). */
interface PaidInfo {
  total: number;
  focus: Holding;
  series: Series | undefined;
  stage: MonthStage | null;
  ok: boolean;
  shares: DayPaid[];
  atOnce: number;
  /** the newest day's share while the month pays, else null */
  newest: DayPaid | null;
  line: string;
}

function paidOf(daily: Holding[], history: (gpu: string) => Day[] | undefined, now: number): PaidInfo | null {
  if (!daily.length) return null;
  const focus = [...daily].sort((a, b) => stageRank(a.v.stage) - stageRank(b.v.stage) || (a.p.month < b.p.month ? 1 : -1))[0];
  const series = focus.series;
  const stage = series ? monthStage(series, now) : null;
  const checked = daily.filter((h) => h.p.month === focus.p.month).map((h) => dailyShares(h.p, h.series, history(h.p.gpu)));
  const ok = !!series && checked.every((x) => x !== null);
  const shares = ok ? sharesByDay(checked.map((x) => x!.days)) : [];
  const paying = stage === "paying" || stage === "lastDay" || stage === "closed";
  return {
    total: daily.reduce((a, h) => a + h.p.paid, 0),
    focus,
    series,
    stage,
    ok,
    shares,
    atOnce: ok ? checked.reduce((a, x) => a + x!.atOnce, 0) : 0,
    newest: paying ? (shares[0] ?? null) : null,
    line: series && stage ? shareLine(series, stage, now) : "",
  };
}

function useHistory() {
  const { markets } = useMarkets();
  return (gpu: string) => markets?.find((x) => x.gpu === gpu)?.history;
}

/** The market's Simple header with the account in it: worth now, paid to you, and four figures beside them. */
function HeadPanel({ list, scope, ai, now, loading }: { list: Holding[]; scope: Scope; ai: Grant | null; now: number; loading: boolean }) {
  const history = useHistory();
  const w = worthOf(list);
  const tone = changeTone(w.change);
  const paid = paidOf(
    list.filter((h) => h.p.daily),
    history,
    now,
  );
  const label = ai ? `Held by ${ai.label}, worth now` : scope === "you" ? "Yours, worth now" : "Worth now";
  const noPrice = !loading && w.open.length > 0 && !w.priced;
  return (
    <>
      <section className={`${t.panel} ${t.headPanel}`} aria-label="What you hold">
        <div className={t.hsRow}>
          <div className={t.priceBlock}>
            <span className={t.pLabel}>{label}</span>
            {/* nothing open has a price yet (the first read on its way, or Monad unreachable): never a bare $0 */}
            <span className={`${t.bigPrice} font-display ag-skel`} data-words={noPrice || undefined}>
              {/* proportional digits, like the market's big prices (even-width digit boxes space a display numeral apart) */}
              {noPrice ? "No price yet" : loading ? "$0,000" : usd0(w.worth)}
            </span>
            <span className={t.pSub}>
              {!w.open.length ? (
                <em>Nothing open right now</em>
              ) : w.change !== null ? (
                <em className={`ag-skel ${tone === "up" ? t.up : tone === "down" ? t.down : ""}`}>
                  <Num>{changeText(w.change)}</Num> since bought
                </em>
              ) : (
                <em className="ag-skel">No price to compare yet</em>
              )}
              {w.unpriced > 0 && w.priced && (
                <span>
                  {w.unpriced === 1 ? "One holding has" : `${w.unpriced} holdings have`} no price yet, so {w.unpriced === 1 ? "it isn't" : "they aren't"} counted.
                </span>
              )}
            </span>
          </div>
          {paid && (
            <div className={t.priceBlock}>
              <span className={t.pLabel}>Paid to you</span>
              <span className={`${t.bigPrice} font-display`}>{usd0(paid.total)}</span>
              <span className={t.pSub}>
                {paid.newest ? (
                  <em className={t.up}>
                    <Num>{`+${usd0(paid.newest.amount)}`}</Num> on {dateText(paid.newest.date)}
                  </em>
                ) : paid.stage === "listed" && paid.total > 0 ? (
                  // before the shares start, their first date is the "Next share" beside this: said once there
                  <span>Paid when bought</span>
                ) : (
                  paid.line && <span>{paid.line}</span>
                )}
              </span>
            </div>
          )}
          {/* everything paid out or collected: no open holding for the figures to speak of, so none (never "Not known") */}
          {(loading || w.open.length > 0) && <Stats list={list} now={now} />}
        </div>
      </section>
      {/* phones: the four figures under the header in their own panel, as on the market page */}
      {(loading || w.open.length > 0) && (
        <section className={`${t.panel} ${t.statsPanel}`} aria-label="Your figures">
          <Stats list={list} now={now} />
        </section>
      )}
    </>
  );
}

/** Ready to collect (only when there is something), the next share (or when it pays out), and when trading closes.
 *  What the holdings cost is left to the rows and the chart's break-even line. */
function Stats({ list, now }: { list: Holding[]; now: number }) {
  const open = list.filter((h) => !h.v.done);
  // only what the account itself holds is collected from here (an AI's pocket collects for itself)
  const ready = list.filter((h) => !h.by && h.v.ready > 0).reduce((a, h) => a + h.v.ready, 0);
  const held = open.flatMap((h) => (h.series ? [{ series: h.series, stage: monthStage(h.series, now) }] : []));
  const front = frontHeld(held);
  const frontStage = front ? monthStage(front, now) : null;
  const daily = open.filter((h) => h.p.daily && h.series);
  const focus = [...daily].sort((a, b) => stageRank(a.v.stage) - stageRank(b.v.stage) || (a.p.month < b.p.month ? 1 : -1))[0];
  const month = front ? monthName(front.month) : "the month";
  const unknownStat: Stat = { value: "Not known" };
  const cells: ({ label: string; note: string; stat: Stat; num?: boolean } | false)[] = [
    ready > 0 && {
      label: "Ready to collect",
      note: "Dollars your own holdings can collect now: a final month's payout, or a daily share waiting. Collect it from the holding.",
      stat: { value: usd0(ready) },
      num: true,
    },
    focus
      ? {
          label: "Next share",
          note: "Pay me daily pays a share as each day of the month turns final, about 07:00 UTC the next day.",
          stat: nextShareStat(focus.series!, monthStage(focus.series!, now), now),
        }
      : {
          label: "Pays out",
          note: "A Long or Short without pay me daily pays once, when the month's last day turns final, about 07:00 UTC.",
          stat: front && frontStage ? payOutStat(front, frontStage) : unknownStat,
        },
    {
      label: "Trading closes",
      note: `The last day to sell or buy back ${month}. After it, what you hold settles on the month's average index.`,
      stat: front && frontStage ? closesStat(front, frontStage, now) : unknownStat,
    },
  ];
  return (
    <dl className={`${t.hsGrid} ${m.stats}`} aria-label="Your figures">
      {cells.filter((x) => x !== false).map((x) => (
        <div key={x.label}>
          <dt>
            <Note label={x.label} note={x.note} />
          </dt>
          <dd>
            <span className="ag-skel">
              {x.num ? <Num>{x.stat.value}</Num> : x.stat.value}
              {x.stat.small && (
                <>
                  {" "}
                  <small>{x.stat.small}</small>
                </>
              )}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ------------------------------------------------------------------ the chart

/** Each held month's hourly candles: the same reads (same keys) as the market page's useCandles, so one cache. */
function useHeldCandles(series: Series[]) {
  const source = useSource();
  const seen = new Map<string, Series>();
  for (const sr of series) if (sr.phase !== "upcoming") seen.set(`${sr.gpu} ${sr.month}`, sr);
  const list = [...seen.entries()];
  const reads = useQueries({
    queries: list.map(([, sr]) => ({
      queryKey: [source.key, "candles", sr.gpu, sr.month],
      queryFn: () => source.candles(sr.gpu, sr.month),
      refetchInterval: (q: { state: { status: string } }) => (q.state.status === "error" ? 60_000 : 30_000),
      staleTime: 15_000,
      retry: source.kind === "live" ? 2 : 0,
      retryDelay: (attempt: number) => (attempt === 0 ? 5_000 : 10_000),
      initialData: source.initial ? () => source.initial!.candles(sr.gpu, sr.month) : undefined,
    })),
  });
  const candles: Record<string, Candle[] | undefined> = {};
  list.forEach(([k], i) => (candles[k] = reads[i]?.data));
  return {
    candles,
    wait: reads.some((r) => r.data === undefined && !r.isError),
    failed: reads.some((r) => r.data === undefined && r.isError),
  };
}

function ChartPanel({ list, now, nodata }: { list: Holding[]; now: number; nodata: boolean }) {
  const history = useHistory();
  const [pick, setView] = useState<"value" | "paid">("value");
  const [range, setRange] = useState<Range>("ALL");
  const { indexerUp } = useIndexer();
  const paid = paidOf(
    list.filter((h) => h.p.daily),
    history,
    now,
  );
  // the line follows what is still open, each valued like the header values it
  const held = list.filter((h) => !h.v.done && h.series && (h.v.long || h.series.cap > 0));
  // everything paid out: no line to draw, so the paid days are the chart (and the gain tab goes)
  const view = paid ? (held.length ? pick : "paid") : "value";
  const reads = useHeldCandles(held.map((h) => h.series!));
  const input: ValueInput[] = held.map((h) => {
    const sr = h.series!;
    const key = `${sr.gpu} ${sr.month}`;
    // bought when it says; a holding whose time is not known starts at its month's listing
    const start = [Date.parse(h.p.openedAt), Date.parse(sr.listedAt), Date.parse(reads.candles[key]?.[0]?.t ?? ""), now].find((x) => Number.isFinite(x))!;
    return { start: Math.min(start, now), q: h.p.q, long: h.v.long, cap: sr.cap, entry: h.p.entry, key, now: h.v.price };
  });
  const { points, quiet } = valueLine(input, reads.candles, now);
  const longEnough = spanHours(points) > 168;
  const shown = clipRange(points, longEnough ? RANGE_HOURS[range] : null);
  const hasCost = points.some((p) => p.cost !== null);
  const anyPaid = held.some((h) => h.p.daily || h.p.paid > 0);
  // trade history the chart needs and cannot read: said, never drawn as a flat line it would be making up
  const noHistory = !indexerUp || reads.failed;
  const drawn = view === "value" && !nodata && !noHistory && !reads.wait && shown.length > 0;

  return (
    <section className={`${t.panel} ${t.chartPanel}`} aria-label={hasCost ? "Gain or loss over time" : "Value over time"} data-series={view}>
      <div className={t.chartBar}>
        <div className={t.barLeft}>
          <div className={t.seriesTabs} role="tablist" aria-label="Chart">
            {(held.length > 0 || !paid) && (
              <button role="tab" aria-selected={view === "value"} onClick={() => setView("value")}>
                {hasCost ? "Gain or loss" : "Value"}
              </button>
            )}
            {paid && (
              <button role="tab" aria-selected={view === "paid"} onClick={() => setView("paid")}>
                Paid to you
              </button>
            )}
          </div>
        </div>
        {drawn && longEnough && (
          <div className={t.barRight}>
            <div className={t.ranges} role="group" aria-label="Range">
              {(["1W", "1M", "ALL"] as Range[]).map((r) => (
                <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>
                  {r === "ALL" ? "All" : r}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className={`${t.chartBody} ${m.chartBox} ag-skel${view === "value" && reads.wait ? " ag-skel-on" : ""}`}>
        {view === "paid" && paid ? (
          <PaidView paid={paid} />
        ) : nodata ? (
          <NoData />
        ) : noHistory ? (
          <StateBox>
            <p className={t.tCopy}>Trade history is unavailable right now, so the chart can't be drawn. The figures above are live.</p>
          </StateBox>
        ) : reads.wait ? null : shown.length ? (
          <ValueChart points={shown} gain={hasCost} />
        ) : held.length ? (
          <StateBox>
            <p className={t.tCopy}>No price to draw yet. The line starts once the months you hold have one.</p>
          </StateBox>
        ) : (
          // everything collected or paid out: nothing open to draw, and nothing to wait for
          <StateBox>
            <p className={t.tCopy}>Nothing open to chart. Everything here has settled.</p>
          </StateBox>
        )}
      </div>
      {drawn && (
        <div className={t.legend}>
          {quiet && <span>No trades since you bought: it holds at your price, then ends at the last traded price.</span>}
          {hasCost ? (
            <>
              <span>
                <i className={t.lgLine} aria-hidden="true" />
                {anyPaid ? "Gain or loss since bought, what was paid out included" : "Gain or loss since bought"}
              </span>
              <span>
                <i className={`${t.lgLine} ${m.lgDash}`} aria-hidden="true" />
                Break even
              </span>
            </>
          ) : (
            <span>
              <i className={t.lgLine} aria-hidden="true" />
              {anyPaid ? "Worth and paid to you, together" : "What it's worth"}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

/** "Paid to you": the month's days as bars (the daily shares only; what was paid at once would dwarf them), the
 *  newest paid day read out until another is pointed at or tapped. */
function PaidView({ paid }: { paid: PaidInfo }) {
  const sr = paid.series;
  const bars = sr && paid.ok ? dayBars(sr, paid.shares) : [];
  const newest = bars.reduce((at, b, i) => (b.kind === "paid" ? i : at), -1);
  const [pin, setPin] = useState<number | null>(null);
  const [hov, setHov] = useState<number | null>(null);
  const month = monthName(paid.focus.p.month);
  if (!sr || !paid.ok)
    return (
      <StateBox>
        <p className={t.tCopy}>{month}'s daily shares can't be checked against its record right now, so only the total is shown.</p>
      </StateBox>
    );
  const shown = hov ?? pin ?? (newest >= 0 ? newest : null);
  const top = Math.max(0, ...bars.map((b) => b.amount));
  const focusAt = shown ?? 0;
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const next = e.key === "ArrowRight" ? Math.min(bars.length - 1, focusAt + 1) : e.key === "ArrowLeft" ? Math.max(0, focusAt - 1) : e.key === "Home" ? 0 : e.key === "End" ? bars.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setHov(null);
    setPin(next);
    e.currentTarget.querySelectorAll<HTMLElement>("button")[next]?.focus();
  };
  const b = shown !== null ? bars[shown] : null;
  return (
    <div className={m.paid}>
      <p className={m.paidLine}>{paidLine(paid.atOnce, paid.shares)}</p>
      <p className={m.paidRead} aria-live="polite">
        {!b ? (
          "No daily share yet."
        ) : b.kind === "paid" ? (
          <>
            {dateText(b.date)}
            {b.price !== null && (
              <>
                , priced at <Num>{usd(b.price)}</Num>
              </>
            )}
            , <em>{<Num>{`+${usd(b.amount)}`}</Num>}</em>
          </>
        ) : (
          barText(b)
        )}
      </p>
      <div className={m.bars} role="group" aria-label={`${month}, day by day`} onKeyDown={onKey} onPointerLeave={() => setHov(null)}>
        {bars.map((x, i) => (
          <button
            key={x.date}
            type="button"
            className={m.bar}
            data-k={x.kind}
            aria-label={barText(x)}
            aria-pressed={i === shown}
            tabIndex={i === focusAt ? 0 : -1}
            onPointerEnter={(e) => e.pointerType === "mouse" && setHov(i)}
            onClick={() => setPin(i)}
          >
            <span style={x.kind === "paid" ? { height: `${Math.round((0.12 + 0.88 * (top > 0 ? x.amount / top : 1)) * 100)}%` } : undefined} />
          </button>
        ))}
      </div>
      <div className={m.barAxis} aria-hidden="true">
        <span>{dateText(bars[0]?.date)}</span>
        <span>{dateText(bars[bars.length - 1]?.date)}</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the list

interface Group {
  month: string;
  series: Series | undefined;
  stage: MonthStage | null;
  hs: Holding[];
}

/** Months in order, the open ones first (a month final with everything collected goes last); in a month, by GPU, your
 *  own before an AI's, pay me daily, then a Long, then a Short (round 1's order). */
function grouped(list: Holding[], now: number): Group[] {
  const months = [...new Set(list.map((h) => h.p.month))].map((month) => {
    const hs = list
      .filter((h) => h.p.month === month)
      .sort((a, b) => ALL_GPUS.indexOf(a.p.gpu) - ALL_GPUS.indexOf(b.p.gpu) || Number(!!a.by) - Number(!!b.by) || sideRank(a.p) - sideRank(b.p));
    const series = hs.find((h) => h.series)?.series;
    return { month, hs, series, stage: series ? monthStage(series, now) : null, done: hs.every((h) => h.v.done) };
  });
  months.sort((a, b) => Number(a.done) - Number(b.done) || (a.month < b.month ? -1 : 1));
  return months;
}

// five columns: the size sits under the name and the two prices share one cell (bought, then now), so each row
// reads like a sentence instead of a spreadsheet
const COLS = ["Holding", "Bought → now", "Worth", "Since bought", "Pays"];

function ListPanel({ groups, sel, now, onSelect, onClose }: { groups: Group[]; sel: Holding | null; now: number; onSelect: (h: Holding, from: "pointer" | "key") => void; onClose: (h: Holding, how: "rail" | "sheet") => void }) {
  const flat = groups.flatMap((g) => g.hs);
  // up and down move the pick through the rows (one tab stop for the list, like a grid)
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!(e.target as HTMLElement).matches('[role="row"]')) return;
    const i = flat.findIndex((h) => h === sel);
    const next = e.key === "ArrowDown" ? Math.min(flat.length - 1, i + 1) : e.key === "ArrowUp" ? Math.max(0, i - 1) : e.key === "Home" ? 0 : e.key === "End" ? flat.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    onSelect(flat[next], "key");
    const rows = e.currentTarget.querySelectorAll<HTMLElement>('[role="row"][data-key]');
    requestAnimationFrame(() => rows[next]?.focus());
  };
  return (
    <section className={`${t.panel} ${m.listPanel}`} aria-labelledby="holdings-h">
      <h2 id="holdings-h" className={m.h2}>
        Holdings
      </h2>
      <div className={m.table} role="grid" aria-labelledby="holdings-h" aria-readonly="true" onKeyDown={onKey}>
        <div className={m.headRow} role="row">
          {COLS.map((x, i) => (
            <span key={x} role="columnheader" className={i > 0 && i < 4 ? m.num : undefined}>
              {x}
            </span>
          ))}
          <span role="columnheader">
            <span className="sr-only">Close</span>
          </span>
        </div>
        {groups.map((g) => (
          <div key={g.month} className={m.group} role="rowgroup">
            <div className={m.groupRow} role="row">
              <span role="rowheader" aria-colspan={6}>
                <b>{monthName(g.month)}</b>
                {g.series && g.stage && (
                  <span>
                    {monthLine(
                      g.series,
                      g.stage,
                      g.hs.filter((h) => !h.by).map((h) => h.v),
                    )}
                  </span>
                )}
              </span>
            </div>
            {g.hs.map((h) => (
              <Row key={keyOf(h)} h={h} sel={h === sel} now={now} onSelect={onSelect} onClose={onClose} />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function Row({ h, sel, now, onSelect, onClose }: { h: Holding; sel: boolean; now: number; onSelect: (h: Holding, from: "pointer" | "key") => void; onClose: (h: Holding, how: "rail" | "sheet") => void }) {
  const account = useAccount();
  const { p, v, by, series } = h;
  // only your own, while its month trades and the router can close it
  const canClose = !by && account.ready && !v.done && !!series && monthOpen(series, now) && !!closeOrder(p);
  const tone = changeTone(v.change);
  const pays = paysCell(p.daily, p.paid, v);
  const worth = v.worth === null ? "No price" : <Num>{usd0(v.worth)}</Num>;
  const change = v.change === null ? "Not known" : <Num>{changeText(v.change)}</Num>;
  const closeBtn = (how: "rail" | "sheet") =>
    canClose && (
      <button
        type="button"
        className={`ag-btn ag-btn--soft ${m.closeBtn}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose(h, how);
        }}
      >
        Close
      </button>
    );
  return (
    <div
      className={m.row}
      role="row"
      data-key={keyOf(h)}
      data-done={v.done || undefined}
      aria-selected={sel}
      tabIndex={sel ? 0 : -1}
      onClick={() => onSelect(h, "pointer")}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect(h, "key");
        }
      }}
    >
      <span role="gridcell" className={m.cHold}>
        <span className={m.cTop}>
          <b>{p.gpu}</b>
          {by && <span className={m.by}>Held by {by.label}</span>}
        </span>
        <span>
          {sideText(p)} · <Num>{showHours(p.q)}</Num> GPU-hours
        </span>
      </span>
      <span role="gridcell" className={m.num}>
        <span className={m.then}>{p.entry > 0 ? <Num>{usd(p.entry)}</Num> : "Not known"}</span>
        <span className={m.arrow} aria-hidden="true">
          {" → "}
        </span>
        <span className="sr-only">, now </span>
        <span className="ag-skel">{v.price !== null ? <Num>{usd(v.price)}</Num> : "No price"}</span>
      </span>
      <span role="gridcell" className={m.num}>
        <span className="ag-skel">{worth}</span>
      </span>
      <span role="gridcell" className={m.num} data-tone={tone}>
        <span className="ag-skel">{change}</span>
      </span>
      <span role="gridcell" className={m.pays}>
        {pays}
      </span>
      <span role="gridcell" className={m.act}>
        {closeBtn("rail")}
      </span>
      {/* phones: round 1's two-line card (side and size over cost, worth and change over what it pays) */}
      <span role="gridcell" className={m.card}>
        <span className={m.cardHead}>
          <span className={m.cardWho}>
            <b>{p.gpu}</b>
            {by && <span className={m.by}>Held by {by.label}</span>}
          </span>
          {closeBtn("sheet")}
        </span>
        <span className={m.cardBody}>
          <span className={m.what}>
            {sideText(p)} · <Num>{showHours(p.q)}</Num> GPU-hours
          </span>
          <span className={m.worth}>
            <span className="ag-skel">{worth}</span>
            {v.change !== null && (
              <span className="ag-skel" data-tone={tone}>
                {change}
              </span>
            )}
          </span>
          <span className={m.cost}>{v.cost === null ? "Cost not known yet" : <>Cost {<Num>{usd0(v.cost)}</Num>}</>}</span>
          <span className={m.cardPays}>{pays}</span>
        </span>
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ the rail

function Chevron() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path d="M4.5 2.5l3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    </svg>
  );
}

function PocketLink({ grant }: { grant: Grant }) {
  const q = useLinkQuery();
  return (
    <Link className={`ag-btn ag-btn--soft ${m.wide}`} href={`/app/ai/${encodeURIComponent(grant.id)}${q}`}>
      See {grant.label}'s pocket
      <Chevron />
    </Link>
  );
}

/** The holding picked: its month and the way to its market, what it is, its timeline, Collect when something is
 *  ready, and its close (the trade panel's own close form), or for an AI's, the way to that pocket. */
function Picked({ h, now, loading }: { h: Holding; now: number; loading: boolean }) {
  const account = useAccount();
  const q = useLinkQuery();
  const { p, v, by, series } = h;
  const [collecting, setCollecting] = useState(false);
  const month = monthName(p.month);
  const stage = series ? monthStage(series, now) : null;
  const L = p.side === "long";
  const canCollect = !by && v.ready > 0 && !!account.collect;
  const closable = !!series && monthOpen(series, now) && !!closeOrder(p);
  const why = closeWhy(stage, month, closable, p.kind);
  const collect = async () => {
    setCollecting(true);
    try {
      await account.collect?.(p);
    } finally {
      setCollecting(false);
    }
  };
  return (
    <>
      <div className={t.tTop}>
        <b>
          {month} {p.gpu}
        </b>
        <Link className={m.go} href={marketHref(q, p.gpu)}>
          Go to market
          <Chevron />
        </Link>
      </div>
      <div className={c.hold}>
        <span className={c.holdText}>
          <b>
            {!by && "Your "}
            <span data-side={p.side}>{L ? "Long" : "Short"}</span>
            {p.daily ? ", paid daily" : ""}
          </b>
          <span>
            <Num>{showHours(p.q)}</Num> GPU-hours
            {p.entry > 0 && (
              <>
                , {L ? "bought" : "opened"} at <Num>{usd(p.entry)}</Num>
              </>
            )}
          </span>
          {by && <span>Held by {by.label} in its own pocket</span>}
        </span>
      </div>
      {series && stage && (
        <ol className={m.steps}>
          {steps({ openedAt: p.openedAt, daily: p.daily, series, stage, now }).map((x) => (
            <li key={x.label} data-done={x.done || undefined}>
              <span className={m.dot} aria-hidden="true" />
              <span className={m.stepText}>
                <span>{x.label}</span>
                {x.sub && <span className={m.stepSub}>{x.sub}</span>}
              </span>
              <span className={m.stepWhen}>{x.when}</span>
            </li>
          ))}
        </ol>
      )}
      {canCollect && (
        <button type="button" className={`ag-btn ag-btn--primary ${m.wide}`} disabled={collecting} onClick={collect}>
          {collecting ? (
            <>
              <span className="ag-spinner" aria-hidden="true" />
              Collecting
            </>
          ) : (
            <>
              Collect <Num>{usd0(v.ready)}</Num>
            </>
          )}
        </button>
      )}
      {by ? (
        <PocketLink grant={by} />
      ) : (
        !v.done &&
        stage !== "final" && (
          <section className={m.closeSec} aria-labelledby="rail-close-h">
            <h2 id="rail-close-h" className={m.h2} tabIndex={-1}>
              Close
            </h2>
            {loading ? (
              <div className={`${m.skelHold} ag-skel ag-skel-on`} aria-hidden="true" />
            ) : why ? (
              <p className={m.quiet}>{why}</p>
            ) : (
              <div className={m.closeForm}>
                <CloseForm key={p.id} p={p} onClose={() => {}} />
              </div>
            )}
          </section>
        )
      )}
    </>
  );
}

// ------------------------------------------------------------------ empty, signed out, loading

/** Trade the next month (and take today's test dollars while they are there): the empty page's way in. */
function TradeActs() {
  const q = useLinkQuery();
  const next = useNextMonth();
  const account = useAccount();
  const drip = useDrip();
  return (
    <>
      <span className={m.actRow}>
        <Link className="ag-btn ag-btn--primary" href={`/app${q}`}>
          {next ? `Trade ${monthLong(next.month)}` : "Go to Markets"}
        </Link>
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
      </span>
      {drip.error && (
        <p className="ag-fine" aria-live="polite">
          {drip.error}
        </p>
      )}
    </>
  );
}

/** The frame with nothing in it, as a quiet preview of what it becomes: the header's labels over soft blank figures,
 *  a faded gain line, the rail's shapes, and one card in the middle that says what is here and the way in (Lighter's
 *  ghost preview, made calm). The figures are an illustration, hidden from screen readers; the card carries the words. */
function EmptyPanels({ label = "Worth now", title, text, notes, acts }: { label?: string; title: string; text: string; notes?: ReactNode; acts?: ReactNode }) {
  const blank = (cls: string) => <span className={`${m.ghost} ${cls}`} />;
  return (
    <div className={m.grid} data-empty>
      <section className={`${t.panel} ${t.headPanel}`} aria-hidden="true">
        <div className={t.hsRow}>
          <div className={t.priceBlock}>
            <span className={t.pLabel}>{label}</span>
            {blank(m.ghostBig)}
            {blank(m.ghostSub)}
          </div>
          <div className={t.priceBlock}>
            <span className={t.pLabel}>Paid to you</span>
            {blank(m.ghostBig)}
            {blank(m.ghostSub)}
          </div>
          <dl className={`${t.hsGrid} ${m.stats}`}>
            {["Next share", "Trading closes"].map((x) => (
              <div key={x}>
                <dt>{x}</dt>
                <dd>{blank(m.ghostStat)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
      <section className={`${t.panel} ${t.chartPanel}`} aria-labelledby="pos-empty-title">
        <div className={`${t.chartBody} ${m.chartBox} ${m.exampleBox}`}>
          <ExampleLine />
          <div className={m.exampleActs}>
            <div className={m.invite}>
              <h2 id="pos-empty-title" className={`${m.inviteTitle} font-display`}>
                {title}
              </h2>
              <p className={m.inviteText}>{text}</p>
              {notes}
              {acts}
            </div>
          </div>
        </div>
      </section>
      <aside className={`${t.panel} ${m.rail}`} aria-label="Your AIs">
        <div className={m.railInner}>
          <div className={m.ghostRail} aria-hidden="true">
            {blank(m.ghostTitle)}
            {blank(m.ghostCard)}
            {blank(m.ghostLine)}
            {blank(m.ghostLine)}
            {blank(m.ghostLine)}
          </div>
          <YourAis className={m.ais} titleClass={m.h2} />
        </div>
      </aside>
    </div>
  );
}

/** Signed out, or signed in with nothing held anywhere. `unread`: pockets that could not be read, said so, since they
 *  may hold something. */
function Empty({ out = false, unread = [] }: { out?: boolean; unread?: PocketRead[] }) {
  const { openSignIn } = useFlow();
  const q = useLinkQuery();
  return (
    <main className={t.main}>
      <EmptyPanels
        title={out ? "See what you hold" : "Nothing held yet"}
        text={out ? "Sign in to see your positions, what they're worth now and what they've paid you." : "Your first trade shows up here, with what it's worth and what it pays you."}
        notes={unread.map((x) => (
          <p key={x.grant.id} className={m.inviteNote}>
            Can't read {x.grant.label}'s pocket right now. Trying again.
          </p>
        ))}
        acts={
          out ? (
            <span className={m.actRow}>
              <button type="button" className="ag-btn ag-btn--primary" onClick={openSignIn}>
                Sign in
              </button>
              <Link className="ag-btn ag-btn--soft" href={`/app${q}`}>
                Explore markets
              </Link>
            </span>
          ) : (
            <TradeActs />
          )
        }
      />
    </main>
  );
}

/** The frame while the account arrives: masked figures, never numbers (and never a "Nothing held" flash). */
function WaitingGrid() {
  return (
    <div className={m.grid} aria-busy="true">
      <section className={`${t.panel} ${t.headPanel}`} aria-label="Loading what you hold">
        <div className={t.hsRow}>
          <div className={t.priceBlock}>
            <span className={t.pLabel}>Worth now</span>
            <span className={`${t.bigPrice} font-display ag-skel ag-skel-on`} aria-hidden="true">
              $0,000
            </span>
            <span className={t.pSub}>
              <em className="ag-skel ag-skel-on" aria-hidden="true">
                +$00 since bought
              </em>
            </span>
          </div>
          <dl className={t.hsGrid} aria-hidden="true">
            {["What you paid", "Ready to collect", "Next share", "Trading closes"].map((x) => (
              <div key={x}>
                <dt>{x}</dt>
                <dd>
                  <span className="ag-skel ag-skel-on">$0,000</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
      <section className={`${t.panel} ${t.chartPanel}`} aria-hidden="true">
        <div className={t.chartBar}>
          <div className={t.barLeft}>
            <div className={t.seriesTabs} role="tablist">
              <button type="button" role="tab" aria-selected="true" tabIndex={-1}>
                Value
              </button>
            </div>
          </div>
        </div>
        <div className={`${t.chartBody} ${m.chartBox} ag-skel ag-skel-on`} />
      </section>
      <section className={`${t.panel} ${m.listPanel}`} aria-hidden="true">
        <h2 className={m.h2}>Holdings</h2>
        <div className={`${m.skelRow} ag-skel ag-skel-on`} />
        <div className={`${m.skelRow} ag-skel ag-skel-on`} />
        <div className={`${m.skelRow} ag-skel ag-skel-on`} />
      </section>
      <aside className={`${t.panel} ${m.rail}`} aria-hidden="true">
        <div className={m.railInner}>
          <div className={`${m.skelHold} ag-skel ag-skel-on`} />
        </div>
      </aside>
    </div>
  );
}

function Waiting() {
  return (
    <main className={`${t.main} is-loading`} aria-busy="true">
      <WaitingGrid />
    </main>
  );
}
