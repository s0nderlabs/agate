"use client";
// Small browser helpers for the phone and tablet layout. Media queries read through useSyncExternalStore with a
// server snapshot of false, so the first client render matches the server (no hydration mismatch).
import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from "react";

/** True while the media query matches; false on the server and during hydration. */
export function useMedia(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Below the desktop layout, or a screen without hover: notes and sources open as sheets. Call it in handlers only. */
export function tapMode() {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 1099.98px), (hover: none)").matches;
}

/** Not a touch screen: the one case where a field may take focus on its own without raising a keyboard. Asked as
 * "not coarse" rather than "fine", because some desktop browsers report a trackpad as pointer: none. */
export function finePointer() {
  return typeof window !== "undefined" && !window.matchMedia("(pointer: coarse)").matches;
}

export function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The browser chrome (address bar, status bar) follows the app's own theme, not the system's. */
export function useThemeColor(theme: "light" | "dark") {
  useEffect(() => {
    const color = theme === "dark" ? "#141413" : "#f6f5f1";
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = color;
  }, [theme]);
}

/** While active, --kb on the root holds how much of the layout viewport the on-screen keyboard covers, so a
 * bottom sheet can sit on top of the keyboard instead of under it. */
export function useKeyboardInset(active: boolean) {
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    if (!active || !vv) return;
    const set = () => root.style.setProperty("--kb", `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
    set();
    vv.addEventListener("resize", set);
    vv.addEventListener("scroll", set);
    return () => {
      vv.removeEventListener("resize", set);
      vv.removeEventListener("scroll", set);
      root.style.removeProperty("--kb");
    };
  }, [active]);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A modal's focus: on open, remember who opened it and move focus in; Tab and Shift+Tab stay inside; on close,
 * focus goes back to the opener if it is still on the page (unless focus already moved into another dialog). A
 * dialog layered above (a Flow sheet over the phone ticket) owns Tab while it is open. */
export function useModalFocus(ref: RefObject<HTMLElement | null>, active: boolean) {
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    if (!active) return;
    const box0 = ref.current;
    opener.current = document.activeElement;
    if (box0 && !box0.contains(document.activeElement)) box0.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      const box = ref.current;
      if (e.key !== "Tab" || !box) return;
      // a Flow sheet open over this dialog traps Tab itself: this one stands aside
      const top = document.querySelector('.ag-backdrop [aria-modal="true"]');
      if (top && top !== box && !box.contains(top)) return;
      const at = document.activeElement;
      // focus inside another dialog (the Mock controls, say): not ours to trap
      if (at && !box.contains(at) && at.closest('[role="dialog"]')) return;
      const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden");
      if (!items.length) {
        e.preventDefault();
        box.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!at || !box.contains(at)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (at === first || at === box)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const back = opener.current;
      opener.current = null;
      // closed under a Flow sheet (placing an order): focus already lives in that sheet, so it stays there
      const at = document.activeElement;
      const ours = !at || at === document.body || (!!box0 && box0.contains(at));
      if (ours && back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    };
  }, [active, ref]);
}
