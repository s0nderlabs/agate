"use client";
// App chrome: the navbar keeps Ornn's arrangement (logo left, plain links right), a small stone marks the active
// link, and under it the three markets sit still as tabs, each the way to switch GPU.
import Link from "next/link";
import { useMemo, useState } from "react";
import { Lockup, Stone } from "@/components/brand/Logo";
import { Num } from "@/components/num/Num";
import { useFlow } from "@/components/markets/Flow";
import { getMarket, GPUS } from "@/lib/mock/data";
import { DRIP, useLinkQuery, useMock } from "@/lib/mock/store";
import type { Gpu } from "@/lib/mock/types";
import { int, usd } from "@/lib/format";
import s from "./shell.module.css";

export function Notice() {
  const { wallet, drip } = useMock();
  const { openSignIn } = useFlow();
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <div className={s.notice}>
      <span>Agate runs on Monad's test network. Trades use test dollars, {int(DRIP)} free a day.</span>
      <button className={s.noticeBtn} onClick={wallet.signedIn ? drip : openSignIn}>
        {wallet.signedIn ? "Get test dollars" : "Sign in to start"}
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
  const items = useMemo(
    () =>
      GPUS.map((g) => {
        const m = getMarket(g, config.data);
        return { g, index: m.price, month: m.series[0].quote!.last };
      }),
    [config.data],
  );
  return (
    <div className={s.strip} role="tablist" aria-label="Markets">
      {items.map((it) => (
        <button key={it.g} role="tab" aria-selected={config.gpu === it.g} className={s.market} onClick={() => setConfig({ gpu: it.g as Gpu })}>
          <b>{it.g}</b>
          <span className={s.mPrice}>
            <Num>{usd(it.index)}</Num>
          </span>
          <span className={s.mSub}>
            Nov <Num>{usd(it.month)}</Num>
          </span>
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

export function NavBar({ active = "markets" }: { active?: "markets" | "positions" | "index" | "docs" }) {
  const { wallet, config, setConfig } = useMock();
  const linkQuery = useLinkQuery();
  const { openAccount, openSignIn } = useFlow();
  const links: [typeof active, string][] = [
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
          <Link key={k} href={`${k === "index" ? "/index" : "/"}${linkQuery}`} className={s.link} aria-current={k === active ? "page" : undefined}>
            {k === active && <Stone size={11} className={s.mark} />}
            {label}
          </Link>
        ))}
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
        {wallet.signedIn ? (
          <button className={s.acct} onClick={openAccount}>
            <span className={s.acctBal}>
              <Num>{int(wallet.balance)}</Num> test dollars
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
