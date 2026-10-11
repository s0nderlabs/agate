"use client";
// What the AI pages (and the other pages outside the four trading places) share: the page ground and the browser
// chrome following the in-app theme, the offline line, the invite a list shows with nothing in it yet, and the two
// small pictures (a gauge, a tally) the AI pages draw a pocket, its trades and its time with.
import { useEffect } from "react";
import { clamp01 } from "@/lib/account/aiView";
import { groundFor } from "@/lib/mock/config";
import { useMock } from "@/lib/mock/store";
import { useThemeColor } from "@/lib/ui/hooks";
import { AppMark, appOf } from "./apps";
import s from "./ai.module.css";

/** The page ground and the browser chrome follow the in-app theme. */
export function useScreenTheme() {
  const { config } = useMock();
  useEffect(() => {
    document.documentElement.style.background = groundFor(config);
  }, [config]);
  useThemeColor(config.theme);
  return config.theme === "dark" ? "tone-dark" : "tone-light";
}

export const OFFLINE_LINE = "Can't reach Agate's server right now. Your AIs' limits still hold on Monad.";

/** The list panel with nothing to list yet: one card that says what goes here and the way in. */
export function Invite({ title, text, children }: { title: string; text: string; children: React.ReactNode }) {
  return (
    <div className={s.invite}>
      <AppStack />
      <h2 className={`${s.inviteTitle} font-display`}>{title}</h2>
      <p className={s.lead}>{text}</p>
      <div className={s.actions}>{children}</div>
    </div>
  );
}

/** A few of the apps' marks, overlapping: the apps an AI here can be. */
function AppStack() {
  return (
    <span className={s.appStack} aria-hidden="true">
      {(["claude", "chatgpt", "cursor", "hermes"] as const).map((id) => (
        <AppMark key={id} app={appOf(id)} size={40} />
      ))}
    </span>
  );
}

/** A thin gauge: the ink part is the share `f` of the whole. Decorative: the words beside it say the same. */
export function Meter({ f }: { f: number }) {
  return (
    <span className={s.meter} aria-hidden="true">
      <i style={{ width: `${clamp01(f) * 100}%` }} />
    </span>
  );
}

/** Trades in the last 24 hours as one mark per allowed trade, the used ones in ink; a gauge past 12 marks. */
export function Tally({ used, of }: { used: number; of: number }) {
  if (of > 12 || of < 1) return <Meter f={of > 0 ? used / of : 0} />;
  return (
    <span className={s.tally} aria-hidden="true">
      {Array.from({ length: of }, (_, i) => (
        <i key={i} data-on={i < used || undefined} />
      ))}
    </span>
  );
}
