"use client";
import { useId } from "react";
import { DEFAULT_CONFIG } from "@/lib/mock/config";
import { useMockMaybe } from "@/lib/mock/store";
import { MARK, MARK_FILL, MARK_GAP, pointsOf } from "./fold";
import { PEBBLE_LAYERS, PEBBLE_NAME } from "./pebble";
import { STONE_CORE, STONE_MID, STONE_OUTER, WORDMARK, WORDMARK_TRANSFORM, WORDMARK_TITLE } from "./paths";

const G = "translate(0,944) scale(0.1,-0.1)";

export interface StoneColors {
  outer?: string;
  mid?: string;
  core?: string;
}

/** Which mark the Logo row shows: the folded A, the pebble (blue lace or onyx) or today's stone. */
function useLogo() {
  return useMockMaybe()?.config.logo ?? DEFAULT_CONFIG.logo;
}

/** The pebble's three layers, each with its own gradient; the colours come from [data-pebble] in globals.css. */
function PebbleLayers() {
  const id = "pb" + useId().replace(/[^a-zA-Z0-9]/g, "");
  return (
    <>
      <defs>
        {PEBBLE_LAYERS.map((l, i) => (
          <linearGradient key={i} id={`${id}${i}`} gradientUnits="userSpaceOnUse" x1={l.v[0]} y1={l.v[1]} x2={l.v[2]} y2={l.v[3]}>
            <stop offset="0" style={{ stopColor: `var(--pb${i}a)` }} />
            <stop offset="1" style={{ stopColor: `var(--pb${i}b)` }} />
          </linearGradient>
        ))}
      </defs>
      {PEBBLE_LAYERS.map((l, i) => (
        <path key={i} d={l.d} fill={`url(#${id}${i})`} />
      ))}
    </>
  );
}

/** The folded A's faces (colours from [data-pebble="fold"] (one ink) or "foldlace" in globals.css). Its creases stay about a pixel open at
 *  any size, the same width as the masters (MARK_GAP; at least a pixel a side when tiny); only at favicon size, 20 px
 *  and under, are the two triangles drawn as one. */
function FoldFaces({ px }: { px: number }) {
  return (
    <>
      {(px <= 20 ? MARK.small : MARK.faces).map((f) => (
        <polygon key={f.id} points={pointsOf(f, Math.max(MARK_GAP, 50 / px))} style={{ fill: MARK_FILL[f.id] }} />
      ))}
    </>
  );
}
// the folded A on a square box (it is MARK.width wide and 100 tall, its right edge at 100)
const FOLD_BOX = `${(100 - MARK.width / 2 - 50).toFixed(2)} 0 100 100`;
// its lockup: AGATE as in the pebble lockup, its gap starting from the slab's outer edge at mid height (about a fifth of
// the mark's height, as round 9's pick)
const NAME_X0 = Number(/translate\(([\d.]+)/.exec(PEBBLE_NAME.transform)?.[1] ?? 0);
const FOLD_NAME_X = MARK.nameAt + 22;
const FOLD_NAME_TF = PEBBLE_NAME.transform.replace(/translate\([\d.]+,/, `translate(${FOLD_NAME_X.toFixed(3)},`);
const FOLD_X0 = 100 - MARK.width;
const FOLD_LOCKUP = `${FOLD_X0.toFixed(2)} 0 ${(FOLD_NAME_X + PEBBLE_NAME.width - NAME_X0 - FOLD_X0).toFixed(2)} 100`;

/** The mark: the folded A or the pebble while the Logo row picks one, otherwise the three-layer stone. */
export function Stone(props: StoneColors & { size?: number | string; className?: string; title?: string }) {
  const logo = useLogo();
  if (logo === "stone") return <StoneMark {...props} />;
  const { size = 24, className, title } = props;
  if (logo === "fold" || logo === "foldlace") {
    return (
      <svg viewBox={FOLD_BOX} width={size} height={size} className={className} data-pebble={logo} role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
        <FoldFaces px={typeof size === "number" ? size : 64} />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} data-pebble={logo} role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <PebbleLayers />
    </svg>
  );
}

/** The three-layer stone. Defaults to onyx; pass reversed colors on dark grounds. */
function StoneMark({ size = 24, outer = "var(--stone-o)", mid = "var(--stone-m)", core = "var(--stone-c)", className, title }: StoneColors & { size?: number | string; className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 948 944" width={size} height={size} className={className} role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <g transform={G}>
        <path d={STONE_OUTER} fill={outer} />
        <path d={STONE_MID} fill={mid} />
        <path d={STONE_CORE} fill={core} />
      </g>
    </svg>
  );
}

/** Wordmark sizes, as the x-height of "agate" over the stone's height. orig = the Oct 2 lockup (37%). */
export type WordmarkSize = "orig" | "l" | "xl";
export type WordmarkCase = "lower" | "title";
const LOCKUPS: Record<WordmarkSize, { viewBox: string; transform: string }> = {
  orig: { viewBox: "-37.8 -37.8 2835.6 1019.5", transform: WORDMARK_TRANSFORM },
  l: { viewBox: "-37.8 -37.8 3344.6 1019.5", transform: "translate(1188,106.4) scale(1.0114) translate(-47.0,542.0)" },
  xl: { viewBox: "-37.8 -37.8 3701.6 1019.5", transform: "translate(1198,53) scale(1.18) translate(-47.0,542.0)" },
};
/** "Agate": same scale as each lowercase size, same gap after the stone, cap band (top of A to baseline) centred on the stone. */
const LOCKUPS_TITLE: Record<WordmarkSize, { viewBox: string; transform: string }> = {
  orig: { viewBox: "-37.8 -37.8 2959.1 1019.5", transform: "translate(1174.6,285.4) scale(0.78142) translate(-10.0,542.0)" },
  l: { viewBox: "-37.8 -37.8 3504.4 1019.5", transform: "translate(1188,230.2) scale(1.0114) translate(-10.0,542.0)" },
  xl: { viewBox: "-37.8 -37.8 3888.0 1019.5", transform: "translate(1198,189.7) scale(1.18) translate(-10.0,542.0)" },
};

/** Stone + "agate" in Erode (outlined), the name in currentColor; or, while the Logo row picks it, the pebble + AGATE
 *  in Outfit (outlined), the name in the pebble colour's ink. Its spaced capitals are smaller than Erode's "Agate" at the
 *  same height, so the pebble lockup is drawn 15% taller to keep the same weight in the bar. */
export function Lockup({ height = 28, className, size = "orig", wcase = "lower" }: { height?: number; className?: string; size?: WordmarkSize; wcase?: WordmarkCase }) {
  const logo = useLogo();
  if (logo === "fold" || logo === "foldlace") {
    const h = Math.round(height * 1.15);
    return (
      <svg viewBox={FOLD_LOCKUP} height={h} className={className} data-pebble={logo} role="img" aria-label="Agate" style={{ width: "auto", display: "block", overflow: "visible" }}>
        <FoldFaces px={h} />
        <path transform={FOLD_NAME_TF} d={PEBBLE_NAME.d} style={{ fill: "var(--pb-ink)" }} />
      </svg>
    );
  }
  if (logo !== "stone") {
    return (
      <svg viewBox={`0 0 ${PEBBLE_NAME.width} 100`} height={Math.round(height * 1.15)} className={className} data-pebble={logo} role="img" aria-label="Agate" style={{ width: "auto", display: "block", overflow: "visible" }}>
        <PebbleLayers />
        <path transform={PEBBLE_NAME.transform} d={PEBBLE_NAME.d} style={{ fill: "var(--pb-ink)" }} />
      </svg>
    );
  }
  const L = (wcase === "title" ? LOCKUPS_TITLE : LOCKUPS)[size];
  return (
    <svg viewBox={L.viewBox} height={height} className={className} role="img" aria-label="Agate" style={{ width: "auto", display: "block", overflow: "visible" }}>
      <g transform={G}>
        <path d={STONE_OUTER} fill="var(--stone-o)" />
        <path d={STONE_MID} fill="var(--stone-m)" />
        <path d={STONE_CORE} fill="var(--stone-c)" />
      </g>
      <g transform={L.transform}>
        <path d={wcase === "title" ? WORDMARK_TITLE : WORDMARK} fill="currentColor" />
      </g>
    </svg>
  );
}
