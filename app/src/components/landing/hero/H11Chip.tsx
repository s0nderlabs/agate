"use client";
// Hero "The chip, warmed by the market" (Oct 8): an H100's CoWoS module (the
// GPU die, six HBM stacks, the interposer, a substrate studded with capacitors) in the same dark studio as the wafer,
// drawn by one fragment shader. The die face is the GH100 floorplan, its patterns throwing the lamps' colours by the
// grating equation (optics.ts). The market is heat: a working GPU warms the cores doing the work, so each of its 144
// SMs that stands for a block of the GPU-hours held open on next month (live) glows like hot silicon, the warmth
// spreading into the die round it. It powers on when the page opens; the camera drifts, the pointer leans it.
import { useEffect, useRef, useState } from "react";
import { stillMode } from "@/components/lab/data";
import { runShader, trackPointer } from "./gl";
import { OPTICS, cross, norm, setStudio, studio, type V3 } from "./optics";
import { CLAIM, Cta, Nav, Rotator, k, useHero, useSide } from "./kit";
import s from "./h11.module.css";

const SMS = 144; // 8 GPCs x 18 SMs
const NICE = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
const HEAT = 128; // the heat field's texture size, over the die

// the die (26 x 33 mm) and its neighbours, in one unit = 32.7 mm
const DH = [0.4, 0.505];

const FRAG = `
#extension GL_OES_standard_derivatives : enable
precision highp float;
uniform vec2 uRes;
uniform float uTime, uIntro, uFocal, uShift, uExpo;
uniform vec3 uRo, uFw, uRt, uUp;
uniform sampler2D uHeat; // r: each warm SM's core, g: its warmth spread into the die

const vec2 DH = vec2(${DH[0]}, ${DH[1]});
${OPTICS}

float sdBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
// hot silicon: deep red, orange, toward a warm white at the hottest
vec3 blackbody(float t){
  vec3 c = mix(vec3(0.85, 0.07, 0.01), vec3(1.0, 0.36, 0.06), smoothstep(0.2, 0.65, t));
  c = mix(c, vec3(1.0, 0.8, 0.52), smoothstep(0.65, 1.0, t));
  return c * pow(clamp(t, 0.0, 1.0), 1.7);
}
// a raised part's top: its edge rounds off, catching the studio
vec3 bevelN(vec2 p, vec2 b, float r, float w){
  float d = sdBox(p, b, r);
  float k = smoothstep(-w, 0.0, d);
  vec2 e = vec2(1e-3, 0.0);
  vec2 g = normalize(vec2(sdBox(p + e.xy, b, r) - sdBox(p - e.xy, b, r), sdBox(p + e.yx, b, r) - sdBox(p - e.yx, b, r)) + 1e-6);
  return normalize(vec3(g.x * k * 1.3, 1.0, -g.y * k * 1.3));
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec2 sv = uv - vec2(uShift, 0.0);
  vec3 rd = normalize(uFw * uFocal + sv.x * uRt + sv.y * uUp);
  vec3 col = vec3(0.0007, 0.0008, 0.001) + vec3(0.003, 0.0033, 0.0045) * exp(-dot(sv, sv) * 2.0);
  if (rd.y < 0.0) {
    float t = -uRo.y / rd.y;
    vec3 p = uRo + rd * t;
    vec2 c = vec2(p.x, -p.z);
    vec2 fw2 = max(fwidth(c), vec2(1e-5));
    float px = max(fw2.x, fw2.y);
    vec3 up = vec3(0.0, 1.0, 0.0);
    vec3 R0 = reflect(rd, up);
    float fres = 0.04 + 0.96 * pow(1.0 - clamp(-rd.y, 0.0, 1.0), 5.0);
    vec3 Lk = normalize(uKeyC);

    // the floor: black, the module's contact shadow
    float sdSub = sdBox(c, vec2(1.22, 1.08), 0.05);
    col *= mix(0.3, 1.0, smoothstep(0.0, 0.35, sdSub));
    float aSub = 1.0 - smoothstep(-px, px, sdSub);
    if (aSub > 0.0) {
      // substrate: a near-black laminate under a clear coat (the softbox slides across it), a faint weave
      vec3 nS = bevelN(c, vec2(1.22, 1.08), 0.05, 0.03);
      vec3 RS = reflect(rd, nS);
      float weave = noise(c * vec2(160.0, 150.0)) * 0.6 + noise(c * 40.0) * 0.4;
      vec3 sub = vec3(0.0045, 0.0058, 0.0055) * (0.8 + 0.4 * weave) + env(RS) * (0.012 + 0.09 * fres);
      // capacitors in rows round the interposer: tan bodies, tinned ends that glint
      vec2 q = c;
      vec2 aq = abs(q);
      float capRow = 0.0; vec2 lc = vec2(9.0); float vertical = 0.0;
      if (aq.x < 0.8 && (abs(aq.y - 0.68) < 0.035 || abs(aq.y - 0.8) < 0.035)) {
        float cy = aq.y < 0.74 ? 0.68 : 0.8;
        lc = vec2(mod(q.x + 0.03 + step(0.75, cy) * 0.015, 0.06) - 0.03, aq.y - cy);
        capRow = 1.0;
      } else if (aq.y < 0.5 && abs(aq.x - 0.96) < 0.03) {
        float cx = 0.96;
        lc = vec2(mod(q.y + 0.03, 0.06) - 0.03, aq.x - cx);
        capRow = 1.0; vertical = 1.0;
      }
      if (capRow > 0.5) {
        float body = sdBox(lc, vec2(0.019, 0.0095), 0.002);
        float aCap = 1.0 - smoothstep(-px, px, body);
        if (aCap > 0.0) {
          float ends = smoothstep(0.011, 0.0125, abs(lc.x));
          vec3 nC = normalize(vec3(0.0, 1.0, 0.0) + (vertical > 0.5 ? vec3(0.0, 0.0, -sign(lc.y)) : vec3(0.0, 0.0, -sign(lc.y))) * smoothstep(0.004, 0.0095, abs(lc.y)) * 0.8);
          vec3 tan = vec3(0.07, 0.045, 0.024) * (0.3 + 0.7 * max(dot(nC, Lk), 0.0));
          vec3 tin = env(reflect(rd, nC)) * 0.5 + vec3(0.008);
          sub = mix(sub, mix(tan, tin, ends), aCap);
        }
      }
      // corner fiducials: gold rings
      float fid = abs(length(abs(c) - vec2(1.12, 0.98)) - 0.022);
      sub = mix(sub, env(R0) * vec3(1.0, 0.78, 0.42) * 0.9 + vec3(0.03, 0.022, 0.01), 1.0 - smoothstep(0.003, 0.006, fid));
      col = mix(col, sub, aSub);

      // the interposer: silicon with fine wiring (it throws a little colour of its own), a soft shadow round it
      float sdI = sdBox(c, vec2(0.83, 0.56), 0.012);
      col *= mix(0.55, 1.0, smoothstep(0.0, 0.05, sdI));
      float aI = 1.0 - smoothstep(-px, px, sdI);
      if (aI > 0.0) {
        vec3 nI = bevelN(c, vec2(0.83, 0.56), 0.012, 0.008);
        vec3 RI = reflect(rd, nI);
        vec3 ip = env(RI) * 0.35 + vec3(0.006, 0.006, 0.007);
        ip += lamps(RI, vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, -1.0), 1.0 / 2.6, 0.01, 0.05, 0.05) * 0.6;
        col = mix(col, ip, aI);
      }

      // six HBM stacks: the polished back of the top DRAM die, a near mirror; the softbox glides across them
      vec2 hq = vec2(abs(c.x) - 0.615, c.y);
      float hy = hq.y - clamp(floor(hq.y / 0.345 + 0.5), -1.0, 1.0) * 0.345;
      float sdH = sdBox(vec2(hq.x, hy), vec2(0.165, 0.155), 0.006);
      col *= mix(0.6, 1.0, smoothstep(0.0, 0.02, sdH));
      float aH = 1.0 - smoothstep(-px, px, sdH);
      if (aH > 0.0) {
        vec3 nH = bevelN(vec2(hq.x, hy), vec2(0.165, 0.155), 0.006, 0.006);
        nH.x *= sign(c.x);
        vec3 RH = reflect(rd, nH);
        float grain = noise(vec2(hq.x, hy) * vec2(900.0, 40.0));
        vec3 hb = env(RH) * (0.36 + 0.05 * grain) + vec3(0.0035, 0.0038, 0.0045);
        col = mix(col, hb, aH);
      }

      // the GPU die
      float sdD = sdBox(c, DH, 0.004);
      col *= mix(0.5, 1.0, smoothstep(0.0, 0.03, sdD));
      float aD = 1.0 - smoothstep(-px, px, sdD);
      if (aD > 0.0) {
        vec3 nD = bevelN(c, DH, 0.004, 0.005);
        vec3 R = reflect(rd, nD);
        vec2 d = c / DH;
        vec2 fd = fw2 / DH;
        vec2 ad = abs(d);
        float io = smoothstep(0.94 - fd.x, 0.94 + fd.x, max(ad.x, ad.y));
        float phy = smoothstep(0.84 - fd.x, 0.84 + fd.x, ad.x) * (1.0 - io);
        float l2 = (1.0 - smoothstep(0.09 - fd.y, 0.09 + fd.y, ad.y)) * (1.0 - phy) * (1.0 - io);
        float xbar = 1.0 - smoothstep(0.03 - fd.x, 0.03 + fd.x, ad.x);
        float pg = fract((d.y + 1.0) * 1.5);
        float phyOn = smoothstep(0.0, 0.04 + fd.y * 2.0, min(pg, 1.0 - pg));
        // GPCs four across, a row each side of the L2; SMs three across, six down; inside an SM four processing
        // blocks (tensor cores the darker squares) over an L1 strip
        vec2 gq = vec2((d.x + 0.82) / 1.64 * 4.0, (ad.y - 0.09) / 0.84);
        vec2 gf = fract(gq);
        vec2 lane = smoothstep(vec2(0.0), fd * vec2(2.4, 1.2) * 1.5 + vec2(0.025, 0.018), min(gf, 1.0 - gf));
        float gpcOn = lane.x * lane.y;
        vec2 smq = gf * vec2(3.0, 6.0);
        vec2 sm = fract(smq);
        vec2 smId = floor(smq);
        float smEdge = min(min(sm.x, 1.0 - sm.x), min(sm.y, 1.0 - sm.y));
        float fine = clamp(1.0 - max(fd.x, fd.y) * 18.0, 0.0, 1.0);
        float smOn = mix(1.0, smoothstep(0.02, 0.07, smEdge), fine);
        float l1 = step(sm.y, 0.2);
        vec2 pb = fract(vec2(sm.x * 2.0, (sm.y - 0.2) / 0.8 * 2.0));
        float tensor = step(0.55, pb.x) * step(0.5, pb.y) * (1.0 - l1);
        float logic = (1.0 - l2) * (1.0 - phy) * (1.0 - io);
        vec2 bid = floor(gq) + vec2(sign(d.y) * 7.0, 0.0);

        float f0 = 1.0 / (1.5 + 0.25 * hash(bid));
        f0 = mix(f0, 1.0 / 1.2, l1 * fine);
        f0 = mix(f0, 1.0 / 1.36, tensor * fine);
        float on = gpcOn * smOn * logic;
        vec4 e = vec4(0.03, 0.24, 0.19, 0.0) * on;
        f0 = mix(f0, 1.0 / 1.08, l2);
        e = mix(e, vec4(0.02, 0.42, 0.07, 0.0) * (1.0 - xbar), l2);
        f0 = mix(f0, 1.0 / 2.0, phy);
        e = mix(e, vec4(0.03, 0.08, 0.32, 0.0) * phyOn, phy);
        f0 = mix(f0, 1.0 / 2.4, io);
        e = mix(e, vec4(0.02, 0.16, 0.16, 0.0), io);
        vec3 irid = lamps(R, vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, -1.0), f0, e.x, e.y, e.z);
        // a cooler, quieter silicon than the wafer, so the warmth reads
        irid = mix(vec3(dot(irid, vec3(0.3, 0.5, 0.2))), irid, 0.6) * vec3(0.85, 0.95, 1.1);
        vec3 die = env(R) * mix(0.14, 0.5, 1.0 - max(on, max(l2 * (1.0 - xbar), phy * phyOn))) + vec3(0.003, 0.0032, 0.005) + irid;

        // the market's warmth: each warm SM's core, pulsing a little with its load, and the heat spread round it
        vec2 hu = d * 0.5 + 0.5;
        vec4 ht = texture2D(uHeat, hu);
        float smKey = hash(bid * 3.1 + smId * 0.71);
        float delay = 0.25 + 0.6 * fract(smKey * 7.3 + (d.x + 1.0) * 0.2);
        float powered = smoothstep(delay, delay + 0.25, uIntro);
        float flick = 0.86 + 0.14 * sin(uTime * (0.5 + 0.9 * smKey) + smKey * 40.0);
        float core = ht.r * powered * flick;
        float spread = ht.g * smoothstep(0.3, 1.0, uIntro);
        float heat = clamp(core * 0.38 + spread * 0.5, 0.0, 0.74);
        // the heat sits under the patterned surface: the routing lanes and gaps let a little less through
        die += blackbody(heat) * (0.8 + 0.2 * on) * 1.25;
        col = mix(col, die, aD);
      }
    }
    col = mix(vec3(0.0007, 0.0008, 0.001), col, exp(-0.004 * t * t));
  }
  gl_FragColor = vec4(present(col * uExpo), 1.0);
}`;

// the camera settles at 56 degrees above the module, from its front left; the studio is fixed to that pose
const EL = 0.98;
const YAW = -0.42;
const LIGHTS = studio(YAW, EL);
const FOCAL = 2.4;

function camera(intro: number, aspect: number, ptr: { x: number; y: number }, wide: boolean, t = 0) {
  const ease = 1 - Math.pow(1 - intro, 3);
  const el = 1.4 + (EL - 1.4) * ease - ptr.y * 0.05;
  const yaw = YAW + Math.sin(t * 0.08) * 0.12 + ptr.x * 0.08;
  const dist = (wide ? 7.0 : 5.6) * Math.max(1, 1.2 / Math.max(0.5, aspect));
  const ro: V3 = [Math.sin(yaw) * Math.cos(el) * dist, Math.sin(el) * dist, Math.cos(yaw) * Math.cos(el) * dist];
  const fw = norm([-ro[0], -ro[1], -ro[2]]);
  const rt = norm(cross(fw, [0, 1, 0]));
  const up = cross(rt, fw);
  return { ro, fw, rt, up };
}

/** The heat field over the die: each warm SM a tight core (red) and a wide spread (green), built here once. */
function heatField(lit: number) {
  // which SMs are warm: a scattered, steady pick, the way a scheduler spreads work
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const order = Array.from({ length: SMS }, (_, i) => ({ i, r: rnd() })).sort((a, b) => a.r - b.r).map((o) => o.i);
  const warm = order.slice(0, lit);
  const core = new Float32Array(HEAT * HEAT), spread = new Float32Array(HEAT * HEAT);
  const splat = (out: Float32Array, cx: number, cy: number, sx: number, sy: number, a: number) => {
    const r = 3;
    const x0 = Math.max(0, Math.floor((cx - r * sx) * HEAT)), x1 = Math.min(HEAT - 1, Math.ceil((cx + r * sx) * HEAT));
    const y0 = Math.max(0, Math.floor((cy - r * sy) * HEAT)), y1 = Math.min(HEAT - 1, Math.ceil((cy + r * sy) * HEAT));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const dx = ((x + 0.5) / HEAT - cx) / sx, dy = ((y + 0.5) / HEAT - cy) / sy;
        out[y * HEAT + x] += a * Math.exp(-0.5 * (dx * dx + dy * dy));
      }
  };
  for (const i of warm) {
    const gpc = Math.floor(i / 18), half = gpc < 4 ? 1 : -1, col = gpc % 4;
    const sm = i % 18, smC = sm % 3, smR = Math.floor(sm / 3);
    // the SM's centre in die coordinates (-1..1), the same floorplan as the shader
    const dx = -0.82 + 1.64 * ((col + (smC + 0.5) / 3) / 4);
    const dy = half * (0.09 + 0.84 * ((smR + 0.5) / 6));
    const u = dx * 0.5 + 0.5, v = dy * 0.5 + 0.5;
    splat(core, u, v, 0.034, 0.03, 0.55);
    splat(spread, u, v, 0.085, 0.08, 1);
  }
  let m = 0;
  for (let k = 0; k < spread.length; k++) m = Math.max(m, spread[k]);
  const px = new Uint8Array(HEAT * HEAT * 4);
  for (let k = 0; k < HEAT * HEAT; k++) {
    px[k * 4] = Math.round(Math.min(1, core[k]) * 255);
    px[k * 4 + 1] = Math.round(Math.min(1, m ? spread[k] / m : 0) * 255);
    px[k * 4 + 3] = 255;
  }
  return px;
}

export function H11Chip() {
  const r = useHero();
  const i = useSide(r.sides.length);
  const cv = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLElement>(null);
  const open = Math.round(r.open);
  const unit = open ? NICE.find((u) => open / u <= SMS * 0.62) ?? 10000 : 0;
  const lit = unit ? Math.min(SMS, Math.round(open / unit)) : 0;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const c = cv.current, el = box.current;
    if (!c || !el || !ready) return;
    const still = stillMode();
    const ptr = trackPointer(el);
    const t0 = performance.now();
    const heat = heatField(lit);
    const stop = runShader(c, {
      frag: FRAG,
      still,
      dprMax: 1.5,
      setup: (gl, _p, U) => {
        setStudio(gl, U, LIGHTS);
        const tex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, HEAT, HEAT, 0, gl.RGBA, gl.UNSIGNED_BYTE, heat);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.uniform1i(U("uHeat"), 0);
      },
      frame: (gl, U, t, w, h) => {
        const p = ptr.get(0.04);
        const intro = still ? 1 : Math.min(1, Math.max(0, ((performance.now() - t0) / 1000 - 0.2) / 3.6));
        const wide = w / h > 1.15;
        const cam = camera(intro, w / h, p, wide, t);
        gl.uniform2f(U("uRes"), w, h);
        gl.uniform1f(U("uTime"), t);
        gl.uniform1f(U("uIntro"), intro);
        gl.uniform1f(U("uExpo"), still ? 1 : Math.pow(Math.min(1, intro * 1.6), 1.4));
        gl.uniform1f(U("uShift"), wide ? Math.min(0.42, 0.21 * (w / h) - 0.02) : 0);
        gl.uniform3fv(U("uRo"), cam.ro);
        gl.uniform3fv(U("uFw"), cam.fw);
        gl.uniform3fv(U("uRt"), cam.rt);
        gl.uniform3fv(U("uUp"), cam.up);
        gl.uniform1f(U("uFocal"), FOCAL);
      },
    });
    return () => {
      stop();
      ptr.stop();
    };
  }, [lit, ready]);

  // the warm cores are known once the market has been read
  useEffect(() => {
    if (r.ready) setReady(true);
  }, [r.ready]);

  return (
    <section ref={box} className={`${k.hero} ${s.hero}`}>
      <Nav dark />
      <div className={s.body}>
        <div className={s.copy}>
          <h1 className={s.h1}>{CLAIM}</h1>
          <Rotator as="p" sides={r.sides} index={i} className={s.sub} qClass={s.q} />
          <Cta />
        </div>
        <div className={s.slot}>
          <canvas ref={cv} className={s.gl} aria-label="An H100 module, its cores warm with the GPU-hours held open" role="img" />
        </div>
        <p className={s.stat}>
          <b>{open ? open.toLocaleString("en-US") : " "}</b>
          <span>
            GPU-hours held open on {r.month} right now. Each warm core on the chip is {unit ? `${unit.toLocaleString("en-US")} of them` : "a block of them"}.
          </span>
        </p>
      </div>
    </section>
  );
}
