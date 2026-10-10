"use client";
// The site's footer under every docs page, the 404s and the privacy page: the landing's footer (its lockup, its one
// line and its four columns of links) on the page's own tokens, so it follows the page's light or dark. App links carry
// the link's mock states like every other link on these pages.
import Link from "next/link";
import { Lockup } from "@/components/brand/Logo";
import { useLinkQuery } from "@/lib/mock/store";
import s from "./docs.module.css";

type Item = { label: string; href: string; plain?: boolean };

const COLUMNS: { name: string; items: Item[] }[] = [
  {
    name: "Market",
    items: [
      { label: "Markets", href: "/app" },
      { label: "Index", href: "/app/gpu-index" },
      { label: "Positions", href: "/app/positions" },
    ],
  },
  {
    name: "AI",
    items: [
      { label: "Connect your AI", href: "/app/connect" },
      { label: "Your AIs", href: "/app/ai" },
      { label: "Budgets and limits", href: "/docs/ai-pockets" },
    ],
  },
  {
    name: "Build",
    items: [
      { label: "Docs", href: "/docs" },
      { label: "SDK", href: "/docs/sdk" },
      { label: "API", href: "/docs/api" },
      // a text file, not a page: a plain link
      { label: "llms.txt", href: "/llms.txt", plain: true },
    ],
  },
  {
    name: "Agate",
    items: [
      { label: "How it’s priced", href: "/docs/the-price" },
      { label: "What comes next", href: "/docs/limits" },
      { label: "Privacy", href: "/privacy" },
    ],
  },
];

export function DocsFooter() {
  const q = useLinkQuery();
  return (
    <footer className={s.site}>
      <div className={s.siteIn}>
        <div className={s.siteBrand}>
          <Link href={`/${q}`} className={s.siteHome} aria-label="Agate, home">
            <Lockup height={26} wcase="title" />
          </Link>
          <p>The open price of compute, for anyone to trade or build on.</p>
        </div>
        <nav className={s.siteCols} aria-label="Site">
          {COLUMNS.map((c) => (
            <div key={c.name} className={s.siteCol}>
              <h2 id={`site-foot-${c.name.toLowerCase()}`}>{c.name}</h2>
              <ul aria-labelledby={`site-foot-${c.name.toLowerCase()}`}>
                {c.items.map((i) => (
                  <li key={i.href}>{i.plain ? <a href={i.href}>{i.label}</a> : <Link href={`${i.href}${q}`}>{i.label}</Link>}</li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
    </footer>
  );
}
