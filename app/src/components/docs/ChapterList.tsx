"use client";
// The chapter list: the left column and the phone's Contents sheet. The groups in reading order, each chapter a link,
// the current one marked with its sections under it. Searching happens in the search dialog (SearchPalette).
import Link from "next/link";
import { useId } from "react";
import type { NavGroup } from "@/lib/docs/types";
import { useLinkQuery } from "@/lib/mock/store";
import s from "./docs.module.css";

/** A chapter's address (a section's when `id` is given), keeping the link's mock states. */
export function docHref(slug: string, id: string | null | undefined, linkQuery: string) {
  return `/docs/${slug}${linkQuery}${id ? `#${id}` : ""}`;
}

/** The groups and chapters, the current one marked and its sections under it. */
export function ChapterList({ nav, current, onGo }: { nav: NavGroup[]; current: string | null; onGo?: () => void }) {
  const linkQuery = useLinkQuery();
  // the left column and the phone sheet both hold a list: each labels its groups with its own ids
  const uid = useId();
  return (
    <nav className={s.chapters} aria-label="Chapters">
      {nav.map((g) => {
        const gid = `${uid}-${g.group.toLowerCase().replace(/\s+/g, "-")}`;
        return (
          <div key={g.group} className={s.group}>
            <p className={s.groupName} id={gid}>
              {g.group}
            </p>
            <ul aria-labelledby={gid}>
              {g.chapters.map((c) => (
                <li key={c.slug}>
                  <Link className={s.chapter} href={docHref(c.slug, null, linkQuery)} onClick={onGo} aria-current={c.slug === current ? "page" : undefined}>
                    {c.title}
                  </Link>
                  {c.slug === current && c.sections.length > 0 && (
                    // the page's sections, where there is no "On this page" column (below 1100 px)
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
        );
      })}
    </nav>
  );
}
