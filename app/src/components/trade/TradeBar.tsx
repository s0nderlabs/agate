"use client";
// The phone's way into a trade (Robinhood, Polymarket, Hyperliquid on phones): Long and Short with the price each
// fills at, always at the bottom above the tabs. A tap opens the ticket as a sheet with that side picked. The same
// two prices as the ticket's Long / Short toggle (the month's ask and bid). Live states each get one plain button.
import { Num } from "@/components/num/Num";
import type { Gpu, Quote, Series, Side } from "@/lib/mock/types";
import { usd } from "@/lib/format";
import { whenText } from "@/lib/data/derive";
import s from "./trade.module.css";

export function TradeBar({
  gpu,
  month,
  quote,
  phase,
  opensOn,
  tradable = true,
  loading = false,
  stale = "none",
  open,
  side,
  onOpen,
  onSwitchGpu,
}: {
  gpu: Gpu;
  /** the month's name, "November" */
  month: string;
  quote: Quote | null;
  phase: Series["phase"];
  opensOn?: string;
  /** false for a price-only GPU (no market to trade) */
  tradable?: boolean;
  loading?: boolean;
  stale?: "none" | "stale" | "nodata";
  /** the ticket sheet is open, and on which side */
  open: boolean;
  side: Side;
  onOpen: (side?: Side) => void;
  onSwitchGpu?: (gpu: Gpu) => void;
}) {
  const common = { "aria-haspopup": "dialog" as const, "aria-controls": "ticket" };
  const one = (label: string, opts: { disabled?: boolean; onClick?: () => void } = {}) => (
    <button type="button" className={s.tbOne} disabled={opts.disabled} onClick={opts.onClick} {...(opts.onClick ? common : {})} aria-expanded={opts.onClick ? open : undefined}>
      {label}
    </button>
  );

  // Long and Short with their prices (skeletons while the first read is on its way)
  const pair = (ask: number | null, bid: number | null) => {
    const btn = (sd: Side) => {
      const L = sd === "long";
      const price = L ? ask : bid;
      return (
        <button type="button" data-side={sd} disabled={loading} onClick={() => onOpen(sd)} {...common} aria-expanded={open && side === sd}>
          <b>{L ? "Long" : "Short"}</b>{" "}
          {loading ? <span className="ag-skel">$0.00</span> : price === null ? <span>{L ? "No sellers" : "No buyers"}</span> : <Num>{usd(price)}</Num>}
        </button>
      );
    };
    return (
      <>
        {btn("long")}
        {btn("short")}
      </>
    );
  };

  let body: React.ReactNode;
  if (loading) {
    // nothing read yet: the usual pair, waiting (a stand-in market can say nothing true about opening or the book)
    body = pair(null, null);
  } else if (!tradable) {
    body = (
      <>
        <span className={s.tbNote}>{gpu} is price only</span>
        <button type="button" className={s.tbOne} onClick={() => onSwitchGpu?.("H100")}>
          Trade H100
        </button>
      </>
    );
  } else if (stale === "stale") {
    body = one("Waiting for fresh prices", { disabled: true });
  } else if (stale === "nodata") {
    body = one("Waiting for prices", { disabled: true });
  } else if (phase === "upcoming") {
    body = one(`${month} opens ${whenText(opensOn) || "soon"}`, { onClick: () => onOpen() });
  } else {
    const ask = quote && quote.ask > 0 ? quote.ask : null;
    const bid = quote && quote.bid > 0 ? quote.bid : null;
    body = ask === null && bid === null ? one("No prices in the book yet", { onClick: () => onOpen() }) : pair(ask, bid);
  }

  return (
    <div className={s.tradeBar} data-trade-bar role="group" aria-label={`Trade ${month} ${gpu}`}>
      {body}
    </div>
  );
}
