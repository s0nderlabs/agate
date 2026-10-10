"use client";
// The site's 404, for any address nothing answers, an unknown chapter under /docs included (the chapters are all
// written at build and any other slug is refused before the docs layout). It is part of every page's payload (the
// root's not-found boundary), so it stays light on purpose: no providers, no docs frame, no docs stylesheet, only the
// lockup every page already loads, plain links and one small stylesheet that React adds to the head when the page
// shows. The reader's saved light or dark applies before the first paint (an inline script in the server HTML), then
// from the cookie on a client visit.
import Link from "next/link";
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { Lockup } from "@/components/brand/Logo";
import { groundFor, THEME_COOKIE } from "@/lib/mock/config";

const WAYS = [
  { href: "/docs", title: "The docs", line: "Every chapter, by group, with the search.", go: "Docs home" },
  { href: "/docs/quickstart", title: "Quickstart", line: "Sign in, go Long or Short, and close. Three minutes, no wallet.", go: "Start here" },
  { href: "/app", title: "The app", line: "Today's price of an hour on every GPU, and its monthly markets.", go: "Open the app" },
] as const;

// tokens only (globals.css), square corners, hairlines; the ways are the docs contents' panel grid with its corner marks
const CSS = `
.ag404{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);font-variant-numeric:lining-nums;--g:max(clamp(16px,2.4vw,32px),env(safe-area-inset-left))}
.ag404 a:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.ag404-bar{display:flex;align-items:center;justify-content:space-between;gap:24px;width:100%;max-width:1400px;margin:0 auto;min-height:var(--nav-h,68px);padding:0 var(--g)}
.ag404-home{display:inline-flex;color:var(--ink);border-radius:var(--r-1)}
.ag404-links{display:flex;gap:24px}
.ag404-links a{display:inline-flex;align-items:center;min-height:44px;font-size:16px;font-weight:500;color:var(--ink-2);text-decoration:none}
.ag404-main{flex:1;width:100%;max-width:1080px;margin:0 auto;padding:72px var(--g) 104px}
.ag404-h1{margin:0 0 14px;font-family:var(--font-display);font-weight:400;font-size:clamp(38px,4.6vw,54px);line-height:1.05;letter-spacing:-.015em;text-wrap:balance}
.ag404-lead{margin:0 0 40px;max-width:60ch;font-size:18px;line-height:1.55;color:var(--ink-2);text-wrap:pretty}
.ag404-ways{--m:var(--line-2);position:relative;list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--line);box-shadow:0 0 0 1px var(--line)}
.ag404-ways::after{content:"";position:absolute;inset:-6px;pointer-events:none;background:linear-gradient(var(--m),var(--m)) left 5px top 0/1px 11px no-repeat,linear-gradient(var(--m),var(--m)) left 0 top 5px/11px 1px no-repeat,linear-gradient(var(--m),var(--m)) right 5px top 0/1px 11px no-repeat,linear-gradient(var(--m),var(--m)) right 0 top 5px/11px 1px no-repeat,linear-gradient(var(--m),var(--m)) left 5px bottom 0/1px 11px no-repeat,linear-gradient(var(--m),var(--m)) left 0 bottom 5px/11px 1px no-repeat,linear-gradient(var(--m),var(--m)) right 5px bottom 0/1px 11px no-repeat,linear-gradient(var(--m),var(--m)) right 0 bottom 5px/11px 1px no-repeat}
.ag404-way{display:grid;grid-template-rows:auto 1fr auto;gap:10px;height:100%;min-height:200px;padding:24px 22px 22px;background:var(--bg);color:inherit;text-decoration:none;transition:background-color .2s ease}
.ag404-way b{font-size:19px;font-weight:500;line-height:1.3;color:var(--ink)}
.ag404-way span{font-size:16px;line-height:1.5;color:var(--ink-2);text-wrap:pretty}
.ag404-way i{display:inline-flex;align-items:center;gap:10px;margin-top:6px;font-style:normal;font-size:16px;font-weight:500;color:var(--ink)}
.ag404-way i svg{transition:transform .3s cubic-bezier(.2,.7,.2,1)}
.ag404-way:focus-visible{outline-offset:-2px}
@media (hover:hover) and (pointer:fine){.ag404-links a:hover{color:var(--ink)}.ag404-way:hover{background:var(--well)}.ag404-way:hover i svg{transform:translateX(3px)}}
@media (prefers-reduced-motion:reduce){.ag404-way,.ag404-way i svg{transition:none}}
@media (max-width:759.98px){.ag404-ways{grid-template-columns:minmax(0,1fr)}.ag404-way{min-height:0}.ag404-main{padding-top:40px;padding-bottom:72px}.ag404-links{gap:18px}}
`;

// runs while the server HTML is parsed: the saved dark theme on this page and the document's ground, before the first
// paint (the ground is read from the theme's own token, so no colour is written here)
const PREPAINT = `(function(){try{var e=document.currentScript&&document.currentScript.parentElement;if(!e)return;var m=document.cookie.match(/(?:^|;\\s*)${THEME_COOKIE}=(light|dark)/);if(m&&m[1]==="dark"){e.classList.remove("tone-light");e.classList.add("tone-dark");document.documentElement.style.background=getComputedStyle(e).getPropertyValue("--bg");}}catch(_){}})();`;

const noSubscribe = () => () => {};

function savedTheme() {
  try {
    const m = new RegExp(`(?:^|;\\s*)${THEME_COOKIE}=(light|dark)`).exec(document.cookie);
    return m ? (m[1] as "light" | "dark") : null;
  } catch {
    return null;
  }
}

export default function NotFound() {
  // true on the server and while hydrating, so the inline script is only ever part of the server HTML
  const serverHtml = useSyncExternalStore(
    noSubscribe,
    () => false,
    () => true,
  );
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useLayoutEffect(() => {
    if (savedTheme() === "dark") setTheme("dark");
  }, []);
  useEffect(() => {
    const html = document.documentElement;
    const before = html.style.background;
    html.style.background = groundFor({ theme });
    return () => {
      html.style.background = before;
    };
  }, [theme]);

  return (
    <div className={`ag404 tone-${theme}`} suppressHydrationWarning>
      {serverHtml && <script dangerouslySetInnerHTML={{ __html: PREPAINT }} />}
      <style href="agate-404" precedence="default">
        {CSS}
      </style>
      <header className="ag404-bar">
        <Link href="/" className="ag404-home" aria-label="Agate, home">
          <Lockup height={26} wcase="title" />
        </Link>
        <nav className="ag404-links" aria-label="Site">
          <Link href="/docs">Docs</Link>
          <Link href="/app">Open the app</Link>
        </nav>
      </header>
      <main className="ag404-main">
        <h1 className="ag404-h1">This page does not exist.</h1>
        <p className="ag404-lead">The address may be mistyped, or the page may have moved. One of these should get you where you were going.</p>
        <nav aria-label="Ways back">
          <ul className="ag404-ways">
            {WAYS.map((w) => (
              <li key={w.href}>
                <Link className="ag404-way" href={w.href}>
                  <b>{w.title}</b>
                  <span>{w.line}</span>
                  <i>
                    {w.go}
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                      <path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </i>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </main>
    </div>
  );
}
