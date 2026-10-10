// A small WebGL runner for the hero shaders (no library): one full-screen fragment shader on a canvas, drawn every
// frame while the canvas is on screen, once in still mode (render checks, reduced motion). The caller gives the
// shader and a per-frame uniform setter; textures go in through setup.

const VERT = `attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }`;

export type Uniform = (name: string) => WebGLUniformLocation | null;

export interface ShaderRun {
  frag: string;
  /** device pixels per CSS pixel, capped (the shaders are per pixel; a 4K screen at 2x is four times the work) */
  dprMax?: number;
  setup?: (gl: WebGLRenderingContext, prog: WebGLProgram, U: Uniform) => void;
  frame: (gl: WebGLRenderingContext, U: Uniform, t: number, w: number, h: number) => void;
  still: boolean;
  /** true when nothing on screen would change: the frame is skipped (a settled picture costs no GPU) */
  idle?: () => boolean;
}

export function runShader(canvas: HTMLCanvasElement, o: ShaderRun): () => void {
  const gl = canvas.getContext("webgl", { premultipliedAlpha: true, antialias: false, alpha: true, preserveDrawingBuffer: o.still });
  if (!gl || gl.isContextLost()) {
    canvas.dataset.nogl = "1";
    return () => {};
  }
  // fwidth() for antialiased lines (every WebGL 1 browser in use has it); a shader that asks for it enables it
  gl.getExtension("OES_standard_derivatives");
  const sh = (type: number, src: string) => {
    const x = gl.createShader(type)!;
    gl.shaderSource(x, src);
    gl.compileShader(x);
    if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) {
      console.warn("hero shader:", gl.getShaderInfoLog(x));
      return null;
    }
    return x;
  };
  const vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, o.frag);
  if (!vs || !fs) {
    canvas.dataset.nogl = "1";
    return () => {};
  }
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn("hero shader link:", gl.getProgramInfoLog(prog));
    canvas.dataset.nogl = "1";
    return () => {};
  }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const cache = new Map<string, WebGLUniformLocation | null>();
  const U: Uniform = (n) => {
    if (!cache.has(n)) cache.set(n, gl.getUniformLocation(prog, n));
    return cache.get(n)!;
  };
  o.setup?.(gl, prog, U);

  let raf = 0, visible = true, alive = true;
  const t0 = performance.now();
  // a still frame stands at 9 s (past every intro), or at ?t= for a render check of another moment
  const tStill = Number(new URLSearchParams(window.location.search).get("t") ?? 9) || 9;
  const draw = () => {
    const dpr = Math.min(o.dprMax ?? 1.5, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    o.frame(gl, U, o.still ? tStill : (performance.now() - t0) / 1000, w, h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  // the size the last frame was drawn at: a resize always draws, even when the picture is otherwise idle
  let drawnW = 0, drawnH = 0;
  const loop = () => {
    if (!alive) return;
    const sized = canvas.clientWidth === drawnW && canvas.clientHeight === drawnH;
    if (!(o.idle?.() && sized)) {
      draw();
      drawnW = canvas.clientWidth;
      drawnH = canvas.clientHeight;
    }
    if (!o.still && visible && !document.hidden) raf = requestAnimationFrame(loop);
  };
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    cancelAnimationFrame(raf);
    if (visible) raf = requestAnimationFrame(loop);
  });
  io.observe(canvas);
  const onVis = () => {
    cancelAnimationFrame(raf);
    if (!document.hidden && visible) raf = requestAnimationFrame(loop);
  };
  document.addEventListener("visibilitychange", onVis);
  draw();
  if (!o.still) raf = requestAnimationFrame(loop);
  // a still frame is redrawn when the box changes size (a render check resizes nothing, but a phone rotates)
  const ro = o.still ? new ResizeObserver(() => draw()) : null;
  ro?.observe(canvas);
  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    io.disconnect();
    ro?.disconnect();
    document.removeEventListener("visibilitychange", onVis);
    gl.deleteProgram(prog);
    gl.deleteBuffer(buf);
  };
}

/** The same loop for a 2D canvas: sized to its box at the screen's pixel density (capped), drawn every frame while on
 *  screen, once in still mode (redrawn on resize). draw gets CSS-pixel units (the context is pre-scaled). */
export function runCanvas(
  canvas: HTMLCanvasElement,
  o: { still: boolean; dprMax?: number; draw: (ctx: CanvasRenderingContext2D, t: number, w: number, h: number) => void },
): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  let raf = 0, visible = true, alive = true;
  const t0 = performance.now();
  const tStill = Number(new URLSearchParams(window.location.search).get("t") ?? NaN);
  const draw = () => {
    const dpr = Math.min(o.dprMax ?? 2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const w = Math.max(1, Math.round(cw * dpr)), h = Math.max(1, Math.round(ch * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    o.draw(ctx, o.still ? (Number.isFinite(tStill) ? tStill : -1) : (performance.now() - t0) / 1000, cw, ch);
  };
  const loop = () => {
    if (!alive) return;
    draw();
    if (!o.still && visible && !document.hidden) raf = requestAnimationFrame(loop);
  };
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    cancelAnimationFrame(raf);
    if (visible && !o.still) raf = requestAnimationFrame(loop);
  });
  io.observe(canvas);
  const onVis = () => {
    cancelAnimationFrame(raf);
    if (!document.hidden && visible && !o.still) raf = requestAnimationFrame(loop);
  };
  document.addEventListener("visibilitychange", onVis);
  const ro = new ResizeObserver(() => draw());
  ro.observe(canvas);
  draw();
  if (!o.still) raf = requestAnimationFrame(loop);
  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    io.disconnect();
    ro.disconnect();
    document.removeEventListener("visibilitychange", onVis);
  };
}

/** Pointer position over an element, -1..1 each way, eased toward where the pointer is (0,0 when it leaves). */
export function trackPointer(el: HTMLElement) {
  const p = { x: 0, y: 0, tx: 0, ty: 0 };
  const move = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    const b = el.getBoundingClientRect();
    p.tx = ((e.clientX - b.left) / b.width) * 2 - 1;
    p.ty = ((e.clientY - b.top) / b.height) * 2 - 1;
  };
  const leave = () => {
    p.tx = 0;
    p.ty = 0;
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerleave", leave);
  return {
    get: (k = 0.05) => {
      p.x += (p.tx - p.x) * k;
      p.y += (p.ty - p.y) * k;
      return p;
    },
    stop: () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    },
  };
}
