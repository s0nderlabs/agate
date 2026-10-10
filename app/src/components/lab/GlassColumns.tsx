"use client";
// "Six GPUs, one open price" as an object (asset lab, round 2): today's index for each GPU as a column of frosted
// glass, cheapest to dearest, raymarched in a WebGL fragment shader (no library, no generated image). The columns rise
// to their prices when they come into view; a softbox drifts across so the glass catches the light. After
// Wealthsimple's glass candlesticks and Robinhood Legend's chrome candles: the data's own shape made into a material.
import { useEffect, useMemo, useRef, useState } from "react";
import { usd } from "@/lib/format";
import type { LabGpu } from "./data";
import { stillMode } from "./data";
import s from "./lab.module.css";

const VERT = `attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }`;

// camera, shared with the label projection below
const CAM = { y: 2.6, z: 9.6, ty: 1.35, f: 2.15 };
const SPACING = 1.24, HALF = 0.42, ROUND = 0.12, MAX_H = 2.9;

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uDark;
uniform vec4 uCol[6];
uniform float uGrow;
uniform float uCamZ;

float sdRoundBox(vec3 p, vec3 b, float r){ vec3 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r; }

float map(vec3 p, out vec2 hc){
  float d = 1e5; hc = vec2(0.0);
  for (int i = 0; i < 6; i++){
    float h = max(uCol[i].y * uGrow, 0.06);
    vec3 c = vec3(uCol[i].x, h * 0.5, 0.0);
    float di = sdRoundBox(p - c, vec3(${HALF - ROUND}, max(h * 0.5 - ${ROUND}, 0.001), ${HALF - ROUND}), ${ROUND});
    if (di < d){ d = di; hc = vec2(h, uCol[i].x); }
  }
  return d;
}
float mapD(vec3 p){ vec2 hc; return map(p, hc); }
// how far a ray travels inside one column before it leaves (its box, ignoring the rounding)
float exitT(vec3 o, vec3 r, vec2 hc){
  vec3 lo = vec3(hc.y - ${HALF}, 0.0, -${HALF}), hi = vec3(hc.y + ${HALF}, hc.x, ${HALF});
  vec3 inv = 1.0 / (r + vec3(1e-5));
  vec3 t1 = (lo - o) * inv, t2 = (hi - o) * inv;
  vec3 tmax = max(t1, t2);
  return max(min(min(tmax.x, tmax.y), tmax.z), 0.0);
}
vec3 nrm(vec3 p){ vec2 e = vec2(0.0012, 0.0); return normalize(vec3(mapD(p + e.xyy) - mapD(p - e.xyy), mapD(p + e.yxy) - mapD(p - e.yxy), mapD(p + e.yyx) - mapD(p - e.yyx))); }

// the studio the glass reflects: a long softbox that drifts, a dim ceiling, a floor
vec3 env(vec3 d){
  float sweep = 0.55 * sin(uTime * 0.23);
  vec3 bd = normalize(vec3(-0.35 + sweep, 0.75, 0.55));
  float box = smoothstep(0.90, 0.985, dot(d, bd));
  float strip = smoothstep(0.965, 0.995, dot(d, normalize(vec3(0.9, 0.25, 0.35))));
  vec3 lo = mix(vec3(0.84, 0.85, 0.88), vec3(0.06, 0.065, 0.09), uDark);
  vec3 hi = mix(vec3(0.97, 0.975, 0.99), vec3(0.20, 0.22, 0.30), uDark);
  vec3 c = mix(lo, hi, clamp(d.y * 0.5 + 0.5, 0.0, 1.0));
  return c + vec3(1.0) * box * 1.1 + mix(vec3(0.55, 0.62, 1.0), vec3(0.62, 0.72, 1.0), uDark) * strip * 0.7;
}

float softShadow(vec3 ro, vec3 rd){
  float res = 1.0, t = 0.02;
  for (int i = 0; i < 40; i++){
    float h = mapD(ro + rd * t);
    res = min(res, 10.0 * h / t);
    t += clamp(h, 0.02, 0.25);
    if (res < 0.01 || t > 7.0) break;
  }
  return clamp(res, 0.0, 1.0);
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec3 ro = vec3(0.0, ${CAM.y.toFixed(3)}, uCamZ);
  vec3 ta = vec3(0.0, ${CAM.ty.toFixed(3)}, 0.0);
  vec3 fw = normalize(ta - ro), rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0))), up = cross(rt, fw);
  vec3 rd = normalize(uv.x * rt + uv.y * up + ${CAM.f.toFixed(3)} * fw);

  float t = 0.0, d = 1.0; vec2 hc = vec2(0.0);
  for (int i = 0; i < 120; i++){
    d = map(ro + rd * t, hc);
    if (d < 0.0008 || t > 60.0) break;
    t += d * 0.95;
  }
  vec3 L = normalize(vec3(-0.5, 0.9, 0.6));
  if (d < 0.002){
    vec3 p = ro + rd * t;
    vec3 n = nrm(p);
    vec3 V = -rd;
    float cosv = max(dot(n, V), 0.0);
    float fres = 0.04 + 0.96 * pow(1.0 - cosv, 5.0);
    float h = hc.x;
    // through the glass: the studio behind, bent by refraction, softened (frosted) and tinted by how far the light
    // travels inside (thin edges stay clear, the body deepens to the tint)
    vec3 rr = refract(rd, n, 1.0 / 1.47);
    float thick = exitT(p + rr * 0.002, rr, hc);
    vec3 tint = mix(vec3(0.55, 0.61, 0.95), vec3(0.42, 0.52, 1.0), uDark);
    // a floor on the path length, so even a thin side face carries the glass's colour instead of going white
    vec3 absorb = exp(-(vec3(1.0) - tint) * (thick + 0.45) * mix(1.25, 1.6, uDark));
    vec3 behind = mix(env(rr), env(vec3(rr.x, 0.15, rr.z)), 0.55);
    float up01 = clamp(p.y / max(h, 0.001), 0.0, 1.0);
    vec3 inner = behind * absorb * (0.86 + 0.22 * up01);
    // frost: a little light scattered inside, more in the thick body
    inner += mix(vec3(0.10, 0.11, 0.16), vec3(0.06, 0.08, 0.16), uDark) * (1.0 - exp(-thick * 1.4));
    // on a dark stage, light from the top face glows down through the body
    inner += tint * uDark * (0.08 + 0.30 * up01 * up01);
    // reflections pick up a little of the glass's own colour, and stay moderate at grazing angles so the side faces
    // read as glass, not white panels
    vec3 refl = env(reflect(rd, n)) * mix(vec3(1.0), tint, 0.35);
    vec3 col = mix(inner, refl, fres * mix(0.55, 0.8, uDark));
    // edges: the rounded corners catch the softbox as bright rims
    // only the rounded edges, not the flat side faces seen at an angle
    vec3 an = abs(n);
    float edge = 1.0 - max(an.x, max(an.y, an.z));
    float rim = smoothstep(0.02, 0.16, edge) * 0.75;
    col += mix(vec3(1.0), vec3(0.70, 0.80, 1.0), uDark) * rim * mix(0.35 + 0.65 * up01, 0.7 + 0.9 * up01, uDark);
    // the top face reads as a lit plane, the line along its front edge as a bright bevel
    float topFace = smoothstep(0.7, 0.95, n.y);
    col = mix(col, col + vec3(0.10), topFace);
    float alpha = clamp(mix(0.52, 0.70, uDark) + 0.38 * (1.0 - exp(-thick * 0.9)) + fres * 0.3 + rim * 0.25, 0.0, 1.0);
    gl_FragColor = vec4(col * alpha, alpha);
    return;
  }
  // the floor: soft shadows and a contact shade, fading out with distance; transparent elsewhere
  if (rd.y < 0.0){
    float tf = -ro.y / rd.y;
    vec3 p = ro + rd * tf;
    float fade = exp(-0.018 * dot(p.xz, p.xz)) * smoothstep(9.0, 4.0, abs(p.x));
    float sh = 1.0 - softShadow(p + vec3(0.0, 0.002, 0.0), L);
    float ao = 1.0 - smoothstep(0.0, 0.45, mapD(p));
    float a = clamp((sh * 0.10 + ao * 0.24) * fade, 0.0, 1.0) * mix(1.0, 1.5, uDark);
    vec3 shade = mix(vec3(0.12, 0.14, 0.32), vec3(0.0), uDark);
    gl_FragColor = vec4(shade * a, a);
    return;
  }
  gl_FragColor = vec4(0.0);
}`;

/** How far back the camera stands: a narrow canvas (a phone) needs it further away so the row of six still fits. */
const camZ = (w: number, h: number) => CAM.z * Math.max(1, 2.05 / Math.max(0.5, w / Math.max(1, h)));

/** Where a world point lands on the canvas (CSS px), the same camera as the shader. */
function project(x: number, y: number, z: number, w: number, h: number) {
  const ro = [0, CAM.y, camZ(w, h)];
  const fw = norm([0 - ro[0], CAM.ty - ro[1], 0 - ro[2]]);
  const rt = norm(cross(fw, [0, 1, 0]));
  const up = cross(rt, fw);
  const d = [x - ro[0], y - ro[1], z - ro[2]];
  const zz = dot(d, fw);
  const u = (dot(d, rt) / zz) * CAM.f, v = (dot(d, up) / zz) * CAM.f;
  return { x: u * h + w / 2, y: h / 2 - v * h };
}
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: number[]) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function GlassColumns({ data, dark }: { data: LabGpu[]; dark: boolean }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const cols = useMemo(() => {
    const priced = data.filter((g) => g.price > 0).sort((a, b) => a.price - b.price);
    const top = Math.max(...priced.map((g) => g.price), 1);
    return priced.map((g, i) => ({ g, x: (i - (priced.length - 1) / 2) * SPACING, h: (g.price / top) * MAX_H }));
  }, [data]);
  const key = cols.map((c) => `${c.g.gpu}:${c.g.price}`).join(",");
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const ro = new ResizeObserver(() => setBox({ w: c.clientWidth, h: c.clientHeight }));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const c = cv.current;
    if (!c || !cols.length) return;
    const gl = c.getContext("webgl", { premultipliedAlpha: true, antialias: true, alpha: true });
    if (!gl || gl.isContextLost()) {
      c.dataset.nogl = "1";
      return;
    }
    const sh = (type: number, src: string) => {
      const x = gl.createShader(type)!;
      gl.shaderSource(x, src);
      gl.compileShader(x);
      if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) {
        console.warn("GlassColumns shader:", gl.getShaderInfoLog(x));
        return null;
      }
      return x;
    };
    const vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) {
      c.dataset.nogl = "1";
      return;
    }
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("GlassColumns link:", gl.getProgramInfoLog(prog));
      c.dataset.nogl = "1";
      return;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = (n: string) => gl.getUniformLocation(prog, n);
    const arr = new Float32Array(24);
    cols.forEach((col, i) => arr.set([col.x, col.h, 0, 0], i * 4));
    for (let i = cols.length; i < 6; i++) arr.set([100, 0, 0, 0], i * 4);
    gl.uniform4fv(U("uCol"), arr);
    gl.uniform1f(U("uDark"), dark ? 1 : 0);
    const still = stillMode();
    let raf = 0, visible = false, grownAt = 0;
    const t0 = performance.now();
    const frame = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
      if (w && h && (c.width !== w || c.height !== h)) {
        c.width = w;
        c.height = h;
      }
      const now = performance.now();
      const g = still ? 1 : grownAt ? Math.min(1, (now - grownAt) / 1700) : 0;
      gl.viewport(0, 0, c.width, c.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(U("uRes"), c.width, c.height);
      gl.uniform1f(U("uCamZ"), camZ(c.width, c.height));
      gl.uniform1f(U("uTime"), still ? 3 : (now - t0) / 1000 + 3);
      gl.uniform1f(U("uGrow"), 1 - Math.pow(1 - g, 3));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (!still && visible) raf = requestAnimationFrame(frame);
    };
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible && !grownAt) grownAt = performance.now();
      cancelAnimationFrame(raf);
      if (visible) raf = requestAnimationFrame(frame);
    });
    io.observe(c);
    frame();
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      gl.deleteProgram(prog);
      gl.deleteBuffer(buf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, dark]);
  return (
    <div className={s.glassWrap}>
      <canvas ref={cv} className={s.fill} role="img" aria-label={`Today's index for ${cols.length} GPUs as glass columns, from ${cols[0] ? `${cols[0].g.gpu} at ${usd(cols[0].g.price)}` : ""} to ${cols.at(-1) ? `${cols.at(-1)!.g.gpu} at ${usd(cols.at(-1)!.g.price)}` : ""}`} />
      {box.w > 0 &&
        cols.map((col) => {
          const p = project(col.x, 0, HALF + 0.05, box.w, box.h);
          return (
            <div key={col.g.gpu} className={s.glassLabel} style={{ left: p.x, top: p.y + 14 }}>
              <span>{col.g.gpu}</span>
              <b>{usd(col.g.price)}</b>
            </div>
          );
        })}
    </div>
  );
}
