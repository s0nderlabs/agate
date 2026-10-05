"use client";
// Judging chrome, not design: flips the mock world. Every choice is mirrored in the URL (?auth=in&data=carried...),
// so any state can be shared as a link. Off in production builds (NEXT_PUBLIC_MOCK_CONTROLS).
// Design options join DESIGN_ROWS while they are being judged, beside the current state, and leave once decided.
import { useEffect } from "react";
import { useAccount } from "@/lib/account";
import { useMock, type MockConfig } from "@/lib/mock/store";
import { useDataStatus, useIndexer } from "@/lib/data/hooks";
import s from "./MockDock.module.css";

type Row = { key: keyof MockConfig; label: string; options: [string, string][] };

/** Options being judged right now: the proposal first (the default), the state before it marked "(before)". */
const DESIGN_ROWS: Row[] = [
  {
    key: "months",
    label: "Simple's months",
    options: [
      ["one", "Next full month"],
      ["both", "Every open month (before)"],
    ],
  },
  {
    key: "dfill",
    label: "Dark trade button",
    options: [
      ["deep", "Deeper fill"],
      ["bright", "Bright (before)"],
    ],
  },
  {
    key: "phone",
    label: "Phone and tablet layout",
    options: [
      ["new", "New"],
      ["stacked", "Stacked (before)"],
    ],
  },
  {
    key: "pbar",
    label: "Phone trade buttons",
    options: [
      ["fill", "Filled"],
      ["tint", "Tinted"],
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
    // example data only; live data shows whatever the testnet holds
    options: [
      ["normal", "Normal day"],
      ["loading", "Loading"],
      ["degraded", "One cloud missing"],
      ["carried", "Carried day"],
      ["beforeFirst", "Before the first price"],
      ["upcoming", "Month not open yet"],
      ["noTrades", "Listed, no trades"],
      ["emptyBook", "Empty book"],
      ["indexerDown", "Indexer down"],
      ["rpcDown", "Monad unreachable"],
      ["rpcStale", "Monad unreachable, old data"],
    ],
  },
  {
    key: "when",
    label: "Day",
    // example data only: the month timeline (lib/mock/timeline.ts)
    options: [
      ["oct", "Today: Nov listed"],
      ["nov3", "Nov 3: Nov paying, Dec just listed"],
      ["nov13", "Nov 13: day 12 of 30"],
      ["nov30", "Nov 30, 22:15: last hour"],
      ["dec1gap", "Dec 1, 03:00: Nov not final"],
      ["dec1final", "Dec 1, 09:00: Nov final"],
    ],
  },
  {
    key: "gpu",
    label: "GPU",
    options: [
      ["H100", "H100"],
      ["H200", "H200"],
      ["B200", "B200"],
      ["B300", "B300"],
      ["A100", "A100"],
      ["L40S", "L40S"],
    ],
  },
  {
    key: "source",
    label: "Data source",
    options: [
      ["example", "Example data"],
      ["live", "Live testnet"],
    ],
  },
];

/** How the pretend wallet and Agate's pretend server answer (example data only), so every sheet and page state can be
 *  judged without the chain. */
const WALLET_ROWS: Row[] = [
  {
    key: "holds",
    label: "Holds",
    options: [
      ["none", "Only my trades"],
      ["nov", "H100 November (3)"],
    ],
  },
  {
    key: "signin",
    label: "Sign-in outcome",
    options: [
      ["auto", "As the wallet is"],
      ["new", "New person"],
      ["returning", "Returning"],
      ["wrong", "Wrong code first"],
      ["expired", "Expired code first"],
      ["walletfail", "Wallet fails once"],
      ["dripfail", "First drip fails"],
      ["slow", "Slow setup"],
    ],
  },
  {
    key: "ais",
    label: "Connected AIs",
    options: [
      ["none", "None"],
      ["one", "One"],
      ["two", "Two"],
      ["ended", "Ended"],
    ],
  },
  {
    key: "connect",
    label: "Connect outcome",
    options: [
      ["normal", "Normal"],
      ["stepup", "Needs a fresh code"],
      ["notyet", "Key not there yet"],
      ["fundfail", "Funding fails once"],
      ["refused", "Agate refuses once"],
      ["expired", "Request runs out"],
      ["offline", "Server offline"],
    ],
  },
  {
    key: "disc",
    label: "Disconnect outcome",
    options: [
      ["normal", "Normal"],
      ["stopfail", "Server misses once"],
      ["takebackfail", "Take back fails once"],
    ],
  },
];

/** While the source is live: whether the indexer answers and when the markets were last read (UTC). */
function LiveRow() {
  const st = useDataStatus();
  // "answers" only once a check has said so (the screens treat the indexer as up until then)
  const ix = useIndexer();
  const at = st.updatedAt ? new Date(st.updatedAt).toISOString().slice(11, 19) : "";
  const read = at ? `last read ${at} UTC` : st.error ? "Monad unreachable, nothing read yet" : "first read on its way";
  return (
    <div className={s.row}>
      <span>Live status</span>
      <div className={s.opts}>
        <span className={s.stat}>
          Live testnet: indexer {!ix.checked ? "checking" : ix.indexerUp ? "answers" : "not answering"}, {read}
          {st.error && at ? ", the last read failed" : ""}
        </span>
      </div>
    </div>
  );
}

export function MockDock() {
  const { config, setConfig, reset } = useMock();
  const account = useAccount();
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
          {[...DESIGN_ROWS, ...STATE_ROWS, ...WALLET_ROWS].map((r) => {
            // the example's states do nothing to live data: the row stands down while the source is live
            const idle = (r.key === "data" || r.key === "when" || WALLET_ROWS.includes(r)) && config.source === "live";
            return (
              <div className={s.row} key={r.key}>
                <span>{r.label}</span>
                <div className={s.opts}>
                  {idle && <span className={s.stat}>Example data only. Live shows what the testnet holds.</span>}
                  {r.options.map(([v, label]) => (
                    <button key={v} aria-pressed={!idle && config[r.key] === v} disabled={idle} onClick={() => setConfig({ [r.key]: v } as Partial<MockConfig>)}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          {config.source === "live" && <LiveRow />}
          <div className={s.row}>
            <span>Wallet</span>
            <div className={s.opts}>
              <span className={s.stat}>
                {account.ready ? `${Math.round(account.balance).toLocaleString("en-US")} test dollars, ${account.positions.length} ${account.positions.length === 1 ? "position" : "positions"}` : "No wallet yet"}
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
