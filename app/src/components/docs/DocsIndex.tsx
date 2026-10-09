"use client";
// /docs: the contents, from each chapter's frontmatter. The five groups in reading order, each chapter as its name and
// its one-line description; the search above filters the same list in place.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLinkQuery } from "@/lib/mock/store";
import { docHref, Lit, SearchField, useDocSearch } from "./ChapterList";
import { useDocsNav } from "./DocsFrame";
import s from "./docs.module.css";

export function DocsIndex() {
  const nav = useDocsNav();
  const router = useRouter();
  const linkQuery = useLinkQuery();
  const [query, setQuery] = useState("");
  const hits = useDocSearch(query, nav);
  const chapters = new Map(nav.flatMap((g) => g.chapters).map((c) => [c.slug, c]));

  return (
    <main className={s.home}>
      <header className={s.homeHead}>
        <h1 className={s.homeTitle}>Agate docs</h1>
        <p className={s.lead}>How the price of a GPU-hour is made, how its monthly market works, and every way in: the app, an AI, the API, the SDK and the contracts.</p>
      </header>
      <div className={s.homeSearch}>
        <SearchField
          value={query}
          onChange={setQuery}
          onEnter={() => {
            const h = hits?.[0];
            if (h) router.push(docHref(h.slug, h.hint?.id, linkQuery));
          }}
        />
      </div>
      {hits ? (
        <section className={s.homeGroup} aria-label="Search results">
          <p className="sr-only" role="status">
            {hits.length === 1 ? "1 page" : `${hits.length} pages`}
          </p>
          {hits.length ? (
            <ul className={s.entries}>
              {hits.map((h) => {
                const c = chapters.get(h.slug);
                return (
                  <li key={h.slug}>
                    <Link className={s.entry} href={docHref(h.slug, h.hint?.id, linkQuery)}>
                      <b>{c?.title}</b>
                      <span>{h.hint ? <Lit text={h.hint.text} query={query} /> : c?.description}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className={s.none}>No pages match &ldquo;{query.trim()}&rdquo;.</p>
          )}
        </section>
      ) : (
        nav.map((g) => (
          <section key={g.group} className={s.homeGroup} aria-labelledby={`group-${g.group.toLowerCase().replace(/\s+/g, "-")}`}>
            <h2 className={s.homeGroupName} id={`group-${g.group.toLowerCase().replace(/\s+/g, "-")}`}>
              {g.group}
            </h2>
            <ul className={s.entries}>
              {g.chapters.map((c) => (
                <li key={c.slug}>
                  <Link className={s.entry} href={docHref(c.slug, null, linkQuery)}>
                    <b>{c.title}</b>
                    <span>{c.description}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      <p className={s.agents}>
        For AI agents: <a href="/llms.txt">llms.txt</a> lists every page, <a href="/llms-full.txt">llms-full.txt</a> holds them all as markdown, and each page has a View as Markdown link.
      </p>
    </main>
  );
}
