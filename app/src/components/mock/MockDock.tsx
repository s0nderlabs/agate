"use client";
// Judging chrome, not design: flips the mock world. Every choice is mirrored in the URL (?auth=in&data=carried...),
// so any state can be shared as a link. Off in production builds (NEXT_PUBLIC_MOCK_CONTROLS).
// Design options join DESIGN_ROWS while they are being judged, beside the current state, and leave once decided.
// Oct 8: the pill opens and closes it, so do the panel's
// own Close button, a click outside and Esc; M still opens and closes it. On the landing it is only the hero picker
// (arrows on the pill); on the app's pages the everyday states show first and the rest fold away.
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAccount } from "@/lib/account";
import { LANDINGS } from "@/lib/mock/config";
import { useMock, type MockConfig } from "@/lib/mock/store";
import { useDataStatus, useIndexer } from "@/lib/data/hooks";
import s from "./MockDock.module.css";

type Row = { key: keyof MockConfig; label: string; options: [string, string][] };

/** The chip films' own option, on the landing. */
const HERO_ROWS: Row[] = [
  {
    key: "story",
    label: "Below the hero",
    options: [
      ["site", "The site: the chip dive, then a market page (Public's order)"],
      ["on", "The story in zooms (before)"],
      ["off", "Nothing below the hero"],
    ],
  },
  {
    key: "turnAt",
    label: "The turn (site)",
    options: [
      ["beside", "Words beside the H100"],
      ["under", "Words under the H100"],
    ],
  },
  {
    key: "aiUi",
    label: "Your AI (site)",
    options: [
      ["tabs", "Wide panel, three tabs"],
      ["held", "Card held, words scroll past"],
    ],
  },
  {
    key: "payUi",
    label: "Paid every day (site)",
    options: [
      ["rows", "Ruled rows in a dark card"],
      ["grid", "The month as a grid"],
    ],
  },
  {
    key: "chartMotion",
    label: "After the film",
    options: [
      ["live", "The chart keeps trading: a new day every few seconds"],
      ["still", "Still once it settles (before)"],
    ],
  },
  {
    key: "textIn",
    label: "Words arrive",
    options: [
      ["settle", "Settle in turn: headline, buttons, bar, a soft blur clearing"],
      ["quick", "All at once (before)"],
    ],
  },
  {
    key: "closeArt",
    label: "The close shows",
    options: [
      ["type", "Nothing but type: the headline at full width, a ruled band with the buttons"],
      ["chip", "The H100 at rest (before)"],
    ],
  },

  {
    key: "intro",
    label: "Opening",
    options: [
      ["fold", "Loading screen: the A folds, then the film"],
      ["cell", "No loading screen, the cell breathes (before)"],
    ],
  },
  {
    key: "wicks",
    label: "Chip candles",
    options: [
      ["off", "Without wicks"],
      ["on", "With wicks (before)"],
    ],
  },
  {
    key: "chipColor",
    label: "Chip colour",
    options: [
      ["silicon", "Silicon"],
      ["mono", "Monochrome"],
      ["ink", "Ink"],
    ],
  },
  {
    key: "oldDays",
    label: "Older days",
    options: [
      ["faded", "Faded"],
      ["full", "Not faded"],
    ],
  },
  {
    key: "heroWords",
    label: "Words (Field)",
    options: [
      ["center", "Up top, centred"],
      ["top", "Up top, left"],
      ["low", "Low left (before)"],
    ],
  },
  {
    key: "navShape",
    label: "Top bar shape",
    options: [
      ["pill", "Floating capsule"],
      ["center", "Links centred"],
      ["split", "Split (before)"],
    ],
  },
  {
    key: "corners",
    label: "Corners (whole page)",
    options: [
      ["square", "Square, as the app (2 px everywhere)"],
      ["round", "Round (pill buttons, soft boxes)"],
    ],
  },
  {
    key: "boardCut",
    label: "Words on the board",
    options: [
      ["off", "Shade"],
      ["on", "Board makes room"],
    ],
  },
  {
    key: "navLinks",
    label: "Top bar",
    options: [
      ["docs", "Docs + Open app"],
      ["before", "Positions + Start trading (before)"],
    ],
  },
];

/** Options being judged right now: the proposal first (the default), the state before it marked "(before)". */
const DESIGN_ROWS: Row[] = [
  {
    key: "logo",
    label: "Logo",
    options: [
      ["fold", "Folded A, one ink"],
      ["foldlace", "Folded A, blue lace"],
      ["lace", "Pebble, blue lace"],
      ["onyx", "Pebble, onyx"],
      ["stone", "Today's stone (before)"],
    ],
  },
  {
    key: "closeUi",
    label: "Close from the panel",
    options: [
      ["tabs", "Open | Close tabs"],
      ["before", "Only opens (before)"],
    ],
  },
  {
    key: "candles",
    label: "Candle size",
    options: [
      ["auto", "Follows the range"],
      ["before", "Always hourly (before)"],
    ],
  },
  {
    key: "positionsUi",
    label: "Positions page",
    options: [
      ["market", "Market frame (round 2)"],
      ["new", "Reworked (round 1)"],
      ["before", "Before"],
    ],
  },
  {
    key: "indexUi",
    label: "Index page",
    options: [
      ["market", "Market frame (round 2)"],
      ["new", "Reworked (round 1)"],
      ["before", "Before"],
    ],
  },
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
  const path = usePathname();
  const onLanding = path === "/landing";
  const open = config.dock === "open";
  const [hidden, setHidden] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "m" || e.key === "M") {
        setHidden(false);
        setConfig({ dock: open ? "closed" : "open" });
      } else if (e.key === "Escape" && open) setConfig({ dock: "closed" });
    };
    // a click anywhere outside the panel and the pill closes it
    const onDown = (e: PointerEvent) => {
      if (open && wrap.current && !wrap.current.contains(e.target as Node)) setConfig({ dock: "closed" });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open, setConfig]);

  const li = Math.max(0, LANDINGS.findIndex(([key]) => key === config.landing));
  const pick = (n: number) => {
    setConfig({ landing: LANDINGS[(n + LANDINGS.length) % LANDINGS.length][0] });
    window.scrollTo({ top: 0 });
  };

  if (hidden)
    return (
      <div className={s.wrap}>
        <button className={s.dot} onClick={() => setHidden(false)} aria-label="Show Mock controls" title="Show Mock controls" />
      </div>
    );

  return (
    <div className={s.wrap} ref={wrap}>
      {open && (
        <div className={s.panel} role="dialog" aria-label="Mock controls">
          <div className={s.head}>
            <b>{onLanding ? "Hero styles" : "Mock controls"}</b>
            <div className={s.headBtns}>
              <button
                onClick={() => {
                  setConfig({ dock: "closed" });
                  setHidden(true);
                }}
                title="Hide it all; the dot in the corner brings it back"
              >
                Hide
              </button>
              <button onClick={() => setConfig({ dock: "closed" })}>Close</button>
            </div>
          </div>
          {onLanding ? (
            <>
              <ol className={s.list}>
                {LANDINGS.map(([key, label], n) => (
                  <li key={key}>
                    <button aria-pressed={config.landing === key} onClick={() => pick(n)}>
                      <span className={s.num}>{n === 9 ? 0 : n + 1}</span>
                      {label}
                    </button>
                  </li>
                ))}
              </ol>
              <Rows rows={HERO_ROWS} />
              <Fold title="Logo in the top bar">
                <Rows rows={DESIGN_ROWS.filter((r) => r.key === "logo")} />
              </Fold>
            </>
          ) : (
            <>
              <Rows rows={STATE_ROWS.filter((r) => EVERYDAY.includes(r.key))} />
              <Fold title={`Options being judged (${DESIGN_ROWS.length})`}>
                <Rows rows={DESIGN_ROWS} />
              </Fold>
              <Fold title="Example data: GPU, day, data states">
                <Rows rows={STATE_ROWS.filter((r) => r.key === "gpu")} />
                <Rows rows={STATE_ROWS.filter((r) => r.key === "when" || r.key === "data")} idleLive />
              </Fold>
              <Fold title="Example wallet and AI outcomes">
                <Rows rows={WALLET_ROWS} idleLive />
                <div className={s.row}>
                  <span>Wallet</span>
                  <div className={s.opts}>
                    <span className={s.stat}>
                      {account.ready ? `${Math.round(account.balance).toLocaleString("en-US")} test dollars, ${account.positions.length} ${account.positions.length === 1 ? "position" : "positions"}` : "No wallet yet"}
                    </span>
                    <button onClick={reset}>Reset</button>
                  </div>
                </div>
              </Fold>
              {config.source === "live" && <LiveRow />}
            </>
          )}
        </div>
      )}
      <div className={s.pillRow}>
        {onLanding && (
          <button className={s.arrow} onClick={() => pick(li - 1)} aria-label="Previous hero style">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
              <path d="M10 3.5L5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <button className={s.pill} onClick={() => setConfig({ dock: open ? "closed" : "open" })} aria-expanded={open}>
          {onLanding ? (
            <>
              <span className={s.pillNum}>
                {li + 1} of {LANDINGS.length}
              </span>
              {LANDINGS[li][1]}
            </>
          ) : open ? (
            "Close"
          ) : (
            "Mock controls"
          )}
        </button>
        {onLanding && (
          <button className={s.arrow} onClick={() => pick(li + 1)} aria-label="Next hero style">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
              <path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

/** The everyday states, shown first on the app's pages; the rest fold away. */
const EVERYDAY: (keyof MockConfig)[] = ["mode", "theme", "auth", "source"];

function Rows({ rows, idleLive = false }: { rows: Row[]; idleLive?: boolean }) {
  const { config, setConfig } = useMock();
  // the example's states do nothing to live data: those rows stand down while the source is live
  const idle = idleLive && config.source === "live";
  return (
    <>
      {rows.map((r) => (
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
      ))}
    </>
  );
}

function Fold({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className={s.fold}>
      <summary>{title}</summary>
      <div className={s.foldBody}>{children}</div>
    </details>
  );
}
