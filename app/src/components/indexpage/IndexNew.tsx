"use client";
// The Index page, reworked (Oct 6 mock; Mock controls "Index page": new). One GPU's index the way the best index pages
// show one (trade-refs/pages/index-pages.md): a switcher of sparkline cards (Computable), the price with its date,
// cadence and method in one line and its change over 1, 7 and 30 days (Ornn), the clouds as dots on one price line
// with a row each (Computable), the onchain facts beside the chart (Chainlink), the last 14 days, how to use the
// price, every GPU in one table, the traded prices beside ours, and the method in plain words.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CopyButton } from "@/components/flow/Copy";
import { Num } from "@/components/num/Num";
import { BottomDock } from "@/components/shell/Dock";
import { NavBar, Notice } from "@/components/shell/Shell";
import { Beside } from "@/components/trade/Insight";
import { LineChart, type Range } from "@/components/trade/LineChart";
import { indexStartsText, NoData } from "@/components/trade/States";
import { shortAddress } from "@/lib/account/aiView";
import { useDataStatus, useMarkets, useScreenMarket } from "@/lib/data/hooks";
import { countWord, dateText, panelCount, statusLine, timeText } from "@/lib/data/derive";
import { signedUsd, usd } from "@/lib/format";
import { groundFor } from "@/lib/mock/config";
import { ALL_GPUS } from "@/lib/mock/data";
import { useLinkQuery, useMock } from "@/lib/mock/store";
import type { Gpu } from "@/lib/mock/types";
import { reducedMotion, useThemeColor } from "@/lib/ui/hooks";
import { Facts } from "./Facts";
import { GpuCards } from "./GpuCards";
import { INDEX_CONTRACT } from "./pages";
import { PriceLine } from "./PriceLine";
import { changeOver, pctText, recentDays, type DayRow } from "./view";
import s from "./indexnew.module.css";

const PERIODS = [
  [1, "1 day"],
  [7, "7 days"],
  [30, "30 days"],
] as const;

/** Up, down or flat, for the one place color is allowed: the direction of a move. */
const dir = (n: number | null | undefined) => (n === null || n === undefined || Math.abs(n) < 0.005 ? s.flat : n > 0 ? s.up : s.down);

/** Under the 14 days, once instead of on every row: which of them are not onchain (drawn lighter), by their dates. */
function lightNotes(rows: DayRow[], recordFrom: string | undefined) {
  // "Oct 1 to Oct 3" (newest first in `rows`), and whether it is more than one day
  const span = (kind: DayRow["kind"]) => {
    const ds = rows.filter((r) => r.kind === kind).map((r) => r.date);
    if (!ds.length) return null;
    return { text: ds.length > 1 ? `${dateText(ds[ds.length - 1])} to ${dateText(ds[0])}` : dateText(ds[0]), many: ds.length > 1 };
  };
  const logger = span("logger");
  const example = span("example");
  return [
    logger && `${logger.text} ${logger.many ? "were" : "was"} recorded by our logger before the index went onchain. Nothing settles on ${logger.many ? "them" : "it"}.`,
    example && `${example.text} ${example.many ? "are" : "is"} example history${recordFrom ? `, before our record starts ${dateText(recordFrom)}` : ""}.`,
  ].filter((x): x is string => !!x);
}

export function IndexNew() {
  const { config, setConfig } = useMock();
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
  const linkQuery = useLinkQuery();
  // the history: the logger's days before the first onchain day (drawn lighter), then the index's own
  const days = useMemo(() => (market.prelaunch?.length ? [...market.prelaunch, ...market.history] : market.history), [market.prelaunch, market.history]);
  const hasLogger = days.some((d) => d.onchain === false);
  const hasExample = days.some((d) => d.example);
  const hasCarried = days.some((d) => d.status === "carried");
  // where the onchain record starts (example history before it is drawn lighter, like the logger's days)
  const recordFrom = market.history.find((d) => !d.example)?.date;
  const [range, setRange] = useState<Range>("3M");
  const recent = useMemo(() => recentDays(days, 14), [days]);
  const last = market.history[market.history.length - 1];
  const carried = last?.status === "carried";
  const panel = panelCount(market);
  const counted = before ? panel : market.liveCount;
  const snapshotUrl = process.env.NEXT_PUBLIC_AGATE_SNAPSHOT_URL;
  const dark = config.theme === "dark";
  useEffect(() => {
    document.documentElement.style.background = groundFor(config);
  }, [config.theme]);
  useThemeColor(config.theme);
  // a skeleton class while loading (added only then, so the normal markup is unchanged)
  const sk = (cls?: string) => (loading ? `${cls ?? ""} ag-skel` : cls);
  // a GPU picked from the table: the page moves to it, from the top
  const pick = (g: Gpu) => {
    setConfig({ gpu: g });
    window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
  };

  return (
    <div className={`${s.screen} ${dark ? "tone-dark" : "tone-light"} ${loading ? "is-loading" : ""}`} data-phone={config.phone} aria-busy={loading || undefined}>
      <Notice status={statusLine(st, !!markets)} />
      <NavBar active="index" />
      <main className={s.main}>
        <GpuCards />

        <header className={s.hero}>
          <div className={s.heroMain}>
            <h1 className={s.title}>{market.gpu} index</h1>
            {nodata ? (
              <NoData start />
            ) : (
              <>
                <p className={s.priceRow}>
                  <span className={`${s.price} font-display ag-skel`} aria-hidden={loading || undefined}>
                    {loading ? usd(0) : before ? dateText(market.nextUpdateAt) : usd(market.price)}
                  </span>
                  <span className={sk(s.unit)}>{before ? "the first price" : "per GPU-hour"}</span>
                </p>
                {/* freshness, cadence, finality and the method in one line (Ornn's market page); while loading, a
                    line of the same length under the skeleton, hidden from screen readers */}
                <p className={sk(s.line)} aria-hidden={loading || undefined}>
                  {loading ? (
                    <span>The price for Oct 1 · set once a day from five clouds · final each day about 07:00 UTC</span>
                  ) : (
                    <>
                      <span>
                        {before
                          ? `First price about ${timeText(market.nextUpdateAt)} on ${dateText(market.nextUpdateAt)}`
                          : `The price for ${dateText(market.priceDate)}${carried ? ", carried from the day before, unverified" : ""}`}
                      </span>
                      <span>set once a day from {counted < panel && !before ? `${countWord(counted)} of ${countWord(panel)}` : countWord(panel)} clouds</span>
                      {!before && <span>final each day about {timeText(market.nextUpdateAt) || "07:00 UTC"}</span>}
                      <span>
                        <a href="#method">How it works</a>
                      </span>
                    </>
                  )}
                </p>
              </>
            )}
          </div>
          {/* each change with its period written (Ornn's trio); a period the record does not reach yet says so */}
          {!nodata && !before && (
            <dl className={s.trio} aria-hidden={loading || undefined}>
              {PERIODS.map(([n, label]) => {
                const c = loading ? null : changeOver(market.history, n);
                return (
                  <div key={n}>
                    <dt>{label}</dt>
                    <dd className={sk(c ? dir(c.delta) : s.flat)}>{loading ? "+0.0%" : c ? <Num>{pctText(c.pct)}</Num> : "Not yet"}</dd>
                    <dd className={sk(s.trioSub)}>
                      {loading ? "since Oct 1" : c ? `${Math.abs(c.delta) < 0.005 ? "No change" : signedUsd(c.delta)} since ${dateText(c.base.date)}` : `Record starts ${dateText(recordFrom)}`}
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
        </header>

        {!nodata && (
          <section className={s.section} aria-labelledby="ix-where">
            <h2 id="ix-where">{before || loading ? `Where the ${market.gpu} index comes from` : `Where ${usd(market.price)} comes from`}</h2>
            {loading ? <div className={`${s.skelBlock} ag-skel`} aria-hidden="true" /> : <PriceLine market={market} />}
          </section>
        )}

        <div className={s.body} data-nodata={nodata || undefined}>
          {!nodata && (
            <section className={`${s.section} ${s.chartSec}`} aria-labelledby="ix-history">
              <div className={s.secHead}>
                <h2 id="ix-history">History</h2>
                {!loading && days.length > 1 && (
                  <div className={s.ranges} role="group" aria-label="Range">
                    {(["1W", "1M", "3M", "ALL"] as Range[]).map((r) => (
                      <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}>
                        {r === "ALL" ? "All" : r}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className={`${s.plot} ag-skel`}>
                {before && !hasLogger ? (
                  <div className={s.plotState}>
                    <p>{indexStartsText(market)}</p>
                  </div>
                ) : (
                  <LineChart days={days} range={range} height="100%" />
                )}
              </div>
              {!loading && days.length > 0 && (
                <div className={s.legend}>
                  <span>One price a day, so it moves in steps.</span>
                  {recordFrom && (
                    <span>
                      <i className={s.lgLine} aria-hidden="true" />
                      Onchain, from {dateText(recordFrom)}
                    </span>
                  )}
                  {hasLogger && (
                    <span>
                      <i className={`${s.lgLine} ${s.lgLight}`} aria-hidden="true" />
                      Recorded by our logger, not onchain
                    </span>
                  )}
                  {hasExample && (
                    <span>
                      <i className={`${s.lgLine} ${s.lgLight}`} aria-hidden="true" />
                      Example history
                    </span>
                  )}
                  {hasCarried && (
                    <span>
                      <i className={s.lgDot} aria-hidden="true" />
                      Carried day, unverified
                    </span>
                  )}
                </div>
              )}
            </section>
          )}

          {!nodata && (
            <aside className={`${s.section} ${s.factsSec}`} aria-labelledby="ix-proof">
              <h2 id="ix-proof">Onchain proof</h2>
              {loading ? <div className={`${s.skelBlock} ${s.skelTall} ag-skel`} aria-hidden="true" /> : <Facts market={market} />}
            </aside>
          )}

          {!nodata && (
            <section className={`${s.section} ${s.daysSec}`} aria-labelledby="ix-days">
              <h2 id="ix-days">Last 14 days</h2>
              {loading ? (
                <div className={`${s.skelBlock} ${s.skelTall} ag-skel`} aria-hidden="true" />
              ) : recent.length === 0 ? (
                <p className={s.lead}>
                  No days yet. The first price turns final about {timeText(market.nextUpdateAt)} on {dateText(market.nextUpdateAt)} and shows here.
                </p>
              ) : (
                <>
                  <table className={s.table}>
                    <thead>
                      <tr>
                        <th scope="col">Day</th>
                        <th scope="col" className={s.r}>
                          Index
                        </th>
                        <th scope="col" className={s.r}>
                          Change
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.map((r) => (
                        <tr key={r.date} data-light={r.kind !== "onchain" || undefined}>
                          <td>
                            {dateText(r.date)}
                            {r.status === "carried" && <span className={s.dayNote}>Carried from the day before, unverified</span>}
                          </td>
                          <td className={s.r}>
                            <Num>{usd(r.price)}</Num>
                          </td>
                          <td className={`${s.r} ${dir(r.change)}`}>
                            {r.change === null ? (
                              <span className={s.flat}>First day on record</span>
                            ) : Math.abs(r.change) < 0.005 ? (
                              "No change"
                            ) : (
                              <>
                                <Num>{signedUsd(r.change)}</Num>
                                {r.pct !== null && (
                                  <span className={s.pct}>
                                    <Num>{pctText(r.pct)}</Num>
                                  </span>
                                )}
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {lightNotes(recent, recordFrom).map((n) => (
                    <p key={n} className={s.tableNote}>
                      {n}
                    </p>
                  ))}
                </>
              )}
            </section>
          )}

          {/* beside the 14 days on a wide screen: how to use the price, then how it is made. Narrower, they join the
              page's one column, the method last */}
          <div className={s.side}>
            {!nodata && (
              <section className={s.section} aria-labelledby="ix-use">
                <h2 id="ix-use">Use this price</h2>
                <ul className={s.uses}>
                  <li>
                    <span>
                      <b>Read it onchain</b> from the index contract on Monad testnet, <Num>{shortAddress(INDEX_CONTRACT)}</Num>.
                    </span>
                    <CopyButton text={INDEX_CONTRACT} what="the index contract's address" />
                  </li>
                  {snapshotUrl && (
                    <li>
                      <span>
                        <b>Get it as JSON</b>, every GPU's price and readings in one file.
                      </span>
                      <a className="ag-textbtn" href={snapshotUrl} target="_blank" rel="noreferrer">
                        Open the JSON
                      </a>
                    </li>
                  )}
                  <li>
                    <span>
                      <b>Ask your AI</b>: add Agate to Claude, then ask it for today's {market.gpu} index.
                    </span>
                    <Link className="ag-textbtn" href={`/app/ai${linkQuery}`}>
                      Add Agate to your AI
                    </Link>
                  </li>
                </ul>
              </section>
            )}

            <section id="method" className={`${s.section} ${s.methodSec}`} aria-labelledby="ix-method">
              <h2 id="ix-method">How it works</h2>
              <ol className={s.steps}>
                <li>Every hour, Agate reads each cloud's own public price page for one on-demand {market.gpu} GPU-hour.</li>
                <li>A cloud's price for the day is the average of its hourly reads. The index is the middle of the counted clouds' prices, so no single cloud can set it.</li>
                <li>The day closes at 00:00 UTC. About an hour later the price is written onchain on Monad, and a second, independent reader must countersign any change.</li>
                <li>After six hours for checks it turns final, about 07:00 UTC. A day with no new reading carries the day before's price, marked unverified. Monthly markets pay on final days.</li>
              </ol>
            </section>
          </div>

          {!nodata && (
            <section className={`${s.section} ${s.allSec}`} aria-labelledby="ix-all">
              <h2 id="ix-all">Every GPU</h2>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th scope="col">GPU</th>
                    <th scope="col" className={s.r}>
                      Today's index
                    </th>
                    <th scope="col" className={s.r}>
                      1 day
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ALL_GPUS.map((g) => {
                    const m = markets?.find((x) => x.gpu === g);
                    const c = m ? changeOver(m.history, 1) : null;
                    const here = g === config.gpu;
                    return (
                      <tr key={g} data-here={here || undefined}>
                        <td>
                          {here ? (
                            <b className={s.gpuName}>{g}</b>
                          ) : (
                            <button type="button" className={s.gpuBtn} onClick={() => pick(g)}>
                              {g}
                            </button>
                          )}
                          {m && !m.tradable && <span className={s.gpuNote}>Index only</span>}
                          {here && <span className={s.here}>You are here</span>}
                        </td>
                        <td className={s.r}>
                          {!m ? (
                            <span className={`${s.flat} ag-skel`} aria-hidden="true">
                              {loading ? "$0.00" : ""}
                            </span>
                          ) : m.priceDate === null ? (
                            <span className={s.flat}>First price {dateText(m.nextUpdateAt)}</span>
                          ) : (
                            <Num>{usd(m.price)}</Num>
                          )}
                        </td>
                        <td className={`${s.r} ${c ? dir(c.delta) : s.flat}`}>{!m ? "" : c ? <Num>{pctText(c.pct)}</Num> : "Not yet"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}

          {!nodata && (
            <section className={`${s.section} ${s.besideSec}`} aria-labelledby="ix-beside">
              <h2 id="ix-beside">Beside other prices</h2>
              {loading ? <div className={`${s.skelBlock} ag-skel`} aria-hidden="true" /> : <Beside market={market} />}
            </section>
          )}
        </div>
      </main>
      {config.phone === "new" && <BottomDock active="index" />}
    </div>
  );
}
