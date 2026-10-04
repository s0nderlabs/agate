"use client";
import Link from "next/link";
import { Lockup, Stone } from "@/components/brand/Logo";
import { COMPARISON, GPUS, median } from "@/lib/mock/data";
import { useMock } from "@/lib/mock/store";
import type { Gpu, Market } from "@/lib/mock/types";
import { int, usd, usd0 } from "@/lib/format";
import { useFlow } from "./Flow";
import { monthName } from "./PriceChart";
import type { Trade } from "./useTrade";

export function AppNav({ active = "markets" }: { active?: "markets" | "positions" | "index" }) {
  const { wallet } = useMock();
  const { openAccount, openSignIn } = useFlow();
  const links: [typeof active, string, string][] = [
    ["markets", "Markets", "/"],
    ["positions", "Your positions", "/"],
    ["index", "The index", "/"],
  ];
  return (
    <header className="ag-nav">
      <Link href="/" aria-label="agate home" style={{ color: "var(--ink)" }}>
        <Lockup height={28} />
      </Link>
      <nav className="ag-nav__links" aria-label="Main">
        {links.map(([k, label, href]) => (
          <Link key={k} href={href} aria-current={k === active ? "page" : undefined}>
            {label}
          </Link>
        ))}
      </nav>
      <div className="ag-nav__right">
        {wallet.signedIn ? (
          <button className="ag-acct" onClick={openAccount}>
            <span className="ag-acct__av">
              <Stone size={16} />
            </span>
            <span className="ag-acct__label">{int(wallet.balance)} test dollars</span>
          </button>
        ) : (
          <button className="ag-btn ag-btn--primary" onClick={openSignIn}>
            Sign in
          </button>
        )}
      </div>
    </header>
  );
}

export function GpuSwitch({ className }: { className?: string }) {
  const { config, setConfig } = useMock();
  return (
    <div className={`ag-seg ${className ?? ""}`} role="group" aria-label="GPU">
      {GPUS.map((g) => (
        <button key={g} aria-pressed={config.gpu === g} onClick={() => setConfig({ gpu: g as Gpu })}>
          {g}
        </button>
      ))}
    </div>
  );
}

/** The trade box. layout "stack" = one column; "split" = two halves side by side on wide screens. */
export function TradeTicket({ market, trade, layout = "stack" }: { market: Market; trade: Trade; layout?: "stack" | "split" }) {
  const { submit } = useFlow();
  const { n } = trade;
  const L = n.side === "long";
  const m = monthName(n.series.month);
  const half = layout === "split" ? "grid gap-4 md:grid-cols-2 md:gap-6" : "grid gap-4";
  return (
    <div className="ag-ticket">
      <div className={half}>
        <div className="grid gap-4 content-start">
          <div className="ag-seg ag-ticket__row ag-ticket__months" role="group" aria-label="Month">
            {trade.months.map((s) => (
              <button key={s.month} aria-pressed={trade.month === s.month} disabled={s.phase === "upcoming"} onClick={() => trade.setMonth(s.month)}>
                {s.phase === "upcoming" ? `${monthName(s.month).slice(0, 3)}, opens ${s.opensOn === "2026-11-01" ? "Nov 1" : s.opensOn}` : monthName(s.month)}
              </button>
            ))}
          </div>
          <div className="ag-seg ag-ticket__row ag-side" role="group" aria-label="Side">
            <button aria-pressed={L} onClick={() => trade.setSide("long")}>
              Long
            </button>
            <button aria-pressed={!L} onClick={() => trade.setSide("short")}>
              Short
            </button>
          </div>
          <p className="ag-ticket__copy">
            {L
              ? `Long pays you ${m}'s average ${market.gpu} price. It protects a GPU bill from rising prices.`
              : `Short pays you when ${m}'s average comes in below ${usd(n.price)}. It protects GPU income from falling prices.`}
          </p>
        </div>
        <div className="grid gap-4 content-start">
          <div className="grid grid-cols-2 gap-2.5">
            <div className="ag-field">
              <span>GPUs</span>
              <div className="ag-stepper">
                <button aria-label="Fewer GPUs" onClick={() => trade.setGpus(trade.gpus - 1)}>
                  −
                </button>
                <b>{trade.gpus}</b>
                <button aria-label="More GPUs" onClick={() => trade.setGpus(trade.gpus + 1)}>
                  +
                </button>
              </div>
            </div>
            <div className="ag-field">
              <span>Days in {m}</span>
              <div className="ag-stepper">
                <b style={{ textAlign: "left" }}>{n.series.n}</b>
              </div>
            </div>
          </div>
          <p style={{ fontSize: 15, color: "var(--mute)" }}>
            That is <b style={{ color: "var(--ink)", fontWeight: 500 }}>{int(n.hours)}</b> GPU-hours.
          </p>
          <label className="ag-toggle">
            <input type="checkbox" checked={trade.daily} onChange={(e) => trade.setDaily(e.target.checked)} />
            <span className="ag-switch" aria-hidden="true" />
            <span className="grid gap-0.5">
              <b style={{ fontWeight: 500 }}>Pay me daily</b>
              <span style={{ fontSize: 15, color: "var(--ink-2)" }}>{L ? "Get the floor back now, then a share every morning. Locks the market rate." : "Get your share every morning instead of once at the end. Locks the market rate."}</span>
            </span>
          </label>
          <dl className="ag-sum">
            <div>
              <dt>{L ? "You pay" : "You put up"}</dt>
              <dd>{usd0(n.outlay)}</dd>
            </div>
            <div>
              <dt>{n.daily && L ? "Back right away" : "Paid out"}</dt>
              <dd>{n.daily ? (L ? usd0(n.backNow) : "Every morning") : `After ${m}`}</dd>
            </div>
            <div>
              <dt>Most you can lose</dt>
              <dd>{usd0(n.maxLoss)}</dd>
            </div>
            <div>
              <dt>Most you can make</dt>
              <dd>{usd0(n.maxGain)}</dd>
            </div>
          </dl>
          <button className="ag-btn ag-btn--primary ag-btn--lg w-full" onClick={() => submit(n)}>
            {L ? "Long" : "Short"} at {usd(n.price)}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Where today's price comes from: each cloud on one scale, the middle one marked. */
export function SourceStrip({ market }: { market: Market }) {
  const live = market.sources.filter((s) => s.live);
  const all = market.sources;
  const lo = Math.floor(Math.min(...all.map((s) => s.price)) * 2) / 2 - 0.5;
  const hi = Math.ceil(Math.max(...all.map((s) => s.price)) * 2) / 2 + 0.5;
  const pos = (p: number) => `${((p - lo) / (hi - lo)) * 100}%`;
  const mid = median(live.map((s) => s.price));
  return (
    <div className="grid gap-3">
      <div className="relative" style={{ height: 74, margin: "18px 8px 0" }}>
        <span className="absolute left-0 right-0" style={{ top: 36, height: 2, background: "var(--line-2)", borderRadius: 2 }} />
        {all.map((s) => (
          <span
            key={s.family}
            title={`${s.family} ${usd(s.price)}`}
            className="absolute"
            style={{ left: pos(s.price), top: 37, width: 14, height: 14, borderRadius: 99, transform: "translate(-50%,-50%)", background: s.live ? "var(--card)" : "var(--bg)", boxShadow: `inset 0 0 0 2px ${s.live ? "var(--ink)" : "var(--line-2)"}` }}
          />
        ))}
        <span className="absolute" style={{ left: pos(mid), top: 8, height: 44, width: 2, background: "var(--ink)", transform: "translateX(-50%)" }}>
          <b className="absolute" style={{ bottom: "100%", left: "50%", transform: "translate(-50%,-4px)", fontSize: 14, fontWeight: 500, whiteSpace: "nowrap" }}>
            Middle {usd(mid)}
          </b>
        </span>
        <span className="absolute left-0" style={{ top: 50, fontSize: 14, color: "var(--mute)" }}>
          {usd(lo)}
        </span>
        <span className="absolute right-0" style={{ top: 50, fontSize: 14, color: "var(--mute)" }}>
          {usd(hi)}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {all.map((s) => (
          <span key={s.family} className="inline-flex items-baseline gap-2 rounded-full px-3 py-1.5" style={{ background: "var(--well)", fontSize: 15, opacity: s.live ? 1 : 0.6 }}>
            <span style={{ color: "var(--ink-2)" }}>{s.family}</span>
            <b style={{ fontWeight: 500 }}>{s.live ? usd(s.price) : "not counted today"}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

export function reportingLine(market: Market) {
  const live = market.sources.filter((s) => s.live).length;
  const panel = Math.max(5, live);
  return `${live} of ${panel} clouds reporting`;
}

export function Compare({ market, big = 44 }: { market: Market; big?: number }) {
  if (market.gpu !== "H100") return <p style={{ color: "var(--mute)" }}>Ornn and Akash publish an H100 price only, so the comparison shows for H100.</p>;
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {COMPARISON.map((c) => (
        <div key={c.name} className="grid gap-1.5 rounded-[22px] p-5" style={{ background: c.kind === "ours" ? "var(--card)" : "var(--well)", boxShadow: c.kind === "ours" ? "var(--depth), inset 0 0 0 1px var(--line-2)" : undefined }}>
          <div className="flex items-center gap-2">
            {c.kind === "ours" && <Stone size={20} />}
            <b style={{ fontWeight: 500 }}>{c.name}</b>
          </div>
          <div className="font-display" style={{ fontSize: big, lineHeight: 1.1, fontWeight: 300 }}>
            {usd(c.kind === "ours" ? market.price : c.price)}
          </div>
          <p style={{ color: "var(--ink-2)", fontSize: 15 }}>{c.note}</p>
        </div>
      ))}
    </div>
  );
}

export function priceChange(market: Market) {
  const d = market.price - market.prevPrice;
  if (Math.abs(d) < 0.005) return { text: "Same as yesterday", cls: "" };
  return { text: `${d > 0 ? "Up" : "Down"} ${usd(Math.abs(d))} from yesterday`, cls: d > 0 ? "text-up" : "text-down" };
}

export function carriedNote(market: Market) {
  const last = market.history[market.history.length - 1];
  return last.status === "carried" ? "Carried from yesterday, unverified" : null;
}
