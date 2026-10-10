"use client";
// The opening, chips (Oct 8).
//   1. Loading: the dark screen holds one cell of a tensor core, breathing, for at least a second.
//   2. The cell flashes and its chip powers on block by block, outward through its structure (no soft spotlight).
//   3. The camera pulls back: the chip is the lowest of its day's stack, and the days after it come in to its right,
//      left to right as time runs.
//   4. Each column rises from the first chip's row to its own price, and the stacks are a candlestick chart: each day a
//      column of chips from its open to its close, a rising day powered full, a falling day dark with a lit edge, the
//      wick (when shown) a hairline to the day's high and low. The walk runs to today's high at the top right.
//   5. The camera settles; the words and the top bar come in. Nothing follows the cursor.
//   6. (the field) The market stays open, one move a
//      second: at the chart's end, a few columns in from the right
//      edge, a day opens with one chip at yesterday's close and goes one way, a chip powering on each second; when it
//      closes the board glides one column left and the next day opens in the same place; the oldest day leaves off the
//      left. It draws only while something moves (at most 60 frames a second, even on faster screens); off screen or
//      in a hidden tab it stops. Mock controls keep it still.
// Three layouts:
//   solo     the chart in the room beside the headline (Oct 8)
//   land     the chart is the scene: 32 days edge to edge, the half-month before faded back over the headline, the
//            month's low just past it; chips on a dark glass floor
//            (today's prices no longer run along the bottom)
//   horizon  the headline up top on one line; the chart a full-width band below it, rising from the bottom left
//   field    landscape on a board of chips:
//            every place on the chart's grid holds a chip, unpowered, and the chart is the chips that are on. Its words
//            sit low on the left, or up top on one line, on
//            the left or centred, with the chart a band below them
//   sheet    Direction 3's ruled sheet: hairline cells over the board; some hold the words, the price tape and today's H100 price, the
//            rest are windows onto the board, and the month runs under its right half: it starts in the bottom window
//            and climbs through the price tape into the top windows. The film plays full screen; then the sheet lays
//            itself down over the board
// Two looks: the real die (the GA100 micrograph colours of silicon.ts) and the first chips' clean cells in one ink.
// Both follow the app's theme: on the dark ground a powered chip is lit; on the light ground unpowered silicon is a
// pale print and power brings the colour. Wicks are a Mock controls choice,
// and so is the chips' colour:
// silicon, the first chips' one ink on any layout, or the page's own ink, a rising day solid, a falling day hollow, as
// a chart is printed.
// The field's chart runs edge to edge: sized to its band's height, today's day against the right edge, and as many days before it
// as the width holds, the oldest running off the left edge, so no column of the board is left without its day.
// The landing's loading screen (FoldLoader) plays first
// when the Opening row picks it; the film then starts from its cell as before.
// The candles are illustrative, not data: no numbers; a walk at the volatility measured for traded H100 hours.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { stillMode } from "@/components/lab/data";
import { runShader } from "./gl";
import { LOADER_LEAVE, loaderLeftAt, loaderUp } from "../FoldLoader";
import { CELL, DIE_H, DIE_W, FCX, FCY, SILICON } from "./silicon";
import { useMock } from "@/lib/mock/store";
import { CLAIM, Cta, Nav, k, moveText, useHero, useHref, usd } from "./kit";
import { SUB } from "./H19Bands";
import s from "./h24.module.css";

// price in 12 rows, one chip a row
const ROWS = 12, GX = 260, GY = 110;
const CPX = DIE_W + GX, CPY = DIE_H + GY;
// the month: from its low (where the film starts) to today's high (top right), with a real swing back down in
// between: about 70% a year, near the 75% measured for traded H100 hours
const MOVES = [3.1, 2.4, -1.2, 4.6, 2.2, -3.8, -5.1, 1.6, 3.9, -1.4, 4.2, 2.8, -2.2, 5.1, 3.6, 6.4];
const UPW = [0.8, 1.6, 2.2, 0.9, 1.4, 0.6, 1.1, 2.4, 0.7, 1.8, 0.9, 1.2, 2.0, 0.6, 1.0, 0.5];
const DNW = [1.2, 0.7, 0.9, 1.8, 2.6, 1.1, 0.8, 1.9, 1.4, 0.6, 1.3, 0.9, 0.7, 1.5, 0.8, 1.0];
// the half-month before it (the wide layouts), ending where the month starts. Landscape: higher, then a slide into the
// month's low, so the faded days stand above the headline and the low lands just past it. Horizon: lower, a slow
// climb, so the whole band rises from the bottom left under the headline.
const LAND_BEFORE = [1.8, 2.6, -1.4, 2.2, -2.9, 1.1, 2.4, -1.8, 0.9, -2.6, 1.7, -1.2, -2.4, -1.9, -5.6, -6.8];
const HOR_BEFORE = [2.1, -1.3, 3.4, 1.2, -2.2, 2.8, 1.9, -0.8, 2.6, -1.9, 1.4, 3.1, -1.1, 2.3, -2.7, 1.6];
// the field's longer history (enough for a wide screen): another half-month before the half-month, kept inside the same
// range so the month keeps its rows. 48 days in all, so the shader's days (one vec4 each, plus the tape's place) stay
// inside the 64 uniform vectors some phones allow
const FIELD_BEFORE = [2.7, -2.6, 1.9, -3.4, -2.2, 1.5, 2.8, -1.7, 3.3, 1.2, -2.5, 2.4, -1.6, 1.8, -2.2, 1.6, ...LAND_BEFORE];
const BEFORE_UPW = [1.1, 0.7, 1.6, 0.9, 2.1, 0.8, 1.3, 0.6, 1.9, 1.0, 0.7, 1.5, 0.9, 1.2, 0.8, 1.4];
const BEFORE_DNW = [0.9, 1.4, 0.8, 1.7, 1.0, 2.2, 0.7, 1.3, 0.9, 1.8, 1.1, 0.8, 1.6, 1.0, 2.3, 1.5];

/** each day as (top row, chips (negative when the day fell), high y, low y); the month starts at 2.40 */
function chart(before: number[]) {
  const moves = [...before, ...MOVES];
  // (the wicks of the days before repeat every 16 days, counted back from the month, so a longer history ends the same)
  const back = (a: number[]) => before.map((_, i) => a[(((i - before.length) % 16) + 16) % 16]);
  const upw = [...back(BEFORE_UPW), ...UPW], dnw = [...back(BEFORE_DNW), ...DNW];
  const n = moves.length;
  let p = 2.4 / before.reduce((a, m) => a * (1 + m / 100), 1);
  const days = moves.map((m, i) => {
    const o = p, c = p * (1 + m / 100);
    p = c;
    return { o, c, h: Math.max(o, c) * (1 + upw[i] / 100), l: Math.min(o, c) * (1 - dnw[i] / 100) };
  });
  const lo = Math.min(...days.map((d) => d.l)), hi = Math.max(...days.map((d) => d.h));
  const step = (hi - lo) / ROWS;
  const row = (v: number) => Math.min(ROWS - 1, Math.max(0, Math.floor((hi - v) / step)));
  const yAt = (v: number) => ((hi - v) / step) * CPY;
  const cand = new Float32Array(n * 4);
  days.forEach((d, i) => {
    const top = row(Math.max(d.o, d.c)), rows = row(Math.min(d.o, d.c)) - top + 1;
    cand.set([top, d.c >= d.o ? rows : -rows, yAt(d.h), yAt(d.l)], i * 4);
  });
  // the lowest chip of day kf, and its first cell's place
  const bottomRow = (kf: number) => cand[kf * 4] + Math.abs(cand[kf * 4 + 1]) - 1;
  const focusOf = (kf: number) => [kf * CPX + GX / 2 + FCX, bottomRow(kf) * CPY + FCY] as const;
  // (the live tape) one more day as the chart draws it, from its open, close, high and low
  const entry = (o: number, c: number, h: number, l: number) => {
    const top = row(Math.max(o, c)), rows = row(Math.min(o, c)) - top + 1;
    return [top, c >= o ? rows : -rows, yAt(h), yAt(l)];
  };
  return { n, month: before.length, cand, bottomRow, focusOf, height: ROWS * CPY, lo, hi, close: p, entry };
}

// the live tape's clock (seconds): the rest after the film, the glide after a day closes, a tick (one chip), a chip's
// power on
const TAPE_REST = 1.0, TAPE_GLIDE = 1.0, TAPE_TICK = 1.0, TAPE_FADE = 0.45;
// the empty columns after today's day on the field (the first is where the live day forms)
const TAPE_ROOM = 3;

export type ChipLayout = "solo" | "land" | "horizon" | "field" | "sheet";
const LAND = chart(LAND_BEFORE), FIELD = chart(FIELD_BEFORE);

/** Where the last frame put the board, for the story below the hero (it dives into the chip that is trading now): the
 *  world's origin on screen and its scale in CSS pixels, and that chip's column and row; ready once the film has
 *  settled. The story holds the tape while it dives (hold), and hears of every frame drawn (onDraw). */
export const heroView: { ox: number; oy: number; sc: number; k: number; r: number; ready: boolean; hold: boolean; onDraw: (() => void) | null } = {
  ox: 0,
  oy: 0,
  sc: 0,
  k: -1,
  r: -1,
  ready: false,
  hold: false,
  onDraw: null,
};
/** A chip's place on the hero's canvas, in its CSS pixels: [left, top, width, height]. */
export function heroTile(k: number, r: number) {
  const { ox, oy, sc } = heroView;
  return [(k * CPX + GX / 2 - ox) * sc, (r * CPY - oy) * sc, DIE_W * sc, DIE_H * sc] as const;
}
const CHARTS: Record<ChipLayout, ReturnType<typeof chart>> = { solo: chart([]), land: LAND, horizon: chart(HOR_BEFORE), field: FIELD, sheet: chart([]) };

// the film's clock (seconds after the loading beat)
const HOLD = 1.1, Z0 = 0.3, ZD = 5.9, T_TEXT = 5.3, END = Z0 + ZD;
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const zoomAt = (t: number) => smooth(Math.pow(Math.min(1, Math.max(0, (t - Z0) / ZD)), 0.75));

// the first chips, in one ink: the die's dark field, its ring and interfaces as faint outlines, every core an 8 x 8
// grid of clean cells that light in diagonal waves
const MONO = `
vec3 dieMono(vec2 p, float px, float T, float waves, float focusDie, out float act, out float focus){
  act = 0.0;
  focus = 0.0;
  float v = 0.03;
  float edge = min(min(p.x, DIE_W - p.x), min(p.y, DIE_H - p.y));
  v += 0.09 * box1(edge, 7.0, 13.0, px);
  float side = p.x < DIE_W * 0.5 ? 30.0 : 912.0;
  float py0 = 40.0 + clamp(floor((p.y - 40.0) / 400.0), 0.0, 2.0) * 400.0;
  float mP = rect(p, vec2(side, py0), vec2(side + 58.0, py0 + 380.0), px);
  float mPi = rect(p, vec2(side + 5.0, py0 + 5.0), vec2(side + 53.0, py0 + 375.0), px);
  v += 0.05 * mPi + 0.13 * (mP - mPi);
  v += 0.045 * rect(p, vec2(GX0, TOP1 + 8.0), vec2(GX1, BOT0 - 8.0), px);
  float hf = p.y >= BOT0 ? 1.0 : 0.0;
  float y0 = hf > 0.5 ? BOT0 : TOP0;
  float mG = rect(p, vec2(GX0, y0), vec2(GX1, y0 + TOP1 - TOP0), px);
  float gx = p.x - GX0, g = clamp(floor(gx / GPC_W), 0.0, 3.0);
  gx -= g * GPC_W;
  float gy = p.y - y0;
  float c = clamp(floor((gx - LANE * 0.5) / SM_W), 0.0, 2.0), r = clamp(floor((gy - LANE * 0.5) / SM_H), 0.0, 5.0);
  vec2 sl = vec2(gx - LANE * 0.5 - c * SM_W, gy - LANE * 0.5 - r * SM_H);
  v += 0.06 * mG * rect(sl, vec2(PAD, L1_Y), vec2(SM_W - PAD, L1_Y + L1_H), px);
  float qx = step(PAD * 1.5 + CORE, sl.x), qy = step(PAD * 1.5 + CORE, sl.y);
  vec2 cl = sl - vec2(PAD + qx * (CORE + PAD), PAD + qy * (CORE + PAD));
  float mC = mG * rect(cl, vec2(0.0), vec2(CORE), px);
  if (mC > 0.0) {
    vec2 ij = clamp(floor(cl / CELL), 0.0, 7.0);
    vec2 lp = cl - ij * CELL;
    float n = ((hf * 4.0 + g) * 6.0 + r) * 3.0 + c, q = qx + qy * 2.0;
    vec2 so = vec2(GX0 + g * GPC_W + LANE * 0.5 + c * SM_W, y0 + LANE * 0.5 + r * SM_H);
    float ph = ((so.x + so.y * 0.8) / DIE_W) * 1.7 + fract(n * 0.6180339) * 0.25 + q * 0.37;
    float w = isOff(n) ? 0.0 : wave(T, ij.x + ij.y, ph) * waves;
    act = w * mC;
    // a cell with its gap; once a cell is smaller than a pixel, its average (the gap would otherwise eat it)
    float gap = min(max(CELL * 0.08, px * 0.8), CELL * 0.2);
    float cell = mix(rect(lp, vec2(gap * 0.5), vec2(CELL - gap * 0.5), px), pow(1.0 - gap / CELL, 2.0), smoothstep(CELL * 0.4, CELL * 1.2, px));
    float lit = isOff(n) ? 0.12 : 0.42 + 0.58 * w;
    v = mix(v, 0.03 + cell * lit, mC);
    if (focusDie > 0.5 && abs(n - FOCUS_N) < 0.5 && abs(q - FOCUS_Q) < 0.5 && abs(ij.x - FJ) < 0.5 && abs(ij.y - FI) < 0.5)
      focus = mC * cell;
  }
  return vec3(0.86, 0.9, 1.0) * v;
}
`;

const frag = (N: number) => `
precision highp float;
uniform vec2 uRes, uOrg, uFL;
uniform float uSc, uFilm, uR, uRunIn, uFlash, uWait, uWaves, uKMin, uFK, uFR, uOld, uStep, uMono, uLight, uWick, uFloor, uInk, uField, uCut, uTape, uTickK, uTickR, uTickA;
uniform vec4 uCutN, uCutT;
uniform vec4 uC[${N}];
const float CPX = ${CPX.toFixed(1)}, CPY = ${CPY.toFixed(1)}, GX = ${GX.toFixed(1)}, GY = ${GY.toFixed(1)}, NC = ${N.toFixed(1)};
const float LOW = 0.12;

${SILICON}
${MONO}

float band(float y, float a, float b, float s){ return smoothstep(a - s, a + s, y) * (1.0 - smoothstep(b - s, b + s, y)); }

// the page's own ink and ground (the app's #17171a on #f6f5f1, #f2f0ea on #141413)
vec3 inkC(){ return uLight > 0.5 ? vec3(0.09, 0.09, 0.102) : vec3(0.949, 0.941, 0.918); }
vec3 groundC(){ return uLight > 0.5 ? vec3(0.965, 0.961, 0.945) : vec3(0.078, 0.078, 0.075); }

// a die as a flat print (the field's chips): the I/O ring, the memory interfaces, the GPCs' SMs and the L2 band as
// plain shapes, cheap enough to fill the screen; rim is its outline
float diePrint(vec2 p, float px, out float rim){
  float inD = rect(p, vec2(0.0), vec2(DIE_W, DIE_H), px);
  float b = max(px * 1.3, 8.0);
  rim = inD - rect(p, vec2(b), vec2(DIE_W - b, DIE_H - b), px);
  if (inD <= 0.0) return 0.0;
  float side = p.x < DIE_W * 0.5 ? 30.0 : 912.0;
  float py0 = 40.0 + clamp(floor((p.y - 40.0) / 400.0), 0.0, 2.0) * 400.0;
  float st = 0.6 * rect(p, vec2(side, py0), vec2(side + 58.0, py0 + 380.0), px);
  st += 0.4 * rect(p, vec2(GX0, TOP1 + 8.0), vec2(GX1, BOT0 - 8.0), px);
  float y0 = p.y >= BOT0 ? BOT0 : TOP0;
  float mG = rect(p, vec2(GX0, y0), vec2(GX1, y0 + TOP1 - TOP0), px);
  float gx = p.x - GX0, g = clamp(floor(gx / GPC_W), 0.0, 3.0);
  gx -= g * GPC_W;
  float gy = p.y - y0;
  float c = clamp(floor((gx - LANE * 0.5) / SM_W), 0.0, 2.0), r = clamp(floor((gy - LANE * 0.5) / SM_H), 0.0, 5.0);
  vec2 sl = vec2(gx - LANE * 0.5 - c * SM_W, gy - LANE * 0.5 - r * SM_H);
  st += mG * rect(sl, vec2(PAD * 2.0), vec2(SM_W, SM_H) - PAD * 2.0, px);
  return min(st, 1.0) * inD;
}

// the field: a chip at every place of the chart's grid, unpowered, as faint as a watermark; they come up from the first
// chip outward while the camera pulls back
float overlap(vec4 a, vec4 b){ return step(b.x, a.z) * step(a.x, b.z) * step(b.y, a.w) * step(a.y, b.w); }
// how much of a chip lies inside a box across (its rows are in or out whole): the words' box falls on the board's
// columns at rest, so a chip is all in or all out, and one gliding under its edge fades as it goes
float cover(vec4 a, vec4 b){ return clamp((min(a.z, b.z) - max(a.x, b.x)) / max(1.0, a.z - a.x), 0.0, 1.0) * step(b.y, a.w) * step(a.y, b.w); }

vec4 field(vec2 p, float px){
  float k = floor(p.x / CPX), r = floor(p.y / CPY);
  vec2 lp = vec2(p.x - k * CPX - GX * 0.5, p.y - r * CPY);
  float rim;
  float st = diePrint(lp, px, rim);
  float inD = rect(lp, vec2(0.0), vec2(DIE_W, DIE_H), px);
  if (inD <= 0.0) return vec4(0.0);
  float d = length(vec2(k - uFK, r - uFR));
  float on = smoothstep(0.7 + d * 0.075, 1.4 + d * 0.075, uFilm);
  vec3 col = uInk > 0.5 ? inkC() : uLight > 0.5 ? vec3(0.3, 0.31, 0.34) : uMono > 0.5 ? vec3(0.6, 0.63, 0.7) : vec3(0.62, 0.6, 0.56);
  float a = uLight > 0.5 ? 0.035 * inD + 0.05 * st + 0.15 * rim : 0.03 * inD + 0.04 * st + 0.13 * rim;
  // the board makes room for the words: a chip under the top bar or
  // behind the headline and its buttons switches off, whole, as the words come in (in no set order, like a board
  // powering down part of itself)
  vec2 c0 = (vec2(k * CPX + GX * 0.5, r * CPY) - uOrg) * uSc;
  vec4 cb = vec4(c0, c0 + vec2(DIE_W, DIE_H) * uSc);
  float gone = max(overlap(cb, uCutN), cover(cb, uCutT)) * clamp(uCut * 1.8 - hash(vec2(k, r) + 3.1) * 0.8, 0.0, 1.0);
  return vec4(col * a, a) * on * (1.0 - gone);
}

// the centre of the SM a point of the die lies in, or (-1, -1) outside the compute blocks
vec2 smOf(vec2 p){
  if (p.x < GX0 || p.x > GX1 || p.y < TOP0 || p.y > BOT0 + TOP1 - TOP0 || (p.y > TOP1 && p.y < BOT0)) return vec2(-1.0);
  float y0 = p.y >= BOT0 ? BOT0 : TOP0;
  float g = clamp(floor((p.x - GX0) / GPC_W), 0.0, 3.0);
  float c = clamp(floor((p.x - GX0 - g * GPC_W - LANE * 0.5) / SM_W), 0.0, 2.0);
  float r = clamp(floor((p.y - y0 - LANE * 0.5) / SM_H), 0.0, 5.0);
  return vec2(GX0 + g * GPC_W + LANE * 0.5 + (c + 0.5) * SM_W, y0 + LANE * 0.5 + (r + 0.5) * SM_H);
}

// the chart at a point of the world, premultiplied (px: the size of a pixel there; larger draws it softer)
vec4 scene(vec2 p, float px){
  float k = floor(p.x / CPX);
  if (k < uKMin - 0.5 || k > NC - 0.5) return vec4(0.0);
  vec4 cd = vec4(0.0);
  for (int i = 0; i < ${N}; i++) {
    if (abs(float(i) - k) < 0.5) {
      cd = uC[i];
      break;
    }
  }
  float rTop = cd.x, n = abs(cd.y), rBot = rTop + n - 1.0;
  bool up = cd.y > 0.0;
  // the days come in outward from the first one: those after it to its right as time runs, and (landscape) the days
  // before it to its left
  float lane = k - uFK;
  bool first = abs(lane) < 0.5;
  float tIn = 2.5 + abs(lane) * 0.07 * uStep, tS = 3.2 + abs(lane) * 0.06 * uStep;
  float appear = first ? 1.0 : smoothstep(tIn, tIn + 0.5, uFilm);
  // (the live tape) the oldest day on screen goes as it leaves; an empty place (today's, before it opens) is ground
  if (abs(k - uKMin) < 0.5) appear *= 1.0 - uTape;
  if (abs(cd.y) < 0.5) return vec4(0.0);
  if (appear <= 0.0) return vec4(0.0);
  // each column comes in with its lowest chip on the first chip's row, rises to its own price, powers on, and grows
  // its wick
  float slide = smoothstep(0.0, 1.0, (uFilm - tS) / 0.9);
  float off = (uFR - rBot) * CPY * (1.0 - slide);
  float power = first ? 1.0 : smoothstep(tS + 0.55, tS + 0.95, uFilm);
  float wk = smoothstep(tS + 0.7, tS + 1.1, uFilm) * uWick;

  float lx = p.x - k * CPX - GX * 0.5, yy = p.y - off;
  float r = floor(yy / CPY);
  vec2 lp = vec2(lx, yy - r * CPY);
  float inBody = step(rTop - 0.5, r) * step(r, rTop + n - 0.5);
  float inChip = inBody * rect(lp, vec2(0.0), vec2(DIE_W, DIE_H), px);
  // (the live tape) today's newest chip powering on: it shows, then lights
  float tk = (abs(k - uTickK) < 0.5 && abs(r - uTickR) < 0.5) ? uTickA : 1.0;
  float tkS = smoothstep(0.0, 0.4, tk);
  inChip *= tkS;
  float isFocus = (first && abs(r - rBot) < 0.5) ? 1.0 : 0.0;
  // the first day's other chips power on one after another above the first, once it is fully on
  float colPower = first ? smoothstep(2.0, 2.5, uFilm) : power;
  if (first && isFocus < 0.5) power = smoothstep(1.95 + (rBot - r) * 0.12, 2.3 + (rBot - r) * 0.12, uFilm);

  vec3 col = vec3(0.0);
  float act = 0.0, focus = 0.0;
  if (inChip > 0.0) {
    vec3 dc = uMono > 0.5 || uInk > 0.5 ? dieMono(lp, px, uFilm, uWaves, isFocus, act, focus) : die(lp, px, uFilm, uWaves, isFocus, act, focus);
    // the first chip powers on by its own parts (not a lamp's soft circle): the first core's cells one by one, then
    // whole SMs as the front reaches them, then the ring and the interfaces in blocks
    float dq, w;
    vec2 smP = smOf(lp), smF = smOf(uFL);
    if (smP.x < 0.0) {
      vec2 qi = floor(lp / 90.0);
      dq = length((qi + 0.5) * 90.0 - uFL) + hash(qi + 7.0) * 60.0;
      w = 60.0;
    } else if (length(smP - smF) < 1.0) {
      vec2 sl = lp - smP + vec2(SM_W, SM_H) * 0.5;
      vec2 cq = vec2(step(PAD * 1.5 + CORE, sl.x), step(PAD * 1.5 + CORE, sl.y));
      vec2 co = smP - vec2(SM_W, SM_H) * 0.5 + PAD + cq * (CORE + PAD);
      vec2 ij = floor((lp - co) / CELL);
      dq = length(co + (ij + 0.5) * CELL - uFL);
      w = CELL;
    } else {
      dq = length(smP - uFL) + hash(smP) * SM_W * 0.4;
      w = SM_W * 0.5;
    }
    float run = uRunIn * (1.0 - smoothstep(uR - w, uR, dq));
    // a falling day's chips stay half lit on a dark page, unpowered (a pale print) on a light one
    float lit = up ? 1.0 : uLight > 0.5 ? LOW : 0.38;
    // (the first chip, once fully on, settles to its own day: a falling first day dims back with the rest of its stack)
    float L = isFocus > 0.5 ? mix(max(LOW, run), lit, smoothstep(2.4, 3.2, uFilm)) : mix(LOW, lit, power);
    L = mix(LOW, L, smoothstep(0.3, 1.0, tk));
    float b = max(px * 1.3, 8.0);
    float rim = 1.0 - rect(lp, vec2(b), vec2(DIE_W - b, DIE_H - b), px);
    if (uInk > 0.5) {
      // ink: one colour, the page's own. Unpowered, a chip is a faint outline; a rising day's chip is printed solid with
      // its cores a shade lighter, a falling day's is drawn hollow; the first chip runs solid, then settles to its day
      float v = dc.g / 0.9, bi = max(px * 1.6, 10.0);
      float rimI = 1.0 - rect(lp, vec2(bi), vec2(DIE_W - bi, DIE_H - bi), px);
      vec3 I = inkC(), G = groundC();
      vec3 ghost = mix(G, I, 0.05 * v + rimI * 0.3);
      vec3 solid = mix(I, G, 0.2 * v + act * 0.3);
      vec3 hollow = mix(G, I, 0.08 * v + rimI);
      float on = isFocus > 0.5 ? clamp((max(LOW, run) - LOW) / (1.0 - LOW), 0.0, 1.0) : 0.0;
      float settle = (isFocus > 0.5 ? smoothstep(2.4, 3.2, uFilm) : power) * smoothstep(0.3, 1.0, tk);
      col = mix(mix(ghost, solid, on), up ? solid : hollow, settle);
      col = mix(col, I, uWait * 0.8 * focus);
      col = mix(col, I, uFlash * focus);
    } else if (uLight > 0.5) {
      // light: unpowered silicon is a pale grey print of itself; power brings its colour (a die photo on a white page)
      float lum = dot(dc, vec3(0.3, 0.55, 0.15));
      vec3 ghost = mix(vec3(0.7, 0.705, 0.715), vec3(0.925, 0.925, 0.915), smoothstep(0.0, 0.45, lum));
      vec3 on = dc * 1.08 + (dc * 1.25 + vec3(0.05, 0.045, 0.035)) * act * 0.6;
      if (uMono > 0.5) on += vec3(0.86, 0.9, 1.0) * act * 0.35;
      col = mix(ghost, on, clamp((L - LOW) / (1.0 - LOW), 0.0, 1.0));
      // a falling day's print carries an ink edge (drawn hollow)
      if (!up) col = mix(col, vec3(0.22, 0.22, 0.24), rim * power * 0.85);
      col = mix(col, uMono > 0.5 ? vec3(0.3, 0.33, 0.4) : vec3(0.93, 0.6, 0.22), uWait * 0.85 * focus);
      col = mix(col, uMono > 0.5 ? vec3(0.12, 0.13, 0.16) : vec3(1.0, 0.72, 0.3), uFlash * focus);
    } else {
      col = dc * (0.04 + 0.96 * L);
      col += (col * 1.25 + vec3(0.05, 0.045, 0.035)) * act * 0.6 * L;
      if (uMono > 0.5) col += vec3(0.86, 0.9, 1.0) * act * 0.35 * L;
      // the one-ink die is mostly dark field: a powered rising chip burns brighter so it reads from across the page
      if (uMono > 0.5 && up) col *= 1.0 + 1.3 * power;
      // a rising day's chips run a little warm; a falling day's are cool, dark, with a lit edge (drawn hollow)
      vec3 warm = uMono > 0.5 ? vec3(0.03) : vec3(0.06, 0.045, 0.025);
      if (up) col += warm * power + vec3(0.07) * rim * power;
      else {
        col *= mix(vec3(1.0), uMono > 0.5 ? vec3(1.0) : vec3(0.84, 0.9, 1.1), power);
        col = mix(col, uMono > 0.5 ? vec3(0.62, 0.65, 0.72) : vec3(0.5, 0.52, 0.6), rim * power * 0.8);
      }
      // the first cell: a slow breath while the page loads, then the flash
      col = mix(col, uMono > 0.5 ? vec3(0.95, 0.97, 1.0) : vec3(1.0, 0.86, 0.64), uWait * 0.8 * focus);
      col = mix(col, vec3(1.0, 0.95, 0.88), uFlash * focus);
    }
  }
  // the wick: a hairline from the body to the day's high and low, behind nothing
  float ww = min(26.0, px * 1.1), dx = abs(lx - DIE_W * 0.5);
  float bodyTop = rTop * CPY, bodyBot = (rTop + n) * CPY - GY, sw = max(px * 0.75, 10.0);
  float wick = (1.0 - smoothstep(ww - px * 0.6, ww + px * 0.6, dx)) * (band(yy, mix(bodyTop, cd.z, wk), bodyTop, sw) + band(yy, bodyBot, mix(bodyBot, cd.w, wk), sw));
  wick *= step(0.001, wk) * (1.0 - inChip);
  vec3 wc = uInk > 0.5 ? inkC() : uLight > 0.5 ? vec3(0.3, 0.3, 0.32) : uMono > 0.5 ? vec3(0.78, 0.8, 0.86) : vec3(0.82, 0.78, 0.7);
  // dark: a powered stack gives off a little light into the dark round it; light: every stack casts a soft shadow,
  // a little below it (its own column only)
  float ox = max(max(-lx, lx - DIE_W), 0.0), oy = max(max(bodyTop - yy, yy - bodyBot), 0.0);
  float oys = max(max(bodyTop + 40.0 - yy, yy - bodyBot - 40.0), 0.0);
  // (gone before the edge of the column's slot, so no seam where the next column begins)
  float slotFade = 1.0 - smoothstep(GX * 0.2, GX * 0.5, ox);
  // (ink is flat: no light, no shadow)
  float glow = uInk > 0.5 ? 0.0 : slotFade * (uLight > 0.5
    ? (1.0 - inChip) * 0.09 * exp(-length(vec2(ox, oys)) / 70.0)
    : (1.0 - inChip) * (up ? 1.0 : 0.3) * colPower * 0.07 * exp(-length(vec2(ox, oy)) / 140.0));
  // (its shadow or glow comes in with the newest chip, not before it)
  glow *= tkS;
  vec3 gc = uLight > 0.5 ? vec3(0.0) : uMono > 0.5 ? vec3(0.8, 0.85, 1.0) : vec3(1.0, 0.78, 0.5);
  float a = max(inChip, wick) * appear;
  vec3 rgb = mix(col, wc, wick) * a + gc * glow * appear * (1.0 - a);
  float al = max(a, glow * appear);
  // (landscape) the days before the month fall back into the ground, the oldest furthest (measured where the column is
  // on screen, so a gliding tape dims its days smoothly as they move left)
  float kk = k - uTape;
  float old = uOld > 0.5 ? 1.0 - smoothstep(uOld - 1.0, uOld, kk) : 0.0;
  if (old > 0.0) {
    float f = mix(1.0, max(0.0, mix(0.2, 0.62, (kk - uKMin) / max(1.0, uOld - 1.0 - uKMin))), old);
    rgb *= f;
    al *= f;
  }
  return vec4(rgb, al);
}

void main(){
  vec2 p = uOrg + vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uSc;
  float px = 1.0 / uSc;
  vec4 c = scene(p, px);
  if (uField > 0.5) c += field(p, px) * (1.0 - c.a);
  // (the wide layouts) a dark glass floor under the chart: the chips and their light, mirrored, softer, fading away
  if (uFloor > 0.0 && p.y > uFloor) {
    float f = (uLight > 0.5 ? 0.14 : 0.22) * exp(-(p.y - uFloor) / 1100.0);
    if (f > 0.004) c += scene(vec2(p.x, 2.0 * uFloor - p.y), px * 3.0) * f * (1.0 - c.a);
  }
  c.rgb += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0 * c.a;
  gl_FragColor = c;
}`;

export type ChipLook = "real" | "mono";

export function H24Chips({ look = "real", layout = "solo" }: { look?: ChipLook; layout?: ChipLayout }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLElement>(null);
  const head = useRef<HTMLHeadingElement>(null);
  const [shown, setShown] = useState(false);
  const to = useHref();
  const words = CLAIM.split(" ");
  const lines = [words.slice(0, -1).join(" "), words[words.length - 1]];
  const wide = layout !== "solo";
  // the app's own theme, and the wicks, colour and older-days choices; a switch redraws the settled frame and never
  // replays the film
  const { config } = useMock();
  const tone = config.theme;
  const opening = config.intro;
  const light = useRef(tone === "light");
  light.current = tone === "light";
  const wick = useRef(config.wicks === "on");
  wick.current = config.wicks === "on";
  const mono = useRef(false), ink = useRef(false);
  mono.current = look === "mono" || config.chipColor === "mono";
  ink.current = !mono.current && config.chipColor === "ink";
  const fade = useRef(true);
  fade.current = config.oldDays === "faded";
  // the live tape, switched without replaying the film
  const live = useRef(true);
  live.current = config.chartMotion === "live";
  // the field's room for the words, and the top bar's links
  const cut = useRef(false);
  cut.current = layout === "field" && config.boardCut === "on";
  const place = layout === "field" ? config.heroWords : "low";
  const wordsAt = useRef(place);
  wordsAt.current = place;
  const acts = useRef<HTMLDivElement>(null);
  // the sheet's first window (a phone's chart sits in it)
  const win = useRef<HTMLDivElement>(null);
  const sheet = layout === "sheet";
  const board = layout === "field" || sheet;

  useEffect(() => {
    const c = cv.current, el = box.current;
    if (!c || !el) return;
    const C = CHARTS[layout];
    let drawnLight = light.current, drawnWick = wick.current, drawnMono = mono.current, drawnInk = ink.current, drawnFade = fade.current, drawnCut = cut.current, drawnWords = wordsAt.current;
    const still = stillMode();
    const q = new URLSearchParams(window.location.search).get("t");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // where the film stands: before 0 it is the loading beat; a still frame or reduced motion starts at the rest
    let film = still ? (q !== null ? Number(q) || 0 : END) : reduce ? END : -1;
    let go = film >= 0, speed = 1, last = performance.now();
    const born = last;
    let fontsIn = false, textOn = false;
    // the landing's loading screen goes first (when the Opening row has it): the film waits until it lifts, then holds
    // its cell a moment as the screen fades off it (a fallback starts it anyway if no screen ever shows: one that is up
    // always leaves on its own clock)
    const afterLoader = opening === "fold" && !still;
    const loaderOff = (now: number) => {
      const at = loaderLeftAt();
      return !afterLoader || (at > 0 && now - at > LOADER_LEAVE * 900) || (!loaderUp() && now - born > 9000);
    };
    document.fonts.ready.then(() => (fontsIn = true));
    // (a replay, the Opening row switched, starts with the words away again)
    setShown(film >= T_TEXT);
    if (film >= T_TEXT) textOn = true;

    // skip: any scroll, click or key during the film runs it out fast instead of cutting
    const skip = () => {
      if (film < END) {
        // (under the loading screen it only hurries: the film still starts once the screen has lifted)
        if (loaderOff(performance.now())) go = true;
        speed = 6;
      }
    };
    window.addEventListener("wheel", skip, { passive: true });
    window.addEventListener("keydown", skip);
    window.addEventListener("touchstart", skip, { passive: true });
    el.addEventListener("pointerdown", skip);

    // where the headline ends, so the solo chart sits in the room beside it at any width
    const range = document.createRange();
    // (the story below the hero zooms the whole hero while it dives into a chip: measures are taken back to the
    // canvas's own pixels, so the chart never moves under the zoom)
    const zoomOf = (cr: DOMRect) => (c.clientWidth > 0 ? cr.width / c.clientWidth : 1) || 1;
    const headEnd = () => {
      const h = head.current;
      if (!h) return 0;
      const cr = c.getBoundingClientRect(), f = zoomOf(cr);
      let end = 0;
      for (const line of Array.from(h.children)) {
        range.selectNodeContents(line);
        end = Math.max(end, (range.getBoundingClientRect().right - cr.left) / f);
      }
      return end;
    };

    // the headline and its buttons at their resting place, in the canvas's CSS pixels (they rise into place: their
    // transform is taken back out)
    const at = (e: Element | null) => {
      if (!e) return null;
      const cr = c.getBoundingClientRect(), r = e.getBoundingClientRect(), tf = getComputedStyle(e).transform, f = zoomOf(cr);
      const ty = tf && tf !== "none" ? new DOMMatrixReadOnly(tf).m42 : 0;
      return [(r.left - cr.left) / f, (r.top - cr.top) / f - ty, (r.right - cr.left) / f, (r.bottom - cr.top) / f - ty];
    };
    const textBox = () => {
      const hd = at(head.current), ac = at(acts.current);
      if (!hd) return null;
      return ac ? [Math.min(hd[0], ac[0]), Math.min(hd[1], ac[1]), Math.max(hd[2], ac[2]), Math.max(hd[3], ac[3])] : hd;
    };

    // the live tape (the field): once the film has settled the
    // market keeps trading, a chip at a time, at the chart's end: in the first empty place after today's day a new day opens with one chip at yesterday's close and
    // goes one way only, up or down, a chip
    // powering on each tick. Then the day closes and the board glides one column left, so the chart's end stays where
    // it was and the next day opens in the same place. Which way a day goes leans back toward the middle rows, so the
    // chart never leaves them. The glide moves the camera; at its end the days shift down a slot: the same picture.
    const tape = layout === "field";
    const days = new Float32Array((C.n + 1) * 4);
    days.set(C.cand);
    const todayAt = C.n * 4;
    // the forming day: its open and current rows, the rows it has reached, its way (-1 up, the top row is 0), its
    // ticks; the chip powering on
    let open = 0, cur = 0, hiR = 0, loR = 0, way = -1, ticks = 0, tickMax = 0;
    let phase: "rest" | "glide" | "tick" = "rest", tl = 0, tLast = performance.now(), glide = 0;
    let fadeR = -10, fadeA = 1, fading = false, shifted = false, formed = false;
    // today's day in its place: rows a to b, rising or falling by its way from the open
    const setDay = (a: number, b: number) => {
      const top = Math.min(a, b), rows = Math.abs(a - b) + 1;
      days.set([top, way < 0 ? rows : -rows, hiR * CPY, (loR + 1) * CPY - GY], todayAt);
      shifted = true;
    };
    const closeRow = (i: number) => (days[i * 4 + 1] > 0 ? days[i * 4] : days[i * 4] + Math.abs(days[i * 4 + 1]) - 1);
    // one more chip, the day's way
    const tick = () => {
      cur += way;
      [hiR, loR] = [Math.min(hiR, cur), Math.max(loR, cur)];
      setDay(open, cur);
      [fadeR, fadeA, fading] = [cur, 0, true];
    };
    // a new day in the first empty place, opening with one chip at the last day's close; its way leans back toward the
    // middle rows, and it never runs past the chart's top or bottom
    const openDay = () => {
      open = cur = hiR = loR = closeRow(C.n - 1);
      formed = true;
      way = Math.random() < 0.5 + (open - 5.5) * 0.09 ? -1 : 1;
      if ((way < 0 && open === 0) || (way > 0 && open === ROWS - 1)) way = -way;
      [ticks, tickMax] = [0, Math.min(1 + Math.floor(Math.random() * 3), way < 0 ? open : ROWS - 1 - open)];
      setDay(open, cur);
      [fadeR, fadeA, fading] = [open, 0, true];
      [phase, tl] = ["tick", 0];
    };
    const stepTape = (dt: number) => {
      tl += dt;
      if (fading) {
        fadeA = Math.min(1, fadeA + dt / TAPE_FADE);
        // (its last frame is always drawn, whatever the frame cap skipped)
        if (fadeA >= 1) [fading, shifted] = [false, true];
      }
      if (phase === "rest" && tl >= TAPE_REST) openDay();
      else if (phase === "glide") {
        glide = smooth(Math.min(1, tl / TAPE_GLIDE));
        if (tl >= TAPE_GLIDE) {
          // the shift: the day that formed joins the chart, its place is empty again, and the next day opens there
          days.copyWithin(0, 4);
          days.fill(0, C.n * 4);
          glide = 0;
          openDay();
        }
      } else if (phase === "tick" && tl >= TAPE_TICK) {
        tl = 0;
        if (ticks < tickMax) {
          tick();
          ticks++;
        } else phase = "glide";
      }
    };
    // (a still check can show one moment of it: ?tape= seconds of trading after the film, then ?glide=0..1)
    const tq = new URLSearchParams(window.location.search);
    if (tape && still && tq.get("tape") !== null) {
      for (let x = 0; x < Math.min(120, Number(tq.get("tape")) || 0); x += 0.05) stepTape(0.05);
      if (tq.get("glide") !== null) glide = Math.min(1, Math.max(0, Number(tq.get("glide")) || 0));
    }
    // (held while the story dives into the board: it pauses where it is, and picks up again without catching up)
    const moving = () => !heroView.hold && (phase === "glide" || fading);
    const tapeTick = (now: number) => {
      const dt = Math.min(0.05, (now - tLast) / 1000);
      tLast = now;
      if (!tape || still || film < END || heroView.hold) return;
      if (!live.current) {
        // (switched off: it settles where it is)
        if (moving()) [glide, fading, fadeA, shifted] = [0, false, 1, true];
        if (phase === "glide") {
          // (mid-glide: the shift happens now, so the day that formed joins the chart and the next opens at its close)
          days.copyWithin(0, 4);
          days.fill(0, C.n * 4);
          [phase, tl, formed] = ["rest", 0, false];
        }
        return;
      }
      stepTape(dt);
    };

    // ?fps=1: the frames actually drawn each second, shown in a corner (a measuring aid, never on by default)
    let drawn = 0, probe: HTMLDivElement | null = null, probeTimer = 0;
    if (new URLSearchParams(window.location.search).get("fps") === "1") {
      probe = document.createElement("div");
      probe.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:9999;padding:6px 10px;font:500 15px/1.2 ui-monospace,monospace;background:#17171a;color:#f6f5f1;border-radius:2px;pointer-events:none";
      document.body.appendChild(probe);
      let t0 = performance.now();
      probeTimer = window.setInterval(() => {
        const now = performance.now();
        if (probe) probe.textContent = `${Math.round((drawn * 1000) / (now - t0))} fps drawn`;
        [drawn, t0] = [0, now];
      }, 1000);
    }

    let stop = () => {};
    let gone = false;
    const start = () => {
      if (gone) return;
      stop = runShader(c, {
        frag: frag(tape ? C.n + 1 : C.n),
        still,
        // sharp on a Retina screen (a soft canvas steps pixel to pixel as the board glides), within a pixel budget: a
        // laptop gets 2x, a large external screen steps down toward the old 1.25x, a phone keeps 1.5x
        dprMax: Math.max(1, Math.min(window.innerWidth < 760 ? 1.5 : 2, Math.sqrt(6e6 / Math.max(1, c.clientWidth * c.clientHeight)))),
        setup: (gl, _p, U) => {
          gl.uniform2f(U("uFL"), FCX, FCY);
          gl.uniform4fv(U("uC"), tape ? days : C.cand);
          gl.uniform1f(U("uField"), layout === "field" || layout === "sheet" ? 1 : 0);
        },
        idle: () => {
          tapeTick(performance.now());
          // (while the tape moves, every frame the screen shows: 120 a second on a 120 Hz screen)
          if (moving()) return false;
          if (shifted) return false;
          return film >= END && drawnLight === light.current && drawnWick === wick.current && drawnMono === mono.current && drawnInk === ink.current && drawnFade === fade.current && drawnCut === cut.current && drawnWords === wordsAt.current;
        },
        frame: (gl, U, _t, w, h) => {
          drawn++;
          drawnLight = light.current;
          drawnWick = wick.current;
          drawnMono = mono.current;
          drawnInk = ink.current;
          drawnFade = fade.current;
          drawnCut = cut.current;
          drawnWords = wordsAt.current;
          gl.uniform1f(U("uLight"), drawnLight ? 1 : 0);
          gl.uniform1f(U("uMono"), drawnMono ? 1 : 0);
          gl.uniform1f(U("uInk"), drawnInk ? 1 : 0);
          gl.uniform1f(U("uWick"), drawnWick ? 1 : 0);
          const now = performance.now();
          const dt = Math.min(0.05, (now - last) / 1000);
          last = now;
          // the loading beat ends once the fonts are in and the cell has been seen for a moment
          if (!go && !still && fontsIn && now - born > HOLD * 1000 && loaderOff(now)) {
            go = true;
            film = 0;
          }
          if (go && !still && film < END) film = Math.min(END, film + dt * speed);
          if (!textOn && film >= T_TEXT) {
            textOn = true;
            setShown(true);
          }
          const t = film;
          const W = c.clientWidth || w, H = c.clientHeight || h, dpr = w / W;

          // a phone shows the month's last nine days above the words, from a rising day on the bottom row
          const narrow = W < 760;
          // the first day on screen, and the day the film starts in (its lowest chip): landscape (and the field) starts
          // in the month's low, with the faded half-month before it to its left
          let kVis = narrow ? C.n - 9 : 0;
          const kF = narrow ? kVis : C === LAND || C === FIELD ? C.month : 0;
          const [fx, fy] = C.focusOf(kF);
          const x1w = C.n * CPX - GX / 2, chartH = C.height;
          let x0w = kVis * CPX + GX / 2, chartW = x1w - x0w;
          let s1: number, ccx: number, ccy: number;
          const pane = layout === "sheet" && narrow ? at(win.current) : null;
          if (pane) {
            // a phone's sheet: the chart in its first window, under the words
            s1 = Math.min((pane[2] - pane[0] - 32) / chartW, (pane[3] - pane[1] - 32) / chartH);
            ccx = (pane[0] + pane[2]) / 2;
            ccy = (pane[1] + pane[3]) / 2;
          } else if (narrow) {
            // (the live tape: one more place at the right for the day that forms, the whole centred)
            const extra = tape ? CPX : 0;
            s1 = Math.min((W - 40) / (chartW + extra), (H * 0.44) / chartH);
            ccx = W / 2 - (extra * s1) / 2;
            ccy = H * 0.33;
          } else {
            let xa: number, xb: number, ya: number, yb: number;
            if (wide) {
              // edge to edge on the page's own gutters, clear of the top bar, with room for the floor below (the field
              // has none: its board runs to the bottom edge)
              const g = Math.min(56, Math.max(16, W * 0.04));
              xa = g;
              xb = W - g;
              ya = layout === "horizon" ? 124 : 112;
              yb = H - (layout === "field" ? 96 : 170);
              // the sheet: the month under its right half, from the bottom window (where it started) up through the
              // price tape to the top windows (where it got to)
              if (layout === "sheet") {
                const bar = at(el.querySelector("header"));
                xa = W / 2 + 28;
                ya = (bar ? bar[3] : 80) + 28;
                yb = H - 28;
              }
              // the field's words up top: the chart is a band under them
              const tb = drawnWords !== "low" ? textBox() : null;
              if (tb) {
                ya = Math.max(ya, tb[3] + 44);
                yb = H - 56;
              }
            } else {
              // clear of the top bar above and the headline on the left
              // (the first day sits low on the left, beside the headline's end: a little more room there)
              xa = Math.max(W * 0.4, headEnd() + 128);
              xb = W - Math.min(72, W * 0.045);
              ya = 112;
              yb = H - 72;
            }
            if (C === FIELD) {
              // the band's height sets the size (never so big the month does not fit across); the days before run off
              // the left edge, and today's day ends a few columns in from the right one: the live tape's day forms there
              s1 = Math.min((yb - ya) / chartH, W / ((C.n - kF + TAPE_ROOM) * CPX));
              // (a very wide or very short band would need more days than there are: the chart grows instead, so the
              // days still reach the left edge)
              s1 = Math.max(s1, W / ((C.n - 2 + TAPE_ROOM) * CPX));
              const room = TAPE_ROOM * CPX * s1;
              kVis = Math.max(0, C.n - Math.ceil((W - room) / (CPX * s1)) - 1);
              x0w = kVis * CPX + GX / 2;
              chartW = x1w - x0w;
              ccx = W - room - (x1w + GX / 2 - (x0w + x1w) / 2) * s1;
            } else {
              s1 = Math.min((xb - xa) / chartW, (yb - ya) / chartH);
              ccx = (xa + xb) / 2;
            }
            ccy = (ya + yb) / 2;
          }
          // the first cell's place at the rest, and at the start
          const P1x = ccx + (fx - (x0w + x1w) / 2) * s1, P1y = ccy + (fy - chartH / 2) * s1;
          const P0x = W / 2, P0y = H * (narrow ? 0.42 : 0.46);
          const s0 = Math.min(W * 0.3, narrow ? 120 : 200) / CELL;
          const z = t < 0 ? 0 : zoomAt(t);
          const sc = Math.exp(Math.log(s0) + (Math.log(s1) - Math.log(s0)) * z);
          const wz = Math.pow(z, 1.5);
          const px0 = P0x + (P1x - P0x) * wz, py0 = P0y + (P1y - P0y) * wz;
          // the days come in over the same time however many there are
          const lanes = Math.max(kF - kVis, C.n - 1 - kF);

          // the light's timing
          const tt = Math.max(0, t);
          // the loading beat: the cell breathes, slowly (a standby light, not a spinner)
          const wait = t < 0 ? 0.25 + 0.55 * (0.5 - 0.5 * Math.cos(((now - born) / 1000) * Math.PI * 1.25)) : 0.55 * (1 - smooth(t / 0.25));
          const flash = t < 0 ? 0 : 0.75 * Math.exp(-(((t - 0.12) / 0.28) ** 2));
          const R = Math.min(2200, CELL * 0.5 * Math.exp(2.3 * Math.max(0, t - 0.08)));

          gl.uniform2f(U("uRes"), w, h);
          // (the live tape glides the camera one column right, so the board and its chart move left)
          gl.uniform2f(U("uOrg"), fx - px0 / sc + glide * CPX, fy - py0 / sc);
          // (for the story below: the board's place, and the chip trading now: the forming day's newest chip, or the
          // last day's close)
          heroView.ox = fx - px0 / sc + glide * CPX;
          heroView.oy = fy - py0 / sc;
          heroView.sc = sc;
          [heroView.k, heroView.r] = tape && formed ? [C.n, cur] : [C.n - 1, closeRow(C.n - 1)];
          heroView.ready = film >= END;
          heroView.onDraw?.();
          if (shifted) {
            gl.uniform4fv(U("uC"), days);
            shifted = false;
          }
          gl.uniform1f(U("uTape"), glide);
          gl.uniform1f(U("uTickK"), tape ? C.n : -10);
          gl.uniform1f(U("uTickR"), fadeR);
          gl.uniform1f(U("uTickA"), fadeA);
          gl.uniform1f(U("uFK"), kF);
          gl.uniform1f(U("uFR"), C.bottomRow(kF));
          gl.uniform1f(U("uOld"), narrow || (C !== LAND && C !== FIELD) || !drawnFade ? 0 : C.month);
          gl.uniform1f(U("uStep"), Math.min(1, 15 / Math.max(1, lanes)));
          gl.uniform1f(U("uFloor"), wide && layout !== "field" && layout !== "sheet" ? chartH + 160 : 0);
          gl.uniform1f(U("uSc"), sc * dpr);
          gl.uniform1f(U("uFilm"), tt);
          gl.uniform1f(U("uR"), t < 0 ? 0 : R);
          gl.uniform1f(U("uRunIn"), t < 0 ? 0 : smooth(t / 0.35));
          gl.uniform1f(U("uFlash"), flash);
          gl.uniform1f(U("uWait"), wait);
          gl.uniform1f(U("uWaves"), 1 - smooth((tt - 2.6) / 2));
          gl.uniform1f(U("uKMin"), kVis);
          // where the words and the top bar are, in the canvas's own pixels (y down), at their resting place (the
          // words rise into place: their transform is taken back out)
          let cn = [0, 0, 0, 0], ct = [0, 0, 0, 0];
          if (drawnCut) {
            const bar = at(el.querySelector("header")), u = textBox();
            if (bar) cn = [0, 0, W, bar[3] + 4].map((v) => v * dpr);
            // low on the left, a clear corner: from the left edge to a little past the headline's end, from just above
            // it to the bottom; up top, a clear block round the words (whole chips go, so its edges fall on the
            // board's own lines)
            if (u) {
              ct = drawnWords === "low" ? [0, u[1] - 20, u[2] + 36, H] : [u[0] - 36, u[1] - 20, u[2] + 36, u[3] + 20];
              // (its sides out to the board's own column lines, where the camera rests)
              const ox = fx - px0 / sc, col = (x: number) => (x / sc + ox) / CPX;
              ct[0] = (Math.floor(col(ct[0])) * CPX - ox) * sc;
              ct[2] = (Math.ceil(col(ct[2])) * CPX - ox) * sc;
              ct = ct.map((v) => v * dpr);
            }
          }
          gl.uniform4f(U("uCutN"), cn[0], cn[1], cn[2], cn[3]);
          gl.uniform4f(U("uCutT"), ct[0], ct[1], ct[2], ct[3]);
          gl.uniform1f(U("uCut"), drawnCut ? smooth((t - T_TEXT + 0.05) / 0.8) : 0);
        },
      });
    };
    // (no WebGL: no film, so the words come in at once)
    const startOrWords = () => {
      start();
      if (c.dataset.nogl === "1") setShown(true);
    };
    if (still) {
      // a still frame is drawn once: wait for the headline's own face (fonts.ready alone resolves before it is asked for)
      const h = head.current;
      const cs = h ? getComputedStyle(h) : null;
      const font = cs ? `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}` : "";
      (font ? document.fonts.load(font, CLAIM) : Promise.resolve([]))
        .catch(() => [])
        .then(() => document.fonts.ready)
        .then(startOrWords);
    } else startOrWords();
    return () => {
      gone = true;
      stop();
      window.clearInterval(probeTimer);
      probe?.remove();
      Object.assign(heroView, { sc: 0, k: -1, r: -1, ready: false });
      window.removeEventListener("wheel", skip);
      window.removeEventListener("keydown", skip);
      window.removeEventListener("touchstart", skip);
      el.removeEventListener("pointerdown", skip);
    };
  }, [look, layout, wide, opening]);

  return (
    <section ref={box} className={`${k.hero} ${s.hero}`} data-shown={shown ? "1" : "0"} data-tone={tone} data-layout={layout} data-cut={layout === "field" && config.boardCut === "on" ? "1" : "0"} data-words={place} data-corners={config.corners} data-textin={config.textIn}>
      <div className={s.slot}>
        <canvas ref={cv} className={s.gl} role="img" aria-label="One cell of a GPU chip lights, the camera pulls back, and a row of identical chips slides into a candlestick chart of the price of compute" />
      </div>
      <div className={s.shade} aria-hidden />
      <Nav
        dark={tone === "dark"}
        className={s.nav}
        theme
        links={wide && config.navLinks === "docs" ? "docs" : "app"}
        shape={!wide ? "split" : sheet && config.navShape === "pill" ? "center" : config.navShape}
        corners={config.corners}
      />
      {sheet ? (
        <Sheet head={head} acts={acts} win={win} lines={lines} />
      ) : (
      <div className={s.body}>
        <h1 ref={head} className={s.h1}>
          <span>{lines[0]}</span> <span>{lines[1]}</span>
        </h1>
        {wide ? (
          <div ref={acts} className={s.actions}>
            <Cta className={s.sq} />
            <Link href={to("/docs")} className={s.ghost}>
              Read the docs
            </Link>
          </div>
        ) : (
          <Cta className={`${s.cta} ${s.sq}`} />
        )}
      </div>
      )}
    </section>
  );
}

/** Direction 3's ruled sheet over the board: the words, the buttons, every GPU's price on a running tape, today's H100
 *  price, and windows onto the chart underneath. */
function Sheet({ head, acts, win, lines }: { head: React.RefObject<HTMLHeadingElement | null>; acts: React.RefObject<HTMLDivElement | null>; win: React.RefObject<HTMLDivElement | null>; lines: string[] }) {
  const r = useHero();
  const to = useHref();
  const tape = r.gpus.filter((g) => g.price > 0);
  const item = (g: (typeof tape)[number], n: number) => (
    <span key={`${g.gpu}-${n}`} className={s.tick}>
      <b>{g.gpu}</b>
      <span>{usd(g.price)}</span>
      <span className={g.change > 0.004 ? s.up : g.change < -0.004 ? s.down : s.flat}>{moveText(g.change)}</span>
    </span>
  );
  return (
    <div className={s.sheet}>
      <div className={`${s.cell} ${s.shead}`}>
        <h1 ref={head} className={s.sh1}>
          <span>{lines[0]}</span> <span>{lines[1]}</span>
        </h1>
        <div className={s.scopy}>
          <p className={s.ssub}>
            {SUB.map((l) => (
              <span key={l}>{l}</span>
            ))}
          </p>
          <div ref={acts} className={s.actions}>
            <Cta className={s.sq} />
            <Link href={to("/docs")} className={s.ghost}>
              Read the docs
            </Link>
          </div>
        </div>
      </div>
      <div ref={win} className={`${s.cell} ${s.swin} ${s.sw1}`} />
      <div className={`${s.cell} ${s.swin} ${s.sw2}`} />
      <div className={`${s.cell} ${s.stape}`} aria-label="Every GPU's price an hour today">
        <div className={s.srun}>
          {tape.map((g) => item(g, 0))}
          {tape.map((g) => item(g, 1))}
        </div>
      </div>
      <div className={`${s.cell} ${s.swin} ${s.sw3}`} />
      <div className={`${s.cell} ${s.swin} ${s.sw4}`} />
      <div className={`${s.cell} ${s.sprice}`}>
        <span className={s.slabel}>H100, an hour today</span>
        <b className={s.sbig}>{r.h.price > 0 ? usd(r.h.price) : ""}</b>
        <span className={s.slabel}>{r.m ? `Lock in ${r.month} at ${usd(r.m.long)}` : "One open price, from the clouds that rent it"}</span>
      </div>
    </div>
  );
}

/** The same film in the first chips' one-ink look. */
export function H24ChipsMono() {
  return <H24Chips look="mono" />;
}

/** The chart as the whole scene (layout 1). */
export function H24ChipsLand() {
  return <H24Chips layout="land" />;
}

/** The headline up top, the chart a band below (layout 2). */
export function H24ChipsHorizon() {
  return <H24Chips layout="horizon" />;
}

/** Direction 3's ruled sheet, its windows onto the board and the chart. */
export function H24ChipsSheet() {
  return <H24Chips layout="sheet" />;
}

/** Landscape on a board of chips: the chart is the chips that are on. */
export function H24ChipsField() {
  return <H24Chips layout="field" />;
}
