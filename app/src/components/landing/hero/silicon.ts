// A GPU die as a microscope sees it, for the hero shaders: the GH100-like floorplan (I/O ring and pads, HBM interfaces
// down both sides, the L2 band, eight GPCs of 18 SMs, each SM four tensor cores of 8 x 8 datapath tiles over an L1 strip)
// drawn with colours read off a real GA100 die shot (CC BY 3.0, Wikimedia Commons). Logic is standard-cell rows with
// power rails, gates and vias under a cloudy drift read cell by cell; SRAM is bit lines in sub-arrays; every pattern is
// box-filtered to the pixel, so it resolves up close and settles to its true average far off. Shared by the hour zoom
// (H15Hour) and the opening film (H23Open).

// the die in world units (26 x 33 mm) and its floorplan: an I/O ring, HBM interfaces down both sides, the L2 band across
// the middle, eight GPCs of 18 SMs (3 x 6), each SM four tensor cores over an L1 strip, each core an 8 x 8 tile array
export const DIE_W = 1000, DIE_H = 1270;
const GX0 = 100, GPC_W = 200, TOP0 = 40, BOT0 = 680, LANE = 8;
const SM_W = (GPC_W - LANE) / 3, SM_H = (590 - TOP0 - LANE) / 6;
const PAD = 3;
const CORE = (SM_W - PAD * 3) / 2;
export const CELL = CORE / 8;
// the cell the film starts in: SM 25 (top half, GPC 1, row 2, column 1), core 1, row 3, column 4
export const FOCUS_N = 25, FOCUS_Q = 1, FI = 3, FJ = 4;
export const [FCX, FCY] = (() => {
  const g = 1, r = 2, c = 1;
  const sx = GX0 + g * GPC_W + LANE / 2 + c * SM_W, sy = TOP0 + LANE / 2 + r * SM_H;
  return [sx + PAD + (FOCUS_Q % 2) * (CORE + PAD) + (FJ + 0.5) * CELL, sy + PAD + Math.floor(FOCUS_Q / 2) * (CORE + PAD) + (FI + 0.5) * CELL];
})();

/** GLSL: the floorplan constants, the filtered patterns, and die(p, px, T, waves, focusDie, act, focus): the colour of
 *  the die at die-local p (units), px world units per pixel; act is the compute wave there (0..1, times waves), focus
 *  the share of the pixel inside the film's first cell (only when focusDie is 1). */
export const SILICON = `
const float DIE_W = ${DIE_W.toFixed(1)}, DIE_H = ${DIE_H.toFixed(1)};
const float GX0 = 100.0, GX1 = 900.0, TOP0 = 40.0, TOP1 = 590.0, BOT0 = 680.0;
const float GPC_W = 200.0, LANE = 8.0, PAD = 3.0;
const float SM_W = ${SM_W.toFixed(5)}, SM_H = ${SM_H.toFixed(5)};
const float CORE = ${CORE.toFixed(5)}, CELL = ${CELL.toFixed(5)};
const float L1_Y = ${(PAD * 3 + CORE * 2).toFixed(5)}, L1_H = ${(SM_H - CORE * 2 - PAD * 4).toFixed(5)};
const float RIM = 22.0;
const float FOCUS_N = ${FOCUS_N.toFixed(1)}, FOCUS_Q = ${FOCUS_Q.toFixed(1)}, FI = ${FI.toFixed(1)}, FJ = ${FJ.toFixed(1)};

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// cloudy variation whose octaves finer than a pixel (px, in the noise's own units) settle to their mean
float fbm(vec2 p, float px){
  float s = 0.0, a = 0.5;
  for (int o = 0; o < 3; o++) {
    s += a * mix(noise(p), 0.5, smoothstep(0.3, 0.8, px));
    p = p * 2.07 + vec2(13.1, 7.7); px *= 2.07; a *= 0.5;
  }
  return s / 0.875;
}
// how much of a pixel (w wide) lies inside [x0, x1]
float box1(float x, float x0, float x1, float w){ return clamp((min(x + 0.5 * w, x1) - max(x - 0.5 * w, x0)) / w, 0.0, 1.0); }
float rect(vec2 p, vec2 a, vec2 b, float w){ return box1(p.x, a.x, b.x, w) * box1(p.y, a.y, b.y, w); }
// how much of a pixel is covered by stripes of period P that are on for the first d of each period (exact box filter,
// so a stripe finer than the pixel turns into its average instead of shimmering)
float stripe(float x, float P, float d, float w){
  float a = (x - 0.5 * w) / P, b = (x + 0.5 * w) / P;
  return clamp(((floor(b) - floor(a)) * d + min(fract(b), d) - min(fract(a), d)) * P / w, 0.0, 1.0);
}
bool isOff(float n){
  return abs(n - 5.0) < 0.5 || abs(n - 17.0) < 0.5 || abs(n - 22.0) < 0.5 || abs(n - 40.0) < 0.5 || abs(n - 51.0) < 0.5
      || abs(n - 63.0) < 0.5 || abs(n - 77.0) < 0.5 || abs(n - 86.0) < 0.5 || abs(n - 98.0) < 0.5 || abs(n - 109.0) < 0.5
      || abs(n - 121.0) < 0.5 || abs(n - 140.0) < 0.5;
}
float wave(float T, float k, float ph){ float x = mod(T - k * 0.07 - ph, 3.0); return exp(-pow((x - 0.45) / 0.3, 2.0)); }

// logic: standard-cell rows (lp is the block's own frame, rowP its row pitch). The colour is the die's cloudy drift
// read at each cell's centre, so up close it changes cell by cell along the layout, as metal density does on a real
// die, and far off it settles into the clouds
vec3 logic(vec2 p, vec2 lp, float px, float rowP){
  float row = floor(lp.y / rowP);
  float cw = rowP * 0.36, off = hash(vec2(row, 3.0)) * 7.0;
  float ci = floor(lp.x / cw + off);
  float k = 1.0 - smoothstep(0.35, 1.0, px / cw);
  vec2 s = mix(p, p - lp + vec2((ci - off + 0.5) * cw, (row + 0.5) * rowP), k);
  float m1 = fbm(s / 7.0, px / 7.0), m2 = fbm(s / 2.3 + 31.0, px / 2.3);
  vec3 c = mix(vec3(0.15, 0.17, 0.32), vec3(0.35, 0.41, 0.62), smoothstep(0.32, 0.64, m1));
  c = mix(c, vec3(0.55, 0.52, 0.66), smoothstep(0.6, 0.82, m2) * 0.65);
  c = mix(c, vec3(0.24, 0.45, 0.49), smoothstep(0.6, 0.74, m1) * (1.0 - smoothstep(0.42, 0.58, m2)) * 0.85);
  c = mix(c, vec3(0.44, 0.34, 0.2), smoothstep(0.7, 0.84, m2) * smoothstep(0.55, 0.38, m1) * 0.8);
  // each cell a little lighter or darker than its neighbours: a barcode that resolves only up close
  c *= 1.0 + (hash(vec2(row, ci)) - 0.5) * 0.5 * k;
  // gates: fine vertical lines inside the cells
  c *= 1.0 - 0.12 * stripe(lp.x, rowP * 0.1, 0.45, px) * k;
  // the power rails between rows, bright metal
  c = mix(c, vec3(0.74, 0.7, 0.78), stripe(lp.y + rowP * 0.04, rowP, 0.08, px) * 0.55);
  // a few vias, off the grid, small and dull; seen only when they are a few pixels across
  vec2 vg = lp / (rowP * 0.5), vi = floor(vg);
  vec2 jit = vec2(hash(vi + 1.7), hash(vi + 8.3)) - 0.5;
  float dv = length(fract(vg) - 0.5 - jit * 0.6) * rowP * 0.5, rv = rowP * 0.035;
  float via = step(0.9, hash(vi + 5.3)) * (1.0 - smoothstep(rv - 0.5 * px, rv + 0.5 * px, dv));
  c = mix(c, vec3(0.72, 0.66, 0.54), via * 0.45 * (1.0 - smoothstep(0.012, 0.03, px)));
  return c;
}
// between the big blocks: glue logic and wiring, denser, darker and warmer than the cores (a real die has no empty
// ground), fine routing along it
vec3 channel(vec2 p, float px){
  vec3 c = logic(p, p, px, 0.42) * vec3(0.6, 0.56, 0.54);
  return c + vec3(0.03, 0.028, 0.032) * stripe(p.y, 0.16, 0.4, px);
}
// SRAM: bit lines in sub-arrays, the periphery (decoders, sense amps) between them
vec3 sram(vec2 lp, float px, float bitP, vec2 subP){
  float sx = stripe(lp.x, subP.x, 0.88, px), sy = stripe(lp.y, subP.y, 0.9, px);
  float bits = stripe(lp.x, bitP, 0.45, px);
  vec3 c = mix(vec3(0.28, 0.25, 0.29), vec3(0.09, 0.075, 0.11), sx * sy);
  c = mix(c, vec3(0.88, 0.8, 0.9), sx * sy * bits);
  // wordline straps across the array
  return mix(c, vec3(0.5, 0.45, 0.52), stripe(lp.y, bitP * 8.0, 0.12, px) * sx * sy * 0.35);
}
// a datapath tile of a tensor core: a register file down its left side, logic beside it, a channel round it
vec3 tile(vec2 p, vec2 lp, float px){
  vec3 c = logic(p, lp, px, CELL / 6.0);
  c = mix(c, sram(lp - vec2(0.2, 0.22), px, 0.085, vec2(0.6, 0.75)), rect(lp, vec2(0.2, 0.22), vec2(0.78, CELL - 0.22), px));
  return mix(vec3(0.13, 0.12, 0.15), c, rect(lp, vec2(0.06), vec2(CELL - 0.06), px));
}
// memory interface: gold driver rows, finer structure inside, a dark slot down the middle
vec3 phy(vec2 lp, float px){
  vec3 c = mix(vec3(0.6, 0.42, 0.19), vec3(0.82, 0.52, 0.27), stripe(lp.y, 6.0, 0.45, px));
  c *= 0.82 + 0.36 * stripe(lp.x, 0.5, 0.5, px);
  c *= 0.9 + 0.2 * stripe(lp.y, 0.8, 0.5, px);
  return mix(c, vec3(0.14, 0.1, 0.07), box1(lp.x, 25.5, 30.5, px));
}

vec3 die(vec2 p, float px, float T, float waves, float focusDie, out float act, out float focus){
  act = 0.0;
  focus = 0.0;

  // where the pixel is: the ring, a memory interface, the L2 band, or a GPC (and in it an L1 strip or a core)
  float edge = min(min(p.x, DIE_W - p.x), min(p.y, DIE_H - p.y));
  float mR = edge < RIM + 1.0 ? box1(edge, -1.0, RIM, px) : 0.0;
  float side = p.x < DIE_W * 0.5 ? 30.0 : 912.0;
  float py0 = 40.0 + clamp(floor((p.y - 40.0) / 400.0), 0.0, 2.0) * 400.0;
  float mP = rect(p, vec2(side, py0), vec2(side + 58.0, py0 + 380.0), px);
  float mX = rect(p, vec2(GX0, TOP1 + 8.0), vec2(GX1, BOT0 - 8.0), px);
  float hf = p.y >= BOT0 ? 1.0 : 0.0;
  float y0 = hf > 0.5 ? BOT0 : TOP0;
  float mG = rect(p, vec2(GX0, y0), vec2(GX1, y0 + TOP1 - TOP0), px);
  float gx = p.x - GX0, g = clamp(floor(gx / GPC_W), 0.0, 3.0);
  gx -= g * GPC_W;
  float gy = p.y - y0;
  float c = clamp(floor((gx - LANE * 0.5) / SM_W), 0.0, 2.0), r = clamp(floor((gy - LANE * 0.5) / SM_H), 0.0, 5.0);
  vec2 sl = vec2(gx - LANE * 0.5 - c * SM_W, gy - LANE * 0.5 - r * SM_H);
  float mL1 = mG * rect(sl, vec2(PAD, L1_Y), vec2(SM_W - PAD, L1_Y + L1_H), px);
  float qx = step(PAD * 1.5 + CORE, sl.x), qy = step(PAD * 1.5 + CORE, sl.y);
  vec2 cl = sl - vec2(PAD + qx * (CORE + PAD), PAD + qy * (CORE + PAD));
  float mC = mG * rect(cl, vec2(0.0), vec2(CORE), px);
  // the glue logic between the parts, drawn only where they leave some of the pixel uncovered
  float cover = max(max(mR, mP), max(mX, max(mL1, mC)));
  vec3 col = cover < 0.999 ? channel(p, px) : vec3(0.0);

  // the I/O ring: bond pads in a row, the seal ring at the very edge
  if (mR > 0.0) {
    float along = (p.y < RIM || p.y > DIE_H - RIM) ? p.x : p.y;
    vec3 rim = vec3(0.17, 0.14, 0.1) * (0.8 + 0.4 * fbm(p / 3.0, px / 3.0));
    float pad = stripe(along - 4.0, 16.0, 0.5, px) * box1(edge, 7.0, 15.0, px);
    vec3 gold = vec3(0.8, 0.67, 0.38) * (0.88 + 0.24 * hash(vec2(floor((along - 4.0) / 16.0), 1.0)));
    gold = mix(gold, vec3(0.55, 0.45, 0.26), box1(edge, 9.5, 12.5, px) * stripe(along - 6.5, 16.0, 0.19, px));
    rim = mix(rim, gold, pad);
    rim = mix(rim, vec3(0.72, 0.68, 0.62), box1(edge, 1.0, 3.5, px));
    col = mix(col, rim, mR);
  }

  // the memory interfaces down both sides, three each
  if (mP > 0.0) col = mix(col, phy(p - vec2(side, py0), px), mP);

  // the L2 band: SRAM banks above and below the crossbar, copper wiring through it
  if (mX > 0.0) {
    vec2 lp = p - vec2(GX0, TOP1 + 8.0);
    vec3 xb = vec3(0.15, 0.12, 0.09) * (0.75 + 0.5 * fbm(p / 4.0, px / 4.0));
    xb = mix(xb, vec3(0.7, 0.45, 0.24), stripe(lp.y, 1.1, 0.25, px) * box1(lp.y, 31.0, 43.0, px) * 0.7);
    float bx = mod(lp.x, 50.0);
    float bank = box1(bx, 2.0, 48.0, px) * clamp(box1(lp.y, 6.0, 31.0, px) + box1(lp.y, 43.0, 68.0, px), 0.0, 1.0);
    if (bank > 0.0) xb = mix(xb, sram(vec2(bx, lp.y), px, 0.12, vec2(11.5, 6.25)), bank);
    col = mix(col, xb, mX);
  }

  // the GPCs: SMs, each four tensor cores over an L1 strip
  if (mL1 > 0.0) col = mix(col, sram(sl - vec2(PAD, L1_Y), px, 0.12, vec2(4.6, L1_H * 0.5)), mL1);
  if (mC > 0.0) {
    vec2 so = vec2(GX0 + g * GPC_W + LANE * 0.5 + c * SM_W, y0 + LANE * 0.5 + r * SM_H);
    float n = ((hf * 4.0 + g) * 6.0 + r) * 3.0 + c;
    {
      vec2 ij = clamp(floor(cl / CELL), 0.0, 7.0);
      vec2 lp = cl - ij * CELL;
      vec3 tc = tile(p, lp, px);
      float q = qx + qy * 2.0;
      if (!isOff(n)) {
        float ph = ((so.x + so.y * 0.8) / DIE_W) * 1.7 + fract(n * 0.6180339) * 0.25 + q * 0.37;
        act = wave(T, ij.x + ij.y, ph) * mC * waves;
      } else tc *= 0.86;
      if (focusDie > 0.5 && abs(n - FOCUS_N) < 0.5 && abs(q - FOCUS_Q) < 0.5 && abs(ij.x - FJ) < 0.5 && abs(ij.y - FI) < 0.5)
        focus = mC * rect(lp, vec2(0.06), vec2(CELL - 0.06), px);
      col = mix(col, tc, mC);
    }
  }
  return col;
}
`;
