"use client";
// One chapter: the text (HTML written at build from the markdown; its own H1 is the headline), then the raw markdown
// link, the code it describes, and the previous and next chapters. From 1200 px "On this page" sits on the right and
// marks the section being read.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Heading } from "@/lib/docs/types";
import { useLinkQuery } from "@/lib/mock/store";
import { docHref } from "./ChapterList";
import s from "./docs.module.css";

type Near = { slug: string; title: string } | null;

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

export function DocArticle({ slug, html, toc, source, prev, next }: { slug: string; html: string; toc: Heading[]; source: string[]; prev: Near; next: Near }) {
  const router = useRouter();
  const linkQuery = useLinkQuery();
  const body = useRef<HTMLDivElement>(null);
  const active = useReading(toc.map((h) => h.id));

  // a table or code block wider than the column scrolls in its own box; when it does, it takes a tab stop and a name,
  // so a keyboard can scroll it too
  useEffect(() => {
    const root = body.current;
    if (!root) return;
    const boxes = Array.from(root.querySelectorAll<HTMLElement>("pre, .table"));
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
    <div className={s.doc}>
      <article className={s.article}>
        {/* the HTML is written at build from the repo's own markdown, with any raw HTML in it escaped */}
        <div className={s.prose} ref={body} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
        <footer className={s.foot}>
          <p className={s.meta}>
            <a href={`/docs/raw/${slug}.md`}>View as Markdown</a>
            {source.length > 0 && (
              <span>
                In the code:{" "}
                {source.map((p, i) => (
                  <span key={p}>
                    {i > 0 && ", "}
                    <code>{p}</code>
                  </span>
                ))}
              </span>
            )}
          </p>
          {(prev || next) && (
            <nav className={s.pager} aria-label="More chapters">
              {prev ? (
                <Link className={s.prev} href={docHref(prev.slug, null, linkQuery)} rel="prev">
                  <span>Previous</span>
                  <b>{prev.title}</b>
                </Link>
              ) : (
                <span />
              )}
              {next && (
                <Link className={s.next} href={docHref(next.slug, null, linkQuery)} rel="next">
                  <span>Next</span>
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
    </div>
  );
}
