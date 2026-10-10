"use client";
// Hero "One H100 hour" (Oct 8). The pick of the three compute heroes, with a smoother transition and
// no explaining: no numbers and no captions, only
// the motion. One cell of a tensor core flashes, the light runs out through the core, and the camera pulls back in one
// eased move (no stops on the way) through the compute unit to the whole die: 132 of its 144 compute units on, 528
// tensor cores, each an 8 x 8 array of datapath tiles lit in diagonal waves. It rests on the die, dives back to the
// cell, and the light settles into that one cell again.
// Then true chip colours, more realistic: the die is drawn the way a
// microscope sees one, by a fragment shader, its colours read off a real die shot of GA100 (the A100's die, H100's
// parent; CC BY 3.0 on Wikimedia Commons). Logic is standard-cell rows (bright power rails, cells of every width, vias)
// under cloudy slate, periwinkle, teal and bronze; SRAM is bit-line arrays in sub-arrays; the memory interfaces are gold
// driver rows; the I/O ring has its pads and the seal ring at the very edge. Every detail is box-filtered to the pixel,
// so it resolves as the camera comes close and settles to its true average far off, as in a real micrograph.
import { useEffect, useRef, useState } from "react";
import { stillMode } from "@/components/lab/data";
import { runShader } from "./gl";
import { CELL, DIE_H, DIE_W, FCX, FCY, SILICON } from "./silicon";
import { CLAIM, Cta, Nav, k } from "./kit";
import s from "./h15.module.css";

const LOOP = 24;
const FRAG = `
precision highp float;
uniform vec2 uRes, uOrg, uF;
uniform float uSc, uT, uR, uRunIn, uFlat, uFlash, uWait;
const float LOW = 0.12;

${SILICON}
void main(){
  vec2 p = uOrg + vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uSc;
  float px = 1.0 / uSc;
  float aDie = rect(p, vec2(0.0), vec2(DIE_W, DIE_H), px);
  if (aDie <= 0.0) { gl_FragColor = vec4(0.0); return; }

  float act, focus;
  vec3 col = die(p, px, uT, 1.0, 1.0, act, focus);

  // across the die the films are a touch thicker or thinner, so the colour drifts a little
  float drift = noise(p / 260.0) - 0.5;
  col *= 1.0 + vec3(0.1, -0.05, 0.08) * drift;

  // the lamp: dim while the first cell waits, then running out from it; the compute waves are metal catching it
  float d = length(p - uF);
  float L = uFlat >= 0.0 ? uFlat : LOW + (1.0 - LOW) * (1.0 - smoothstep(0.0, 1.0, (d - uR) / max(CELL * 0.8, uR * 0.5))) * uRunIn;
  col *= 0.05 + 0.95 * L;
  col += (col * 1.25 + vec3(0.05, 0.045, 0.035)) * act * 0.6 * L;
  col += vec3(0.1, 0.1, 0.11) * uWait * focus;
  col = mix(col, vec3(1.0, 0.95, 0.86), uFlash * focus);
  col += vec3(1.0, 0.8, 0.52) * uFlash * 0.45 * exp(-d / (CELL * 0.8)) * (1.0 - focus);
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  gl_FragColor = vec4(col * aDie, aDie);
}`;

// a diagonal wave and the light, timed exactly as before (only the drawing changed)
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

// the camera: 0 on the first cell, 1 on the whole die. Each move is half a cosine, so it only slows to a stop at the
// two ends and never between levels; the rest on the die breathes a little (zero speed where it meets the moves).
const OUT0 = 1.0, OUT1 = 11.0, IN0 = 14.0, IN1 = 22.2;
const zoomAt = (tau: number) =>
  tau < OUT0 || tau >= IN1 ? 0
  : tau < OUT1 ? 0.5 - 0.5 * Math.cos((Math.PI * (tau - OUT0)) / (OUT1 - OUT0))
  : tau < IN0 ? 1
  : 0.5 + 0.5 * Math.cos((Math.PI * (tau - IN0)) / (IN1 - IN0));
const breath = (tau: number) => (tau > OUT1 && tau < IN0 ? 0.05 * Math.sin((Math.PI * (tau - OUT1)) / (IN0 - OUT1)) ** 2 : 0);

// the light: low everywhere while the first cell waits, a flash in it, the light running out from it (a soft circle
// growing in world units, so it crosses the screen in about two seconds), and near the end of the dive a settle back
const LOW = 0.12, LIGHT = 0.75, HUSH0 = 21.4, HUSH1 = 23.3;
const hushAt = (tau: number) => LOW + (1 - LOW) * (1 - smooth((tau - HUSH0) / (HUSH1 - HUSH0)));
const waitAt = (tau: number) => (tau < 2 ? 0.3 * (1 - smooth((tau - 1.2) / 0.8)) : tau >= HUSH0 ? 0.3 * smooth((tau - HUSH0) / (HUSH1 - HUSH0)) : 0);
const flashAt = (tau: number) => 0.72 * Math.exp(-(((tau - 0.85) / 0.36) ** 2));

export type TitlePlace = "middle" | "low";
export type Tone = "dark" | "light";

export function H15Hour({ title = "middle", tone = "dark" }: { title?: TitlePlace; tone?: Tone }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLHeadingElement>(null);
  // a still frame is drawn once, so it waits for the headline's font (its width places the die)
  const [fonts, setFonts] = useState(false);
  useEffect(() => {
    let live = true;
    document.fonts.ready.then(() => live && setFonts(true));
    return () => {
      live = false;
    };
  }, []);
  const words = CLAIM.split(" ");
  const lines = [words.slice(0, -1).join(" "), words[words.length - 1]];

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const still = stillMode();
    // a still frame stands on the whole die unless a render check asks for another moment
    const asked = new URLSearchParams(window.location.search).get("t") !== null;
    // where the headline's longest line ends, so the die can sit in the room beside it at any width (the words run
    // wider than a fixed share of a laptop screen)
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
    const stop = runShader(c, {
      frag: FRAG,
      still,
      // the detail is drawn per pixel, so the pixel count is the cost: capped so a laptop keeps its browser light
      dprMax: 1.25,
      setup: (gl, _p, U) => gl.uniform2f(U("uF"), FCX, FCY),
      frame: (gl, U, t0, w, h) => {
        const W = c.clientWidth || w, H = c.clientHeight || h, dpr = w / W;
        const t = still && !asked ? 12.5 : t0;
        const tau = ((t % LOOP) + LOOP) % LOOP;
        const narrow = W < 900;
        // where the camera points: the middle, or right of the headline when it sits low on the left
        // (in the middle the first cell sits above the headline, so the flash is never under the words)
        const low = title === "low";
        const side = low && !narrow;
        const x0 = side ? Math.max(W * 0.4, headEnd() + 48) : 0, x1 = W - Math.min(72, W * 0.04);
        const Ax = side ? (x0 + x1) / 2 : W / 2;
        const Ay = low ? H * (narrow ? 0.4 : 0.47) : H / 2;
        const A0y = low ? Ay : H * (narrow ? 0.24 : 0.2);
        const sDie = Math.min((H * 0.84) / DIE_H, (side ? x1 - x0 : W * (narrow ? 0.9 : 0.84)) / DIE_W);
        const sCell = Math.min(W * 0.32, Math.max(100, Math.min(200, H * 0.2))) / CELL;
        const u = zoomAt(tau);
        const sc = Math.exp(Math.log(sCell) + (Math.log(sDie) - Math.log(sCell)) * u - breath(tau));
        // the first cell sits on the aim point when close; the die's centre does when wide (a zoom about a point that
        // slides with the zoom, so nothing swings off and back)
        const fx = Ax + (FCX - DIE_W / 2) * sDie * u, fy = A0y + (Ay - A0y + (FCY - DIE_H / 2) * sDie) * u;
        const R = CELL * 0.5 * Math.exp(1.25 * (tau - LIGHT));
        const flat = tau < LIGHT ? LOW : tau >= HUSH0 ? hushAt(tau) : R > 4000 ? 1 : -1;
        gl.uniform2f(U("uRes"), w, h);
        gl.uniform2f(U("uOrg"), FCX - fx / sc, FCY - fy / sc);
        gl.uniform1f(U("uSc"), sc * dpr);
        gl.uniform1f(U("uT"), t);
        gl.uniform1f(U("uR"), R);
        gl.uniform1f(U("uRunIn"), smooth((tau - LIGHT) / 0.4));
        gl.uniform1f(U("uFlat"), flat);
        gl.uniform1f(U("uFlash"), flashAt(tau));
        gl.uniform1f(U("uWait"), waitAt(tau));
      },
    });
    return stop;
  }, [title, tone, fonts]);

  return (
    <section className={`${k.hero} ${s.hero}`} data-title={title} data-tone={tone}>
      <div className={s.slot}>
        <canvas ref={cv} className={s.gl} role="img" aria-label="Inside an H100 under a microscope: one cell of a tensor core lights, the light runs through the chip, and the camera pulls back to the whole die" />
      </div>
      <div className={s.shade} aria-hidden />
      <Nav dark={tone === "dark"} />
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

/** The same hero with the headline low on the left, on a dark page and a light one, for the dock. */
export function H15HourLow() {
  return <H15Hour title="low" />;
}
export function H15HourLight() {
  return <H15Hour title="low" tone="light" />;
}
