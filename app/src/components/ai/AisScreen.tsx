"use client";
// Connected AIs (/ai, wallet spec 10.1, screen 9): every AI the person let trade, each with its pocket's dollars, what
// it spent, its trades in the last 24 hours and its end date; the ended ones below with what is left in their
// pockets. Empty: how to connect one. Rows on desktop, cards on narrower screens, the dock on phones.
import Link from "next/link";
import { useEffect } from "react";
import { useFlow } from "@/components/markets/Flow";
import { NavBar, Notice } from "@/components/shell/Shell";
import { BottomDock } from "@/components/shell/Dock";
import { Num } from "@/components/num/Num";
import { useAccount } from "@/lib/account";
import { useActivity, useGrants, usePocket } from "@/lib/account/ai";
import { grantState, limitsOf, spentOf, statusText, tradesIn24h } from "@/lib/account/aiView";
import type { ActivityEvent, Grant } from "@/lib/account/api";
import { whenText } from "@/lib/data/derive";
import { usd0 } from "@/lib/format";
import { groundFor } from "@/lib/mock/config";
import { useLinkQuery, useMock } from "@/lib/mock/store";
import { useThemeColor } from "@/lib/ui/hooks";
import { useNow } from "@/lib/ui/useNow";
import { HowTo } from "./HowTo";
import s from "./ai.module.css";

/** The page ground and the browser chrome follow the in-app theme. */
export function useScreenTheme() {
  const { config } = useMock();
  useEffect(() => {
    document.documentElement.style.background = groundFor(config);
  }, [config]);
  useThemeColor(config.theme);
  return config.theme === "dark" ? "tone-dark" : "tone-light";
}

export const OFFLINE_LINE = "Can't reach Agate's server right now. Your AIs' limits still hold on Monad.";

export function AisScreen() {
  const { config } = useMock();
  const tone = useScreenTheme();
  const account = useAccount();
  const flow = useFlow();
  const grants = useGrants({ poll: true });
  const activity = useActivity(undefined, { poll: true });
  const now = useNow(60_000);
  const list = grants.data ?? [];
  const live = list.filter((g) => grantState(g, now) === "active");
  const ended = list.filter((g) => grantState(g, now) !== "active");
  const offline = grants.isError;

  return (
    <div className={`${s.screen} ${tone}`} data-phone={config.phone}>
      <Notice />
      <NavBar active={null} />
      <main className={s.main}>
        {!account.ready ? (
          <>
            <header className={s.headText}>
              <h1 className={s.h1}>Connected AIs</h1>
              <p className={s.lead}>Sign in to see the AIs you've connected.</p>
              <div className={s.actions}>
                <button className="ag-btn ag-btn--primary" type="button" onClick={flow.openSignIn}>
                  Sign in
                </button>
              </div>
            </header>
            <section className={s.section}>
              <HowTo />
            </section>
          </>
        ) : (
          <>
            <header className={s.head}>
              <div className={s.headText}>
                <h1 className={s.h1}>Connected AIs</h1>
                <p className={s.lead}>Each AI trades only from its own pocket, inside the limits you set. Disconnect stops it at once.</p>
              </div>
              {list.length > 0 && (
                <button className="ag-btn ag-btn--ghost" type="button" onClick={flow.openHowTo}>
                  Add another AI
                </button>
              )}
            </header>
            {offline && (
              <div className={s.banner} role="status">
                <span>{OFFLINE_LINE}</span>
                <button className="ag-btn ag-btn--ghost" type="button" onClick={() => void grants.refetch()}>
                  Try now
                </button>
              </div>
            )}
            {grants.isPending ? (
              <ul className={s.list} aria-busy="true" aria-label="Loading your AIs">
                {[0, 1].map((i) => (
                  <li key={i} className={s.skelRow}>
                    <span className="ag-skel ag-skel-on" />
                  </li>
                ))}
              </ul>
            ) : list.length === 0 && !offline ? (
              <section className={s.section}>
                <HowTo />
              </section>
            ) : (
              <>
                {live.length > 0 && (
                  <section className={s.section} aria-label="Connected">
                    <div className={s.cols} aria-hidden="true">
                      <span>AI</span>
                      <span>Left in its pocket</span>
                      <span>Spent</span>
                      <span>Trades in the last 24 hours</span>
                      <span>Ends</span>
                      <span />
                    </div>
                    <ul className={s.list}>
                      {live.map((g) => (
                        <AiRow key={g.id} g={g} events={activity.data} now={now} />
                      ))}
                    </ul>
                  </section>
                )}
                {ended.length > 0 && (
                  <section className={s.section}>
                    <h2 className={s.h2}>Ended</h2>
                    <ul className={s.list}>
                      {ended.map((g) => (
                        <EndedRow key={g.id} g={g} events={activity.data} now={now} />
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}
          </>
        )}
      </main>
      {config.phone === "new" && <BottomDock active={null} />}
    </div>
  );
}

function AiRow({ g, events, now }: { g: Grant; events: ActivityEvent[] | undefined; now: number }) {
  const q = useLinkQuery();
  const flow = useFlow();
  const pocket = usePocket(g.pocket);
  const lim = limitsOf(g);
  const left = pocket.data?.balance;
  const spent = spentOf(g.id, events);
  const trades = tradesIn24h(g.id, events, now);
  const ends = whenText(g.expiresAt);
  const leftText = pocket.isError ? "Can't read" : left === undefined ? "" : usd0(left);
  // what it was given, while that is what the pocket is measured against: once more is in it than the first move in
  // (dollars added, a refund, a sale back into the pocket) only what is left is said, never a guessed total
  const given = left !== undefined && left > lim.budget + 0.005 ? null : lim.budget;
  return (
    <li className={s.row}>
      <div className={s.who}>
        <Link className={s.name} href={`/app/ai/${encodeURIComponent(g.id)}${q}`}>
          {g.label}
        </Link>
        <span className={s.status}>{statusText(g, events, now)}</span>
      </div>
      <div className={s.fig}>
        <span className={s.k}>Left in its pocket: </span>
        {pocket.isPending ? (
          <span className="ag-skel ag-skel-on">$000</span>
        ) : pocket.isError ? (
          <span className={s.status}>Can't read</span>
        ) : (
          <>
            <Num>{leftText}</Num>
            {given !== null && <small> of {usd0(given)}</small>}
          </>
        )}
      </div>
      <div className={s.fig}>
        <span className={s.k}>Spent: </span>
        {spent === null ? <span className={s.status}>Not yet shown</span> : <Num>{usd0(spent)}</Num>}
      </div>
      <div className={s.fig}>
        <span className={s.k}>Trades in the last 24 hours: </span>
        <Num>{`${trades} of ${lim.tradesPerDay}`}</Num>
      </div>
      <div className={s.fig} data-k="ends">
        <span className={s.k}>Ends: </span>
        {ends}
      </div>
      <div className={s.cardLines}>
        <span>
          {pocket.isError ? "Can't read its pocket right now." : left === undefined ? " " : `${usd0(left)} left${given !== null ? ` of ${usd0(given)}` : ""}.`}
          {spent !== null ? ` Spent ${usd0(spent)}.` : ""}
        </span>
        <span>
          {trades} of {lim.tradesPerDay} trades in the last 24 hours. Ends {ends}.
        </span>
      </div>
      <div className={s.rowActs}>
        <Link className="ag-btn ag-btn--ghost" href={`/app/ai/${encodeURIComponent(g.id)}${q}`} aria-label={`Open ${g.label}`}>
          Open
        </Link>
        <button type="button" className={`ag-textbtn ${s.textDown}`} onClick={() => flow.openDisconnect(g.id)} aria-label={`Disconnect ${g.label}`}>
          Disconnect
        </button>
      </div>
    </li>
  );
}

function EndedRow({ g, events, now }: { g: Grant; events: ActivityEvent[] | undefined; now: number }) {
  const q = useLinkQuery();
  const flow = useFlow();
  const pocket = usePocket(g.pocket);
  const left = pocket.data?.balance ?? 0;
  const leftLine = pocket.isPending ? "" : pocket.isError ? "Can't read its pocket right now." : left > 0 ? `${usd0(left)} still in its pocket` : "Its pocket is empty";
  return (
    <li className={`${s.row} ${s.ended}`}>
      <div className={s.who}>
        <Link className={s.name} href={`/app/ai/${encodeURIComponent(g.id)}${q}`}>
          {g.label}
        </Link>
        <span className={s.status}>{statusText(g, events, now)}</span>
      </div>
      <div className={s.fig} style={{ gridColumn: "2 / 5" }}>
        {pocket.isPending ? <span className="ag-skel ag-skel-on">$000 still in its pocket</span> : leftLine}
      </div>
      <div className={s.fig} />
      <div className={s.cardLines}>
        <span>{leftLine ? `${leftLine}.` : " "}</span>
        <span />
      </div>
      <div className={s.rowActs}>
        {left > 0 && (
          <button data-keep className="ag-btn ag-btn--ghost" type="button" onClick={() => flow.openPocket({ pocket: g.pocket, ai: g.label, ended: true }, "takeBack")}>
            Take back {usd0(left)}
          </button>
        )}
        <Link className="ag-btn ag-btn--ghost" href={`/app/ai/${encodeURIComponent(g.id)}${q}`} aria-label={`Open ${g.label}`}>
          Open
        </Link>
      </div>
    </li>
  );
}
