"use client";
// The opening (Oct 8, the sequence): "some kind of loading animation like what ornn has, then we start from the
// animation first without any text or navbar, purely the animation, then it zooms out and once it's settled it stops
// moving but is still interactive", and "we compile all of this chip and make a chart out of it, chip + market".
//   1. Loading: the dark screen holds one cell of a tensor core, breathing, for at least a second (Ornn holds a beat on
//      black before its shader springs in; ours holds on the cell the film starts from).
//   2. The cell flashes, the light runs out through the die, and the camera pulls back in one move, past the die, until
//      the die is one of hundreds on a wafer.
//   3. As the wafer comes into view the dies power up in the shape of a candlestick chart, from today back: each candle
//      a column of dies, lit from its open to its close, its wick a thin trace to the day's high and low. The die the
//      film began in is the top of today's candle. Up days are lit full, down days dimmer and cooler.
//   4. The camera settles and nothing moves on its own again (the frame is not redrawn). Then the words and the top bar.
//   5. The cursor is the lamp: light pools where it is, the wafer throws a little colour round it, the candle under it
//      lifts.
// The candles are illustrative, not data: no numbers, no axis. Their shape is a 16-day walk at the volatility measured
// for traded H100 hours (about 75% a year; volatility.md), so it is honest about what the price of compute does without
// claiming to be a record. Scroll, click or a key skips to the settled frame.
import { useEffect, useRef, useState } from "react";
import { stillMode } from "@/components/lab/data";
import { runShader } from "./gl";
import { CELL, DIE_H, DIE_W, FCX, FCY, SILICON } from "./silicon";
import { CLAIM, Cta, Nav, k } from "./kit";
import s from "./h23.module.css";

// the wafer: dies on a grid with scribe lanes between them, centred on a lane crossing; a 300 mm wafer holds about
// 21 of these dies across
const SCRIBE = 64,
  PX = DIE_W + SCRIBE,
  PY = DIE_H + SCRIBE;
const WR = 11 * PX,
  EDGE = 260;
// the chart: 16 candles on the die columns -8..7, a body most of a die wide, a wick a thin trace
const N = 16,
  COL0 = -8,
  BODY = 380,
  WICK = 26;

// the 16 days, as moves from the day before (percent) and how far each day reached past its open and close (percent)
const MOVES = [
  2.1, 3.4, -1.6, 4.8, 1.2, -5.9, -8.7, -2.4, 1.9, -0.8, 3.6, 2.9, -1.7, 5.4,
  3.8, 8.2,
];
const UPW = [
  0.8, 1.6, 2.2, 0.9, 1.4, 0.6, 1.1, 2.4, 0.7, 1.8, 0.9, 1.2, 2.0, 0.6, 1.0,
  0.5,
];
const DNW = [
  1.2, 0.7, 0.9, 1.8, 2.6, 1.1, 0.8, 1.9, 1.4, 0.6, 1.3, 0.9, 0.7, 1.5, 0.8,
  1.0,
];

/** the candles in world units (y grows down): open, close, low, high, placed so the film's first cell sits at the
 *  close of the last day, and the die that holds it */
function chart() {
  let p = 2.4;
  const days = MOVES.map((m, i) => {
    const o = p,
      c = p * (1 + m / 100);
    p = c;
    return {
      o,
      c,
      h: Math.max(o, c) * (1 + UPW[i] / 100),
      l: Math.min(o, c) * (1 - DNW[i] / 100),
    };
  });
  const lo = Math.min(...days.map((d) => d.l)),
    hi = Math.max(...days.map((d) => d.h));
  const band = 8.6 * PY,
    per = band / (hi - lo),
    mid = (hi + lo) / 2;
  const y = (v: number) => -(v - mid) * per;
  // the last close lands exactly on the first cell of a die in the last column
  const yc = y(days[N - 1].c);
  const row = Math.round((yc - FCY) / PY);
  const shift = row * PY + FCY - yc;
  const cand = new Float32Array(N * 4);
  days.forEach((d, i) =>
    cand.set(
      [y(d.o) + shift, y(d.c) + shift, y(d.l) + shift, y(d.h) + shift],
      i * 4,
    ),
  );
  const fdx = (COL0 + N - 1) * PX,
    fdy = row * PY;
  return {
    cand,
    focusDie: [fdx, fdy] as const,
    focus: [fdx + FCX, fdy + FCY] as const,
  };
}
const CHART = chart();

// the film's clock (seconds after the loading beat): the flash, the pull back, the candles, the words, the rest
const HOLD = 1.1,
  Z0 = 0.3,
  ZD = 5.9,
  T_TEXT = 5.2,
  END = Z0 + ZD;
// the room before the wafer is lit: dark, the dies just readable
const LOWAMB = 0.11;
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const zoomAt = (t: number) =>
  smooth(Math.pow(Math.min(1, Math.max(0, (t - Z0) / ZD)), 0.75));

const FRAG = `
precision highp float;
uniform vec2 uRes, uOrg, uF, uFD;
uniform float uSc, uFilm, uR, uRunIn, uFlash, uWait, uDrain, uAmb, uWaves;
uniform vec4 uC[${N}];
uniform vec3 uLamp;
uniform float uLampR, uHov, uHovAmt;
const float PXW = ${PX.toFixed(1)}, PYW = ${PY.toFixed(1)}, WR = ${WR.toFixed(1)}, EDGE = ${EDGE.toFixed(1)};
const float COL0 = ${COL0.toFixed(1)}, NC = ${N.toFixed(1)}, BODY = ${BODY.toFixed(1)}, WICK = ${WICK.toFixed(1)};
const float LOW = 0.12;

${SILICON}

// white light split by wavelength (Zucconi's fit), for the colour a patterned surface throws near the lamp
vec3 bump3(vec3 x, vec3 y){ return clamp(1.0 - x * x - y, 0.0, 1.0); }
vec3 spectral(float nm){
  float x = (nm - 400.0) / 300.0;
  if (x <= 0.0 || x >= 1.0) return vec3(0.0);
  return bump3(vec3(3.54585104, 2.93225262, 2.41593945) * (x - vec3(0.69549072, 0.49228336, 0.27699880)), vec3(0.02312639, 0.15225084, 0.52607955))
       + bump3(vec3(3.90307140, 3.21182957, 3.96587128) * (x - vec3(0.11748627, 0.86755042, 0.66077860)), vec3(0.84897130, 0.88445281, 0.73949448));
}
float band(float y, float a, float b, float s){ return smoothstep(a - s, a + s, y) * (1.0 - smoothstep(b - s, b + s, y)); }

void main(){
  vec2 p = uOrg + vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uSc;
  float px = 1.0 / uSc;
  float r = length(p);
  // the wafer, with its notch at the bottom
  float notch = 1.0 - smoothstep(-px, px, 300.0 - (abs(p.x) * 1.4 + (WR - p.y)));
  float aW = (1.0 - smoothstep(WR - px, WR + px, r)) * notch;
  if (aW <= 0.0) { gl_FragColor = vec4(0.0); return; }

  vec2 cellI = floor(p / vec2(PXW, PYW));
  vec2 lp = p - cellI * vec2(PXW, PYW);
  float printed = 1.0 - smoothstep(WR - EDGE - px, WR - EDGE + px, r);
  float inDie = rect(lp, vec2(0.0), vec2(DIE_W, DIE_H), px) * printed;
  float isFocusDie = (abs(cellI.x * PXW - uFD.x) < 1.0 && abs(cellI.y * PYW - uFD.y) < 1.0) ? 1.0 : 0.0;

  // bare polished silicon: the edge ring a dark mirror, the scribe lanes between the dies a little brighter (that grid
  // of fine light lines is what makes a wafer read as a wafer)
  vec3 bare = vec3(0.04, 0.043, 0.052) + vec3(0.075, 0.078, 0.09) * printed;
  float act = 0.0, focus = 0.0;
  vec3 col = bare;
  if (inDie > 0.0) col = mix(bare, die(lp, px, uFilm, uWaves, isFocusDie, act, focus), inDie);
  // the films are a touch thicker or thinner across the wafer, so each die's colour drifts a little
  col *= 1.0 + vec3(0.09, -0.04, 0.08) * (noise(p / 7000.0) - 0.5) * 2.0 * inDie;

  // the chart: which candle's column this is, and how much of it is powered now
  float ix = cellI.x, kc = ix - COL0;
  float upBody = 0.0, dnBody = 0.0, dnEdge = 0.0, wickL = 0.0, glow = 0.0, inShape = 0.0, hov = 0.0;
  if (kc >= 0.0 && kc < NC) {
    vec4 cd = vec4(0.0);
    for (int i = 0; i < ${N}; i++) if (abs(float(i) - kc) < 0.5) cd = uC[i];
    float cx = ix * PXW + DIE_W * 0.5, dx = abs(p.x - cx);
    bool up = cd.y < cd.x;
    float tk = 3.0 + (NC - 1.0 - kc) * 0.085;
    float pk = smoothstep(tk, tk + 0.55, uFilm), wk = smoothstep(tk + 0.25, tk + 0.8, uFilm);
    float soft = max(px * 0.75, 14.0);
    // the body fills from the open toward the close; the wick grows out of it to the day's high and low
    float fill = mix(cd.x, cd.y, pk);
    float y0 = min(cd.x, fill), y1 = max(cd.x, fill);
    float body = (1.0 - smoothstep(BODY - soft, BODY + soft, dx)) * band(p.y, y0, y1, soft) * step(0.001, pk);
    // a wick is a hairline at any zoom: about two pixels, never the width of a bar
    float ww = min(WICK, px * 1.1);
    float wick = (1.0 - smoothstep(ww - px * 0.6, ww + px * 0.6, dx)) * band(p.y, mix(min(cd.x, cd.y), cd.w, wk), mix(max(cd.x, cd.y), cd.z, wk), soft) * step(0.001, wk);
    hov = abs(kc - uHov) < 0.5 ? uHovAmt : 0.0;
    // a lit body glows a little past its edge, inside its own column (the light the powered silicon gives off)
    float ox = max(dx - BODY, 0.0), oy = max(max(y0 - p.y, p.y - y1), 0.0);
    glow = step(0.001, pk) * exp(-length(vec2(ox, oy)) / 260.0) * (1.0 - body) * (up ? 1.0 : 0.35);
    if (up) upBody = body;
    else {
      dnBody = body;
      // a falling day is drawn hollow: a bright edge round a dim body
      float e = max(px * 1.2, 34.0);
      dnEdge = body * (1.0 - (1.0 - smoothstep(BODY - e - soft, BODY - e + soft, dx)) * band(p.y, y0 + e, y1 - e, soft));
    }
    wickL = wick;
    inShape = max(body, wick);
  }

  // the light: the run from the first cell (inside its own die, later draining into today's candle), the room
  float d = length(p - uF);
  float run = uRunIn * isFocusDie * (1.0 - smoothstep(0.0, 1.0, (d - uR) / max(CELL * 0.8, uR * 0.45)));
  run *= mix(1.0, inShape * step(NC - 1.5, kc), uDrain);
  float L = max(uAmb, run);
  // the lamp: the cursor's pool of light, in screen space
  float dl = length(gl_FragCoord.xy - uLamp.xy);
  float pool = uLamp.z * exp(-pow(dl / uLampR, 2.0));
  L += pool * 0.75;
  vec3 base = col;
  col *= 0.04 + 0.96 * L;
  col += (col * 1.25 + vec3(0.05, 0.045, 0.035)) * act * 0.6 * L;
  // powered dies: a rising day lit warm and full, a falling day cool and low with its bright edge; the wick a fine
  // bright trace; the candle under the lamp lifts
  vec3 warm = base * (1.2 + 0.3 * hov) + vec3(0.32, 0.25, 0.15) * (1.0 + 0.4 * hov);
  vec3 cool = base * (0.62 + 0.25 * hov) * vec3(0.84, 0.9, 1.1) + vec3(0.015, 0.02, 0.04);
  col = mix(col, warm, upBody);
  col = mix(col, cool, dnBody);
  col = mix(col, base * 1.2 + vec3(0.1, 0.1, 0.13), dnEdge * 0.85);
  col = mix(col, vec3(0.86, 0.8, 0.7) + 0.1 * hov, wickL * 0.9);
  col += vec3(1.0, 0.72, 0.42) * 0.07 * glow * (1.0 + hov);
  // the wafer's die arrays split the studio light into colour: a slow rainbow across the disc, ringed round where the
  // lamp's reflection would sit (upper left), like any wafer on a bench
  float lum = dot(base, vec3(0.3, 0.5, 0.2));
  float lampD = length(p / WR - vec2(-0.75, -0.9));
  col += spectral(400.0 + 300.0 * clamp((lampD - 0.45) / 1.75, 0.0, 1.0)) * 0.12 * (0.3 + lum * 1.4) * inDie * (1.0 - inShape) * smoothstep(0.12, 0.26, uAmb);
  // and near the cursor's lamp, a faint arc of its own, stronger where the pattern is brighter
  float arc = smoothstep(0.25, 0.55, dl / uLampR) * (1.0 - smoothstep(1.1, 1.9, dl / uLampR));
  col += spectral(430.0 + 250.0 * clamp((dl / uLampR - 0.4) / 1.3, 0.0, 1.0)) * 0.28 * (0.25 + lum) * arc * uLamp.z * inDie;
  // the first cell: a slow breath while the page loads, then the flash
  col = mix(col, vec3(1.0, 0.86, 0.64), uWait * 0.8 * focus);
  col += vec3(1.0, 0.78, 0.48) * uWait * 0.5 * exp(-d / (CELL * 1.5)) * (1.0 - focus) * isFocusDie;
  col = mix(col, vec3(1.0, 0.95, 0.86), uFlash * focus);
  col += vec3(1.0, 0.8, 0.52) * uFlash * 0.45 * exp(-d / (CELL * 0.8)) * (1.0 - focus);
  // the softbox across the polished wafer, and its bevel catching the room
  float sheen = exp(-pow((dot(p / WR, normalize(vec2(0.8, -0.6))) - 0.35) / 0.28, 2.0));
  col += vec3(0.05, 0.055, 0.065) * sheen * (1.0 - 0.6 * inDie) * smoothstep(0.08, 0.2, uAmb);
  col += vec3(0.16, 0.16, 0.18) * band(r, WR - 90.0, WR - 20.0, max(px, 12.0)) * smoothstep(0.1, 0.2, uAmb);
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  gl_FragColor = vec4(col * aW, aW);
}`;

export function H23Open() {
  const cv = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLElement>(null);
  const head = useRef<HTMLHeadingElement>(null);
  const [shown, setShown] = useState(false);
  const words = CLAIM.split(" ");
  const lines = [words.slice(0, -1).join(" "), words[words.length - 1]];

  useEffect(() => {
    const c = cv.current,
      el = box.current;
    if (!c || !el) return;
    const still = stillMode();
    const q = new URLSearchParams(window.location.search).get("t");
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    // where the film stands: before 0 it is the loading beat; a still frame or reduced motion starts at the rest
    let film = still ? (q !== null ? Number(q) || 0 : END) : reduce ? END : -1;
    let go = film >= 0,
      speed = 1,
      last = performance.now();
    const born = last;
    let fontsIn = false,
      textOn = false;
    document.fonts.ready.then(() => (fontsIn = true));
    if (film >= T_TEXT) {
      textOn = true;
      setShown(true);
    }

    // skip: any scroll, click or key during the film runs it out fast instead of cutting
    const skip = () => {
      if (film < END) {
        go = true;
        speed = 6;
      }
    };
    window.addEventListener("wheel", skip, { passive: true });
    window.addEventListener("keydown", skip);
    window.addEventListener("touchstart", skip, { passive: true });
    el.addEventListener("pointerdown", skip);

    // the lamp follows the cursor once the film has settled
    const lamp = {
      x: 0,
      y: 0,
      a: 0,
      tx: 0,
      ty: 0,
      ta: 0,
      hov: -1,
      ha: 0,
      th: -1,
    };
    let cam = { s: 1, px: 0, py: 0 };
    const move = (e: PointerEvent) => {
      if (e.pointerType === "touch" && film < END) return;
      const b = c.getBoundingClientRect();
      lamp.tx = e.clientX - b.left;
      lamp.ty = e.clientY - b.top;
      lamp.ta = film >= END ? 1 : 0;
      // the candle under the cursor: its column, and the cursor within its day's range
      const wx = CHART.focus[0] + (lamp.tx - cam.px) / cam.s,
        wy = CHART.focus[1] + (lamp.ty - cam.py) / cam.s;
      const kc = Math.floor(wx / PX) - COL0;
      let th = -1;
      if (kc >= 0 && kc < N) {
        const cx = (kc + COL0) * PX + DIE_W / 2;
        const lo = CHART.cand[kc * 4 + 2],
          hi = CHART.cand[kc * 4 + 3];
        if (Math.abs(wx - cx) < BODY * 1.3 && wy > hi - 500 && wy < lo + 500)
          th = kc;
      }
      lamp.th = th;
    };
    const leave = () => {
      lamp.ta = 0;
      lamp.th = -1;
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    const lampQ = still
      ? new URLSearchParams(window.location.search).get("lamp")
      : null;

    // where the die sits beside the words (measured, so a laptop's wider headline never runs into it)
    const range = document.createRange();
    const headEnd = () => {
      const h = head.current;
      if (!h) return 0;
      const left = c.getBoundingClientRect().left;
      let end = 0;
      for (const line of Array.from(h.children)) {
        range.selectNodeContents(line);
        end = Math.max(end, range.getBoundingClientRect().right - left);
      }
      return end;
    };

    // a still frame is drawn once, so it waits for the headline's font (its width places the wafer); live, the film
    // measures every frame and its loading beat already waits for the font
    let stop = () => {};
    let gone = false;
    const start = () => {
      if (gone) return;
      stop = runShader(c, {
        frag: FRAG,
        still,
        dprMax: 1.25,
        setup: (gl, _p, U) => {
          gl.uniform2f(U("uF"), CHART.focus[0], CHART.focus[1]);
          gl.uniform2f(U("uFD"), CHART.focusDie[0], CHART.focusDie[1]);
          gl.uniform4fv(U("uC"), CHART.cand);
        },
        idle: () =>
          film >= END &&
          Math.abs(lamp.a - lamp.ta) < 0.002 &&
          Math.abs(lamp.tx - lamp.x) < 0.3 &&
          Math.abs(lamp.ty - lamp.y) < 0.3 &&
          Math.abs(lamp.ha - (lamp.th >= 0 ? 1 : 0)) < 0.002,
        frame: (gl, U, _t, w, h) => {
          const now = performance.now();
          const dt = Math.min(0.05, (now - last) / 1000);
          last = now;
          // the loading beat ends once the fonts are in and the cell has been seen for a moment
          if (!go && !still && fontsIn && now - born > HOLD * 1000) {
            go = true;
            film = 0;
          }
          if (go && !still && film < END)
            film = Math.min(END, film + dt * speed);
          if (!textOn && film >= T_TEXT) {
            textOn = true;
            setShown(true);
          }
          const t = film;
          const W = c.clientWidth || w,
            H = c.clientHeight || h,
            dpr = w / W;

          // the rest: the whole wafer, beside the words on a wide screen, above them on a phone
          const narrow = W < 760;
          // on a wide screen the wafer's left rim keeps clear of the headline's end, and the chart of the screen's right
          // edge: R (the rim, at the headline's height) + 0.76 R (the chart's half width) must fit beside it
          const he = narrow ? 0 : headEnd();
          const Rr = narrow
            ? W * 0.65
            : Math.min(H * 0.45, W * 0.31, (W - 72 - he) / 1.76);
          const s1 = Rr / WR;
          const half = (-COL0 * PX + BODY) * s1;
          const cx = narrow
            ? W / 2
            : Math.min(W - half - 40, Math.max(W / 2, he + 32 + Rr));
          const cy = narrow ? H * 0.36 : H * 0.5;
          // the first cell's place at the rest, and at the start (the middle of the screen)
          const P1x = cx + CHART.focus[0] * s1,
            P1y = cy + CHART.focus[1] * s1;
          const P0x = W / 2,
            P0y = H * (narrow ? 0.42 : 0.46);
          const s0 = Math.min(W * 0.3, narrow ? 120 : 200) / CELL;
          const z = t < 0 ? 0 : zoomAt(t);
          const sc = Math.exp(Math.log(s0) + (Math.log(s1) - Math.log(s0)) * z);
          const wz = Math.pow(z, 1.5);
          const px0 = P0x + (P1x - P0x) * wz,
            py0 = P0y + (P1y - P0y) * wz;
          cam = { s: sc, px: px0, py: py0 };
          if (lampQ && film >= END) {
            const [lx, ly] = lampQ.split(",").map(Number);
            const b = c.getBoundingClientRect();
            move({
              clientX: b.left + lx * W,
              clientY: b.top + ly * H,
              pointerType: "mouse",
            } as PointerEvent);
            lamp.x = lamp.tx;
            lamp.y = lamp.ty;
            lamp.a = 1;
            lamp.hov = lamp.th;
            lamp.ha = lamp.th >= 0 ? 1 : 0;
          }

          // the light's timing
          const tt = Math.max(0, t);
          // the loading beat: the cell breathes, slowly (a standby light, not a spinner)
          const wait =
            t < 0
              ? 0.25 +
                0.55 *
                  (0.5 - 0.5 * Math.cos(((now - born) / 1000) * Math.PI * 1.25))
              : 0.55 * (1 - smooth(t / 0.25));
          const flash =
            t < 0 ? 0 : 0.75 * Math.exp(-(((t - 0.12) / 0.28) ** 2));
          const R = Math.min(
            1700,
            CELL * 0.5 * Math.exp(2.3 * Math.max(0, t - 0.08)),
          );

          // the lamp eases toward the cursor; the candle under it lifts
          lamp.x += (lamp.tx - lamp.x) * 0.2;
          lamp.y += (lamp.ty - lamp.y) * 0.2;
          lamp.a += (lamp.ta - lamp.a) * 0.12;
          if (lamp.th >= 0) lamp.hov = lamp.th;
          lamp.ha += ((lamp.th >= 0 ? 1 : 0) - lamp.ha) * 0.16;

          gl.uniform2f(U("uRes"), w, h);
          gl.uniform2f(
            U("uOrg"),
            CHART.focus[0] - px0 / sc,
            CHART.focus[1] - py0 / sc,
          );
          gl.uniform1f(U("uSc"), sc * dpr);
          gl.uniform1f(U("uFilm"), tt);
          gl.uniform1f(U("uR"), t < 0 ? 0 : R);
          gl.uniform1f(U("uRunIn"), t < 0 ? 0 : smooth(t / 0.35));
          gl.uniform1f(U("uFlash"), flash);
          gl.uniform1f(U("uWait"), wait);
          gl.uniform1f(U("uDrain"), smooth((tt - 3.3) / 1.3));
          gl.uniform1f(
            U("uAmb"),
            LOWAMB + (0.3 - LOWAMB) * smooth((tt - 2.4) / 2.4),
          );
          gl.uniform1f(U("uWaves"), 1 - smooth((tt - 2.6) / 2));
          gl.uniform3f(U("uLamp"), lamp.x * dpr, h - lamp.y * dpr, lamp.a);
          gl.uniform1f(U("uLampR"), Math.min(W, H) * 0.13 * dpr);
          gl.uniform1f(U("uHov"), lamp.hov);
          gl.uniform1f(U("uHovAmt"), lamp.ha);
        },
      });
    };
    if (still) {
      // fonts.ready resolves at once when a face has not started loading, so ask for the headline's own face
      const h = head.current;
      const cs = h ? getComputedStyle(h) : null;
      const font = cs ? `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}` : "";
      (font ? document.fonts.load(font, CLAIM) : Promise.resolve([])).catch(() => []).then(() => document.fonts.ready).then(start);
    }
    else start();
    return () => {
      gone = true;
      stop();
      window.removeEventListener("wheel", skip);
      window.removeEventListener("keydown", skip);
      window.removeEventListener("touchstart", skip);
      el.removeEventListener("pointerdown", skip);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, []);

  return (
    <section
      ref={box}
      className={`${k.hero} ${s.hero}`}
      data-shown={shown ? "1" : "0"}
    >
      <div className={s.slot}>
        <canvas
          ref={cv}
          className={s.gl}
          role="img"
          aria-label="One cell of a GPU lights, the camera pulls back past its chip to a whole wafer, and the wafer's chips light up as a candlestick chart of the price of compute"
        />
      </div>
      <div className={s.shade} aria-hidden />
      <Nav dark className={s.nav} />
      <div className={s.body}>
        <h1 ref={head} className={s.h1}>
          {lines.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </h1>
        <Cta className={s.cta} />
      </div>
    </section>
  );
}
