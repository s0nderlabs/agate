"use client";
// /docs: the contents, from each chapter's frontmatter. The search button, the four ways in, then the five groups in
// reading order, each chapter as its name and its one-line description. The button opens the search dialog
// (SearchPalette), which searches every section.
import Link from "next/link";
import { HOW_SLUG } from "@/lib/docs/explainer";
import { useLinkQuery, useMock } from "@/lib/mock/store";
import { docHref } from "./ChapterList";
import { useDocsNav } from "./DocsFrame";
import { SearchButton } from "./SearchPalette";
import s from "./docs.module.css";

/** The four ways in, each the chapter that starts it (the lead names them: the app, an AI, the API, the SDK). */
const WAYS = [
  { slug: "quickstart", title: "Trade in the app", line: "Sign in with email, Google or a passkey, then go Long or Short. Three minutes, no wallet.", go: "Quickstart" },
  { slug: "connect-an-ai", title: "Let your AI trade", line: "Add Agate to any AI app that takes an MCP server. It trades from a budget you set.", go: "Connect an AI" },
  { slug: "api", title: "Read the price", line: "One request, no key: today's price of every GPU and each cloud's own price behind it.", go: "Developer API" },
  { slug: "sdk", title: "Build on it", line: "The TypeScript library the app runs on, and the price as a feed onchain.", go: "SDK" },
] as const;

const groupId = (g: string) => `group-${g.toLowerCase().replace(/\s+/g, "-")}`;

export function DocsIndex() {
  const { config } = useMock();
  const nav = useDocsNav();
  const linkQuery = useLinkQuery();

  return (
    <main className={s.home}>
      <header className={s.homeHead}>
        <h1 className={s.homeTitle}>Agate docs</h1>
        <p className={s.lead}>How the price of a GPU-hour is made, how its monthly market works, and every way in: the app, an AI, the API, the SDK and the contracts.</p>
        <p className={s.homeStart}>
          New to Agate? <Link href={docHref(HOW_SLUG, null, linkQuery)}>Start with How Agate works</Link>, six short steps with pictures.
        </p>
      </header>
      <div className={s.homeSearch}>
        <SearchButton />
      </div>
      {config.docsHome === "ways" && (
        <nav className={s.ways} aria-label="Ways in">
          {WAYS.map((w) => (
            <Link key={w.slug} className={s.way} href={docHref(w.slug, null, linkQuery)}>
              <b>{w.title}</b>
              <span>{w.line}</span>
              <i>{w.go}</i>
            </Link>
          ))}
        </nav>
      )}
      {nav.map((g) => (
        <section key={g.group} className={s.homeGroup} aria-labelledby={groupId(g.group)}>
          <h2 className={s.homeGroupName} id={groupId(g.group)}>
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
      ))}
      <p className={s.agents}>
        For AI agents: <a href="/llms.txt">llms.txt</a> lists every chapter after How Agate works (its pictures have no markdown), <a href="/llms-full.txt">llms-full.txt</a> holds them all as markdown, and each has a View as Markdown link.
      </p>
    </main>
  );
}
