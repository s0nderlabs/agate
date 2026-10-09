"use client";
// The docs' frame, kept across chapters (the /docs layout): the app's top bar, then on a chapter the groups and
// chapters on the left with the search, and the page. Below 760 px the left column leaves for a Contents button that
// opens the same list as a sheet. The pages are static, so the saved theme and a link's mock states are applied here
// in the browser: an inline script paints the saved theme before the first frame, then the store takes it over.
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useScreenTheme } from "@/components/ai/AisScreen";
import { BottomDock } from "@/components/shell/Dock";
import { NavBar } from "@/components/shell/Shell";
import type { NavGroup } from "@/lib/docs/types";
import { parseConfig, THEME_COOKIE, type MockConfig } from "@/lib/mock/config";
import { useLinkQuery, useMock } from "@/lib/mock/store";
import { ChapterList, docHref, SearchField, useDocSearch } from "./ChapterList";
import s from "./docs.module.css";

const NavCtx = createContext<NavGroup[]>([]);
export function useDocsNav() {
  return useContext(NavCtx);
}

// Runs while the HTML is parsed, before the first paint: the saved theme (or the link's) on the frame and the page
// ground. React then hydrates over it (suppressHydrationWarning on the frame) and the store catches up below.
const PREPAINT = `(function(){try{var e=document.currentScript&&document.currentScript.parentElement;if(!e)return;var q=new URLSearchParams(location.search).get("theme");var m=document.cookie.match(/(?:^|;\\s*)${THEME_COOKIE}=(light|dark)/);var t=q==="light"||q==="dark"?q:m?m[1]:null;if(t==="dark"){e.classList.remove("tone-light");e.classList.add("tone-dark");document.documentElement.style.background="#141413";}}catch(_){}})();`;

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

function readThemeCookie() {
  try {
    const m = new RegExp(`(?:^|;\\s*)${THEME_COOKIE}=(light|dark)`).exec(document.cookie);
    return m ? (m[1] as "light" | "dark") : null;
  } catch {
    return null;
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
  const router = useRouter();
  const linkQuery = useLinkQuery();
  const [query, setQuery] = useState("");
  const hits = useDocSearch(query, nav);
  const sheet = useRef<HTMLDialogElement>(null);
  const side = useRef<HTMLElement>(null);

  // the theme picked before (the cookie the store writes) and the link's mock states, as the server pages read them
  useLayoutEffect(() => {
    const q: Record<string, string> = {};
    new URLSearchParams(window.location.search).forEach((v, k) => (q[k] = v));
    if (q.theme === undefined) {
      const saved = readThemeCookie();
      if (saved) q.theme = saved;
    }
    const want = parseConfig(q);
    const patch: Partial<MockConfig> = {};
    (Object.keys(want) as (keyof MockConfig)[]).forEach((k) => {
      if (want[k] !== config[k]) Object.assign(patch, { [k]: want[k] });
    });
    // applied, never saved: a link's theme is the sender's, and only the reader's own pick is kept (as on app pages)
    if (Object.keys(patch).length) setConfig(patch, false);
    // once, on arrival: later changes come from the controls themselves
  }, []);

  // "/" goes to the search: the one on screen, or (on a phone) the Contents sheet's
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable='true']")) return;
      const field = Array.from(document.querySelectorAll<HTMLInputElement>("input[data-docs-search]")).find((el) => el.offsetParent !== null);
      e.preventDefault();
      if (field) {
        field.focus();
        field.select();
      } else if (sheet.current && !sheet.current.open) {
        sheet.current.showModal();
        sheet.current.querySelector<HTMLInputElement>("input[data-docs-search]")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
  const goFirst = () => {
    const h = hits?.[0];
    if (h) router.push(docHref(h.slug, h.hint?.id, linkQuery));
  };
  const closeSheet = () => sheet.current?.close();

  return (
    <NavCtx.Provider value={nav}>
      <div className={`${s.screen} ${tone}`} data-phone={config.phone} suppressHydrationWarning>
        {serverHtml && <script dangerouslySetInnerHTML={{ __html: PREPAINT }} />}
        <NavBar active="docs" />
        {slug ? (
          <div className={s.frame}>
            <aside className={s.side} ref={side} aria-label="Docs">
              <SearchField value={query} onChange={setQuery} onEnter={goFirst} />
              <ChapterList nav={nav} current={slug} query={query} hits={hits} />
            </aside>
            {/* phones: the list behind one button, under the top bar */}
            <div className={s.bar}>
              <button type="button" className={s.barBtn} aria-haspopup="dialog" onClick={() => sheet.current?.showModal()}>
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
                  <SearchField value={query} onChange={setQuery} onEnter={goFirst} />
                </div>
                <div className={s.sheetBody}>
                  <ChapterList nav={nav} current={slug} query={query} hits={hits} onGo={closeSheet} />
                </div>
              </div>
            </dialog>
            <div className={s.page}>{children}</div>
          </div>
        ) : (
          children
        )}
        {config.phone === "new" && <BottomDock active={null} />}
      </div>
    </NavCtx.Provider>
  );
}
