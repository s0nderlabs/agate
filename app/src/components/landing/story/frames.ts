// The H100's film for the story: 56 rendered frames (Blender Cycles), from straight down on the die, out to the
// whole package, up into the three-quarter view. They are scrubbed by the scroll, never played: a frame is drawn only
// when the scroll asks for it. The files are small (about 4.5 MB in all) and are fetched once; a decoded frame is not
// (1600 x 1000 pixels is 6.4 MB), so only the frames near the scroll's place are decoded, sized to the screen, and the
// farthest are let go. Until a frame is in, the nearest ones on each side are blended.

export const FRAME_W = 1600, FRAME_H = 1000, FRAME_N = 56;
/** the die's place in the first frame (the story's dive lands on it): left, top, width, height */
export const FRAME_DIE = [434, 60, 732, 880] as const;

const src = (i: number) => `/landing/h100/f${String(i).padStart(3, "0")}.webp`;
type Pic = ImageBitmap | HTMLImageElement;
/** decoded at once: the frames either side of the scroll's place, and how many are kept in all */
const NEAR = 5, KEEP = 14;
/** always kept: the frame the dive lands on and the one the H100 scene ends on */
const PINNED = [0, FRAME_N - 1];

export class Frames {
  private blobs: (Blob | null)[] = new Array(FRAME_N).fill(null);
  private pics = new Map<number, Pic>();
  private busy = new Set<number>();
  private want = 0;
  private alive = true;
  private started = false;

  /** onLoad: a frame was decoded; width: how wide to decode, in pixels (the widest the screen draws one) */
  constructor(
    private onLoad: () => void,
    private width: () => number,
  ) {}

  /** fetch the files (once, when the story is near): the first and the last frames first, then in order */
  load() {
    if (this.started) return;
    this.started = true;
    const order = [...PINNED, ...Array.from({ length: FRAME_N }, (_, i) => i)].filter((v, i, a) => a.indexOf(v) === i);
    let next = 0;
    const one = () => {
      if (!this.alive || next >= order.length) return;
      const i = order[next++];
      fetch(src(i))
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => {
          if (!this.alive || !b) return;
          this.blobs[i] = b;
          this.pump();
        })
        .catch(() => {})
        .finally(one);
    };
    // (four at a time)
    for (let k = 0; k < 4; k++) one();
  }

  stop() {
    this.alive = false;
    this.pics.forEach((p) => this.free(p));
    this.pics.clear();
  }

  private free(p: Pic) {
    if ("close" in p) p.close();
    else if (p.src.startsWith("blob:")) URL.revokeObjectURL(p.src);
  }

  /** decode the nearest frames still wanted, two at a time */
  private pump() {
    while (this.alive && this.busy.size < 2) {
      let best = -1, dist = Infinity;
      for (let i = 0; i < FRAME_N; i++) {
        if (!this.blobs[i] || this.pics.has(i) || this.busy.has(i)) continue;
        const d = PINNED.includes(i) ? 0 : Math.abs(i - this.want);
        if (d <= NEAR && d < dist) [best, dist] = [i, d];
      }
      if (best < 0) return;
      this.decode(best);
    }
  }

  private decode(i: number) {
    const b = this.blobs[i]!;
    this.busy.add(i);
    const w = Math.max(320, Math.min(FRAME_W, Math.round(this.width())));
    const h = Math.round((w * FRAME_H) / FRAME_W);
    const done = (p: Pic | null) => {
      this.busy.delete(i);
      if (!p) return;
      if (!this.alive) return this.free(p);
      this.pics.set(i, p);
      this.trim();
      this.onLoad();
      this.pump();
    };
    if (typeof createImageBitmap === "function") {
      createImageBitmap(b, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" })
        .then(done)
        .catch(() => done(null));
    } else {
      const img = new Image();
      img.src = URL.createObjectURL(b);
      img
        .decode()
        .then(() => done(img))
        .catch(() => done(null));
    }
  }

  /** let the farthest frames go once more than KEEP are decoded */
  private trim() {
    if (this.pics.size <= KEEP) return;
    const far = [...this.pics.keys()].filter((i) => !PINNED.includes(i)).sort((a, b) => Math.abs(b - this.want) - Math.abs(a - this.want));
    for (const i of far.slice(0, this.pics.size - KEEP)) {
      this.free(this.pics.get(i)!);
      this.pics.delete(i);
    }
  }

  /** the frames to draw for a place on the film: the nearest decoded frame on each side, and how much of the second */
  at(f: number): [Pic, Pic | null, number] | null {
    const x = Math.min(FRAME_N - 1, Math.max(0, f));
    if (Math.abs(x - this.want) > 0.5) {
      this.want = x;
      this.pump();
    }
    let a = Math.floor(x), b = Math.ceil(x);
    while (a >= 0 && !this.pics.has(a)) a--;
    while (b < FRAME_N && !this.pics.has(b)) b++;
    const A = a >= 0 ? this.pics.get(a)! : null, B = b < FRAME_N ? this.pics.get(b)! : null;
    if (A && B && a !== b) return [A, B, (x - a) / (b - a)];
    const one = A ?? B;
    return one ? [one, null, 0] : null;
  }
}
