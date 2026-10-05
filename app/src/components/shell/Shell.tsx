"use client";
// App chrome: the navbar keeps Ornn's arrangement (logo left, plain links right), a small stone marks the active
// link, and under it the three markets sit still as tabs, each the way to switch GPU.
import Link from "next/link";
import { useMemo, useState } from "react";
import { Lockup, Stone } from "@/components/brand/Logo";
import { Num } from "@/components/num/Num";
import { useFlow } from "@/components/markets/Flow";
import { useDrip } from "@/components/flow/DripButton";
import { GPUS } from "@/lib/mock/data";
import { useMarkets } from "@/lib/data/hooks";
import { dateText, monthLong } from "@/lib/data/derive";
import { DRIP, useAccount } from "@/lib/account";
import { useLinkQuery, useMock } from "@/lib/mock/store";
import type { Gpu } from "@/lib/mock/types";
import { int, usd } from "@/lib/format";
import s from "./shell.module.css";

/** status: a line from the live data (a stale price, a pause) shown instead of the testnet copy, on every width
 * and signed in too, with no dismiss. */
export function Notice({ status }: { status?: string | null } = {}) {
  const { config } = useMock();
  const account = useAccount();
  const signedIn = account.ready;
  const { openSignIn } = useFlow();
  const drip = useDrip();
  const [open, setOpen] = useState(true);
  if (status)
    return (
      <div className={s.notice} role="status" data-status>
        <span>{status}</span>
      </div>
    );
  if (!open) return null;
  return (
    <div className={s.notice} data-signed={signedIn || undefined}>
      {/* phones, new layout: one short line that opens sign-in (signed in, the balance is in the top bar instead) */}
      {config.phone === "new" && !signedIn && (
        <button className={s.noticeShort} onClick={openSignIn} aria-label={`Sign in to get ${int(DRIP)} free test dollars a day`}>
          <span>Get {int(DRIP)} free test dollars a day</span>
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d="M4.5 2.5l3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
          </svg>
        </button>
      )}
      <span className={s.noticeLong} aria-live="polite">
        {signedIn && drip.error ? drip.error : `Agate runs on Monad's test network. Trades use test dollars, ${int(DRIP)} free a day.`}
      </span>
      <button className={s.noticeBtn} disabled={signedIn && drip.busy} onClick={signedIn ? () => void drip.run() : openSignIn}>
        {signedIn ? (drip.busy ? "Getting test dollars" : "Get test dollars") : "Sign in to start"}
      </button>
      <button className={s.noticeX} aria-label="Dismiss" onClick={() => setOpen(false)}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
        </svg>
      </button>
    </div>
  );
}

/** The three markets, still (no marquee). Each one is the way to switch GPU. */
export function MarketStrip() {
  const { config, setConfig } = useMock();
  const { markets, loading } = useMarkets();
  const items = useMemo(
    () =>
      // the three GPUs with a market, from the one shared read; before the index's first price its date, a month not
      // open yet when it opens (never a made-up $0.00)
      GPUS.map((g) => {
        const m = markets?.find((x) => x.gpu === g);
        const mo = m?.series.find((x) => x.quote) ?? m?.series[0];
        const short = mo ? monthLong(mo.month).slice(0, 3) : "Nov";
        const waiting = !!mo && (mo.phase === "upcoming" || !mo.quote);
        return {
          g,
          read: !!m,
          // a price, or (before the first one) the day it lands
          index: m && m.priceDate !== null ? m.price : null,
          first: m && m.priceDate === null ? dateText(m.nextUpdateAt) : "",
          short,
          month: mo && !waiting && mo.quote?.last ? mo.quote.last : null,
          // the month in words when it has no price: not open yet, or nothing quoted yet
          note: !mo ? "" : waiting ? `${short} opens ${dateText(mo.opensOn) || "soon"}` : mo.quote?.last ? "" : `${short}, no price yet`,
        };
      }),
    [markets],
  );
  return (
    <div className={s.strip} role="tablist" aria-label="Markets">
      {items.map((it) => (
        <button key={it.g} role="tab" aria-selected={config.gpu === it.g} className={s.market} onClick={() => setConfig({ gpu: it.g as Gpu })}>
          <b>{it.g}</b>
          {/* nothing read yet: skeletons while the read is on its way (they shimmer under the screen's is-loading),
              blank lines when it failed (the Notice bar says why) */}
          {!it.read ? (
            <>
              <span className={`${s.mPrice} ag-skel`} aria-hidden="true">
                {loading ? "$0.00" : " "}
              </span>
              <span className={`${s.mSub} ag-skel`} aria-hidden="true">
                {loading ? "Nov $0.00" : " "}
              </span>
            </>
          ) : (
            <>
              <span className={s.mPrice}>{it.index !== null ? <Num>{usd(it.index)}</Num> : it.first}</span>
              <span className={s.mSub}>
                {it.month !== null ? (
                  <>
                    {it.short} <Num>{usd(it.month)}</Num>
                  </>
                ) : (
                  it.note
                )}
              </span>
            </>
          )}
        </button>
      ))}
      <span className={s.stripNote}>Per GPU-hour. A new index price each day, final about 07:00 UTC.</span>
    </div>
  );
}

function ThemeToggle() {
  const { config, setConfig } = useMock();
  const dark = config.theme === "dark";
  return (
    <button className={s.icon} aria-label={dark ? "Switch to light" : "Switch to dark"} onClick={() => setConfig({ theme: dark ? "light" : "dark" })}>
      {dark ? (
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
          <circle cx="10" cy="10" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10 2v2.2M10 15.8V18M2 10h2.2M15.8 10H18M4.3 4.3l1.6 1.6M14.1 14.1l1.6 1.6M4.3 15.7l1.6-1.6M14.1 5.9l1.6-1.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
          <path d="M16.5 12.2A6.8 6.8 0 0 1 7.8 3.5a6.8 6.8 0 1 0 8.7 8.7z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="miter" />
        </svg>
      )}
    </button>
  );
}

/** active: the place on screen; null on pages outside the four (Connected AIs, the Allow page, an approval) */
export function NavBar({ active = "markets" }: { active?: "markets" | "positions" | "index" | "docs" | null }) {
  const { config, setConfig } = useMock();
  const account = useAccount();
  const linkQuery = useLinkQuery();
  const { openAccount, openSignIn, openMore } = useFlow();
  const links: [NonNullable<typeof active>, string][] = [
    ["markets", "Markets"],
    ["positions", "Positions"],
    ["index", "Index"],
    ["docs", "Docs"],
  ];
  return (
    <header className={s.nav}>
      <Link href={`/${linkQuery}`} className={s.brand} aria-label="Agate home">
        <Lockup height={28} size="l" wcase="title" />
      </Link>
      <nav className={s.links} aria-label="Main">
        <button className={s.icon} aria-label="Search markets">
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M12.5 12.5L17 17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
          </svg>
        </button>
        {links.map(([k, label]) => (
          <Link key={k} href={`${k === "index" ? "/index" : k === "positions" ? "/positions" : "/"}${linkQuery}`} className={s.link} data-place={k} aria-current={k === active ? "page" : undefined}>
            {k === active && <Stone size={11} className={s.mark} />}
            {label}
          </Link>
        ))}
        {/* tablets below 1024 px, new layout: Simple | Pro and the theme leave the compact bar for More */}
        {config.phone === "new" && (
          <button type="button" className={s.more} aria-haspopup="dialog" onClick={openMore}>
            More
          </button>
        )}
      </nav>
      <div className={s.right}>
        <div className={s.mode} role="group" aria-label="Mode">
          <button aria-pressed={config.mode === "simple"} onClick={() => setConfig({ mode: "simple" })}>
            Simple
          </button>
          <button aria-pressed={config.mode === "pro"} onClick={() => setConfig({ mode: "pro" })}>
            Pro
          </button>
        </div>
        <ThemeToggle />
        {account.status === "restoring" ? (
          // a session is being restored: the account button's shape, never a "Sign in" flash
          <span className={s.acct} aria-busy="true" aria-label="Loading your account">
            <span className={`${s.acctBal} ag-skel ag-skel-on`} aria-hidden="true">
              10,000 test dollars
            </span>
            <span className={`${s.avatar} ag-skel ag-skel-on`} aria-hidden="true" />
          </span>
        ) : account.ready ? (
          // phones (new layout): the More sheet carries the account; from 640 px the Account sheet
          <button className={s.acct} onClick={() => (config.phone === "new" && window.matchMedia("(max-width: 639.98px)").matches ? openMore() : openAccount())}>
            <span className={s.acctBal}>
              <Num>{int(account.balance)}</Num> test dollars
            </span>
            <span className={s.avatar}>
              <Stone size={16} />
            </span>
          </button>
        ) : (
          <button className={s.signin} onClick={openSignIn}>
            Sign in
          </button>
        )}
      </div>
    </header>
  );
}
