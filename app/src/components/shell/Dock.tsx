"use client";
// The bottom dock on phones (below 640 px): the four places one thumb tap away (Markets, Positions, Index, More), and
// on the trade screen the trade bar above them. From 640 px the top bar carries the places; the dock is never shown.
// Pages reached from More (Connected AIs, an AI's card) have no tab of their own: the stone marks More instead.
import Link from "next/link";
import { Stone } from "@/components/brand/Logo";
import { useFlow } from "@/components/markets/Flow";
import { useLinkQuery } from "@/lib/mock/store";
import d from "./dock.module.css";

type Place = "markets" | "positions" | "index";

export function BottomDock({ active, children }: { active: Place | null; children?: React.ReactNode }) {
  return (
    <div className={d.dock} data-dock>
      {children && <div className={d.barRow}>{children}</div>}
      <TabBar active={active} />
    </div>
  );
}

export function TabBar({ active }: { active: Place | null }) {
  const linkQuery = useLinkQuery();
  const { openMore } = useFlow();
  const places: [Place, string, string][] = [
    ["markets", "Markets", "/"],
    ["positions", "Positions", "/positions"],
    ["index", "Index", "/index"],
  ];
  return (
    <nav aria-label="Main" className={d.tabbar}>
      {places.map(([k, label, path]) => (
        <Link key={k} href={`${path}${linkQuery}`} aria-current={k === active ? "page" : undefined}>
          {k === active && <Stone size={9} className={d.mark} />}
          {label}
        </Link>
      ))}
      <button type="button" aria-haspopup="dialog" onClick={openMore} data-here={active === null || undefined}>
        {active === null && <Stone size={9} className={d.mark} />}
        More
      </button>
    </nav>
  );
}
