"use client";
// Direction 3, "Agate bands" (Oct 8). What makes Liquid Compute's feel
// intended: a rigid grid of hairline cells, one texture only, confined to cells, and a band of real prices. Ours: a paper
// sheet ruled into cells; some hold the words, the rest are windows onto one stone lying underneath, so the texture is
// one object seen through cut paper. The stone is the name: an agate's bands, laid down layer by layer, printed in fine
// lines and halftone dots in one blue ink, growing slowly outward. Across the middle, every GPU's price today.
import { useEffect, useRef } from "react";
import { stillMode } from "@/components/lab/data";
import { runShader } from "./gl";
import { CLAIM, Cta, Nav, k, moveText, useHero, usd } from "./kit";
import s from "./h19.module.css";

export const SUB = ["Lock in what you pay for GPUs.", "Lock in what you earn from them.", "Or trade where the price goes."];

// the stone: a warped distance from a centre gives the rings; each ring gets its own tone (halftone dots of its own
// size), some rings are bundles of fine lines (the chalcedony layers), every ring edge is a hairline; the rings drift
// outward about one every nine seconds
const FRAG = `#extension GL_OES_standard_derivatives : enable
precision highp float;
uniform vec2 uRes;
uniform vec2 uC;
uniform float uT;
uniform float uDpr;
float h11(float n) { return fract(sin(n * 91.345) * 47453.5453); }
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * noise(p); p = p * 2.02 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}
void main() {
  vec2 px = gl_FragCoord.xy;
  float S = min(uRes.x, uRes.y);
  vec2 p = (px - uC) / S;
  float t = uT;
  // one heart, gently warped, so the rings stay nested round it (a fortification agate, not a map of islands)
  vec2 w = vec2(fbm(p * 1.0 + vec2(0.0, t * 0.01)), fbm(p * 1.0 + vec2(5.2, 1.3 - t * 0.008)));
  vec2 q = p + (w - 0.5) * 0.38;
  float d = length(q * vec2(1.0, 1.3));
  float v = d * 16.0 + 1.6 * fbm(q * 2.6 + 3.1) - t * 0.11;
  float i = floor(v);
  float f = fract(v);
  // each band is one of three kinds: a bundle of fine lines, a toned layer (halftone of its own weight), or clear
  float kind = h11(i);
  float fine = step(kind, 0.36);
  float clear = step(0.78, kind);
  float dens = mix(0.22 + 0.7 * h11(i + 5.0), 0.04, clear) * (1.0 - fine);
  float cell = 4.0 * uDpr;
  vec2 l = fract(px / cell) - 0.5;
  float r = sqrt(dens) * 0.5;
  float aa = 0.9 / cell;
  float dotc = 1.0 - smoothstep(r - aa, r + aa, length(l));
  float n = 4.0 + floor(h11(i + 9.0) * 5.0);
  float vn = v * n;
  float sn = fract(vn);
  float lines = fine * (1.0 - smoothstep(0.0, 1.2 * fwidth(vn), min(sn, 1.0 - sn)));
  float edge = (1.0 - fine) * (1.0 - smoothstep(0.0, 1.3 * fwidth(v), min(f, 1.0 - f)));
  vec3 paper = vec3(0.957, 0.953, 0.937);
  // two inks, as blue lace agate has: a deep steel blue and a softer lavender blue, chosen band by band
  vec3 ink = mix(vec3(0.16, 0.27, 0.46), vec3(0.40, 0.44, 0.66), step(0.55, h11(i + 3.0)));
  vec3 col = paper;
  col = mix(col, mix(paper, ink, 0.55), dotc);
  col = mix(col, ink, max(edge * 0.32, lines * 0.55));
  gl_FragColor = vec4(col, 1.0);
}`;

export function H19Bands() {
  const r = useHero();
  const cv = useRef<HTMLCanvasElement>(null);
  const words = CLAIM.split(" ");
  const lines = [words.slice(0, -1).join(" "), words[words.length - 1]];

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    return runShader(c, {
      frag: FRAG,
      // the motion is slow and the lines are fine: 1.25 device pixels a point keeps them crisp at about 5 ms of GPU a frame
      dprMax: 1.25,
      still: stillMode(),
      frame: (gl, U, t, w, h) => {
        gl.uniform2f(U("uRes"), w, h);
        // the stone's heart sits behind the right-hand windows (in GL, y counts up from the bottom)
        gl.uniform2f(U("uC"), w * (c.clientWidth > 900 ? 0.7 : 0.55), h * 0.6);
        gl.uniform1f(U("uT"), t);
        gl.uniform1f(U("uDpr"), w / Math.max(1, c.clientWidth));
      },
    });
  }, []);

  // every GPU's price today, twice over so the band can run without a seam
  const tape = r.gpus.filter((g) => g.price > 0);
  const item = (g: (typeof tape)[number], n: number) => (
    <span key={`${g.gpu}-${n}`} className={s.tick}>
      <b>{g.gpu}</b>
      <span className={s.num}>{usd(g.price)}</span>
      <span className={g.change > 0.004 ? s.up : g.change < -0.004 ? s.down : s.flat}>{moveText(g.change)}</span>
    </span>
  );

  return (
    <section className={`${k.hero} ${s.hero}`}>
      <canvas ref={cv} className={s.stone} aria-hidden />
      <Nav className={s.nav} />
      <div className={s.grid}>
        <div className={`${s.cell} ${s.head}`}>
          <h1 className={s.h1}>
            {lines.map((l) => (
              <span key={l}>{l}</span>
            ))}
          </h1>
          <div className={s.copy}>
            <p className={s.sub}>
              {SUB.map((l) => (
                <span key={l}>{l}</span>
              ))}
            </p>
            <Cta />
          </div>
        </div>
        <div className={`${s.cell} ${s.win} ${s.w1}`} />
        <div className={`${s.cell} ${s.win} ${s.w2}`} />
        <div className={`${s.cell} ${s.tape}`} aria-label="Every GPU's price an hour today">
          <div className={s.run}>
            {tape.map((g) => item(g, 0))}
            {tape.map((g) => item(g, 1))}
          </div>
        </div>
        <div className={`${s.cell} ${s.win} ${s.w3}`} />
        <div className={`${s.cell} ${s.win} ${s.w4}`} />
        <div className={`${s.cell} ${s.price}`}>
          <span className={s.label}>H100, an hour today</span>
          <b className={s.big}>{r.h.price > 0 ? usd(r.h.price) : ""}</b>
          <span className={s.label}>{r.m ? `Lock in ${r.month} at ${usd(r.m.long)}` : "One open price, from the clouds that rent it"}</span>
        </div>
      </div>
    </section>
  );
}
