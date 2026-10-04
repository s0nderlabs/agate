import { STONE_CORE, STONE_MID, STONE_OUTER, WORDMARK, WORDMARK_TRANSFORM, WORDMARK_TITLE } from "./paths";

const G = "translate(0,944) scale(0.1,-0.1)";

export interface StoneColors {
  outer?: string;
  mid?: string;
  core?: string;
}

/** The three-layer stone. Defaults to onyx; pass reversed colors on dark grounds. */
export function Stone({ size = 24, outer = "var(--stone-o)", mid = "var(--stone-m)", core = "var(--stone-c)", className, title }: StoneColors & { size?: number | string; className?: string; title?: string }) {
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

/** Stone + "agate" in Erode (outlined). The name takes currentColor. */
export function Lockup({ height = 28, className, size = "orig", wcase = "lower" }: { height?: number; className?: string; size?: WordmarkSize; wcase?: WordmarkCase }) {
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
