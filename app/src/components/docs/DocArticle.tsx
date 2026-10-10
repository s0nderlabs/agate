"use client";
// One chapter: its headline (the markdown's own H1) with the page actions beside it, the text (HTML written at build
// from the markdown), then the page's links (its markdown, its file on GitHub, the code it describes) and the previous
// and next chapters as two cards. From 1100 px "On this page" sits on the right and marks the section being read.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { DOCS_PATH, GITHUB, GITHUB_BRANCH, type Heading } from "@/lib/docs/types";
import { useLinkQuery } from "@/lib/mock/store";
import { docHref } from "./ChapterList";
import { CodeCopy } from "./CodeCopy";
import { PageActions } from "./PageActions";
import s from "./docs.module.css";
import p from "./prose.module.css";

type Near = { slug: string; title: string } | null;

/** The chapter's leading H1 apart from the rest, so the page actions can sit beside it (no title when it has none). */
function splitTitle(html: string): { title: string | null; body: string } {
  const m = /^\s*<h1[\s>][\s\S]*?<\/h1>/.exec(html);
  return m ? { title: m[0].trim(), body: html.slice(m[0].length) } : { title: null, body: html };
}

/** A path from the chapter's frontmatter on GitHub: a file (its name has an extension) as a blob, a folder as a tree. */
function sourceHref(path: string) {
  const clean = path
    .trim()
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");
  const last = clean.split("/").pop() ?? "";
  return `${GITHUB}/${/\.[a-z0-9]+$/i.test(last) ? "blob" : "tree"}/${GITHUB_BRANCH}/${clean}`;
}

function Arrow({ back = false }: { back?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className={s.pagerArrow}>
      <path d={back ? "M13 8H3M7 4L3 8l4 4" : "M3 8h10M9 4l4 4-4 4"} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
    </svg>
  );
}

/** The section being read: the last heading whose anchor position has scrolled past (the bottom of the page counts
 *  as the last one). Read on scroll, at most once a frame. */
function useReading(ids: string[]) {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  const key = ids.join(" ");
  useEffect(() => {
    const list = key ? key.split(" ") : [];
    if (!list.length) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      let cur = list[0];
      for (const id of list) {
        const el = document.getElementById(id);
        if (!el) continue;
        const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
        if (el.getBoundingClientRect().top - margin <= 8) cur = id;
        else break;
      }
      const doc = document.documentElement;
      if (window.scrollY > 0 && window.innerHeight + window.scrollY >= doc.scrollHeight - 2) cur = list[list.length - 1];
      setActive(cur);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [key]);
  return active;
}

export function DocArticle({ slug, file, html, toc, source, prev, next }: { slug: string; file: string; html: string; toc: Heading[]; source: string[]; prev: Near; next: Near }) {
  const router = useRouter();
  const linkQuery = useLinkQuery();
  const body = useRef<HTMLDivElement>(null);
  const active = useReading(toc.map((h) => h.id));
  const parts = useMemo(() => splitTitle(html), [html]);

  // a table or code block wider than the column scrolls in its own box; when it does, it takes a tab stop and a name,
  // so a keyboard can scroll it too
  useEffect(() => {
    const root = body.current;
    if (!root) return;
    const boxes = Array.from(root.querySelectorAll<HTMLElement>("pre, .tablebox"));
    const mark = () =>
      boxes.forEach((b) => {
        if (b.scrollWidth > b.clientWidth + 1) {
          b.tabIndex = 0;
          b.setAttribute("role", "region");
          b.setAttribute("aria-label", b.tagName === "PRE" ? "Code, scrolls sideways" : "Table, scrolls sideways");
        } else {
          b.removeAttribute("tabindex");
          b.removeAttribute("role");
          b.removeAttribute("aria-label");
        }
      });
    mark();
    const ro = new ResizeObserver(mark);
    boxes.forEach((b) => ro.observe(b));
    return () => ro.disconnect();
  }, [html]);

  // links between chapters go through the router (no reload), keeping the link's mock states like the rest of the app
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href") ?? "";
    if (!/^\/docs\/[a-z0-9-]+(#.*)?$/.test(href)) return;
    e.preventDefault();
    const [path, hash] = href.split("#");
    router.push(docHref(path.slice(6), hash, linkQuery));
  };

  return (
    <main className={s.doc}>
      <article className={s.article}>
        <header className={s.head}>
          <div className={s.headRow}>
            {/* the HTML is written at build from the repo's own markdown, with any raw HTML in it escaped */}
            {parts.title && <div className={`${s.prose} ${p.prose} ${s.title}`} dangerouslySetInnerHTML={{ __html: parts.title }} />}
            {/* a new chapter starts the actions afresh (menu closed, no "Copied" left over) */}
            <PageActions key={slug} slug={slug} />
          </div>
        </header>
        <div className={`${s.prose} ${p.prose} ${s.body}`} ref={body} onClick={onClick} dangerouslySetInnerHTML={{ __html: parts.body }} />
        <CodeCopy />
        <footer className={s.foot}>
          <div className={s.meta}>
            <ul className={s.metaLinks}>
              <li>
                <a href={`/docs/raw/${slug}.md`}>View as Markdown</a>
              </li>
              <li>
                <a href={`${GITHUB}/edit/${GITHUB_BRANCH}/${DOCS_PATH}/${file}`} target="_blank" rel="noopener noreferrer">
                  Edit this page on GitHub<span className="sr-only"> (opens in a new tab)</span>
                </a>
              </li>
            </ul>
            {source.length > 0 && (
              <p className={s.code}>
                <span className={s.codeLabel}>In the code</span>
                {source.map((path) => (
                  <a key={path} href={sourceHref(path)} target="_blank" rel="noopener noreferrer">
                    <code>{path}</code>
                    <span className="sr-only"> on GitHub (opens in a new tab)</span>
                  </a>
                ))}
              </p>
            )}
          </div>
          {(prev || next) && (
            <nav className={s.pager} aria-label="More chapters">
              {prev && (
                <Link className={s.prev} href={docHref(prev.slug, null, linkQuery)} rel="prev">
                  <span className={s.pagerWhich}>
                    <Arrow back />
                    Previous
                  </span>
                  <b>{prev.title}</b>
                </Link>
              )}
              {next && (
                <Link className={s.next} href={docHref(next.slug, null, linkQuery)} rel="next">
                  <span className={s.pagerWhich}>
                    Next
                    <Arrow />
                  </span>
                  <b>{next.title}</b>
                </Link>
              )}
            </nav>
          )}
        </footer>
      </article>
      {toc.length > 0 && (
        <nav className={s.toc} aria-labelledby="docs-toc">
          <p className={s.tocHead} id="docs-toc">
            On this page
          </p>
          <ul>
            {toc.map((h) => (
              <li key={h.id} data-depth={h.depth}>
                <a href={`#${h.id}`} aria-current={active === h.id ? "location" : undefined}>
                  {h.text}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </main>
  );
}
