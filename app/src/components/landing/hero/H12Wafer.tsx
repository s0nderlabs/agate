"use client";
// Hero "The wafer" (Oct 8): where compute comes from. A 300 mm silicon wafer
// lying in a dark studio, slowly turning, drawn by one fragment shader. Its dies are H100-sized (26 by 33 mm, so about
// sixty whole ones and the cut-off ones round the edge). The colour is physics, not paint: each part of a die is a fine
// grating (the L2 cache finest, the SMs a little coarser, the HBM interfaces and the I/O ring coarsest), and the shader splits the
// studio's lamps into their first-order colours by the grating equation (optics.ts), so the bands sit where a real
// wafer would throw them and sweep as it turns. Point at a die and it is outlined with what an hour of it costs.
import { useEffect, useRef, useState } from "react";
import { stillMode } from "@/components/lab/data";
import { runShader, trackPointer } from "./gl";
import { OPTICS, cross, norm, setStudio, studio, type V3 } from "./optics";
import { CLAIM, Cta, Nav, Rotator, k, useHero, useSide, usd } from "./kit";
import s from "./h12.module.css";

// wafer radius = 1 (150 mm): a 26 x 33 mm die and a 0.6 mm street; dies are printed up to the 3 mm edge exclusion
const PITCH = [0.1773, 0.224];
const HALF = [0.0867, 0.11];
const FIELD = 0.97;

const FRAG = `
#extension GL_OES_standard_derivatives : enable
precision highp float;
uniform vec2 uRes;
uniform float uIntro, uSpin, uFocal, uShift, uExpo;
uniform vec3 uRo, uFw, uRt, uUp;
uniform vec3 uHover; // die id x, y, and how lit the outline is (0 to 1)

const vec2 PITCH = vec2(${PITCH[0]}, ${PITCH[1]});
const vec2 HALF = vec2(${HALF[0]}, ${HALF[1]});
const float FIELD = ${FIELD};

vec2 rot(vec2 p, float a){ float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
${OPTICS}
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec2 sv = uv - vec2(uShift, 0.0);
  vec3 rd = normalize(uFw * uFocal + sv.x * uRt + sv.y * uUp);
  // the void: black with a faint lift behind the wafer so its dark half still reads as a disc
  vec3 col = vec3(0.0007, 0.0008, 0.001) + vec3(0.0035, 0.0038, 0.005) * exp(-dot(sv, sv) * 2.2);
  if (rd.y < 0.0) {
    float t = -uRo.y / rd.y;
    vec3 p = uRo + rd * t;
    vec2 c = vec2(p.x, -p.z);
    vec2 w = rot(c, -uSpin);
    float r = length(w);
    vec2 fw2 = max(fwidth(w), vec2(1e-5));
    float fr = max(fwidth(r), 1e-5);
    float notch = 1.0 - smoothstep(0.011 - fr, 0.011 + fr, length(w - vec2(0.0, -1.0)));
    float cover = (1.0 - smoothstep(1.0 - fr, 1.0, r)) * (1.0 - notch);
    if (cover > 0.0) {
      // the polished bevel: the normal tips outward over the last millimetre and a half
      vec3 radial = vec3(c.x, 0.0, -c.y) / max(r, 1e-4);
      float bev = smoothstep(0.988, 1.0, r);
      vec3 n = normalize(vec3(0.0, 1.0, 0.0) + radial * bev * 1.4);
      vec3 R = reflect(rd, n);
      vec3 mirror = env(R);

      vec2 id = floor(w / PITCH + 0.5);
      vec2 lc = w - id * PITCH;
      vec2 dd = HALF - abs(lc);
      float inDie = clamp(min(dd.x / fw2.x, dd.y / fw2.y) + 0.5, 0.0, 1.0);
      inDie *= 1.0 - smoothstep(FIELD - fr, FIELD + fr, r);
      // bare silicon (streets, edge exclusion) is a near-perfect mirror
      vec3 surf = mirror * 0.92;
      if (inDie > 0.0) {
        vec2 d = lc / HALF;
        vec2 fd = fw2 / HALF;
        vec2 ad = abs(d);
        // the GH100 floorplan, roughly: an I/O ring, the six HBM interfaces down the two long sides, the L2 cache
        // across the middle with the crossbar through it, and eight GPCs of eighteen SMs above and below
        float io = smoothstep(0.93 - fd.x, 0.93 + fd.x, max(ad.x, ad.y));
        float phy = smoothstep(0.82 - fd.x, 0.82 + fd.x, ad.x) * (1.0 - io);
        float l2 = (1.0 - smoothstep(0.1 - fd.y, 0.1 + fd.y, ad.y)) * (1.0 - phy) * (1.0 - io);
        float xbar = 1.0 - smoothstep(0.035 - fd.x, 0.035 + fd.x, ad.x);
        // the HBM strips come in threes a side, with gaps between
        float pg = fract((d.y + 1.0) * 1.5);
        float phyOn = smoothstep(0.0, 0.05 + fd.y * 2.0, min(pg, 1.0 - pg));
        // GPCs: four across, one row a side of the L2, lanes between; SMs three across by six down inside
        vec2 gq = vec2((d.x + 0.8) / 1.6 * 4.0, (ad.y - 0.1) / 0.83);
        vec2 gf = fract(gq);
        vec2 lane = smoothstep(vec2(0.0), fd * vec2(2.5, 1.2) * 1.5 + vec2(0.03, 0.02), min(gf, 1.0 - gf));
        float gpcOn = lane.x * lane.y;
        vec2 sm = fract(gf * vec2(3.0, 6.0));
        float fine = clamp(1.0 - max(fd.x, fd.y) * 30.0, 0.0, 1.0);
        float smOn = mix(1.0, smoothstep(0.0, 0.07, min(min(sm.x, 1.0 - sm.x), min(sm.y, 1.0 - sm.y))), fine * 0.55);
        vec2 bid = floor(gq) + vec2(sign(d.y) * 7.0, 0.0);
        float logic = (1.0 - l2) * (1.0 - phy) * (1.0 - io);

        vec3 gx = vec3(cos(uSpin), 0.0, -sin(uSpin));
        vec3 gy = vec3(-sin(uSpin), 0.0, -cos(uSpin));
        // each part has its own pitch, so each throws its own colour at the same angle: SMs (1.5 to 1.75 microns,
        // a little different GPC to GPC), the L2 (finest, along its rows), the HBM interfaces and the I/O ring (coarse)
        float f0 = 1.0 / (1.5 + 0.25 * hash(bid));
        float on = gpcOn * smOn * logic;
        vec4 e = vec4(0.035, 0.26, 0.2, 0.0) * on;
        f0 = mix(f0, 1.0 / 1.08, l2);
        e = mix(e, vec4(0.02, 0.45, 0.07, 0.0) * (1.0 - xbar), l2);
        f0 = mix(f0, 1.0 / 2.0, phy);
        e = mix(e, vec4(0.03, 0.08, 0.34, 0.0) * phyOn, phy);
        f0 = mix(f0, 1.0 / 2.4, io);
        e = mix(e, vec4(0.02, 0.18, 0.18, 0.0), io);
        on = max(on, max(l2 * (1.0 - xbar), max(phy * phyOn, io)));
        vec3 irid = lamps(R, gx, gy, f0, e.x, e.y, e.z);
        // the die itself: a darker, faintly violet mirror (its metal layers absorb), plus what its gratings throw
        vec3 dieC = mirror * mix(0.16, 0.5, 1.0 - on) * vec3(0.92, 0.9, 1.0) + vec3(0.004, 0.0035, 0.006) + irid;
        // the die under the pointer: a lit hairline round its edge and a faint lift
        float hov = uHover.z * step(abs(id.x - uHover.x) + abs(id.y - uHover.y), 0.5);
        if (hov > 0.0) {
          float e = min(dd.x / fw2.x, dd.y / fw2.y);
          dieC += vec3(0.75, 0.85, 1.0) * (1.0 - smoothstep(1.0, 2.6, e)) * 2.2 * hov;
          dieC += vec3(0.05, 0.06, 0.09) * hov;
        }
        surf = mix(surf, dieC, inDie);
      }
      col = mix(col, surf * uExpo, cover);
    } else {
      // the wafer's edge face (0.775 mm): a thin grey band below the rim, lit where it catches the softbox
      vec2 o = vec2(uRo.x, uRo.z), dv = vec2(rd.x, rd.z);
      float A = dot(dv, dv), B = dot(o, dv), C = dot(o, o) - 1.0;
      float disc = B * B - A * C;
      if (disc > 0.0) {
        float te = (-B - sqrt(disc)) / A;
        float y = uRo.y + rd.y * te;
        if (y < 0.0 && y > -0.0052) {
          vec3 pe = uRo + rd * te;
          vec3 ne = normalize(vec3(pe.x, 0.0, pe.z));
          col = (env(reflect(rd, ne)) * 0.7 + vec3(0.012)) * uExpo;
        }
      }
    }
  }
  gl_FragColor = vec4(present(col), 1.0);
}`;

// the camera settles at 34 degrees above the wafer, a little to its right; the lights are fixed to that pose, so
// pointer parallax moves the reflections the way it would in a real studio
const EL = 0.6;
const YAW = 0.32;
const LIGHTS = studio(YAW, EL);
const FOCAL = 2.35;

function camera(intro: number, aspect: number, ptr: { x: number; y: number }, wide: boolean, t = 0) {
  const ease = 1 - Math.pow(1 - intro, 3);
  const el = 1.18 + (EL - 1.18) * ease - ptr.y * 0.05;
  const yaw = YAW + Math.sin(t * 0.09) * 0.14 + ptr.x * 0.08;
  const dist = (wide ? 4.9 : 3.9) * Math.max(1, 1.2 / Math.max(0.5, aspect));
  const ro: V3 = [Math.sin(yaw) * Math.cos(el) * dist, Math.sin(el) * dist, Math.cos(yaw) * Math.cos(el) * dist];
  const fw = norm([-ro[0], -ro[1], -ro[2]]);
  const rt = norm(cross(fw, [0, 1, 0]));
  const up = cross(rt, fw);
  return { ro, fw, rt, up };
}

export function H12Wafer() {
  const r = useHero();
  const i = useSide(r.sides.length);
  const cv = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const [hoverOn, setHoverOn] = useState(false);
  const price = r.h.price;

  useEffect(() => {
    const c = cv.current, el = box.current;
    if (!c || !el) return;
    const still = stillMode();
    const ptr = trackPointer(el);
    const t0 = performance.now();
    // the latest camera and spin, so the pointer can find the die under it
    let last = { cam: camera(1, 1.6, { x: 0, y: 0 }, true), spin: 0, shift: 0, w: 1, h: 1, dpr: 1 };
    const hover = { x: 0, y: 0, on: 0, lit: 0 };
    const pick = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const b = c.getBoundingClientRect();
      const x = (e.clientX - b.left) * last.dpr, y = (b.bottom - e.clientY) * last.dpr;
      const u = (x - 0.5 * last.w) / last.h - last.shift, v = (y - 0.5 * last.h) / last.h;
      const { ro, fw, rt, up } = last.cam;
      const rd = norm([fw[0] * FOCAL + u * rt[0] + v * up[0], fw[1] * FOCAL + u * rt[1] + v * up[1], fw[2] * FOCAL + u * rt[2] + v * up[2]]);
      let on = 0;
      if (rd[1] < 0) {
        const tt = -ro[1] / rd[1];
        const cx = ro[0] + rd[0] * tt, cy = -(ro[2] + rd[2] * tt);
        const cs = Math.cos(-last.spin), sn = Math.sin(-last.spin);
        const wx = cs * cx - sn * cy, wy = sn * cx + cs * cy;
        const ix = Math.floor(wx / PITCH[0] + 0.5), iy = Math.floor(wy / PITCH[1] + 0.5);
        const lx = wx - ix * PITCH[0], ly = wy - iy * PITCH[1];
        const whole = Math.hypot(Math.abs(ix * PITCH[0]) + HALF[0], Math.abs(iy * PITCH[1]) + HALF[1]) < FIELD;
        if (whole && Math.abs(lx) < HALF[0] && Math.abs(ly) < HALF[1]) {
          if (hover.x !== ix || hover.y !== iy) hover.lit = 0;
          hover.x = ix;
          hover.y = iy;
          on = 1;
        }
      }
      hover.on = on;
      setHoverOn(!!on);
      if (tip.current) {
        const eb = el.getBoundingClientRect();
        tip.current.style.left = `${e.clientX - eb.left}px`;
        tip.current.style.top = `${e.clientY - eb.top}px`;
      }
    };
    const out = () => {
      hover.on = 0;
      setHoverOn(false);
    };
    c.addEventListener("pointermove", pick);
    c.addEventListener("pointerleave", out);
    const stop = runShader(c, {
      frag: FRAG,
      still,
      dprMax: 1.5,
      setup: (gl, _p, U) => setStudio(gl, U, LIGHTS),
      frame: (gl, U, t, w, h) => {
        const p = ptr.get(0.04);
        const intro = still ? 1 : Math.min(1, Math.max(0, ((performance.now() - t0) / 1000 - 0.15) / 3.4));
        const wide = w / h > 1.15;
        const cam = camera(intro, w / h, p, wide, t);
        const spin = 0.35 + t * 0.03;
        const shift = wide ? Math.min(0.42, 0.21 * (w / h) - 0.02) : 0;
        last = { cam, spin, shift, w, h, dpr: w / Math.max(1, c.clientWidth) };
        hover.lit += ((hover.on ? 1 : 0) - hover.lit) * 0.18;
        gl.uniform2f(U("uRes"), w, h);
        gl.uniform1f(U("uIntro"), intro);
        gl.uniform1f(U("uExpo"), still ? 1 : Math.pow(Math.min(1, intro * 1.4), 1.6));
        gl.uniform1f(U("uSpin"), spin);
        gl.uniform1f(U("uShift"), shift);
        gl.uniform3fv(U("uRo"), cam.ro);
        gl.uniform3fv(U("uFw"), cam.fw);
        gl.uniform3fv(U("uRt"), cam.rt);
        gl.uniform3fv(U("uUp"), cam.up);
        gl.uniform1f(U("uFocal"), FOCAL);
        gl.uniform3f(U("uHover"), hover.x, hover.y, still ? 0 : hover.lit);
      },
    });
    return () => {
      stop();
      ptr.stop();
      c.removeEventListener("pointermove", pick);
      c.removeEventListener("pointerleave", out);
    };
  }, []);

  return (
    <section ref={box} className={`${k.hero} ${s.hero}`}>
      <div ref={tip} className={s.tip} data-on={hoverOn ? "" : undefined} aria-hidden>
        <b>One GPU</b>
        <span>{price > 0 ? `An hour of an H100 is ${usd(price)} today` : "An hour of it has a price"}</span>
      </div>
      <Nav dark />
      <div className={s.body}>
        <div className={s.copy}>
          <h1 className={s.h1}>{CLAIM}</h1>
          <Rotator as="p" sides={r.sides} index={i} className={s.sub} qClass={s.q} />
          <Cta />
        </div>
        <div className={s.slot}>
          <canvas ref={cv} className={s.gl} aria-label="A silicon wafer of H100-sized dies, slowly turning under studio lights" role="img" />
        </div>
        <p className={s.note}>Every square on this wafer becomes one GPU. Agate gives an hour of it an open price you can trade.</p>
      </div>
    </section>
  );
}
