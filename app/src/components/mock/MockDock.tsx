"use client";
// Judging chrome, not design: flips the mock world. Every choice is mirrored in the URL (?auth=in&data=carried...),
// so any state can be shared as a link. Off in production builds (NEXT_PUBLIC_MOCK_CONTROLS).
// Design options join DESIGN_ROWS while they are being judged, beside the current state, and leave once decided.
import { useEffect } from "react";
import { useMock, type MockConfig } from "@/lib/mock/store";
import s from "./MockDock.module.css";

type Row = { key: keyof MockConfig; label: string; options: [string, string][] };

/** Options being judged right now: the proposal first (the default), the state before it marked "(before)". */
const DESIGN_ROWS: Row[] = [
  {
    key: "dfill",
    label: "Dark trade button",
    options: [
      ["deep", "Deeper fill"],
      ["bright", "Bright (before)"],
    ],
  },
];

/** The app's states, for checking every screen in each of them. */
const STATE_ROWS: Row[] = [
  {
    key: "mode",
    label: "Mode",
    options: [
      ["simple", "Simple"],
      ["pro", "Pro"],
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

export function MockDock() {
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
          {[...DESIGN_ROWS, ...STATE_ROWS].map((r) => (
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
        </div>
      )}
      <button className={s.pill} onClick={() => setConfig({ dock: open ? "closed" : "open" })} aria-expanded={open}>
        {open ? "Close" : "Mock controls"}
      </button>
    </div>
  );
}
