"use client";
// The docs' code blocks come as HTML written at build, so their Copy buttons are wired here, once per page, by one
// listener on the document. Copy writes the block's text (a shell transcript's data-copy holds only its commands),
// shows "Copied" with a check for a moment and says so through the chapter's live region (the `say` it is given).
import { useEffect, useRef } from "react";
import { copyText } from "@/lib/ui/clipboard";

const SHOWN_MS = 1400;

/** What a Copy button copies: its data-copy when the build wrote one, else the code in its figure as shown. */
function textFor(button: HTMLElement): string {
  const own = button.getAttribute("data-copy");
  if (own) return own;
  return button.closest("figure")?.querySelector("pre code")?.textContent ?? "";
}

export function CodeCopy({ say }: { say: (text: string) => void }) {
  const timers = useRef(new Map<HTMLElement, number>());

  useEffect(() => {
    const pending = timers.current;
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

    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      pending.forEach((t, b) => {
        window.clearTimeout(t);
        delete b.dataset.state;
      });
      pending.clear();
    };
  }, [say]);

  return null;
}
