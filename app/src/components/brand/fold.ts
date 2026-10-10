// The folded A (Oct 9 2026, the pick: Kuwayama Vol 1 mark 8 redrawn as "a folded rectangle into a ... viewed
// laterally"). One sheet with a chip's proportions (1000 x 1270, so laid flat it is a chip), creased and folded:
//   slab   the right part of the sheet, facing us: the A's right leg
//   up/lo  the left part's two triangles, hinged on the slab's left edge and turned away from us: the A's left leg,
//          seen side on (two tones, as the two facets catch the light differently)
//   tl/bl  the left part's corners, folded back behind the triangles along their outer creases (in the finished A
//          they are out of sight; while it folds they are the moving flaps)
// One model drives the logo (t = 1) and the loader (t from 0, flat, to 1, folded). Pure geometry, no React.

export type FaceId = "slab" | "up" | "lo" | "tl" | "bl";
export interface Face {
  id: FaceId;
  /** the face in the picture, on a 100 x 100 box (y down) */
  pts: [number, number][];
  /** its tone, 0 the slab's deep colour to 1 the palest (the two triangles take their tones as they turn away) */
  shade: number;
  /** per edge (point i to i + 1): 1 where it is a crease, so the gap opens there and the outline stays whole */
  crease: number[];
  /** how much of it shows: a flap, once tucked behind its triangle, goes (else it shows through the creases' gaps) */
  alpha: number;
}

type P3 = [number, number, number];

// the sheet, flat, in its own units: height 1, width 0.787 (the chip's)
const H = 1, W = 1000 / 1270;

function rotY(p: P3, ang: number): P3 {
  // about the slab's left edge (the line x = 0, along y): positive turns the left part away from us
  const c = Math.cos(ang), s = Math.sin(ang);
  return [p[0] * c - p[2] * s, p[1], p[0] * s + p[2] * c];
}

function rotAxis(p: P3, a: P3, b: P3, ang: number): P3 {
  // about the line through a and b (Rodrigues)
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const n = Math.hypot(ux, uy, uz);
  const k: P3 = [ux / n, uy / n, uz / n];
  const v: P3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const c = Math.cos(ang), s = Math.sin(ang);
  const d = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  const x: P3 = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  return [
    a[0] + v[0] * c + x[0] * s + k[0] * d * (1 - c),
    a[1] + v[1] * c + x[1] * s + k[1] * d * (1 - c),
    a[2] + v[2] * c + x[2] * s + k[2] * d * (1 - c),
  ];
}

const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const seg = (t: number, a: number, b: number) => ease((t - a) / (b - a));

/** The creases and the finished pose: the slab's width; the height where the outer creases meet the sheet's left edge
 *  (m) and where the inner one meets the slab (mid); how far the wing and the flaps turn; the lean it is seen at. */
export const POSE = { slab: 0.32, m: 0.5, mid: 0.6, wing: 0.6, flap: 3.05, roll: 0.38, tilt: 0.0 };

// painting order, far to near: the flaps fold behind their triangles, the wing turns away behind the slab's edge and
// never crosses it (it stops short of a right angle), so the order holds at every t
const ORDER: FaceId[] = ["tl", "bl", "up", "lo", "slab"];

/** The sheet folded to t (0 flat, 1 the A), in the picture: faces on a 100 x 100 box, far ones first. With view = 0
 *  the sheet faces us square (the loader's start); view = 1 is the logo's lean. */
export function fold(t: number, view = t): Face[] {
  // the flaps tuck first, then the two triangles turn away
  const S = POSE.slab, PW = W - S, M = POSE.m, MID = POSE.mid;
  const f = seg(t, 0, 0.55) * POSE.flap;
  const k = seg(t, 0.3, 1), a = k * POSE.wing;
  const X: P3 = [-PW, M, 0];
  const top: P3 = [0, H, 0], bot: P3 = [0, 0, 0], mid: P3 = [0, MID, 0];
  const raw: Record<FaceId, P3[]> = {
    slab: [[0, 0, 0], [S, 0, 0], [S, H, 0], [0, H, 0]],
    up: [top, X, mid],
    lo: [X, bot, mid],
    tl: [top, [-PW, H, 0], X],
    bl: [X, [-PW, 0, 0], bot],
  };
  // flaps fold about their creases (top to X, X to bottom), then ride with their triangle
  // (both turn away from us, toward -z; we look from +z)
  raw.tl = raw.tl.map((p) => rotAxis(p, top, X, f));
  raw.bl = raw.bl.map((p) => rotAxis(p, X, bot, f));
  for (const id of ["up", "lo", "tl", "bl"] as FaceId[]) raw[id] = raw[id].map((p) => rotY(p, a));
  const SHADE: Record<FaceId, number> = { slab: 0, up: 0.5 * k, lo: k, tl: seg(t, 0, 0.55), bl: seg(t, 0, 0.55) };
  // (slab: its left edge is the hinge; up and lo: every edge folds against a neighbour; the flaps: their fold line)
  const CREASE: Record<FaceId, number[]> = { slab: [0, 0, 0, 1], up: [1, 1, 1], lo: [1, 1, 1], tl: [0, 0, 1], bl: [0, 0, 1] };

  // the view: the sheet's centre on the box's centre, leaned by roll (and tilted) as it folds
  const r = POSE.roll * ease(view), tl = POSE.tilt * ease(view);
  const cr = Math.cos(r), sr = Math.sin(r), ct = Math.cos(tl), st = Math.sin(tl);
  const cx = (S - PW) / 2, cy = H / 2;
  return ORDER.map((id) => {
    const pts3 = raw[id].map(([x, y, z]) => {
      let X3 = x - cx, Y3 = y - cy, Z3 = z;
      [Y3, Z3] = [Y3 * ct - Z3 * st, Y3 * st + Z3 * ct];
      const px = X3 * cr - Y3 * sr, py = X3 * sr + Y3 * cr;
      return [px, py, Z3] as P3;
    });
    return {
      id,
      pts: pts3.map(([x, y]) => [50 + x * 72, 50 - y * 72] as [number, number]),
      shade: SHADE[id],
      crease: CREASE[id],
      // (and while edge-on, where a flap is only a line)
      alpha: id === "tl" || id === "bl" ? (1 - seg(t, 0.3, 0.5)) * seg(Math.abs(Math.cos(f)), 0.05, 0.2) : 1,
    };
  });
}

/** The faces' colours, as the blue lace layers: shade 0 the slab's deep indigo, 0.5 periwinkle, 1 pale sky. */
export const LACE = { deep: [44, 42, 107], mid: [143, 168, 230], pale: [207, 220, 246] } as const;
export function laceTone(shade: number, deep: readonly number[] = LACE.deep, mid: readonly number[] = LACE.mid, pale: readonly number[] = LACE.pale): string {
  const k = Math.max(0, Math.min(1, shade)) * 2;
  const [a, b, w] = k <= 1 ? [deep, mid, k] : [mid, pale, k - 1];
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * w));
  return `rgb(${c[0]} ${c[1]} ${c[2]})`;
}

/** A convex face pulled in by g along its creases (half a crease's gap each side), so the creases are real gaps on any
 *  ground and the outline keeps its size. */
export function inset(pts: [number, number][], g: number, crease: number[] = pts.map(() => 1)): [number, number][] {
  if (g <= 0) return pts;
  const n = pts.length;
  const area = pts.reduce((a, [x, y], i) => a + x * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * y, 0);
  const sg = area > 0 ? 1 : -1;
  // each edge moved inward along its normal, then each corner where its two moved edges cross
  const lines = pts.map(([x0, y0], i) => {
    const [x1, y1] = pts[(i + 1) % n];
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const nx = (-(y1 - y0) / len) * sg, ny = ((x1 - x0) / len) * sg;
    const d = g * (crease[i] ?? 1);
    return [x0 + nx * d, y0 + ny * d, x1 - x0, y1 - y0];
  });
  const out = pts.map((p, i) => {
    const [ax, ay, adx, ady] = lines[(i + n - 1) % n], [bx, by, bdx, bdy] = lines[i];
    const den = adx * bdy - ady * bdx;
    if (Math.abs(den) < 1e-9) return [bx, by] as [number, number];
    const u = ((bx - ax) * bdy - (by - ay) * bdx) / den;
    return [ax + adx * u, ay + ady * u] as [number, number];
  });
  // a face thinner than its gap (a flap passing edge-on) would turn inside out into a sliver across the page: it is
  // gone instead (pulled in, it must keep its sign, stay smaller, and stay inside its own outline's box)
  const after = out.reduce((a, [x, y], i) => a + x * out[(i + 1) % n][1] - out[(i + 1) % n][0] * y, 0);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), e = 1e-6;
  const x0 = Math.min(...xs) - e, x1 = Math.max(...xs) + e, y0 = Math.min(...ys) - e, y1 = Math.max(...ys) + e;
  const inside = out.every(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
  return inside && after * area > 0 && Math.abs(after) <= Math.abs(area) ? out : [];
}

/** Faces as SVG points strings (pulled in by g for the creases' gaps). */
export const pointsOf = (f: Face, g = 0) => inset(f.pts, g, f.crease).map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");

/** The finished A for the logo: its three faces you see (the flaps are hidden behind), fitted to a 100-tall box with
 *  its right edge at x = 100; nameAt is where the slab's right edge crosses the middle (where the name's gap starts). */
export const MARK = (() => {
  // (the flaps are out of sight, so the triangles' fold lines with them are outline, not creases)
  const faces = fold(1)
    .filter((f) => f.id === "slab" || f.id === "up" || f.id === "lo")
    .map((f) => (f.id === "slab" ? f : { ...f, crease: [0, 1, 1] }));
  const all = faces.flatMap((f) => f.pts);
  const x0 = Math.min(...all.map((p) => p[0])), x1 = Math.max(...all.map((p) => p[0]));
  const y0 = Math.min(...all.map((p) => p[1])), y1 = Math.max(...all.map((p) => p[1]));
  const k = 100 / (y1 - y0);
  const put = (f: Face): Face => ({ ...f, pts: f.pts.map(([x, y]) => [100 - (x1 - x) * k, (y - y0) * k] as [number, number]) });
  const out = faces.map(put);
  // the slab's edges crossing the middle line: the right of the two is its outer edge
  const slab = out.find((f) => f.id === "slab")!.pts;
  const xs = slab.flatMap(([xa, ya], i) => {
    const [xb, yb] = slab[(i + 1) % slab.length];
    return (ya - 50) * (yb - 50) <= 0 && ya !== yb ? [xa + ((50 - ya) / (yb - ya)) * (xb - xa)] : [];
  });
  // drawn small (32 px and under), the two triangles are one: the wing, a single tone, so the A stays two clear pieces
  const up = out.find((f) => f.id === "up")!, lo = out.find((f) => f.id === "lo")!;
  const wing: Face = { id: "up", pts: [up.pts[0], up.pts[1], lo.pts[1]], shade: 0.5, crease: [0, 0, 1], alpha: 1 };
  return { faces: out, small: [wing, out.find((f) => f.id === "slab")!], width: (x1 - x0) * k, nameAt: xs.length ? Math.max(...xs) : 100, scale: k };
})();

/** The creases' gap, half of it on each side, on the mark's 100-tall box: the one width everywhere, the app, the masters
 *  and the loader (the site's 32 px top bar drew 3.1). */
export const MARK_GAP = 3.1;
/** The same gap on the fold's own 100 box (the loader draws the sheet there, the A smaller than the box). */
export const FOLD_GAP = MARK_GAP / MARK.scale;

/** The finished A's tokens, face by face: the slab, the upper triangle, the lower one. */
export const MARK_FILL: Record<FaceId, string> = { slab: "var(--fd0)", up: "var(--fd1)", lo: "var(--fd2)", tl: "var(--fd2)", bl: "var(--fd2)" };
