"use client";
// Judging chrome, not design: flips the mock world. Every choice is mirrored in the URL (?v=b&auth=in...),
// so any state can be shared as a link. Remove before launch.
import { useEffect } from "react";
import { useMock, type MockConfig } from "@/lib/mock/store";
import { VERSIONS } from "@/lib/mock/config";
import s from "./MockDock.module.css";

type Row = { key: keyof MockConfig; label: string; options: [string, string][] };

const ARCHIVE_ROWS: Row[] = [
  {
    key: "v",
    label: "Look",
    options: [
      ["a", "A Editorial (Public)"],
      ["b", "B Object (Plasma)"],
      ["c", "C Statement (Ornn)"],
    ],
  },
];

const TRADE_ROWS: Row[] = [
  {
    key: "style",
    label: "Panels",
    options: [
      ["tech", "Flat, thin lines"],
      ["simple", "Floating cards"],
    ],
  },
  {
    key: "corners",
    label: "Corners",
    options: [
      ["square", "Square"],
      ["soft", "Soft"],
      ["round", "Round"],
    ],
  },
  {
    key: "head",
    label: "Header",
    options: [
      ["two", "Two prices"],
      ["one", "One price (round 2)"],
    ],
  },
  {
    key: "ctx",
    label: "Sources",
    options: [
      ["link", "Index page link"],
      ["pop", "On click"],
      ["top", "In the header"],
      ["bottom", "Below the chart"],
    ],
  },
  {
    key: "tpanel",
    label: "Trade panel",
    options: [
      ["top", "From the top"],
      ["under", "Under the header (before)"],
    ],
  },
  {
    key: "hstats",
    label: "Header stats",
    options: [
      ["refs", "Like the references: 4 plain"],
      ["charts", "Small charts + color (before)"],
      ["rich", "Range lines + hover notes (earlier)"],
      ["grid", "Two rows, plain (earlier)"],
      ["row", "One row (earlier)"],
    ],
  },
  {
    key: "hint",
    label: "Hover hint",
    options: [
      ["icon", "Info icon"],
      ["dots", "Dotted underline (before)"],
    ],
  },
  {
    key: "horder",
    label: "Header order",
    options: [
      ["meaning", "Meaning in the middle"],
      ["board", "One scoreboard (tried)"],
      ["numbers", "Numbers together (tried)"],
    ],
  },
  {
    key: "stats",
    label: "Market stats",
    options: [
      ["on", "Show"],
      ["off", "Hide (before)"],
    ],
  },
  {
    key: "risk",
    label: "Risk wording",
    options: [
      ["avg", "if it averages"],
      ["settle", "if it settles (before)"],
    ],
  },
  {
    key: "row",
    label: "Market row",
    options: [
      ["tabs", "Tabs"],
      ["chips", "Chips"],
      ["ticker", "Ticker (before)"],
    ],
  },
  {
    key: "mark",
    label: "Active link",
    options: [
      ["stone", "Stone"],
      ["square", "Square (before)"],
    ],
  },
  {
    key: "ticket",
    label: "Pro ticket",
    options: [
      ["order", "Order ticket"],
      ["plan", "Same as Simple (before)"],
    ],
  },
  {
    key: "gate",
    label: "Signed out",
    options: [
      ["signin", "Sign in to trade"],
      ["trade", "Trade label (before)"],
    ],
  },
  {
    key: "book",
    label: "Order book",
    options: [
      ["bot", "Testnet bot (3 levels)"],
      ["deep", "Deep (before)"],
    ],
  },
  {
    key: "mode",
    label: "App mode",
    options: [
      ["simple", "Simple"],
      ["pro", "Pro"],
    ],
  },
  {
    key: "wm",
    label: "Wordmark",
    options: [
      ["orig", "37% (current)"],
      ["l", "48%"],
      ["xl", "56%"],
    ],
  },
  {
    key: "wcase",
    label: "Name case",
    options: [
      ["title", "Agate"],
      ["lower", "agate (before)"],
    ],
  },
  {
    key: "theme",
    label: "Theme",
    options: [
      ["light", "Light"],
      ["dark", "Dark"],
    ],
  },
  {
    key: "dark",
    label: "Dark tone",
    options: [
      ["graphite", "Warm graphite"],
      ["black", "Near-black (before)"],
    ],
  },
];

const ROWS: Row[] = [
  {
    key: "auth",
    label: "Visitor",
    options: [
      ["out", "Signed out"],
      ["in", "Signed in"],
    ],
  },
  {
    key: "data",
    label: "Data",
    options: [
      ["live", "Normal day"],
      ["loading", "Loading"],
      ["degraded", "One cloud missing"],
      ["carried", "Carried day"],
    ],
  },
  {
    key: "gpu",
    label: "GPU",
    options: [
      ["H100", "H100"],
      ["H200", "H200"],
      ["B200", "B200"],
    ],
  },
];

export function MockDock({ screen = "trade" }: { screen?: "trade" | "archive" }) {
  const { config, setConfig, reset, wallet } = useMock();
  const open = config.dock === "open";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea")) return;
      if (e.key === "m" || e.key === "M") document.documentElement.toggleAttribute("data-mock-hidden");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={s.wrap}>
      {open && (
        <div className={s.panel} role="dialog" aria-label="Mock controls">
          <div className={s.head}>
            <b>Mock controls</b>
            <span>Press M to hide</span>
          </div>
          {screen === "trade" && (
            <div className={s.row}>
              <span>Version</span>
              <div className={s.opts}>
                {VERSIONS.map((ver) => (
                  <button key={ver.label} aria-pressed={(Object.keys(ver.set) as (keyof MockConfig)[]).every((k) => config[k] === ver.set[k])} onClick={() => setConfig(ver.set)}>
                    {ver.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {[...(screen === "trade" ? TRADE_ROWS : ARCHIVE_ROWS), ...ROWS].map((r) => (
            <div className={s.row} key={r.key}>
              <span>{r.label}</span>
              <div className={s.opts}>
                {r.options.map(([v, label]) => (
                  <button key={v} aria-pressed={config[r.key] === v} onClick={() => setConfig({ [r.key]: v } as Partial<MockConfig>)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className={s.row}>
            <span>Wallet</span>
            <div className={s.opts}>
              <span className={s.stat}>
                {wallet.signedIn ? `${Math.round(wallet.balance).toLocaleString("en-US")} test dollars, ${wallet.positions.length} positions` : "No wallet yet"}
              </span>
              <button onClick={reset}>Reset</button>
            </div>
          </div>
          <div className={s.row}>
            <span>Earlier</span>
            <div className={s.opts}>
              <a className={s.link} href={screen === "trade" ? "/archive?dock=open" : "/?dock=open"}>
                {screen === "trade" ? "First round mocks (A, B, C)" : "Back to the trade screen"}
              </a>
            </div>
          </div>
        </div>
      )}
      <button className={s.pill} onClick={() => setConfig({ dock: open ? "closed" : "open" })} aria-expanded={open}>
        {open ? "Close" : "Mock controls"}
      </button>
    </div>
  );
}
