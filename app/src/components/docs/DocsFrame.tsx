"use client";
// The docs' frame, kept across chapters (the /docs layout): the site's top bar, then the groups and chapters on the
// left under the search button, and the page (the contents page or a chapter). Below 760 px the left column leaves for a Contents
// button that opens the same list as a sheet. The search itself is a dialog (SearchPalette).
// The pages are static, so the theme and a link's mock states are applied here in the browser. The theme is the
// link's, else the reader's saved pick, else the reader's system setting: an inline script paints it before the first
// frame, then the store takes it over. A theme that comes from the system is applied without being saved and keeps
// following the system until the reader picks one with the switch (that pick is saved, as on every page).
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useScreenTheme } from "@/components/ai/shared";
import { BottomDock } from "@/components/shell/Dock";
import { NavBar } from "@/components/shell/Shell";
import { SiteBar } from "@/components/site/SiteBar";
import type { NavGroup } from "@/lib/docs/types";
import { groundFor, parseConfig, THEME_COOKIE, type MockConfig } from "@/lib/mock/config";
import { useMock } from "@/lib/mock/store";
import { ChapterList } from "./ChapterList";
import { DocsFooter } from "./DocsFooter";
import { SearchButton, SearchPalette } from "./SearchPalette";
import s from "./docs.module.css";

const NavCtx = createContext<NavGroup[]>([]);
export function useDocsNav() {
  return useContext(NavCtx);
}

type Theme = MockConfig["theme"];
const isTheme = (v: unknown): v is Theme => v === "light" || v === "dark";
const DARK_QUERY = "(prefers-color-scheme: dark)";

// Runs while the HTML is parsed, before the first paint: the theme on the frame and the page ground. React then
// hydrates over it (suppressHydrationWarning on the frame) and the store catches up below.
const PREPAINT = `(function(){try{var e=document.currentScript&&document.currentScript.parentElement;if(!e)return;var q=new URLSearchParams(location.search).get("theme");if(q!=="light"&&q!=="dark")q=null;var m=document.cookie.match(/(?:^|;\\s*)${THEME_COOKIE}=(light|dark)/);var t=q||(m?m[1]:null);if(!t&&window.matchMedia&&matchMedia("${DARK_QUERY}").matches)t="dark";if(t==="dark"){e.classList.remove("tone-light");e.classList.add("tone-dark");document.documentElement.style.background="${groundFor({ theme: "dark" })}";}}catch(_){}})();`;

const noSubscribe = () => () => {};
/** True on the server and while hydrating, false for a page the browser renders on its own (a client navigation), so
 *  the inline script is only ever part of server HTML (React warns about scripts it would have to create). */
function useServerHtml() {
  return useSyncExternalStore(
    noSubscribe,
    () => false,
    () => true,
  );
}

function readThemeCookie(): Theme | null {
  try {
    const m = new RegExp(`(?:^|;\\s*)${THEME_COOKIE}=(light|dark)`).exec(document.cookie);
    return m ? (m[1] as Theme) : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  try {
    return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** The chapter a path shows, or null on the contents page. */
function slugOf(path: string | null) {
  const m = /^\/docs\/([^/?#]+)/.exec(path ?? "");
  return m ? m[1] : null;
}

export function DocsFrame({ nav, children }: { nav: NavGroup[]; children: React.ReactNode }) {
  const { config, setConfig } = useMock();
  const tone = useScreenTheme();
  const serverHtml = useServerHtml();
  const pathname = usePathname();
  const slug = slugOf(pathname);
  const sheet = useRef<HTMLDialogElement>(null);
  const contents = useRef<HTMLButtonElement>(null);
  const side = useRef<HTMLElement>(null);
  /** the theme applied from the system, while the frame follows it (null once a theme was picked or came in a link) */
  const following = useRef<Theme | null>(null);
  const lastTheme = useRef(config.theme);

  // on arrival: the link's mock states and its theme, else the saved pick, else the system's
  useLayoutEffect(() => {
    const q: Record<string, string> = {};
    new URLSearchParams(window.location.search).forEach((v, k) => (q[k] = v));
    const saved = readThemeCookie();
    let system: Theme | null = null;
    if (!isTheme(q.theme)) {
      if (saved) q.theme = saved;
      else q.theme = system = systemTheme();
    }
    following.current = system;
    const want = parseConfig(q);
    const patch: Partial<MockConfig> = {};
    (Object.keys(want) as (keyof MockConfig)[]).forEach((k) => {
      if (want[k] !== config[k]) Object.assign(patch, { [k]: want[k] });
    });
    // applied, never saved: a link's theme is the sender's and the system's is the device's (kept out of the address
    // and of links too); only the reader's own pick is kept (as on app pages)
    if (Object.keys(patch).length || system) setConfig(patch, system ? "system" : false);
    // once, on arrival: later changes come from the controls themselves and the system listener below
  }, []);

  // the system setting changes (an evening schedule, or by hand in the device's settings): followed until a theme is
  // picked
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(DARK_QUERY);
    } catch {
      return;
    }
    const onChange = () => {
      if (!following.current) return;
      // picked in another tab meanwhile: that pick holds here too
      if (readThemeCookie()) {
        following.current = null;
        return;
      }
      const next: Theme = mq.matches ? "dark" : "light";
      following.current = next;
      setConfig({ theme: next }, "system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [setConfig]);

  // any other change of theme (the switch, Mock controls) is a pick: the system is no longer followed
  useEffect(() => {
    if (lastTheme.current === config.theme) return;
    lastTheme.current = config.theme;
    if (following.current && config.theme !== following.current) following.current = null;
  }, [config.theme]);

  // a new chapter: the sheet closes, and the left column brings the chapter into view if it sits out of sight
  useEffect(() => {
    sheet.current?.close();
    const box = side.current;
    const cur = box?.querySelector<HTMLElement>('a[aria-current="page"]');
    if (box && cur && (cur.offsetTop < box.scrollTop || cur.offsetTop + cur.offsetHeight > box.scrollTop + box.clientHeight)) {
      box.scrollTop = Math.max(0, cur.offsetTop - box.clientHeight / 3);
    }
  }, [pathname]);

  const current = useMemo(() => nav.flatMap((g) => g.chapters).find((c) => c.slug === slug) ?? null, [nav, slug]);
  const closeSheet = () => sheet.current?.close();

  return (
    <NavCtx.Provider value={nav}>
      <div className={`${s.screen} ${tone}`} data-phone={config.phone} suppressHydrationWarning>
        {serverHtml && <script dangerouslySetInnerHTML={{ __html: PREPAINT }} />}
        {config.siteNav === "before" ? <NavBar active="docs" site /> : <SiteBar current="docs" />}
        {/* the contents page and every chapter share one frame, so going from one to the other moves nothing but the page */}
        <div className={s.frame}>
            <aside className={s.side} ref={side} aria-label="Docs">
              <SearchButton />
              <ChapterList nav={nav} current={slug} />
            </aside>
            {/* phones: the list behind one button, under the top bar */}
            <div className={s.bar}>
              <button type="button" ref={contents} className={s.barBtn} aria-haspopup="dialog" onClick={() => sheet.current?.showModal()}>
                <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
                  <path d="M3 5.5h14M3 10h14M3 14.5h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
                </svg>
                Contents
              </button>
              {current && <span className={s.barHere}>{current.title}</span>}
            </div>
            <dialog
              ref={sheet}
              className={s.sheet}
              aria-label="Contents"
              onClick={(e) => {
                // the backdrop: a click on the dialog itself, outside its content
                if (e.target === e.currentTarget) closeSheet();
              }}
            >
              <div className={s.sheetIn}>
                <div className={s.sheetHead}>
                  <h2>Contents</h2>
                  <button type="button" className={s.close} aria-label="Close" onClick={closeSheet}>
                    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
                    </svg>
                  </button>
                </div>
                <div className={s.sheetSearch}>
                  {/* the search takes the whole screen on a phone: the sheet steps aside, and focus comes back to Contents */}
                  <SearchButton beforeOpen={closeSheet} returnTo={() => contents.current} />
                </div>
                <div className={s.sheetBody}>
                  <ChapterList nav={nav} current={slug} onGo={closeSheet} />
                </div>
              </div>
            </dialog>
            <div className={s.page}>{children}</div>
        </div>
        <DocsFooter />
        <SearchPalette nav={nav} />
        {/* the app's bottom tabs belong to the app: only under the app's bar (before) */}
        {config.phone === "new" && config.siteNav === "before" && <BottomDock active={null} />}
      </div>
    </NavCtx.Provider>
  );
}
