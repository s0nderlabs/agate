"use client";
// Long or Short with the price each side trades at, the way Ostium, Polymarket and Kalshi carry it: the picked half
// fills edge to edge (no pill inside a well), tinted in the side's color with its label and price (Ostium,
// Coinbase Advanced).
import { Num } from "@/components/num/Num";
import type { Side } from "@/lib/mock/types";
import { usd } from "@/lib/format";
import t from "./side.module.css";

export function SideToggle({ side, onSide, ask, bid }: { side: Side; onSide: (s: Side) => void; ask: number; bid: number }) {
  const L = side === "long";
  return (
    <div className={t.toggle} role="group" aria-label="Side">
      <button aria-pressed={L} data-side="long" onClick={() => onSide("long")}>
        <b>Long</b>
        <span>
          <Num>{usd(ask)}</Num>
        </span>
      </button>
      <button aria-pressed={!L} data-side="short" onClick={() => onSide("short")}>
        <b>Short</b>
        <span>
          <Num>{usd(bid)}</Num>
        </span>
      </button>
    </div>
  );
}
