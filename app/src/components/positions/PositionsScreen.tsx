"use client";
// Positions, first cut (Oct 4): what you hold and your test dollars, one column on every width. The phone tab bar's
// second place, and where "See your positions" leads after a trade. Open orders stay in Pro's Orders tab until the
// live wiring brings Kuru's open orders here too.
import Link from "next/link";
import { useEffect } from "react";
import { useFlow } from "@/components/markets/Flow";
import { NavBar, Notice } from "@/components/shell/Shell";
import { BottomDock } from "@/components/shell/Dock";
import { PositionCards } from "@/components/trade/ProParts";
import { DripButton } from "@/components/flow/DripButton";
import { YourAis } from "@/components/ai/YourAis";
import { groundFor } from "@/lib/mock/config";
import { useDataStatus, useLastFor, useMarkets } from "@/lib/data/hooks";
import { statusLine } from "@/lib/data/derive";
import { DRIP, useAccount } from "@/lib/account";
import { useLinkQuery, useMock } from "@/lib/mock/store";
import { useThemeColor } from "@/lib/ui/hooks";
import { int, usd0 } from "@/lib/format";
import s from "./positions.module.css";

export function PositionsScreen() {
  const { config } = useMock();
  const account = useAccount();
  const { openSignIn } = useFlow();
  const linkQuery = useLinkQuery();
  const dark = config.theme === "dark";
  useEffect(() => {
    document.documentElement.style.background = groundFor(config);
  }, [config.theme]);
  useThemeColor(config.theme);
  // each position valued at its own market's last price, from the shared markets read
  const lastFor = useLastFor();
  // how the reads are doing, for the Notice bar's status line
  const st = useDataStatus();
  const { markets } = useMarkets();
  return (
    <div className={`${s.screen} ${dark ? "tone-dark" : "tone-light"}`} data-phone={config.phone}>
      <Notice status={statusLine(st, !!markets)} />
      <NavBar active="positions" />
      <main className={s.main}>
        {account.ready ? (
          <header className={s.head}>
            <span className={s.label}>Test dollars</span>
            <span className={`${s.balance} font-display`}>{usd0(account.balance)}</span>
            <div className={s.actions}>
              <DripButton lg={false} />
              <Link className="ag-btn ag-btn--ghost" href={`/${linkQuery}`} style={{ alignSelf: "start" }}>
                Trade
              </Link>
            </div>
          </header>
        ) : (
          <header className={s.head}>
            <h1 className={`${s.title} font-display`}>Your positions</h1>
            <p className={s.lead}>Agate runs on Monad's test network. Trades use test dollars, {int(DRIP)} free a day. Sign in to see what you hold.</p>
            <div className={s.actions}>
              <button className="ag-btn ag-btn--primary" onClick={openSignIn}>
                Sign in
              </button>
            </div>
          </header>
        )}
        {account.ready && (
          <section className={s.section} aria-labelledby="positions-h">
            <h2 id="positions-h">Positions</h2>
            {account.positions.length ? (
              <PositionCards positions={account.positions} lastFor={lastFor} />
            ) : (
              <div className={s.empty}>
                <p>No positions yet. When you go Long or Short, it shows up here with what it's worth and what's been paid.</p>
                <Link href={`/${linkQuery}`}>Go to Markets</Link>
              </div>
            )}
          </section>
        )}
        {account.ready && <YourAis className={s.section} />}
      </main>
      {config.phone === "new" && <BottomDock active="positions" />}
    </div>
  );
}
