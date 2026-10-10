// Writing text to the clipboard: the async clipboard where the browser allows it, else a hidden field and the older
// copy command (which needs the page to be the one in front). Both report whether the text got there.

/** The older way: a hidden, read-only field selected and copied, then removed; focus goes back where it was. */
export function copyFallback(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;";
  const active = document.activeElement as HTMLElement | null;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  active?.focus({ preventScroll: true });
  return ok;
}

/** `text` on the clipboard, by the async clipboard or else the older way. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // denied or unavailable: the older way below
  }
  return copyFallback(text);
}
