"use client";
// The Index page in the market page's frame (round 2, Oct 7; Mock controls "Index page": market). The same app as
// Markets: the strip of GPUs, a header band with the price and four figures, the chart panel, the full-height column
// on the right, panels split by hairlines. The story: today's price, how it moved, where it comes from, how it is made.
// Each number is said once; the days as a list sit behind the chart's own tab, not in another section.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CopyButton } from "@/components/flow/Copy";
import { Num } from "@/components/num/Num";
import { BottomDock } from "@/components/shell/Dock";
import { MarketStrip, NavBar, Notice } from "@/components/shell/Shell";
import { LineChart, type Range } from "@/components/trade/LineChart";
import { Note } from "@/components/trade/Note";
import { NoData, StateBox } from "@/components/trade/States";
import t from "@/components/trade/trade.module.css";
import { explorerAddress, shortAddress } from "@/lib/account/aiView";
import { useDataStatus, useMarkets, useNow, useScreenMarket } from "@/lib/data/hooks";
import { countdown, countWord, dateText, panelCount, statusLine, timeText, whenText } from "@/lib/data/derive";
import { usd } from "@/lib/format";
import { groundFor } from "@/lib/mock/config";
import { useLinkQuery, useMock } from "@/lib/mock/store";
import type { Market } from "@/lib/mock/types";
import { useThemeColor } from "@/lib/ui/hooks";
import { changeWords, checkLine, cloudsCell, dayItems, dayMove, howSteps, ladder, periodCells, railLine, tradeLabel, type Rung, type Tone } from "./marketView";
import { INDEX_CONTRACT } from "./pages";
import type { CloudRow } from "./view";
import x from "./indexmarket.module.css";

const tone = (v: Tone) => (v === "up" ? t.up : v === "down" ? t.down : undefined);

/** The live part of "Next price": "in 15h 33m", read again every 30 s (minutes, like the market's next index price).
 *  Nothing until the page runs, so the server's render and the browser's first one agree. */
function Countdown({ at, children, hold = false }: { at: string; children: (left: string) => React.ReactNode; hold?: boolean }) {
  const [left, setLeft] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setLeft(countdown(at, Date.now()) ?? "due");
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [at]);
  // hold: the countdown is the whole figure, so its place shimmers for the moment before the page runs
  if (!left)
    return hold ? (
      <span className="ag-skel ag-skel-on" aria-hidden="true">
        15h 00m
      </span>
    ) : null;
  return <>{left === "due" ? "Any minute now" : children(left)}</>;
}

function ArrowOut({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path d="M4.5 3h4.5v4.5M9 3L3.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg className={x.chev} viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path d="M4.5 2.5l3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    </svg>
  );
}

/** The figures beside the price, the market header's layout: two rows by two columns, a hairline before each column.
 *  Before the first price there is no change to show, so only the time and the clouds stand. */
function Stats({ market, loading }: { market: Market; loading: boolean }) {
  const before = !loading && market.priceDate === null;
  // while the first read is on its way: the normal labels over skeletons (never "0 of 0")
  const clouds = loading ? { label: "Clouds counted", value: "5 of 5", quiet: "plus 1 reserve" } : cloudsCell(market);
  const sk = (v: React.ReactNode) => (loading ? <span className="ag-skel">{v}</span> : v);
  // 7 and 30 days (their labels over skeletons while loading); before the first price there is no change to show
  const periods = before ? [] : periodCells(market.history);
  return (
    <dl className={`${t.hsGrid} ${x.stats}`} aria-label={`${market.gpu} index figures`}>
      {periods.map((cell) => {
        const c = loading ? null : cell;
        return (
          <div key={cell.n}>
            <dt>{c?.note ? <Note label={cell.label} note={c.note} /> : cell.label}</dt>
            <dd>
              {sk(
                c ? (
                  <>
                    <span className={tone(c.tone)}>
                      <Num>{c.value}</Num>
                    </span>
                    {c.quiet && (
                      <>
                        {" "}
                        <small>{c.tone ? <Num>{c.quiet}</Num> : c.quiet}</small>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    +0.0% <small>+$0.00</small>
                  </>
                ),
              )}
            </dd>
          </div>
        );
      })}
      <div>
        <dt>{before ? "First price in" : "Next price"}</dt>
        <dd>
          {sk(
            before ? (
              // the big figure already says the day and the time: here only how long until it
              <Countdown at={market.nextUpdateAt} hold>
                {(left) => left}
              </Countdown>
            ) : (
              <>
                {timeText(market.nextUpdateAt) || "07:00 UTC"}{" "}
                <small>
                  <Countdown at={market.nextUpdateAt}>{(left) => `in ${left}`}</Countdown>
                </small>
              </>
            ),
          )}
        </dd>
      </div>
      <div>
        <dt>{clouds.label}</dt>
        <dd>
          {sk(
            <>
              {clouds.value}
              {clouds.quiet && (
                <>
                  {" "}
                  <small>{clouds.quiet}</small>
                </>
              )}
            </>,
          )}
        </dd>
      </div>
    </dl>
  );
}

/** One counted cloud: its dot, name and price, a link to the page the price was read from. */
function CloudRung({ row }: { row: CloudRow }) {
  const inner = (
    <>
      <i className={x.dot} aria-hidden="true" />
      <span className={x.rName}>
        {row.family}
        {row.middle && <em>The index</em>}
      </span>
      <span className={x.rPrice}>{row.price !== null ? <Num>{usd(row.price)}</Num> : null}</span>
      {row.url ? <ArrowOut className={x.out} /> : <span aria-hidden="true" />}
    </>
  );
  return row.url ? (
    <a className={x.rung} data-mid={row.middle || undefined} href={row.url} target="_blank" rel="noopener noreferrer" title={row.url}>
      {inner}
    </a>
  ) : (
    <div className={x.rung} data-mid={row.middle || undefined}>
      {inner}
    </div>
  );
}

function RestRung({ row }: { row: CloudRow }) {
  const inner = (
    <>
      <i className={x.dot} data-ring aria-hidden="true" />
      <span className={x.rName}>
        {row.family}
        <em>{row.reserve ? "Reserve, not counted today" : "Not counted today"}</em>
      </span>
      <span className={x.rPrice}>{row.price !== null ? <Num>{usd(row.price)}</Num> : null}</span>
      {row.url ? <ArrowOut className={x.out} /> : <span aria-hidden="true" />}
    </>
  );
  return row.url ? (
    <a className={x.rung} data-rest href={row.url} target="_blank" rel="noopener noreferrer" title={row.url}>
      {inner}
    </a>
  ) : (
    <div className={x.rung} data-rest>
      {inner}
    </div>
  );
}

function Ladder({ rungs, rest }: { rungs: Rung[]; rest: CloudRow[] }) {
  return (
    <div className={`${x.well} ${x.book}`}>
      <div className={x.ladder}>
        {rungs.map((r) =>
          r.kind === "cloud" ? (
            <CloudRung key={r.row.family} row={r.row} />
          ) : (
            // an even count: the index itself, between the two middle clouds (like a book's spread row)
            <div key="mid" className={x.rung} data-mid>
              <i className={x.dot} aria-hidden="true" />
              <span className={x.rName}>
                The index<em>halfway between</em>
              </span>
              <span className={x.rPrice}>
                <Num>{usd(r.price)}</Num>
              </span>
              <span aria-hidden="true" />
            </div>
          ),
        )}
      </div>
      {rest.length > 0 && (
        <div className={x.ladder}>
          {rest.map((r) => (
            <RestRung key={r.family} row={r} />
          ))}
        </div>
      )}
    </div>
  );
}

export function IndexMarket() {
  const { config } = useMock();
  // the shared markets read (a neutral stand-in until it answers)
  const read = useScreenMarket(config.gpu);
  const market = read.market;
  const loading = read.loading;
  // nothing read and nothing on its way: Monad unreachable before any data came in
  const nodata = read.missing && !loading;
  // the index before its first final price (once data has answered; loading has its skeletons)
  const before = !read.missing && market.priceDate === null;
  const st = useDataStatus();
  const { markets } = useMarkets();
  const now = useNow();
  const linkQuery = useLinkQuery();
  // the logger's days before the first onchain day come first, drawn lighter, then the index's own (as on Markets)
  const days = useMemo(() => (market.prelaunch?.length ? [...market.prelaunch, ...market.history] : market.history), [market.prelaunch, market.history]);
  const [range, setRange] = useState<Range>("3M");
  const [view, setView] = useState<"chart" | "days">("chart");
  const items = useMemo(() => dayItems(days, range), [days, range]);
  // the two views need days to tell apart, and the range needs more than one; with none, the plot says why alone
  const tabs = !nodata && (loading || days.length > 0);
  const ranges = !loading && !nodata && days.length > 1;
  const shown = tabs ? view : "chart";
  const hasCarried = days.some((d) => d.status === "carried");
  const hasExample = days.some((d) => d.example);
  const hasLogger = days.some((d) => d.onchain === false);
  const hasRecord = days.some((d) => !d.example && d.onchain !== false);
  const recordFrom = dateText(days.find((d) => !d.example && d.onchain !== false)?.date);
  const move = dayMove(market);
  const book = useMemo(() => ladder(market), [market]);
  const check = checkLine(market);
  const trade = tradeLabel(market, now);
  const snapshotUrl = process.env.NEXT_PUBLIC_AGATE_SNAPSHOT_URL;
  const dark = config.theme === "dark";
  useEffect(() => {
    document.documentElement.style.background = groundFor(config);
  }, [config.theme]);
  useThemeColor(config.theme);
  // a skeleton class while loading (added only then, so the normal markup is unchanged)
  const sk = (cls?: string) => (loading ? (cls ? `${cls} ag-skel` : "ag-skel") : cls);
  const gpu = market.gpu;
  // before the first price with nothing drawn yet: one line in the plot (the date is in the header already)
  const startsLine = `One price a day from ${countWord(panelCount(market))} clouds, drawn here as each day turns final.`;

  return (
    <div className={`${x.screen} ${dark ? "tone-dark" : "tone-light"} ${loading ? "is-loading" : ""}`} data-phone={config.phone} aria-busy={loading || undefined}>
      <Notice status={statusLine(st, !!markets)} />
      <NavBar active="index" />
      <MarketStrip all />
      <main className={x.main}>
        <div className={x.grid}>
          <section className={`${t.panel} ${t.headPanel}`} aria-label={`${gpu} index`}>
            {nodata ? (
              <NoData start />
            ) : (
              <div className={t.hsRow}>
                <div className={t.priceBlock}>
                  <span className={t.pLabel}>{before ? `${gpu} index` : `Today's ${gpu} index`}</span>
                  <span className={`${t.bigPrice} font-display ag-skel`} data-words={before || undefined}>
                    {loading ? usd(0) : before ? dateText(market.nextUpdateAt) : usd(market.price)}
                  </span>
                  <span className={t.pSub}>
                    <em className={sk(tone(move.tone))}>{loading ? "Same as yesterday" : move.text}</em>
                    {(loading || move.quiet) && <span className={sk()}>{loading ? "The price for Oct 2" : move.quiet}</span>}
                  </span>
                </div>
                <Stats market={market} loading={loading} />
              </div>
            )}
          </section>

          <section className={`${t.panel} ${t.chartPanel}`} aria-label={`${gpu} index history`}>
            {(tabs || ranges) && (
              <div className={t.chartBar}>
                <div className={t.barLeft}>
                  {tabs && (
                    <div className={`${t.seriesTabs} ${x.touch}`} role="tablist" aria-label="History">
                      <button type="button" role="tab" id="ix-tab-chart" aria-selected={view === "chart"} aria-controls="ix-history" onClick={() => setView("chart")}>
                        Price history
                      </button>
                      <button type="button" role="tab" id="ix-tab-days" aria-selected={view === "days"} aria-controls="ix-history" onClick={() => setView("days")}>
                        Day by day
                      </button>
                    </div>
                  )}
                </div>
                {ranges && (
                  <div className={t.barRight}>
                    <div className={`${t.ranges} ${x.touch}`} role="group" aria-label="Range">
                      {(["1W", "1M", "3M", "ALL"] as Range[]).map((r) => (
                        <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}>
                          {r === "ALL" ? "All" : r}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            <div
              id="ix-history"
              role={tabs ? "tabpanel" : undefined}
              aria-labelledby={tabs ? (shown === "chart" ? "ix-tab-chart" : "ix-tab-days") : undefined}
              className={`${t.chartBody} ${x.body} ag-skel`}
            >
              {shown === "chart" ? (
                before && !hasLogger ? (
                  <StateBox>
                    <p className={t.tCopy}>{startsLine}</p>
                  </StateBox>
                ) : (
                  <LineChart days={days} range={range} height="100%" />
                )
              ) : items.length === 0 ? (
                <StateBox>
                  <p className={t.tCopy}>{loading ? "" : startsLine}</p>
                </StateBox>
              ) : (
                <ol className={x.days} aria-label={`${gpu} index by day, newest first`}>
                  {items.map((it) =>
                    it.type === "divider" ? (
                      <li key={`d-${it.kind}`} className={x.divider}>
                        {it.text}
                      </li>
                    ) : (
                      <DayRow key={it.date} date={it.date} price={it.price} change={it.change} carried={it.carried} light={it.kind !== "onchain"} />
                    ),
                  )}
                </ol>
              )}
            </div>
            {shown === "chart" && !loading && !nodata && (!before || hasLogger) && (
              <div className={t.legend}>
                <span>One price a day, so it moves in steps.</span>
                {hasRecord && (
                  <span>
                    <i className={t.lgLine} aria-hidden="true" />
                    Our record{recordFrom ? `, from ${recordFrom}` : ""}
                  </span>
                )}
                {hasLogger && (
                  <span>
                    <i className={`${t.lgLine} ${t.lgExample}`} aria-hidden="true" />
                    Recorded by our logger, not onchain
                  </span>
                )}
                {hasExample && (
                  <span>
                    <i className={`${t.lgLine} ${t.lgExample}`} aria-hidden="true" />
                    Example history
                  </span>
                )}
                {hasCarried && (
                  <span>
                    <i className={t.lgDot} aria-hidden="true" />
                    Carried day, unverified
                  </span>
                )}
              </div>
            )}
          </section>

          <aside className={`${t.panel} ${t.ticketPanel} ${x.rail}`} aria-label={`Where the ${gpu} index comes from`}>
            <div className={x.group}>
              <h2 className={x.title}>Where the price comes from</h2>
              <p className={x.lead}>{railLine(gpu, { before, halfway: book.halfway })}</p>
              {loading ? (
                <div className={`${x.well} ${x.skelLadder} ag-skel`} aria-hidden="true" />
              ) : (
                !nodata && (book.rungs.length > 0 || book.rest.length > 0) && <Ladder rungs={book.rungs} rest={book.rest} />
              )}
              {/* an index-only GPU (or any GPU) before its first price: the clouds are being read, no prices yet */}
              {before && <p className={x.quiet}>Their prices show here once the first day is final.</p>}
            </div>

            <div className={`${x.well} ${x.box}`}>
              {loading ? (
                <p className={`${x.check} ag-skel`} aria-hidden="true">
                  The middle of these five is $3.99, and the index contract reads $3.99.
                </p>
              ) : (
                check && (
                  <p className={x.check} data-same={check.same}>
                    {check.same ? (
                      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                        <path d="M4 8h8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
                      </svg>
                    )}
                    <span>{check.text}</span>
                  </p>
                )
              )}
              <div className={x.contract}>
                <span className={x.cLabel}>Index contract</span>
                <span className={x.addr}>
                  <Num>{shortAddress(INDEX_CONTRACT)}</Num>
                </span>
                <span className={x.cBtns}>
                  <CopyButton text={INDEX_CONTRACT} what="the index contract's address" className={x.mini} />
                  <a className={x.mini} href={explorerAddress(INDEX_CONTRACT)} target="_blank" rel="noopener noreferrer">
                    Explorer
                    <ArrowOut />
                  </a>
                </span>
              </div>
              <p className={x.quiet}>On Monad testnet.{!before && !loading && market.updatedAt ? ` Final ${whenText(market.updatedAt)}.` : ""}</p>
            </div>

            <div className={x.actions}>
              {snapshotUrl && (
                <a className={x.action} href={snapshotUrl} target="_blank" rel="noopener noreferrer">
                  <b>Get every price as JSON</b>
                  <Chevron />
                </a>
              )}
              <Link className={x.action} href={`/ai${linkQuery}`}>
                <b>Ask your AI for today's {gpu} index</b>
                <Chevron />
              </Link>
            </div>

            <div className={trade ? x.railEnd : undefined}>
              {trade ? (
                <Link className={`${t.cta} ${x.ctaLink}`} href={`/${linkQuery}`}>
                  {trade}
                </Link>
              ) : (
                <p className={x.quiet}>{gpu} has an index only, no market yet.</p>
              )}
            </div>
          </aside>

          <section className={`${t.panel} ${x.how}`} aria-labelledby="ix-how">
            <h2 id="ix-how" className={x.title}>
              How the price is made
            </h2>
            <ol className={x.steps}>
              {howSteps(gpu).map((step, i) => (
                <li key={step.title}>
                  {/* the number beside its title, on one baseline, so the four steps stay short */}
                  <span className={x.stepHead}>
                    <span className={`${x.stepNo} font-display`} aria-hidden="true">
                      {i + 1}
                    </span>
                    <b>{step.title}</b>
                  </span>
                  <span>{step.text}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </main>
      {config.phone === "new" && <BottomDock active="index" />}
    </div>
  );
}

/** One day of the list: the date, its change from the day before (or that it was carried), the price. */
function DayRow({ date, price, change, carried, light }: { date: string; price: number; change: number | null; carried: boolean; light: boolean }) {
  const c = changeWords(change);
  return (
    <li className={x.day} data-light={light || undefined}>
      <span className={x.dDate}>{dateText(date)}</span>
      <span className={`${x.dChange} ${carried || !c.tone ? x.muted : tone(c.tone)}`}>{carried ? "Carried, unverified" : c.tone ? <Num>{c.text}</Num> : c.text}</span>
      <span className={x.dPrice}>
        <Num>{usd(price)}</Num>
      </span>
    </li>
  );
}
