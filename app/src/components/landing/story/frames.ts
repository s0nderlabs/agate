// The H100's film for the story: 221 rendered frames (Blender Cycles), from straight down on the die, out to the
// whole package, up into the three-quarter view. They are scrubbed by the scroll, never played: a frame is drawn only
// when the scroll asks for it. The files come in coarse first: the two ends and every 4th frame (a whole film already,
// about 4.5 MB) once the page is idle, then every 2nd and the rest when the story starts (18 MB in all). A phone takes
// a lighter set, 1280 wide (13 MB in all); a reader who asked the browser to save data gets the first pass only. The
// addresses carry the render's name, so a browser holding last render's frames never mixes them into this one. A
// decoded frame is big (1600 x 1000 pixels is 6.4 MB), so only the frames near the scroll's place are decoded, sized
// to the screen, and the farthest are let go. Until a frame is in, the nearest ones on each side are blended.

export const FRAME_W = 1600, FRAME_H = 1000, FRAME_N = 221;
/** the die's place in the first frame (the story's dive lands on it): left, top, width, height */
export const FRAME_DIE = [434, 60, 732, 880] as const;

/** the lighter set's width (its own folder) */
const SMALL_W = 1280;
/** the render the files are: change it with every new render (the files keep their names, the addresses change) */
const RENDER = "x4";
const src = (i: number, small: boolean) => `/landing/${small ? "h100s" : "h100"}/f${String(i).padStart(3, "0")}.webp?r=${RENDER}`;
/** a phone, by the device (a touch screen whose short side is a phone's), never by the window: a portrait tablet or a
 *  narrow desktop window draws the chip as wide as the full set */
const phoneScreen = () => window.matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 600;
/** the reader asked the browser to save data */
const saveData = () => !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
type Pic = ImageBitmap | HTMLImageElement;
/** a frame's pass: 4 for every 4th frame (fetched first), 2 for the rest of every 2nd, 1 for the others */
const pass = (i: number) => (i % 4 === 0 ? 4 : i % 2 === 0 ? 2 : 1);
/** decoded at once: a first-pass frame this many frames either side of the scroll's place, a finer one closer in by
 *  its pass (a fast scroll still finds a coarse frame decoded, a slow one the fine frames); the window holds at most
 *  19 frames with the two ends. Beyond KEEP, frames outside the window are let go, farthest first */
const NEAR = 16, KEEP = 20;
/** always kept: the frame the dive lands on and the one the H100 scene ends on */
const PINNED = [0, FRAME_N - 1];

export class Frames {
  private blobs: (Blob | null)[] = new Array(FRAME_N).fill(null);
  private pics = new Map<number, Pic>();
  private busy = new Set<number>();
  private want = 0;
  private alive = true;
  /** the fetch queue, how far along it is, how many are in flight, how many passes are queued, and the most this
   *  reader takes (1 when saving data, else all 3) */
  private order: number[] = [];
  private next = 0;
  private flying = 0;
  private passes = 0;
  private readonly most = saveData() ? 1 : 3;
  /** the lighter set, decided at the first fetch */
  private small = false;

  /** onLoad: a frame was decoded; width: how wide to decode, in pixels (the widest the screen draws one) */
  constructor(
    private onLoad: () => void,
    private width: () => number,
  ) {}

  /** fetch the files: with `first`, the two ends and every 4th frame; without, every frame (the first pass only for a
   *  reader saving data). Each file once; called on every frame of the story, so a call with nothing new returns at once */
  load(first = false) {
    const passes = first ? 1 : this.most;
    if (passes <= this.passes) return;
    if (!this.passes) this.small = phoneScreen();
    const all = Array.from({ length: FRAME_N }, (_, i) => i);
    // (the passes never overlap, and the two ends are in the first: each frame is queued once)
    const add = new Set([...(this.passes ? [] : PINNED), ...[4, 2, 1].slice(this.passes, passes).flatMap((k) => all.filter((i) => pass(i) === k))]);
    this.order.push(...add);
    this.passes = passes;
    // (four at a time)
    while (this.flying < 4 && this.next < this.order.length) this.fetchNext();
  }

  private fetchNext() {
    if (!this.alive || this.next >= this.order.length) return;
    const i = this.order[this.next++];
    this.flying++;
    fetch(src(i, this.small))
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (!this.alive || !b) return;
        this.blobs[i] = b;
        this.pump();
      })
      .catch(() => {})
      .finally(() => {
        this.flying--;
        this.fetchNext();
      });
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

  /** how far frame i is from the scroll's place, a finer pass counted farther (0 for the two ends) */
  private dist(i: number) {
    return PINNED.includes(i) ? 0 : (Math.abs(i - this.want) * 4) / pass(i);
  }

  /** decode the nearest frames still wanted, two at a time */
  private pump() {
    while (this.alive && this.busy.size < 2) {
      let best = -1, dist = Infinity;
      for (let i = 0; i < FRAME_N; i++) {
        if (!this.blobs[i] || this.pics.has(i) || this.busy.has(i)) continue;
        const d = this.dist(i);
        if (d <= NEAR && d < dist) [best, dist] = [i, d];
      }
      if (best < 0) return;
      this.decode(best);
    }
  }

  private decode(i: number) {
    const b = this.blobs[i]!;
    this.busy.add(i);
    // (never wider than the file: a bigger bitmap holds no more detail)
    const w = Math.max(320, Math.min(this.small ? SMALL_W : FRAME_W, Math.round(this.width())));
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

  /** past KEEP, let go of the decoded frames outside the window, farthest first (one inside it would be decoded again
   *  at once) */
  private trim() {
    if (this.pics.size <= KEEP) return;
    const far = [...this.pics.keys()].filter((i) => this.dist(i) > NEAR).sort((a, b) => this.dist(b) - this.dist(a));
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
