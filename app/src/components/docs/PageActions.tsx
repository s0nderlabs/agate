"use client";
// The chapter's actions beside its headline: "Copy page" puts the chapter's markdown on the clipboard, and the menu next
// to it opens that markdown or hands the page to an AI chat app in a new tab. The markdown (/docs/raw/<slug>.md, a
// static file) is fetched only when wanted: on hover or focus of the button, so a click usually has the text ready and
// the clipboard write happens inside the click itself (some browsers refuse a write that waits on the network).
import { useEffect, useId, useRef, useState } from "react";
import { SITE } from "@/lib/docs/types";
import { copyFallback } from "@/lib/ui/clipboard";
import s from "./docs.module.css";

const loading = new Map<string, Promise<string>>();
const loaded = new Map<string, string>();

/** The chapter's markdown, fetched once per visit (a failed fetch may be tried again). */
function markdownOf(slug: string) {
  let p = loading.get(slug);
  if (!p) {
    p = fetch(`/docs/raw/${slug}.md`).then((r) => {
      if (!r.ok) throw new Error(`markdown ${r.status}`);
      return r.text();
    });
    p.then(
      (t) => loaded.set(slug, t),
      () => loading.delete(slug),
    );
    loading.set(slug, p);
  }
  return p;
}

async function copyMarkdown(slug: string) {
  const ready = loaded.get(slug);
  try {
    if (ready !== undefined) {
      await navigator.clipboard.writeText(ready);
    } else if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      // the item takes the text as a promise, so the write is started inside the click and finishes when it lands
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": markdownOf(slug).then((t) => new Blob([t], { type: "text/plain" })) })]);
    } else {
      await navigator.clipboard.writeText(await markdownOf(slug));
    }
    return true;
  } catch {
    try {
      return copyFallback(await markdownOf(slug));
    } catch {
      return false;
    }
  }
}

/** Where each AI chat app takes a first message from its address. */
function askLinks(slug: string) {
  const prompt = `Read ${SITE}/docs/raw/${slug}.md (a page of the Agate docs) and help me with it.`;
  const q = encodeURIComponent(prompt);
  return [
    { name: "Open in Claude", href: `https://claude.ai/new?q=${q}` },
    { name: "Open in ChatGPT", href: `https://chatgpt.com/?q=${q}` },
  ];
}

const Icon = {
  copy: (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M5.5 5.5V2.75h7.75v7.75H10.5M2.75 5.5h7.75v7.75H2.75z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="miter" />
    </svg>
  ),
  done: (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    </svg>
  ),
  more: (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M4 6.25l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    </svg>
  ),
  doc: (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M3.25 1.75h6l3.5 3.5v9H3.25zM9 1.75V5.5h3.75M5.5 8.5h5M5.5 11h5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),
  out: (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M6 3.25H2.75v10h10V10M8.75 2.75h4.5v4.5M13.25 2.75L7 9" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),
};

export function PageActions({ slug }: { slug: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // the copied (or failed) note stays a moment, then the button reads "Copy page" again
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 1800);
    return () => clearTimeout(t);
  }, [state]);

  // the menu closes on a press anywhere outside it, and on Escape (the focus goes back to its button)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const items = () => Array.from(menu.current?.querySelectorAll<HTMLAnchorElement>("a") ?? []);
  const focusItem = (i: number) => {
    const list = items();
    if (list.length) list[(i + list.length) % list.length].focus();
  };

  const onCopy = async () => {
    const ok = await copyMarkdown(slug);
    setState(ok ? "copied" : "failed");
  };

  return (
    <div
      className={s.actions}
      ref={wrap}
      onBlur={(e) => {
        // the focus left the buttons and the menu (Tab past the last item): the menu closes
        if (open && !wrap.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <div className={s.actionsBar}>
        <button type="button" className={s.copy} onClick={onCopy} onPointerEnter={() => void markdownOf(slug).catch(() => {})} onFocus={() => void markdownOf(slug).catch(() => {})} data-state={state}>
          <span className={s.copyIcon}>{state === "copied" ? Icon.done : Icon.copy}</span>
          {/* both labels hold the same cell, so the button keeps its width when it says "Copied" */}
          <span className={s.copyLabel}>
            <span aria-hidden={state !== "idle"}>Copy page</span>
            <span aria-hidden={state !== "copied"}>Copied</span>
            <span aria-hidden={state !== "failed"}>Not copied</span>
          </span>
        </button>
        <button
          type="button"
          ref={toggle}
          className={s.more}
          aria-label="More ways to read this page"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const last = e.key === "ArrowUp";
              setOpen(true);
              requestAnimationFrame(() => focusItem(last ? -1 : 0));
            }
          }}
        >
          {Icon.more}
        </button>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {state === "copied" ? "The page is copied as Markdown." : state === "failed" ? "The page could not be copied." : ""}
      </span>
      <div
        id={menuId}
        ref={menu}
        className={s.menu}
        hidden={!open}
        onKeyDown={(e) => {
          const list = items();
          const at = list.indexOf(document.activeElement as HTMLAnchorElement);
          if (e.key === "ArrowDown") focusItem(at + 1);
          else if (e.key === "ArrowUp") focusItem(at - 1);
          else if (e.key === "Home") focusItem(0);
          else if (e.key === "End") focusItem(-1);
          else return;
          e.preventDefault();
        }}
      >
        <ul>
          <li>
            <a href={`/docs/raw/${slug}.md`} target="_blank" rel="noopener" onClick={() => setOpen(false)}>
              <span className={s.menuIcon}>{Icon.doc}</span>
              <b>View as Markdown</b>
              <span>This page as plain text</span>
              <i className="sr-only">(opens in a new tab)</i>
            </a>
          </li>
          {askLinks(slug).map((l) => (
            <li key={l.name}>
              <a href={l.href} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}>
                <span className={s.menuIcon}>{Icon.out}</span>
                <b>{l.name}</b>
                <span>Ask questions about this page</span>
                <i className="sr-only">(opens in a new tab)</i>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
