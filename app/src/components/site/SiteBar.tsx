"use client";
// The site's top bar on its own pages (docs, privacy): the landing's bar itself (the mark home, Markets, Index, Docs,
// the light and dark switch, a quiet Open app), on the page's ground and pinned to the top, so the site reads as one
// site and the app's bar (Simple | Pro, Sign in, the bottom tabs on a phone) stays inside the app. As a full-width bar
// (a reading page's top) with the links centred as on the landing, or the landing's floating capsule.
import { Nav } from "@/components/landing/hero/kit";
import { useMock } from "@/lib/mock/store";
import s from "./siteBar.module.css";

export function SiteBar({ current }: { current?: "docs" }) {
  const { config } = useMock();
  const pill = config.siteNav === "pill";
  return (
    <div className={s.bar} data-shape={pill ? "pill" : "split"}>
      <Nav className={s.nav} theme links="docs" current={current} shape={pill ? "pill" : "center"} corners="square" />
    </div>
  );
}
