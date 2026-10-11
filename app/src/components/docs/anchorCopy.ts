// A heading's # in the docs is the section's own link: a click copies that link to share and puts it in the address
// bar, and the page stays where it is. "Link copied" shows by the # for a moment (under it when the column has no
// room beside it) and is read out by a polite live region (a useSay announcer, so a second copy is read out too). A
// click with a modifier (a new tab, a new window) is left to the browser.
import { copyText } from "@/lib/ui/clipboard";

const SHOWN_MS = 1600;
/** what "Link copied" takes beside the #, gap included */
const NOTE_PX = 130;
/** each # whose note is showing, and the timer that hides it */
const shown = new WeakMap<HTMLElement, number>();

/** A plain left click: one with a modifier (a new tab, a new window) or already handled is left to the browser. */
export const isPlainClick = (e: React.MouseEvent) => !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/** Copies the section's link; true when it handled the click (it was a heading's #). */
export function onHeadingLink(e: React.MouseEvent, announce: (text: string) => void): boolean {
  if (!isPlainClick(e)) return false;
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a.anchor");
  const id = a?.getAttribute("href")?.replace(/^#/, "");
  if (!a || !id || !document.getElementById(id)) return false;
  e.preventDefault();
  // the link someone else can open: the page and the section, without this tab's own states
  const link = `${window.location.origin}${window.location.pathname}#${id}`;
  // the address bar shows the section too, keeping the tab's states
  history.replaceState(history.state, "", `${window.location.pathname}${window.location.search}#${id}`);
  void copyText(link).then((ok) => {
    if (!ok) return announce("Could not copy the link");
    // the note shows from the latest click, beside the # or, when the heading's line ends near the column's edge, under it
    const room = (a.closest("h2, h3") ?? a).getBoundingClientRect().right - a.getBoundingClientRect().right;
    window.clearTimeout(shown.get(a));
    a.setAttribute("data-copied", room < NOTE_PX ? "under" : "");
    shown.set(
      a,
      window.setTimeout(() => {
        a.removeAttribute("data-copied");
        shown.delete(a);
      }, SHOWN_MS),
    );
    announce("Link to this section copied");
  });
  return true;
}
