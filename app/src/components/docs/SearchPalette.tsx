"use client";
// The docs search: a modal dialog opened with Cmd/Ctrl+K anywhere, "/" when no field is being typed in, or a search
// button (the left column, the phone's Contents sheet, the docs home). The full index (/docs/search.json, written at
// build) is fetched the first time it is wanted; until it lands, chapter titles, descriptions and headings are
// searched from the sidebar's own data. The field is a combobox over a listbox: arrow keys move the selection, Enter
// opens it, Esc or a click outside closes, and focus goes back to what opened it. An empty query lists the chapters.
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { navIndex, prepareIndex, searchIndex, type Part, type PreparedIndex, type SearchEntry } from "@/lib/docs/search";
import type { NavGroup } from "@/lib/docs/types";
import { useLinkQuery } from "@/lib/mock/store";
import { docHref } from "./ChapterList";
import x from "./searchPalette.module.css";

const OPEN_EVENT = "agate:docs-search";

let ready: PreparedIndex | null = null;
let loading: Promise<PreparedIndex | null> | null = null;
/** The full index, fetched once per visit; a failed fetch is tried again on the next open. */
function loadIndex() {
  loading ??= fetch("/docs/search.json")
    .then((r) => (r.ok ? (r.json() as Promise<SearchEntry[]>) : Promise.reject(new Error(`search index: ${r.status}`))))
    .then((entries) => (ready = prepareIndex(entries)))
    .catch(() => {
      loading = null;
      return null;
    });
  return loading;
}

/** Starts fetching the index before the dialog opens (a pointer over, or focus on, a search button). */
export function warmSearch() {
  void loadIndex();
}

/** Opens the search; when it closes, focus goes to `returnTo` (else back where it was). */
export function openSearch(returnTo?: HTMLElement | null) {
  window.dispatchEvent(new CustomEvent<HTMLElement | null>(OPEN_EVENT, { detail: returnTo ?? null }));
}

function Lens() {
  return (
    <svg className={x.lens} viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12.5 12.5L17 17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    </svg>
  );
}

/** A button drawn as the search field. `beforeOpen` runs first (the phone sheet closes itself); `returnTo` names
 *  where focus goes after the search closes, when not this button. */
export function SearchButton({ beforeOpen, returnTo }: { beforeOpen?: () => void; returnTo?: () => HTMLElement | null }) {
  return (
    <button
      type="button"
      className={x.trigger}
      aria-haspopup="dialog"
      aria-keyshortcuts="/ Meta+K Control+K"
      onPointerEnter={warmSearch}
      onFocus={warmSearch}
      onClick={(e) => {
        const self = e.currentTarget;
        beforeOpen?.();
        openSearch(returnTo?.() ?? self);
      }}
    >
      <Lens />
      <span className={x.label}>Search the docs</span>
      <kbd className={x.key} aria-hidden="true">
        /
      </kbd>
    </button>
  );
}

/** Text that takes keys: "/" typed there is a character, not the shortcut. */
function typing(t: EventTarget | null) {
  return t instanceof HTMLElement && (t.isContentEditable || t.closest("input, textarea, select") !== null);
}

function Marked({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.mark ? (
          <mark key={i} className={x.mark}>
            {p.text}
          </mark>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

interface Row {
  key: string;
  href: string;
  /** the chapter a section belongs to (none on a chapter's own row) */
  chapter: string | null;
  name: Part[];
  snippet: Part[];
}

export function SearchPalette({ nav }: { nav: NavGroup[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const linkQuery = useLinkQuery();
  const uid = useId();
  const listId = `${uid}-list`;
  const optId = (i: number) => `${uid}-o${i}`;
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listBox = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const pressedOutside = useRef(false);
  const reveal = useRef(false);
  const pointer = useRef("");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [index, setIndex] = useState<PreparedIndex | null>(ready);
  const [failed, setFailed] = useState(false);
  const fallback = useMemo(() => prepareIndex(navIndex(nav)), [nav]);

  const show = useCallback((to: HTMLElement | null) => {
    const d = dialog.current;
    if (!d) return;
    if (d.open) {
      input.current?.focus();
      input.current?.select();
      return;
    }
    returnTo.current = to;
    setSel(0);
    setOpen(true);
  }, []);

  // the shortcuts, and the buttons' event
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || typeof e.key !== "string") return;
      const cmdK = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
      const slash = e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target);
      if (!cmdK && !slash) return;
      e.preventDefault();
      const a = document.activeElement;
      show(a instanceof HTMLElement && a !== document.body ? a : null);
    };
    const onOpen = (e: Event) => show((e as CustomEvent<HTMLElement | null>).detail);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, [show]);

  // once the body is rendered: the dialog goes modal, the field takes focus, and the index is fetched if needed
  useEffect(() => {
    if (!open) return;
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    input.current?.focus();
    input.current?.select();
    if (ready) {
      setIndex(ready);
      setFailed(false);
      return;
    }
    let live = true;
    setFailed(false);
    void loadIndex().then((p) => {
      if (!live) return;
      if (p) setIndex(p);
      else setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [open]);

  // a page change from outside the dialog (the browser's back button) closes it
  useEffect(() => {
    if (dialog.current?.open) dialog.current.close();
  }, [pathname]);

  const results = useMemo(() => (open && query.trim() ? searchIndex(index ?? fallback, query) : null), [open, index, fallback, query]);
  const rows: Row[] = useMemo(() => {
    if (results)
      return results.map((h) => ({
        key: `${h.entry.slug}#${h.entry.id ?? ""}`,
        href: docHref(h.entry.slug, h.entry.id, linkQuery),
        chapter: h.entry.heading === null ? null : h.entry.chapter,
        name: h.name,
        snippet: h.snippet,
      }));
    return nav.flatMap((g) => g.chapters.map((c) => ({ key: c.slug, href: docHref(c.slug, null, linkQuery), chapter: null, name: [{ text: c.title, mark: false }], snippet: [{ text: c.description, mark: false }] })));
  }, [results, nav, linkQuery]);
  const cur = Math.min(sel, Math.max(0, rows.length - 1));
  const selHref = open ? rows[cur]?.href : undefined;

  // the selection moved by keys stays in view
  useEffect(() => {
    if (!reveal.current) return;
    reveal.current = false;
    document.getElementById(`${uid}-o${cur}`)?.scrollIntoView({ block: "nearest" });
  }, [cur, uid]);

  // the selected page is fetched ahead, so Enter lands without a wait
  useEffect(() => {
    if (selHref) router.prefetch(selHref.split("#")[0]);
  }, [selHref, router]);

  const close = () => dialog.current?.close();
  const onClose = () => {
    setOpen(false);
    const to = returnTo.current;
    returnTo.current = null;
    if (to?.isConnected) to.focus({ preventScroll: true });
  };
  const go = (href: string, newTab = false) => {
    if (newTab) {
      window.open(href, "_blank", "noopener");
      return;
    }
    close();
    router.push(href);
  };
  const onLink = (e: React.MouseEvent<HTMLAnchorElement>) => {
    // a modified click opens a tab as any link does; a plain one navigates in place and closes the search
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(e.currentTarget.getAttribute("href") ?? "/docs");
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = rows.length ? (cur + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length : cur;
      if (next === cur) return;
      reveal.current = true;
      setSel(next);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[cur];
      if (row) go(row.href, e.metaKey || e.ctrlKey);
    }
  };

  const option = (r: Row, i: number) => (
    <a
      key={r.key}
      id={optId(i)}
      role="option"
      aria-selected={i === cur}
      tabIndex={-1}
      href={r.href}
      className={x.option}
      onClick={onLink}
      onMouseMove={(e) => {
        // only a real move of the mouse selects: a browser also sends one when the list scrolls under a still mouse
        // (after the arrow keys bring a row into view), which must not take the selection back
        const at = `${e.clientX},${e.clientY}`;
        if (at === pointer.current) return;
        pointer.current = at;
        if (i !== cur) setSel(i);
      }}
    >
      <span className={x.name}>
        {r.chapter && (
          <>
            <span className={x.chapter}>{r.chapter}</span>
            <span className={x.sep} aria-hidden="true">
              ›
            </span>
            <span className="sr-only">, </span>
          </>
        )}
        <Marked parts={r.name} />
      </span>
      {r.snippet.length > 0 && (
        <span className={x.snippet}>
          <Marked parts={r.snippet} />
        </span>
      )}
    </a>
  );

  let n = 0;
  const status = !results ? "" : rows.length ? `${rows.length} ${rows.length === 1 ? "result" : "results"}` : "No results";

  return (
    <dialog
      ref={dialog}
      className={x.dialog}
      aria-label="Search the docs"
      onClose={onClose}
      onPointerDown={(e) => {
        pressedOutside.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // the backdrop: a press and release on the dialog itself, outside its content (a text selection dragged out
        // of the field does not count)
        if (e.target === e.currentTarget && pressedOutside.current) close();
      }}
    >
      {open && (
        <div className={x.box}>
          <div className={x.field}>
            <Lens />
            <input
              ref={input}
              className={x.input}
              type="text"
              inputMode="search"
              enterKeyHint="go"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={rows.length ? optId(cur) : undefined}
              aria-label="Search the docs"
              placeholder="Search the docs"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSel(0);
                if (listBox.current) listBox.current.scrollTop = 0;
              }}
              onKeyDown={onKeyDown}
            />
            <button type="button" className={x.close} aria-label="Close search (Esc)" onClick={close}>
              <span className={x.closeKey}>Esc</span>
              <span className={x.closeWord}>Close</span>
            </button>
          </div>
          <div ref={listBox} className={x.list}>
            {rows.length > 0 ? (
              <div role="listbox" id={listId} aria-label={results ? "Results" : "Chapters"}>
                {results
                  ? rows.map((r, i) => option(r, i))
                  : nav.map((g) => {
                      const gid = `${uid}-${g.group.toLowerCase().replace(/\s+/g, "-")}`;
                      return (
                        <div key={g.group} role="group" aria-labelledby={gid} className={x.group}>
                          <div id={gid} className={x.groupName} aria-hidden="true">
                            {g.group}
                          </div>
                          {g.chapters.map(() => {
                            const i = n++;
                            return option(rows[i], i);
                          })}
                        </div>
                      );
                    })}
              </div>
            ) : (
              <div className={x.none} id={listId}>
                <p>Nothing in the docs matches &ldquo;{query.trim()}&rdquo;.</p>
                <p>
                  Try a GPU, a contract or a tool name, or start from{" "}
                  <a href={`/docs${linkQuery}`} onClick={onLink}>
                    the docs home
                  </a>{" "}
                  or the{" "}
                  <a href={docHref("quickstart", null, linkQuery)} onClick={onLink}>
                    Quickstart
                  </a>
                  .
                </p>
              </div>
            )}
            {failed && results && <p className={x.note}>Only titles and headings were searched: the full index did not load. It is tried again the next time the search opens.</p>}
          </div>
          <p className="sr-only" role="status">
            {status}
          </p>
        </div>
      )}
    </dialog>
  );
}
