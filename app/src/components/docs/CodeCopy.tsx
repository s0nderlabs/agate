"use client";
// The docs' code blocks come as HTML written at build, so their Copy buttons are wired here, once per page, by one
// listener on the document. Copy writes the block's text (a shell transcript's data-copy holds only its commands),
// shows "Copied" with a check for a moment and says so to a screen reader. The same component tints the H2 or H3 a
// page arrives at by its #link: a hash change in the page is styled by :target, but a move to another chapter goes
// through the router, which updates the address without making the heading the target, so the mark is set here.
import { useEffect, useRef, useState } from "react";
import { copyText } from "@/lib/ui/clipboard";
import p from "./prose.module.css";

const SHOWN_MS = 1400;
const ARRIVED_MS = 1700;

/** What a Copy button copies: its data-copy when the build wrote one, else the code in its figure as shown. */
function textFor(button: HTMLElement): string {
  const own = button.getAttribute("data-copy");
  if (own) return own;
  return button.closest("figure")?.querySelector("pre code")?.textContent ?? "";
}

export function CodeCopy() {
  const [said, setSaid] = useState("");
  const timers = useRef(new Map<HTMLElement, number>());
  const live = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const pending = timers.current;
    let sayFrame = 0;
    const say = (msg: string) => {
      // cleared first, so the same words twice in a row are still read out
      setSaid("");
      cancelAnimationFrame(sayFrame);
      sayFrame = requestAnimationFrame(() => setSaid(msg));
    };
    const onClick = async (e: MouseEvent) => {
      const button = e.target instanceof Element ? e.target.closest<HTMLElement>("figure.code button[data-copy]") : null;
      if (!button) return;
      const ok = await copyText(textFor(button));
      if (!ok) {
        say("Could not copy the code");
        return;
      }
      button.dataset.state = "copied";
      window.clearTimeout(pending.get(button));
      pending.set(
        button,
        window.setTimeout(() => {
          delete button.dataset.state;
          pending.delete(button);
        }, SHOWN_MS),
      );
      say("Code copied");
    };

    // the heading the address points at, marked for a moment (removed and set again, so a repeat restarts the tint)
    let arrivedTimer = 0;
    let arrived: HTMLElement | null = null;
    const mark = () => {
      let id = window.location.hash.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        // a malformed escape: look the id up as written
      }
      // looked up within this chapter: the router may keep a chapter seen before in the page, hidden, with the same ids
      const scope: ParentNode = live.current?.closest("article") ?? document;
      const el = id ? scope.querySelector<HTMLElement>(`#${CSS.escape(id)}`) : null;
      if (arrived) arrived.removeAttribute("data-arrived");
      window.clearTimeout(arrivedTimer);
      if (!el || !/^H[23]$/.test(el.tagName)) return;
      void el.offsetWidth;
      el.setAttribute("data-arrived", "");
      arrived = el;
      arrivedTimer = window.setTimeout(() => el.removeAttribute("data-arrived"), ARRIVED_MS);
    };

    document.addEventListener("click", onClick);
    window.addEventListener("hashchange", mark);
    mark();
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("hashchange", mark);
      cancelAnimationFrame(sayFrame);
      window.clearTimeout(arrivedTimer);
      arrived?.removeAttribute("data-arrived");
      pending.forEach((t, b) => {
        window.clearTimeout(t);
        delete b.dataset.state;
      });
      pending.clear();
    };
  }, []);

  return (
    <p className={p.live} ref={live} role="status" aria-live="polite">
      {said}
    </p>
  );
}
