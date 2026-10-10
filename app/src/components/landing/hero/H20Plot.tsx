"use client";
// Direction 3, new variant (Oct 8):
// "The layout plot". A chip as its designers see it in a layout tool: rows of standard cells, each cell's gates (red
// poly) crossing its diffusion (green), metal straps and power rails (blue), hatched vertical routing (ochre) and long
// horizontal routing (violet), vias where layers meet; translucent layers multiplied on paper, so where they overlap
// the colours mix as in a real plot. It drifts slowly; now and then a signal runs along a wire. The page is an
// engineering drawing: a ruled border with zone marks, and the words in the title block, bottom right.
import { useEffect, useRef } from "react";
import { stillMode } from "@/components/lab/data";
import { runCanvas } from "./gl";
import { CLAIM, Cta, Nav, k, useHero, usd } from "./kit";
import s from "./h20.module.css";

const SUB = ["Lock in what you pay for GPUs.", "Lock in what you earn from them.", "Or trade where the price goes."];
const G = 8; // the gate pitch, in layout units
const RH = 56; // one row of standard cells, rail to rail
const TW = 1600; // the tile's width: the layout repeats across it as it drifts
const h2 = (a: number, b: number) => {
  const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return v - Math.floor(v);
};

interface Wire { x0: number; len: number; y: number }

/** Paint one tile of layout (TW wide, rows tall) into g, which is already scaled to layout units. Returns its long wires. */
function paintTile(g: CanvasRenderingContext2D, rows: number): Wire[] {
  const hatch = (rgb: string) => {
    const c = document.createElement("canvas");
    c.width = c.height = 6;
    const x = c.getContext("2d")!;
    x.strokeStyle = rgb;
    x.lineWidth = 1.1;
    x.beginPath();
    x.moveTo(-1, 7);
    x.lineTo(7, -1);
    x.moveTo(5, 7);
    x.lineTo(7, 5);
    x.stroke();
    return g.createPattern(c, "repeat")!;
  };
  const diff = new Path2D(), poly = new Path2D(), m1 = new Path2D(), cont = new Path2D(), m2 = new Path2D(), m3 = new Path2D(), via = new Path2D();
  const wires: Wire[] = [];
  const addVia = (x: number, y: number) => {
    via.rect(x - 2.2, y - 2.2, 4.4, 4.4);
  };
  // one memory block a tile: an SRAM array of bit cells, word lines across, bit lines down, a ring round it
  const MX0 = 1000, MX1 = 1400, MR0 = 2, MR1 = Math.min(rows - 3, 6);
  const inMacro = (x: number, w: number, r: number) => r >= MR0 && r <= MR1 && x + w > MX0 - 8 && x < MX1 + 8;
  for (let r = 0; r < rows; r++) {
    const y0 = r * RH;
    // the power rails, shared by neighbouring rows
    m1.rect(0, y0 - 2.5, TW, 5);
    let x = 0;
    for (let n = 0; x < TW; n++) {
      let w = (2 + Math.floor(h2(r * 7.1 + 0.3, n * 3.3) * 7)) * G;
      if (TW - x - w < 3 * G) w = TW - x;
      if (inMacro(x, w, r)) {
        x += w;
        continue;
      }
      const gates = Math.max(1, Math.round(w / G) - 1);
      diff.rect(x + 3, y0 + RH * 0.17, w - 6, RH * 0.24);
      diff.rect(x + 3, y0 + RH * 0.59, w - 6, RH * 0.24);
      for (let q = 1; q <= gates; q++) {
        const px = x + q * G - 1;
        poly.rect(px, y0 + RH * 0.1, 2, RH * 0.8);
        if (h2(r + q * 0.7, n * 1.9) < 0.22) {
          poly.rect(px - 2, y0 + RH * 0.46, 6, 5);
          cont.rect(px - 0.25, y0 + RH * 0.46 + 1.25, 2.5, 2.5);
        }
      }
      for (let q = 0; q <= gates; q++) {
        const cx = x + q * G + G / 2 - 1.25 - (q === gates ? G / 2 : 0);
        if (h2(r * 1.3 + q, n * 2.1) > 0.35) cont.rect(cx, y0 + RH * 0.29 - 1.25, 2.5, 2.5);
        if (h2(r * 1.7 + q, n * 2.9) > 0.35) cont.rect(cx, y0 + RH * 0.71 - 1.25, 2.5, 2.5);
      }
      // the cell's output: a strap from its pull-up to its pull-down; wider cells get a local strap across
      const o = Math.floor(h2(r, n * 5.3) * gates);
      m1.rect(x + o * G + G / 2 - 1.5, y0 + RH * 0.26, 3, RH * 0.48);
      if (w >= 4 * G && h2(r * 3.1, n) < 0.5) m1.rect(x + G, y0 + RH * 0.475, w - 2 * G, 3);
      x += w;
    }
    // long horizontal routing, two lanes a row, wrapping round the tile's edge
    for (let l = 0; l < 2; l++) {
      if (h2(r * 2.3, l * 9.1) > 0.8) continue;
      const x0 = Math.floor(h2(r, l * 2.3 + 1) * TW / G) * G, len = 120 + Math.floor(h2(r, l * 4.4) * 90) * G;
      const y = y0 + RH * (l ? 0.36 : 0.64);
      wires.push({ x0, len, y });
      for (const dx of [0, -TW]) m3.rect(x0 + dx, y - 1.5, len, 3);
      addVia(x0 + 1.5, y);
      addVia((x0 + len - 1.5) % TW, y);
    }
  }
  if (MR1 > MR0) {
    const my0 = MR0 * RH + 6, my1 = (MR1 + 1) * RH - 6;
    for (let y = my0 + 6; y < my1 - 6; y += 10) {
      poly.rect(MX0 + 6, y, MX1 - MX0 - 12, 1.6);
      for (let x = MX0 + 8; x < MX1 - 8; x += 6) diff.rect(x, y + 3, 3, 4);
    }
    for (let x = MX0 + 9; x < MX1 - 8; x += 6) m2.rect(x, my0 + 4, 1.4, my1 - my0 - 8);
    m1.rect(MX0, my0 - 4, MX1 - MX0, 4);
    m1.rect(MX0, my1, MX1 - MX0, 4);
    m1.rect(MX0 - 4, my0 - 4, 4, my1 - my0 + 8);
    m1.rect(MX1, my0 - 4, 4, my1 - my0 + 8);
  }
  // vertical routing on a 16-unit track grid, a few rows long, a via at each end
  for (let tx = 0; tx < TW / 16; tx++)
    for (let sgm = 0; sgm < 3; sgm++) {
      if (h2(tx * 1.1, sgm * 13.7 + 5.5) > 0.3) continue;
      const rs = Math.floor(h2(tx, sgm * 6.6 + 1) * rows), span = 1 + Math.floor(h2(tx, sgm * 7.7 + 2) * 3);
      const x = tx * 16 + 6, ya = rs * RH + RH * 0.3, yb = ya + span * RH;
      m2.rect(x, ya, 3, yb - ya);
      addVia(x + 1.5, ya);
      addVia(x + 1.5, yb);
    }
  g.fillStyle = "#f3f2ee";
  g.fillRect(0, -RH, TW, (rows + 2) * RH);
  g.globalCompositeOperation = "multiply";
  g.fillStyle = "rgba(60,150,100,0.30)";
  g.fill(diff);
  g.fillStyle = "rgba(210,75,60,0.5)";
  g.fill(poly);
  g.fillStyle = "rgba(55,100,200,0.3)";
  g.fill(m1);
  g.fillStyle = "rgba(25,28,40,0.55)";
  g.fill(cont);
  g.fillStyle = hatch("rgba(190,140,30,0.8)");
  g.fill(m2);
  g.strokeStyle = "rgba(190,140,30,0.55)";
  g.lineWidth = 0.7;
  g.stroke(m2);
  g.fillStyle = "rgba(125,85,175,0.34)";
  g.fill(m3);
  g.strokeStyle = "rgba(125,85,175,0.65)";
  g.stroke(m3);
  g.fillStyle = "rgba(25,28,40,0.62)";
  g.fill(via);
  g.globalCompositeOperation = "source-over";
  return wires;
}

export function H20Plot() {
  const r = useHero();
  const cv = useRef<HTMLCanvasElement>(null);
  const words = CLAIM.split(" ");
  const lines = [words.slice(0, -1).join(" "), words[words.length - 1]];

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const tile = document.createElement("canvas");
    let key = "", wires: Wire[] = [], S = 1;
    return runCanvas(c, {
      still: stillMode(),
      dprMax: 2,
      draw: (ctx, t0, W, H) => {
        const t = t0 < 0 ? 6 : t0;
        // the drawing's scale: a row of cells is about 100 points tall on a wide screen
        S = Math.max(1.4, Math.min(2.2, W / 1000));
        const dpr = Math.min(1.5, window.devicePixelRatio || 1);
        const rows = Math.ceil(H / (RH * S)) + 1;
        const k2 = `${rows}:${S.toFixed(3)}:${dpr}`;
        if (k2 !== key) {
          key = k2;
          tile.width = Math.round(TW * S * dpr);
          tile.height = Math.round(rows * RH * S * dpr);
          const g = tile.getContext("2d")!;
          g.setTransform(S * dpr, 0, 0, S * dpr, 0, 0);
          wires = paintTile(g, rows);
        }
        // drift: slowly right to left, the tile repeating
        const span = TW * S, off = (t * 9) % span;
        const tw = tile.width / dpr, th = tile.height / dpr;
        for (let x = -off; x < W; x += span) ctx.drawImage(tile, x, 0, tw, th);

        // a signal now and then: a long wire lights from one end to the other, then fades
        const every = 2.4, life = 3.2;
        for (let n = Math.floor((t - life) / every); n <= Math.floor(t / every); n++) {
          if (n < 0 || !wires.length) continue;
          const age = t - n * every;
          if (age < 0 || age > life) continue;
          const w = wires[Math.floor(h2(n, 3.3) * wires.length)];
          const run = Math.min(1, age / 1.4), fade = 1 - Math.max(0, (age - 1.8) / (life - 1.8));
          for (let x = -off; x < W; x += span) {
            const xa = x + w.x0 * S, y = w.y * S;
            const xb = xa + w.len * S * run;
            if (xb < 0 || xa > W) continue;
            ctx.strokeStyle = `rgba(42,91,215,${(0.85 * fade).toFixed(3)})`;
            ctx.lineWidth = 3 * S;
            ctx.beginPath();
            ctx.moveTo(xa, y);
            ctx.lineTo(xb, y);
            ctx.stroke();
            if (run < 1) {
              const rg = ctx.createRadialGradient(xb, y, 0, xb, y, 14 * S);
              rg.addColorStop(0, "rgba(42,91,215,0.45)");
              rg.addColorStop(1, "rgba(42,91,215,0)");
              ctx.fillStyle = rg;
              ctx.fillRect(xb - 14 * S, y - 14 * S, 28 * S, 28 * S);
            }
          }
        }
      },
    });
  }, []);

  return (
    <section className={`${k.hero} ${s.hero}`}>
      <Nav cta={s.sq} />
      <div className={s.body}>
        <canvas ref={cv} className={s.plot} role="img" aria-label="A chip's layout as its designers draw it: rows of cells, gates, metal routing and vias, with signals running along its wires" />
        {/* the drawing's border, with zone marks */}
        <div className={s.frame} aria-hidden>
          <div className={s.zonesX}>
            {["A", "B", "C", "D", "E", "F"].map((z) => (
              <span key={z}>{z}</span>
            ))}
          </div>
          <div className={s.zonesY}>
            {["1", "2", "3", "4"].map((z) => (
              <span key={z}>{z}</span>
            ))}
          </div>
        </div>
        <div className={s.block}>
          <h1 className={s.h1}>
            {lines.map((l) => (
              <span key={l}>{l}</span>
            ))}
          </h1>
          <p className={s.sub}>
            {SUB.map((l) => (
              <span key={l}>{l}</span>
            ))}
          </p>
          <div className={s.price}>
            <span>H100, an hour today</span>
            <b>{r.h.price > 0 ? usd(r.h.price) : ""}</b>
          </div>
          <div className={s.go}>
            <Cta className={s.sq} />
          </div>
          <div className={s.lock}>{r.m ? `Lock in ${r.month} at ${usd(r.m.long)}` : "Trade it, or lock it in"}</div>
        </div>
      </div>
    </section>
  );
}
