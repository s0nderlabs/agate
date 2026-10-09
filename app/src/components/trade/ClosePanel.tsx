"use client";
// Close what you hold from the trade panel (Mock controls, closeUi "tabs"): Open | Close at the head of the ticket, the
// way every exchange-style ticket carries Buy | Sell (Limitless, Myriad, Kuru, Computable; the Oct 6 study). Close
// always says which holding it closes (a Long and a Short never net), sizes it in GPU-hours from All, and sums up what
// comes back at the book's prices now. Held tokens can sell any part; a pay me daily Long or a Short closes whole (the
// router closes a position by its id). The button opens the review sheet (CloseSheet), so the plan and the send are
// the real ones. The Positions page's Close opens this same form as a sheet (CloseForm), so there is one close screen.
import { useId, useMemo, useState, type ReactNode } from "react";
import { useFlow } from "@/components/markets/Flow";
import { monthName } from "@/components/markets/PriceChart";
import type { Trade } from "@/components/markets/useTrade";
import { Num } from "@/components/num/Num";
import { closeOrder } from "@/components/flow/CloseSheet";
import { useAccount, type Order, type TicketShown } from "@/lib/account";
import { isOld, useBook, useDataStatus, useMarkets, useNow, useSeriesFor } from "@/lib/data/hooks";
import { staleState } from "@/lib/data/derive";
import { usd, usd0 } from "@/lib/format";
import { cleanTyping, floorHours, fmtGpus, fmtHours, gpuWord, parseAmount, showHours, walkHours } from "@/lib/size";
import type { Book, Market, Position, Series, Side } from "@/lib/mock/types";
import { emptySideText, MonthSeg, monthSoFarText } from "./States";
import { KuruLine } from "./ProParts";
import s from "./trade.module.css";
import o from "./order.module.css";
import c from "./close.module.css";

type Stale = "none" | "stale" | "nodata";
export type TicketTab = "open" | "close";

/** What a holding can close from here, in GPU-hours: held tokens less any resting at Kuru (closeOrder's rule), a
 *  position whole, none when closeOrder cannot close it (it settles at the month's end). */
function closable(p: Position) {
  if (!closeOrder(p)) return 0;
  return p.kind === "tokens" ? floorHours(p.q - p.inMargin) : p.q;
}

/** The close order for `hours` of a holding: part of held tokens sells as sellLong; a position closes whole. */
function orderFor(p: Position, hours: number): Order | null {
  const whole = closeOrder(p);
  if (!whole || whole.kind !== "sellLong") return whole;
  return hours > 0 ? { ...whole, gpuHours: floorHours(hours).toFixed(4) } : null;
}

/** Closing `hours` of a holding at the book's prices now, best price first: a Long sells into the bids, a Short buys
 *  back from the asks. sold: the GPU-hours that close now (fewer than asked when the book is thin; every figure is
 *  for those, as the open ticket's are for what fills). value: the sale, or the buy-back. back: what reaches your
 *  balance now (a pay me daily Long hands back what it was already paid; a Short gets the ceiling back, less what it
 *  was paid and the buy-back, as the pretend account books it). gain: against the price it was opened at; null when
 *  that price is not known. */
function estimate(p: Position, hours: number, book: Book, cap: number) {
  const L = p.side === "long";
  // walkHours' "long" sums each GPU-hour at its own price, which is what both a sale and a buy-back come to
  const w = walkHours(L ? book.bids : book.asks, "long", hours, cap);
  const sold = w.short ? w.filled : hours;
  const value = w.outlay;
  const back = L ? value - (p.daily ? p.paid : 0) : sold * cap - p.paid - value;
  const gain = p.entry > 0 ? (L ? value - p.entry * sold : p.entry * sold - value) : null;
  return { avg: w.avg, filled: w.filled, short: w.short, sold, value, back, gain };
}

/** "+$12", "−$72", "$0" (whole dollars, like the open ticket's totals) and the tone it reads in. */
function gainOf(g: number | null) {
  if (g === null) return { text: "Not known", tone: c.quiet };
  if (Math.abs(g) < 0.5) return { text: "$0", tone: undefined };
  return { text: `${g > 0 ? "+" : "−"}${usd0(Math.abs(g))}`, tone: g > 0 ? s.up : s.down };
}

/** The ticket's Open | Close: what the signed-in account holds in the ticket's month, the tab on screen, the holding
 *  Close has picked, and the Open tab's guard. always: Pro keeps Close (it says why it is empty); Simple shows it only
 *  while something is held. */
function useCloseTabs(market: Market, trade: Trade, always: boolean) {
  const account = useAccount();
  const month = trade.n.series.month;
  const holdings = useMemo(() => (account.ready ? account.positions.filter((p) => p.gpu === market.gpu && p.month === month) : []), [account.ready, account.positions, market.gpu, month]);
  const [tab, setTab] = useState<TicketTab>("open");
  const [pickedId, setPickedId] = useState<string | null>(null);
  // a side picked while Close shows came from outside the ticket (the phone trade bar's Long or Short): that means
  // open. A side picked at all is the reader's own choice, so the guard may speak even beside a holding of that side
  const [seenSide, setSeenSide] = useState(trade.side);
  const [chose, setChose] = useState(false);
  if (seenSide !== trade.side) {
    setSeenSide(trade.side);
    setChose(true);
    if (tab === "close") setTab("open");
  }
  const hasClose = always || holdings.length > 0;
  // nothing left to close here (the last holding closed, or another GPU): back to Open, so a later buy that brings
  // the tab back does not land on Close
  if (!hasClose && tab === "close") setTab("open");
  // the picked holding while it is still held, else the first (a closed one leaves the list)
  const pick = holdings.find((p) => p.id === pickedId) ?? holdings[0] ?? null;
  const closeThis = (id: string) => {
    setPickedId(id);
    setTab("close");
  };
  // the side picked opens beside a holding of the other side and does not close it: said once the reader picks the
  // side, or at once when they hold only the other side (holding both, the default Long stays quiet)
  const against = holdings.filter((p) => p.side !== trade.side);
  const guard = against.length > 0 && (chose || !holdings.some((p) => p.side === trade.side)) ? <OpenGuard side={trade.side} against={against} onClose={closeThis} /> : null;
  return { holdings, hasClose, tab, setTab, pick, setPickedId, guard };
}

/** Open's one line when the side picked would open beside a holding of the other side, with the way to close that
 *  holding instead (Close, with it picked). */
function OpenGuard({ side, against, onClose }: { side: Side; against: Position[]; onClose: (id: string) => void }) {
  const L = side === "long";
  const other = L ? "Short" : "Long";
  const many = against.length > 1;
  // the first that can close from here, else the first (Close then says why it can't)
  const target = against.find((p) => closable(p) > 0) ?? against[0];
  return (
    <p className={c.guard}>
      This opens a separate {L ? "Long" : "Short"}. It does not close your {other}
      {many ? "s" : ""}.{" "}
      <button type="button" className={c.textBtn} onClick={() => onClose(target.id)}>
        Close {many ? "a" : "your"} {other} instead
      </button>
    </p>
  );
}

/** Open | Close at the head of the ticket: underline tabs like the order type's (Market | Limit), a size up, since they
 *  switch what the whole ticket does. Arrow keys, Home and End move between them. */
function ModeTabs({ tab, onTab, ids }: { tab: TicketTab; onTab: (t: TicketTab) => void; ids: ReturnType<typeof tabIds> }) {
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const next: TicketTab = e.key === "Home" ? "open" : e.key === "End" ? "close" : tab === "open" ? "close" : "open";
    onTab(next);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next === "open" ? 0 : 1]?.focus();
  };
  return (
    <div className={c.tabs} role="tablist" aria-label="Open or close" onKeyDown={onKey}>
      {(["open", "close"] as const).map((t) => (
        <button key={t} type="button" role="tab" id={ids[t].tab} aria-controls={ids[t].panel} aria-selected={tab === t} tabIndex={tab === t ? 0 : -1} onClick={() => onTab(t)}>
          {t === "open" ? "Open" : "Close"}
        </button>
      ))}
    </div>
  );
}

const tabIds = (id: string) => ({ open: { tab: `${id}-open-tab`, panel: `${id}-open` }, close: { tab: `${id}-close-tab`, panel: `${id}-close` } });

/** The ticket with Open | Close: the open ticket (today's, with the guard under Long / Short) and the Close panel, both
 *  kept mounted so each keeps what was typed while the other shows. Simple without a holding in the month shows the
 *  open ticket alone, no tabs. pickSignal: Pro's book picks; a price picked from the book is a trade at that price, so
 *  the ticket shows Open. */
export function TicketTabs({
  market,
  trade,
  always,
  dense = false,
  loading = false,
  stale = "none",
  pickSignal = 0,
  renderOpen,
}: {
  market: Market;
  trade: Trade;
  always: boolean;
  dense?: boolean;
  loading?: boolean;
  stale?: Stale;
  pickSignal?: number;
  renderOpen: (guard: ReactNode) => ReactNode;
}) {
  const t = useCloseTabs(market, trade, always);
  const [seenPick, setSeenPick] = useState(pickSignal);
  if (seenPick !== pickSignal) {
    setSeenPick(pickSignal);
    if (t.tab === "close") t.setTab("open");
  }
  const ids = tabIds(useId());
  const panel = (k: TicketTab) => (t.hasClose ? { id: ids[k].panel, role: "tabpanel", "aria-labelledby": ids[k].tab } : {});
  return (
    <div className={c.tabbed} data-dense={dense || undefined}>
      {t.hasClose && <ModeTabs tab={t.tab} onTab={t.setTab} ids={ids} />}
      <div {...panel("open")} hidden={t.tab !== "open"}>
        {renderOpen(t.guard)}
      </div>
      {t.hasClose && (
        <div {...panel("close")} hidden={t.tab !== "close"}>
          <ClosePanel market={market} trade={trade} holdings={t.holdings} pick={t.pick} onPick={t.setPickedId} dense={dense} loading={loading} stale={stale} />
        </div>
      )}
    </div>
  );
}

/** The Close tab: the ticket's month, which holding (one said in a line, more picked from a list, the first picked),
 *  then its close. Holding nothing (or signed out, in Pro), where holdings will show, never a dead form. */
function ClosePanel({ market, trade, holdings, pick, onPick, dense, loading, stale }: { market: Market; trade: Trade; holdings: Position[]; pick: Position | null; onPick: (id: string) => void; dense: boolean; loading: boolean; stale: Stale }) {
  const account = useAccount();
  const { openSignIn } = useFlow();
  const series = trade.n.series;
  const m = monthName(series.month);
  const now = useNow();
  const soFar = loading ? null : monthSoFarText(series, now);
  return (
    <div className={dense ? o.ticket : s.ticket}>
      <div className={s.tTop}>
        {trade.pickable ? (
          <MonthSeg trade={trade} />
        ) : (
          <b>
            {m} {market.gpu}
          </b>
        )}
        {soFar && <span>{soFar}</span>}
      </div>
      {!pick ? (
        <>
          <p className={s.tCopy}>
            What you buy in {market.gpu} {m} shows here to close any time.
          </p>
          {!account.ready && (
            <div className={dense ? o.ctaBar : s.ctaBar}>
              <button type="button" className={dense ? o.cta : s.cta} data-gate="true" onClick={openSignIn}>
                Sign in to see what you hold
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          {holdings.length > 1 ? <HoldingPick holdings={holdings} pick={pick} onPick={onPick} /> : <HoldingRow p={pick} />}
          <CloseBody key={pick.id} p={pick} series={series} dense={dense} loading={loading} stale={stale} />
        </>
      )}
    </div>
  );
}

/** "720 GPU-hours · bought at $4.08" (a Short was opened at its price; no price when it is not known). */
function HoldingMeta({ p }: { p: Position }) {
  return (
    <span>
      <Num>{showHours(p.q)}</Num> GPU-hours
      {p.entry > 0 && (
        <>
          {" "}
          · {p.side === "long" ? "bought" : "opened"} at <Num>{usd(p.entry)}</Num>
        </>
      )}
    </span>
  );
}

/** The side in its color ("Long" in the up color, "Short" in the down), then pay me daily when it is. */
function HoldingName({ p, your = false }: { p: Position; your?: boolean }) {
  return (
    <b>
      {your && "Your "}
      <span data-side={p.side}>{p.side === "long" ? "Long" : "Short"}</span>
      {p.daily ? ", paid daily" : ""}
    </b>
  );
}

/** One holding in the month: "Your Long" over its GPU-hours and the price it was opened at. */
function HoldingRow({ p }: { p: Position }) {
  return (
    <div className={c.hold}>
      <span className={c.holdText}>
        <HoldingName p={p} your />
        <HoldingMeta p={p} />
      </span>
    </div>
  );
}

/** More than one holding in the month: pick the one to close (native radios, so arrow keys move the pick). */
function HoldingPick({ holdings, pick, onPick }: { holdings: Position[]; pick: Position; onPick: (id: string) => void }) {
  const name = useId();
  return (
    <div className={c.holds} role="radiogroup" aria-label="What to close">
      {holdings.map((p) => (
        <label key={p.id} className={c.hold}>
          <input type="radio" name={name} checked={p.id === pick.id} onChange={() => onPick(p.id)} />
          <span className={c.holdText}>
            <HoldingName p={p} />
            <HoldingMeta p={p} />
          </span>
        </label>
      ))}
    </div>
  );
}

/** One holding's close: how much (held tokens in GPU-hours from All, with 25% / 50% / All; a position whole, said in a
 *  line), what it comes to at the book's prices now, and the button that names the act and opens its review. sheet:
 *  inside a Flow sheet (the Positions page's Close), where the sheet's own type rules apply. initial: the GPU-hours
 *  it opens on (Back from the review keeps the part picked); absent, All. */
function CloseBody({ p, series, dense, loading: marketLoading = false, stale = "none", sheet = false, initial }: { p: Position; series: Series; dense: boolean; loading?: boolean; stale?: Stale; sheet?: boolean; initial?: number }) {
  const { openClose } = useFlow();
  const bq = useBook(series);
  const book = bq.book;
  const loading = marketLoading || bq.loading;
  // skeletons masked on their own (ag-skel-on): the book can still be on its way after the screen has loaded
  const skel = loading ? "ag-skel ag-skel-on" : undefined;
  const L = p.side === "long";
  const side = L ? "Long" : "Short";
  const m = monthName(series.month);
  const whole = closeOrder(p);
  // held tokens sell any part; a pay me daily Long or a Short closes whole
  const part = whole?.kind === "sellLong";
  const max = closable(p);
  // the amount in GPU-hours; null is All (it follows the holding when it changes)
  const [text, setText] = useState<string | null>(() => (part && initial !== undefined && initial > 0 && initial < max ? fmtHours(initial) : null));
  const typed = part && text !== null ? (parseAmount(text) ?? 0) : max;
  const asked = floorHours(typed);
  const over = part && asked > max && showHours(asked) !== showHours(max);
  const hours = Math.min(asked, max);
  const est = estimate(p, hours, book, series.cap);
  const levels = L ? book.bids : book.asks;
  // nobody on the side a close needs (buyers for a Long, sellers for a Short): no price, nothing fills
  const none = !loading && !levels.length;
  // more than the book takes now: said, never closed in part without asking (agate's ThinBook rule)
  const thin = !loading && !none && hours > 0 && est.short;
  const walks = est.filled > 0 && Math.abs(est.avg - (levels[0]?.price ?? est.avg)) >= 0.0005;
  const order = over ? null : orderFor(p, hours);
  // the button waits while prices load, and once they are two minutes old (it says which), as the open ticket's does
  const wait = marketLoading || (bq.loading && !bq.error) ? "Loading prices" : stale === "stale" ? "Waiting for fresh prices" : stale === "nodata" || bq.loading ? "Waiting for prices" : null;
  const share = (pct: number) => floorHours((max * pct) / 100);
  const chip = hours === max && !over ? 100 : hours === share(50) ? 50 : hours === share(25) ? 25 : null;
  const gpus = hours / (24 * series.n);
  const gain = gainOf(est.gain);
  // a warning line in a Flow sheet takes the sheet's own error color (its paragraph rule outranks the ticket's)
  const warnCls = dense ? `${o.warn} ${o.sizeMsg}` : `${s.amountWarn}${sheet ? " ag-err" : ""}`;
  const helpCls = dense ? `${o.help} ${o.sizeMsg}` : s.amountEcho;

  const go = () => {
    if (!order) return;
    // the prices this showed: the pretend account books the close at them (the real one plans from the chain)
    const shown: TicketShown = { side: p.side, gpuHours: hours, price: est.avg, floor: series.floor, cap: series.cap, daily: p.daily, close: p };
    openClose(p, { order, shown });
  };

  if (!whole) {
    return p.kind === "tokens" ? <AtKuru p={p} all /> : <p className={s.tCopy}>This one can't be closed from here: it settles at the month's end.</p>;
  }

  // what the line under the amount says: the book's limits first, then what the amount comes to
  const msg = loading ? null : none ? (
    <p className={warnCls} key="none">
      {emptySideText(series, !L)}
    </p>
  ) : over ? (
    <p className={warnCls} key="over">
      You hold {fmtHours(max)} GPU-hours to sell.{" "}
      <button type="button" className={dense ? o.linkBtn : s.textBtn} onClick={() => setText(null)}>
        Close all
      </button>
    </p>
  ) : thin && part ? (
    <p className={warnCls} key="thin">
      Only {fmtHours(est.filled)} GPU-hours sell right now.{" "}
      <button type="button" className={dense ? o.linkBtn : s.textBtn} onClick={() => setText(fmtHours(est.filled))}>
        Use that
      </button>
    </p>
  ) : thin ? (
    <p className={warnCls} key="thinWhole">
      The book takes {showHours(est.filled)} GPU-hours right now, and this closes whole.
    </p>
  ) : null;

  const amount = part ? (
    dense ? (
      <div className={o.group}>
        <label className={o.input}>
          <span>Size</span>
          <input
            inputMode="decimal"
            enterKeyHint="done"
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            value={text ?? fmtHours(max)}
            placeholder="0"
            aria-label={`GPU-hours of your ${side} to sell`}
            onChange={(e) => setText(cleanTyping(e.target.value, 4))}
            onBlur={() => text !== null && setText(fmtHours(asked))}
          />
          <em>GPU-hours</em>
        </label>
        <div className={`${o.chips} ${c.chips}`} role="group" aria-label={`Share of your ${side}`}>
          {[25, 50, 100].map((pct) => (
            <button key={pct} type="button" aria-pressed={chip === pct} onClick={() => setText(pct === 100 ? null : fmtHours(share(pct)))}>
              {pct === 100 ? "All" : `${pct}%`}
            </button>
          ))}
        </div>
        {msg ?? (
          <p className={helpCls}>
            {fmtHours(max)} GPU-hours to sell.{" "}
            {hours > 0 && (gpus >= 0.01 ? `About ${fmtGpus(Math.round(gpus * 100) / 100)} ${gpuWord(gpus)} for all of ${m}.` : `About ${fmtGpus(Math.round((hours / 24) * 100) / 100 || 0.01)} GPU for a day.`)}
          </p>
        )}
      </div>
    ) : (
      <div className={s.amount}>
        <div className={s.amountHead}>
          <span>Amount</span>
        </div>
        <label className={s.amountBox}>
          <input
            inputMode="decimal"
            enterKeyHint="done"
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            value={text ?? fmtHours(max)}
            placeholder="0"
            aria-label={`GPU-hours of your ${side} to sell`}
            onChange={(e) => setText(cleanTyping(e.target.value, 4))}
            onBlur={() => text !== null && setText(fmtHours(asked))}
          />
          <span className={s.amountPost}>GPU-hours</span>
        </label>
        <div className={sheet ? `${s.amountRow} ${c.wrapRow}` : s.amountRow}>
          <div className={`${s.amountChips} ${c.chips}`} role="group" aria-label={`Share of your ${side}`}>
            {[25, 50, 100].map((pct) => (
              <button key={pct} type="button" aria-pressed={chip === pct} onClick={() => setText(pct === 100 ? null : fmtHours(share(pct)))}>
                {pct === 100 ? "All" : `${pct}%`}
              </button>
            ))}
          </div>
          <span>
            <Num>{fmtHours(max)}</Num> GPU-hours held
          </span>
        </div>
        {msg ?? (
          <p className={helpCls}>
            {hours > 0
              ? gpus >= 0.01
                ? `About ${fmtGpus(Math.round(gpus * 100) / 100)} ${gpuWord(gpus)} for all of ${m}.`
                : `About ${fmtGpus(Math.round((hours / 24) * 100) / 100 || 0.01)} GPU for a day.`
              : "Pick a share, or type the GPU-hours to sell."}
          </p>
        )}
      </div>
    )
  ) : (
    <>
      <p className={s.tCopy}>
        {L ? "Pay me daily" : "A Short"} closes whole: all <Num>{showHours(p.q)}</Num> GPU-hours.
      </p>
      {msg}
    </>
  );

  const label =
    wait ??
    (none ? (
      L ? "No buyers right now" : "No sellers right now"
    ) : !L ? (
      "Close your Short"
    ) : !part || chip === 100 ? (
      "Close your Long"
    ) : hours <= 0 ? (
      "Enter an amount"
    ) : chip ? (
      `Close ${chip}% of your Long`
    ) : (
      <>
        Close <Num>{showHours(hours)}</Num> GPU-hours of your Long
      </>
    ));
  // the other way out, in one quiet line under the button: hold, and the month pays
  const hold = p.daily ? `Or hold to the end of ${m}: it pays a share each day until then.` : L ? `Or hold to the end of ${m}: it pays ${m}'s average price.` : `Or hold to the end of ${m}: it pays ${usd(series.cap)} less ${m}'s average price.`;

  return (
    <>
      {amount}
      {p.kind === "tokens" && p.inMargin > 0 && <AtKuru p={p} all={false} />}

      {/* with nobody on the side a close needs nothing fills, and a whole close the book can't take can't happen, so
          there is nothing to sum up */}
      {!none && !(thin && !part) && (
        <dl className={dense ? o.sum : s.sum}>
          <div>
            <dt>
              {L ? "Sells at" : "Buys back at"}
              {walks && (
                <>
                  {" "}
                  <span className={dense ? undefined : s.hint}>averaged across the book's prices</span>
                </>
              )}
            </dt>
            <dd className={skel}>
              <Num>{walks ? `$${est.avg.toFixed(3)}` : usd(levels[0]?.price ?? 0)}</Num>
            </dd>
          </div>
          {p.daily && (
            <div>
              <dt>Already paid to you</dt>
              <dd>
                <Num>{usd0(p.paid)}</Num>
              </dd>
            </div>
          )}
          <div>
            {/* a Short's buy-back can spend up to its bound and hand any extra back as GPU-hours, so its dollars are an estimate */}
            <dt>{p.daily ? "You get now" : L ? "You'll receive" : "You'll receive about"}</dt>
            <dd className={skel}>
              <Num>{usd0(Math.max(0, est.back))}</Num>
            </dd>
          </div>
          <div>
            <dt>
              Gain or loss <span className={dense ? undefined : s.hint}>if you close now</span>
            </dt>
            <dd className={[skel, gain.tone].filter(Boolean).join(" ") || undefined}>{est.gain === null ? gain.text : <Num>{gain.text}</Num>}</dd>
          </div>
          <div>
            <dt>Your {side}</dt>
            <dd>
              <Num>{showHours(p.q)}</Num> → <Num>{showHours(Math.max(0, floorHours(p.q - est.sold)))}</Num> <span className={c.unit}>GPU-hours</span>
            </dd>
          </div>
          {dense && (
            <div>
              <dt>Fee</dt>
              <dd>None on testnet</dd>
            </div>
          )}
        </dl>
      )}

      {/* the button and its line stay pinned at the bottom of the ticket on phones and tablets, as the open ticket's */}
      <div className={sheet ? c.sheetCta : dense ? o.ctaBar : s.ctaBar}>
        <button type="button" className={dense ? o.cta : s.cta} disabled={wait !== null || none || !order || hours <= 0 || thin} onClick={go}>
          {label}
        </button>
        <p className={sheet ? `ag-fine ${c.center}` : dense ? o.note : s.fine}>{hold}</p>
      </div>
    </>
  );
}

/** Held tokens waiting in Kuru's margin account (a filled bid lands there). The real account moves them to the account
 *  (planWithdrawMargin), where they sell from here; the pretend account never has any, and says they settle at the
 *  month's end. all: every GPU-hour of the holding waits there. */
function AtKuru({ p, all }: { p: Position; all: boolean }) {
  const account = useAccount();
  const [moved, setMoved] = useState<{ line: string; ok: boolean } | null>(null);
  const some = all ? "These" : <><Num>{showHours(p.inMargin)}</Num> more</>;
  if (!account.planLimit) return <p className={s.tCopy}>{some} GPU-hours rest in an order at Kuru{all ? ", so they settle" : " and settle"} at the month&apos;s end.</p>;
  if (moved?.ok) return <p className={s.tCopy} role="status">{moved.line}</p>;
  return (
    <>
      <KuruLine
        order={{ kind: "withdrawMargin", asset: { gpu: p.gpu, month: p.month } }}
        back={(r) => `${showHours(r.withdrawn?.gpuHours ?? p.inMargin)} GPU-hours are in your account now.`}
        onMoved={(line, ok) => setMoved({ line, ok })}
        label="Move them"
        className={s.tCopy}
        btnClass={c.textBtn}
      >
        {some} GPU-hours wait at Kuru, where a limit order left them. Move them to your account to sell them here.
      </KuruLine>
      {/* why it did not go, with the button still there for another try */}
      {moved && (
        <p className={s.tCopy} role="status">
          {moved.line}
        </p>
      )}
    </>
  );
}

/** The Positions page's Close (closeUi "tabs"): the trade panel's close form for that one holding, as a sheet. Its
 *  button opens the same review the panel's does, and Back from there returns here with the amount it had (hours). */
export function CloseForm({ p, hours, onClose }: { p: Position; hours?: number; onClose: () => void }) {
  const seriesFor = useSeriesFor();
  const series = seriesFor(p.gpu, p.month);
  const { markets, loading } = useMarkets();
  // the button waits once the prices are two minutes old, as on the trade screen
  const st = useDataStatus();
  const stale = staleState({ error: st.error, stale: isOld(st.updatedAt) }, !!markets);
  const m = monthName(p.month);
  return (
    <>
      <h2>
        {p.gpu} {m}
      </h2>
      <HoldingRow p={p} />
      {series ? (
        <CloseBody p={p} series={series} dense={false} loading={loading} stale={stale} sheet initial={hours} />
      ) : (
        <p>{loading ? `Reading ${m}'s prices.` : `Can't read ${m}'s prices right now. Try again in a moment.`}</p>
      )}
      <button className="ag-btn ag-btn--quiet" type="button" onClick={onClose}>
        Not now
      </button>
    </>
  );
}
