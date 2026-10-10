// Shared GLSL for the silicon heroes (the wafer, the chip): the studio they sit in and how patterned silicon throws
// light. One place, so both are lit the same way.

export type V3 = [number, number, number];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** a direction from azimuth (0 = toward -z, away from a camera on +z) and elevation */
export const dir = (az: number, el: number): V3 => [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
export const horiz = (c: V3): V3 => norm([c[2], 0, -c[0]]);
export const vert = (c: V3): V3 => norm(cross(c, horiz(c)));

/** The studio, fixed to a camera pose (azimuth yaw, elevation el): one small softbox the mirror shows, and three
 *  lamps placed round the mirror direction at the angles where patterned silicon throws their first-order colours. */
export function studio(yaw: number, el: number) {
  const keyC = dir(-yaw + 0.34, el + 0.04);
  const s1C = dir(-yaw - 0.45, el + 0.02);
  const s2C = dir(-yaw + 0.5, el + 0.12);
  const s3C = dir(-yaw + 0.02, el + 0.6);
  return { keyC, keyA: horiz(keyC), s1C, s1A: vert(s1C), s2C, s2A: horiz(s2C), s3C, s3A: horiz(s3C) };
}
export type Studio = ReturnType<typeof studio>;
export function setStudio(gl: WebGLRenderingContext, U: (n: string) => WebGLUniformLocation | null, s: Studio) {
  gl.uniform3fv(U("uKeyC"), s.keyC);
  gl.uniform3fv(U("uKeyA"), s.keyA);
  gl.uniform3fv(U("uS1C"), s.s1C);
  gl.uniform3fv(U("uS1A"), s.s1A);
  gl.uniform3fv(U("uS2C"), s.s2C);
  gl.uniform3fv(U("uS2A"), s.s2A);
  gl.uniform3fv(U("uS3C"), s.s3C);
  gl.uniform3fv(U("uS3A"), s.s3A);
}

export const OPTICS = `
uniform vec3 uKeyC, uKeyA, uS1C, uS1A, uS2C, uS2A, uS3C, uS3A;

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
// a rectangular light on the sky: centre direction c, long axis a, half sizes in tangent units, soft edge
float panel(vec3 d, vec3 c, vec3 a, vec2 hs, float soft){
  float z = dot(d, c);
  if (z <= 0.05) return 0.0;
  vec3 b = cross(c, a);
  vec2 q = abs(vec2(dot(d, a), dot(d, b)) / z);
  vec2 e = 1.0 - smoothstep(hs - soft, hs + soft, q);
  return e.x * e.y;
}
// white light split by wavelength: Zucconi's fit of the CIE response, in linear RGB (dark outside 400 to 700 nm)
vec3 bump3(vec3 x, vec3 y){ return clamp(1.0 - x * x - y, 0.0, 1.0); }
vec3 spectral(float nm){
  float x = (nm - 400.0) / 300.0;
  if (x <= 0.0 || x >= 1.0) return vec3(0.0);
  return bump3(vec3(3.54585104, 2.93225262, 2.41593945) * (x - vec3(0.69549072, 0.49228336, 0.27699880)), vec3(0.02312639, 0.15225084, 0.52607955))
       + bump3(vec3(3.90307140, 3.21182957, 3.96587128) * (x - vec3(0.11748627, 0.86755042, 0.66077860)), vec3(0.84897130, 0.88445281, 0.73949448));
}
// the studio as a mirror sees it: near black, a dim grey falloff toward the horizon, one small softbox, and the three
// lamps as small hot spots (only a bevel ever turns far enough to show them)
vec3 env(vec3 d){
  vec3 c = vec3(0.0045, 0.005, 0.0065) * (1.0 - smoothstep(0.0, 0.9, d.y)) + vec3(0.0006);
  c += vec3(1.0, 0.985, 0.96) * panel(d, uKeyC, uKeyA, vec2(0.075, 0.06), 0.045) * 1.6;
  c += vec3(0.92, 0.96, 1.0) * panel(d, uS1C, uS1A, vec2(0.03, 0.03), 0.02) * 14.0;
  c += vec3(1.0, 0.95, 0.88) * panel(d, uS2C, uS2A, vec2(0.03, 0.03), 0.02) * 12.0;
  c += vec3(1.0) * panel(d, uS3C, uS3A, vec2(0.03, 0.03), 0.02) * 10.0;
  return c;
}
// what one lamp sends to the eye off a patterned patch, by the grating equation: the lamp's offset from the mirror
// direction (along the surface, in the pattern's own axes) over the wavelength must be a spatial frequency of the
// pattern. f0 is the pattern's main frequency (1 / pitch in microns); ring is how much it scatters every way at that
// pitch (the colour then depends only on how far the lamp is from the mirror direction, so rainbow arcs ring each
// lamp); ax and ay are the extra strength along the pattern's rows and columns, where the colour turns with the part
vec3 scatter(vec2 D, float f0, float ring, float ax, float ay){
  float m = length(D);
  vec3 c = (spectral(1000.0 * m / f0) + 0.35 * spectral(500.0 * m / f0)) * ring;
  float px = max(abs(D.x), 1e-3), py = max(abs(D.y), 1e-3);
  c += spectral(1000.0 * px / f0) * ax * exp(-pow(D.y / px * 3.2, 2.0));
  c += spectral(1000.0 * py / f0) * ay * exp(-pow(D.x / py * 3.2, 2.0));
  return c;
}
vec3 lamps(vec3 R, vec3 gx, vec3 gy, float f0, float ring, float ax, float ay){
  vec3 d1 = uS1C - R, d2 = uS2C - R, d3 = uS3C - R;
  return vec3(0.92, 0.96, 1.0) * 5.0 * scatter(vec2(dot(d1, gx), dot(d1, gy)), f0, ring, ax, ay)
       + vec3(1.0, 0.95, 0.88) * 4.0 * scatter(vec2(dot(d2, gx), dot(d2, gy)), f0, ring, ax, ay)
       + vec3(1.0) * 3.0 * scatter(vec2(dot(d3, gx), dot(d3, gy)), f0, ring, ax, ay);
}
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
// linear light to the screen: filmic curve, sRGB-ish gamma, a hair of dither against banding in the dark
vec3 present(vec3 col){
  col = pow(aces(col * 1.15), vec3(1.0 / 2.2));
  return col + (hash(gl_FragCoord.xy) - 0.5) / 255.0;
}
`;
