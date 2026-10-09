"use client";
// The chapter list (the left column and the phone's Contents sheet), the search field, and the search itself. The
// index (/docs/search.json, written at build) is fetched the first time someone searches; until it lands, titles,
// descriptions and headings are searched from the list's own data.
import Link from "next/link";
import { Fragment, useEffect, useId, useMemo, useState } from "react";
import { searchDocs, terms, type Hit } from "@/lib/docs/search";
import type { NavGroup, SearchDoc } from "@/lib/docs/types";
import { useLinkQuery } from "@/lib/mock/store";
import s from "./docs.module.css";

let index: SearchDoc[] | null = null;
let loading: Promise<SearchDoc[] | null> | null = null;
/** The full index, once per visit (a failed fetch may be tried again). */
export function loadSearchIndex() {
  loading ??= fetch("/docs/search.json")
    .then((r) => (r.ok ? (r.json() as Promise<SearchDoc[]>) : null))
    .then((d) => (index = d))
    .catch(() => null)
    .then((d) => {
      if (!d) loading = null;
      return d;
    });
  return loading;
}

/** Hits for a query, or null when the field is empty. */
export function useDocSearch(query: string, nav: NavGroup[]): Hit[] | null {
  const [docs, setDocs] = useState<SearchDoc[] | null>(index);
  const active = query.trim().length > 0;
  useEffect(() => {
    if (!active || docs) return;
    let live = true;
    void loadSearchIndex().then((d) => {
      if (live && d) setDocs(d);
    });
    return () => {
      live = false;
    };
  }, [active, docs]);
  const base = useMemo<SearchDoc[]>(
    () => docs ?? nav.flatMap((g) => g.chapters.map((c) => ({ slug: c.slug, title: c.title, description: c.description, sections: c.sections.map((x) => ({ id: x.id, heading: x.text, text: "" })) }))),
    [docs, nav],
  );
  return useMemo(() => (active ? searchDocs(base, query) : null), [active, base, query]);
}

export function docHref(slug: string, id: string | null | undefined, linkQuery: string) {
  return `/docs/${slug}${linkQuery}${id ? `#${id}` : ""}`;
}

/** The words of the query, set in ink inside a hint line. */
export function Lit({ text, query }: { text: string; query: string }) {
  const words = terms(query).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.join("|")})`, "gi"));
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <mark key={i} className={s.mark}>
            {p}
          </mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

export function SearchField({ value, onChange, onEnter }: { value: string; onChange: (v: string) => void; onEnter: () => void }) {
  return (
    <div className={s.search}>
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M12.5 12.5L17 17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
      </svg>
      <input
        type="search"
        data-docs-search
        value={value}
        placeholder="Search the docs"
        aria-label="Search the docs"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="go"
        onFocus={() => void loadSearchIndex()}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
          } else if (e.key === "Escape" && value) {
            // the first Escape clears the field (and keeps a sheet open); the next one leaves
            e.preventDefault();
            onChange("");
          }
        }}
      />
      <kbd className={s.kbd} aria-hidden="true">
        /
      </kbd>
    </div>
  );
}

/** The groups and chapters (the current one marked, its sections under it), or the search's hits. */
export function ChapterList({ nav, current, query, hits, onGo }: { nav: NavGroup[]; current: string | null; query: string; hits: Hit[] | null; onGo?: () => void }) {
  const linkQuery = useLinkQuery();
  // the left column and the phone sheet both hold a list: each labels its groups with its own ids
  const uid = useId();
  if (hits) {
    const titles = new Map(nav.flatMap((g) => g.chapters).map((c) => [c.slug, c.title]));
    return (
      <div className={s.hits}>
        <p className="sr-only" role="status">
          {hits.length === 1 ? "1 page" : `${hits.length} pages`}
        </p>
        {hits.length ? (
          <ul>
            {hits.map((h) => (
              <li key={h.slug}>
                <Link className={s.hit} href={docHref(h.slug, h.hint?.id, linkQuery)} onClick={onGo} aria-current={h.slug === current && !h.hint?.id ? "page" : undefined}>
                  <b>{titles.get(h.slug)}</b>
                  {h.hint && (
                    <span>
                      <Lit text={h.hint.text} query={query} />
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className={s.none}>No pages match &ldquo;{query.trim()}&rdquo;.</p>
        )}
      </div>
    );
  }
  return (
    <nav className={s.chapters} aria-label="Chapters">
      {nav.map((g) => (
        <div key={g.group} className={s.group}>
          <p className={s.groupName} id={`${uid}-${g.group.toLowerCase().replace(/\s+/g, "-")}`}>
            {g.group}
          </p>
          <ul aria-labelledby={`${uid}-${g.group.toLowerCase().replace(/\s+/g, "-")}`}>
            {g.chapters.map((c) => (
              <li key={c.slug}>
                <Link className={s.chapter} href={docHref(c.slug, null, linkQuery)} onClick={onGo} aria-current={c.slug === current ? "page" : undefined}>
                  {c.title}
                </Link>
                {c.slug === current && c.sections.length > 0 && (
                  // the page's sections, where there is no "On this page" column (below 1200 px)
                  <ul className={s.fold}>
                    {c.sections.map((x) => (
                      <li key={x.id}>
                        <a href={`#${x.id}`} onClick={onGo}>
                          {x.text}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
