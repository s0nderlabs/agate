// Index history plus the open month's band (floor to ceiling) and its market price, drawn to one scale.
import type { Market, Series } from "@/lib/mock/types";
import { shortDate, usd } from "@/lib/format";

const DAY = 86400000;

export function PriceChart({ market, series, height = 260, className }: { market: Market; series: Series; height?: number | string; className?: string }) {
  const hist = market.history;
  const t0 = Date.parse(hist[0].date + "T00:00:00Z");
  const tToday = Date.parse(hist[hist.length - 1].date + "T00:00:00Z");
  const mStart = Date.parse(series.month + "-01T00:00:00Z");
  const mEnd = mStart + (series.n - 1) * DAY;
  const span = mEnd - t0;
  const top = Math.ceil((series.cap * 1.08) / 2) * 2;
  const X = (t: number) => ((t - t0) / span) * 1000;
  const Y = (p: number) => ((top - p) / top) * 400;
  const pct = (v: number, max: number) => `${(v / max) * 100}%`;

  const line = hist.map((d, i) => `${i ? "L" : "M"}${X(Date.parse(d.date + "T00:00:00Z")).toFixed(1)},${Y(d.price).toFixed(1)}`).join(" ");
  const xT = X(tToday);
  const area = `${line} L${xT.toFixed(1)},400 L0,400 Z`;
  const x1 = X(mStart);
  const level = series.quote?.last ?? market.price;
  const ticks = [2, 4, 6, 8, 10, 12, 14].filter((v) => v < top * 0.95);
  const carried = hist.filter((d) => d.status === "carried");

  const fill = height === "fill";
  return (
    <div className={`ag-chart ${className ?? ""}`} style={fill ? { display: "flex", flexDirection: "column", height: "100%" } : undefined}>
      <div className="ag-chart__plot" style={fill ? { flex: 1, minHeight: 240 } : { height }}>
        <svg viewBox="0 0 1000 400" preserveAspectRatio="none" aria-hidden="true">
          <rect className="zone" x={x1} y={0} width={1000 - x1} height={400} />
          <g className="grid">
            {ticks.map((v) => (
              <line key={v} x1={0} x2={1000} y1={Y(v)} y2={Y(v)} />
            ))}
          </g>
          <rect className="band" x={x1} y={Y(series.cap)} width={1000 - x1} height={Y(series.floor) - Y(series.cap)} />
          <line className="rail" x1={x1} x2={1000} y1={Y(series.cap)} y2={Y(series.cap)} />
          <line className="rail" x1={x1} x2={1000} y1={Y(series.floor)} y2={Y(series.floor)} />
          <line className="level" x1={x1} x2={1000} y1={Y(level)} y2={Y(level)} />
          <path className="area" d={area} />
          <path className="hist" d={line} />
          <path className="gap" d={`M${xT},${Y(market.price)} L${x1},${Y(level)}`} />
        </svg>
        {ticks.map((v) => (
          <span key={v} className="ag-chart__lbl" style={{ left: 0, top: pct(Y(v), 400), transform: "translateY(-120%)", color: "var(--mute)" }}>
            ${v}
          </span>
        ))}
        <span className="ag-chart__lbl" style={{ left: pct(x1, 1000), top: pct(Y(series.cap), 400), marginLeft: 8, transform: "translateY(6px)" }}>
          Ceiling {usd(series.cap)}
        </span>
        <span className="ag-chart__lbl" style={{ left: pct(x1, 1000), top: pct(Y(series.floor), 400), marginLeft: 8, transform: "translateY(calc(-100% - 6px))" }}>
          Floor {usd(series.floor)}
        </span>
        <span className="ag-chart__lbl" style={{ right: 6, top: pct(Y(level), 400), transform: "translateY(-125%)", fontWeight: 500, color: "var(--ink)" }}>
          {monthName(series.month)} {usd(level)}
        </span>
        {carried.map((d) => (
          <span key={d.date} title={`${shortDate(d.date)}: carried, unverified`} className="ag-chart__lbl" style={{ left: pct(X(Date.parse(d.date + "T00:00:00Z")), 1000), top: pct(Y(d.price), 400), width: 8, height: 8, borderRadius: 99, background: "var(--bg)", boxShadow: "inset 0 0 0 2px var(--mute)", transform: "translate(-50%,-50%)" }} />
        ))}
        <span className="ag-chart__dot" style={{ left: pct(xT, 1000), top: pct(Y(market.price), 400) }} />
        <span className="ag-chart__flag" style={{ left: pct(xT, 1000), top: pct(Y(market.price), 400) }}>
          Today {usd(market.price)}
        </span>
      </div>
      <div className="ag-chart__x">
        <span style={{ left: 0 }}>{shortDate(hist[0].date)}</span>
        <span style={{ left: pct(X(Date.parse("2026-10-01T00:00:00Z")), 1000) }}>Oct 1</span>
        <span style={{ left: pct(x1, 1000) }}>{shortDate(series.month + "-01")}</span>
        <span style={{ left: "100%" }}>{shortDate(new Date(mEnd).toISOString())}</span>
      </div>
    </div>
  );
}

export function monthName(m: string) {
  return new Date(m + "-01T00:00:00Z").toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
}
