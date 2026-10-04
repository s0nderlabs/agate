"use client";
// Long or Short with the price each side trades at, the way Ostium, Polymarket and Kalshi carry it: the picked half
// fills edge to edge (no pill inside a well), tinted in the side's color with its label and price (Ostium,
// Coinbase Advanced).
import { Num } from "@/components/num/Num";
import type { Side } from "@/lib/mock/types";
import { usd } from "@/lib/format";
import t from "./side.module.css";

/** ask / bid null: that side has no price to show (the month is not open yet, or nobody is selling or buying), so
 * the half carries its label only. skel: the prices are on their way (the markets read or the month's book), so a
 * skeleton masked on its own: the screen may have loaded while the book has not. */
export function SideToggle({ side, onSide, ask, bid, skel = false }: { side: Side; onSide: (s: Side) => void; ask: number | null; bid: number | null; skel?: boolean }) {
  const L = side === "long";
  const price = (p: number | null) =>
    skel ? (
      <span className="ag-skel ag-skel-on" aria-hidden="true">
        $0.00
      </span>
    ) : p === null ? null : (
      <span>
        <Num>{usd(p)}</Num>
      </span>
    );
  return (
    <div className={t.toggle} role="group" aria-label="Side">
      <button aria-pressed={L} data-side="long" onClick={() => onSide("long")}>
        <b>Long</b>
        {price(ask)}
      </button>
      <button aria-pressed={!L} data-side="short" onClick={() => onSide("short")}>
        <b>Short</b>
        {price(bid)}
      </button>
    </div>
  );
}
