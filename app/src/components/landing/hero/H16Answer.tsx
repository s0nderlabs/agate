"use client";
// Hero "A question becoming an answer" (Oct 8): what an AI answer is made of.
// A question types in and splits into tokens, each with its id. Each token becomes a column of numbers, one row per
// layer of the model. The question's columns run through every layer at once; then the model writes the answer one
// word at a time, each new word one more column run top to bottom, looking back at the others (the arcs), and the
// likeliest next words come out the bottom with their odds. It speeds up the way a real answer does. A meter counts
// the GPU time the answer used, priced at today's H100 hour (live). Numbers drawn as a heatmap; no glowing brains.
import { useEffect, useRef, useState } from "react";
import { stillMode } from "@/components/lab/data";
import { runCanvas } from "./gl";
import { CLAIM, Cta, Nav, StepLine, k, useHero, usd } from "./kit";
import s from "./h16.module.css";

const LOOP = 18;
// the model's layers, drawn as rows (a large model has about 80)
const ROWS = 24;
// numbers drawn per token per row (a real token carries thousands)
const DIMS = 8;
// seconds of one H100 a token of this answer takes (a large model, batched serving: tens of milliseconds a token)
const GPU_S_PER_TOKEN = 0.03;
const T_TOK = 1.6, T_EMB = 2.2, T_RUN = 3.4;

const hash = (a: number, b: number) => {
  const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return v - Math.floor(v);
};
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const split = (text: string) => [...text.matchAll(/[A-Za-z]+|\$?[0-9]+(?:\.[0-9]+)?|[^\sA-Za-z0-9]/g)].map((m) => ({ w: m[0], end: (m.index ?? 0) + m[0].length }));

// a token's number in a layer, -1..1: a few dimensions run strong through many layers, the rest stay small
const val = (i: number, l: number, d: number) => {
  const amp = hash(i * 3.3 + d, 9.1) ** 2;
  const v = 0.95 * amp * Math.sin(l * (0.18 + 0.3 * hash(d, i)) + 6.3 * hash(i, d)) + 0.4 * (hash(i * 17.3 + d * 3.1, l * 7.7 + d) * 2 - 1);
  return Math.max(-1, Math.min(1, Math.sign(v) * Math.abs(v) ** 1.7));
};
// cold for negative, pale for positive, near black for zero; `f` flashes it toward white
const heat = (v: number, a: number, f: number) => {
  const p = Math.abs(v);
  let r = v >= 0 ? 20 + 200 * p : 20 + 50 * p, g = v >= 0 ? 24 + 206 * p : 24 + 62 * p, b = v >= 0 ? 36 + 219 * p : 36 + 150 * p;
  r += (236 - r) * f;
  g += (242 - g) * f;
  b += (255 - b) * f;
  return `rgba(${r | 0},${g | 0},${b | 0},${a})`;
};

const STEPS = [
  "You ask an AI a question.",
  "Your words become numbers.",
  "A GPU runs them through the model, layer by layer, for every word it writes.",
  "Every answer is seconds of GPU time. That time has a price.",
];

export function H16Answer() {
  const r = useHero();
  const cv = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  const price = r.h.price;
  const lock = r.m?.long ?? 0;
  const month = r.month;
  const question = "How much will an H100 cost me next month?";
  const answer = price > 0 ? `Today an H100 hour is ${usd(price)}. ${lock > 0 ? `You can lock in ${usd(lock)} for ${month}.` : "You can lock in next month now."}` : "An H100 hour has a price today, and you can lock in next month's.";

  useEffect(() => {
    const c = cv.current, st = stage.current;
    if (!c || !st) return;
    const still = stillMode();
    const font = getComputedStyle(document.body).fontFamily;
    const qT = split(question), aT = split(answer);
    const all = [...qT, ...aT].map((x) => x.w);
    const nQ = qT.length, nA = aT.length;
    const ids = all.map((w, i) => 200 + Math.floor(hash(i * 3 + w.length, w.charCodeAt(0)) * 48000));
    // the generation plan. Pass 0 runs the whole question and gives the first word; pass n runs the newest word and
    // gives the next; the last pass runs the final word and ends the answer. The first passes are slow so you see
    // them, then each word takes less, as a real answer streams.
    const durs = Array.from({ length: nA + 1 }, (_, n) => (n === 0 ? 2.4 : n === 1 ? 1.5 : n === 2 ? 1.0 : n === 3 ? 0.6 : Math.max(0.2, 0.6 * 0.82 ** (n - 3))));
    const pStart: number[] = [];
    let acc = T_RUN;
    for (const d of durs) {
      pStart.push(acc);
      acc += d;
    }
    const tDone = acc;
    let widths: number[] | null = null;
    let last = -1;
    const stop = runCanvas(c, {
      still,
      dprMax: 2,
      draw: (ctx, t0, W, H) => {
        const t = t0 < 0 ? LOOP - 2.2 : t0;
        const tau = ((t % LOOP) + LOOP) % LOOP;
        const sr = st.getBoundingClientRect(), cr = c.getBoundingClientRect();
        const L = sr.left - cr.left, T = sr.top - cr.top, SW = sr.width, SH = sr.height;
        const narrow = SW < 600;
        ctx.globalAlpha = 1 - smooth((tau - (LOOP - 0.8)) / 0.8);
        ctx.textBaseline = "alphabetic";
        ctx.textAlign = "left";
        ctx.font = `500 15px ${font}`;
        if (!widths) widths = all.map((w, i) => Math.max(44, Math.max(ctx.measureText(w).width, ctx.measureText(String(ids[i])).width) + 18));

        // where the run is
        let pass = -1;
        for (let n = 0; n <= nA; n++) if (tau >= pStart[n]) pass = n;
        if (tau >= tDone) pass = -1;
        const pT = pass >= 0 ? (tau - pStart[pass]) / durs[pass] : 0;
        let made = 0;
        for (let n = 0; n < nA; n++) if (tau >= pStart[n] + durs[n]) made = n + 1;
        // how far down the layers a column is (0..1), and whether its first row (the lookup) is in
        const prog = (i: number) => {
          const n = i < nQ ? 0 : i - nQ + 1;
          return tau >= pStart[n] + durs[n] ? 1 : pass === n ? pT : 0;
        };
        const appear = (i: number) => (i < nQ ? smooth((tau - T_TOK - 0.05 * i) / 0.35) : smooth((tau - (pStart[i - nQ] + durs[i - nQ])) / 0.3));
        const embed = (i: number) => (i < nQ ? tau >= T_EMB + 0.06 * i : appear(i) > 0.6);

        // 1. the question, typed
        const qChars = Math.floor(smooth(tau / 1.5) * question.length);
        const qSize = narrow ? 17 : 22;
        ctx.font = `500 ${qSize}px ${font}`;
        ctx.fillStyle = "rgba(240,244,252,0.96)";
        ctx.fillText(question.slice(0, qChars), L, T + qSize);
        if (tau < 1.6 && Math.floor(t * 2) % 2 === 0) ctx.fillRect(L + ctx.measureText(question.slice(0, qChars)).width + 3, T + 4, 2, qSize);
        ctx.font = `500 15px ${font}`;

        // 2. the columns: laid out like a tokenizer's view, sliding left as the answer grows
        const GAP = 6;
        const gx0 = L, gx1 = L + SW;
        const xs: number[] = [];
        let cw = 0;
        const cols = nQ + made;
        for (let i = 0; i < nQ + nA; i++) {
          xs.push(cw);
          if (i < cols) cw += (widths[i] + GAP) * (i < nQ ? 1 : appear(i));
        }
        const off = Math.max(0, cw - GAP - (gx1 - gx0));
        const tokY = T + qSize + 50;
        const y0 = tokY + 40, y1 = T + SH * (narrow ? 0.68 : 0.66);
        const pitch = (y1 - y0) / ROWS, ch = Math.max(2, pitch - 3);
        const rowY = (l: number) => y0 + l * pitch;
        const edge = (x: number) => (off > 0 ? smooth((x - gx0) / 60) : 1);

        let activeX = -1;
        for (let i = 0; i < cols; i++) {
          const cx0 = gx0 + xs[i] - off, w = widths[i];
          if (cx0 + w < gx0 - 1 || cx0 > gx1) continue;
          const isAns = i >= nQ;
          const a = appear(i) * edge(cx0 + w);
          if (a <= 0.01) continue;
          // the token chip
          ctx.fillStyle = isAns ? `rgba(120,150,255,${0.09 * a})` : `rgba(255,255,255,${0.05 * a})`;
          ctx.beginPath();
          ctx.roundRect(cx0, tokY - 21, w, 52, 6);
          ctx.fill();
          ctx.textAlign = "center";
          ctx.fillStyle = isAns ? `rgba(170,192,255,${a})` : `rgba(236,240,250,${0.95 * a})`;
          ctx.fillText(all[i], cx0 + w / 2, tokY);
          ctx.fillStyle = `rgba(140,150,172,${0.85 * a * smooth((tau - T_TOK - 0.4) / 0.4)})`;
          ctx.fillText(String(ids[i]), cx0 + w / 2, tokY + 21);

          // the column of numbers, one row per layer
          const f = prog(i), on = pass >= 0 && f > 0 && f < 1;
          const pL = f * (ROWS - 1);
          if (on) activeX = cx0 + w / 2;
          const sx0 = cx0 + 3, sw = (w - 6) / DIMS;
          for (let l = 0; l < ROWS; l++) {
            const y = rowY(l);
            const done = l === 0 ? embed(i) : pL >= l;
            if (!done) {
              ctx.fillStyle = `rgba(255,255,255,${0.028 * a})`;
              ctx.fillRect(sx0, y, w - 6, ch);
              continue;
            }
            const fl = on ? Math.exp(-(((l - pL) / 1.3) ** 2)) * 0.75 : 0;
            for (let d = 0; d < DIMS; d++) {
              ctx.fillStyle = heat(val(i, l, d), a, fl);
              ctx.fillRect(sx0 + d * sw, y, sw - 1, ch);
            }
          }
          if (on) {
            // the layer being worked: a soft band across the column
            const y = rowY(pL) + ch / 2;
            const g = ctx.createLinearGradient(0, y - pitch * 2.5, 0, y + pitch * 2.5);
            g.addColorStop(0, "rgba(160,185,255,0)");
            g.addColorStop(0.5, `rgba(160,185,255,${0.16 * a})`);
            g.addColorStop(1, "rgba(160,185,255,0)");
            ctx.fillStyle = g;
            ctx.fillRect(cx0 - 4, y - pitch * 2.5, w + 8, pitch * 5);
          }
        }

        // attention: the newest word looks back at every word before it, at the layer it is on
        if (pass >= 1 && durs[pass] >= 0.5 && activeX > 0) {
          const ai = nQ + pass - 1;
          const pL = pT * (ROWS - 1);
          const y = rowY(pL) + ch / 2;
          for (let i = 0; i < ai; i++) {
            const cx0 = gx0 + xs[i] - off;
            const x = cx0 + widths[i] / 2;
            if (x < gx0 + 8) continue;
            const wgt = hash(i * 7 + Math.floor(pL), pass * 13) ** 2.4;
            if (wgt < 0.06) continue;
            ctx.strokeStyle = `rgba(190,208,255,${(0.2 + 0.7 * wgt) * edge(x)})`;
            ctx.lineWidth = 1 + wgt;
            ctx.beginPath();
            ctx.moveTo(activeX, y);
            ctx.quadraticCurveTo((activeX + x) / 2, y - Math.min(90, Math.abs(activeX - x) * 0.32 + 14), x, y);
            ctx.stroke();
          }
        }

        // 3. what comes out the bottom: the likeliest next words and their odds; the winner joins the answer
        if (pass >= 0 && pass < nA && durs[pass] >= 0.9 && pT > 0.62 && activeX > 0) {
          const word = aT[pass].w;
          const alts = ["The", "It", "about", "you", "per", "is", "a"].filter((x) => x !== word);
          const p0 = 0.5 + 0.35 * hash(pass, 3);
          const rows: [string, number][] = [[word, p0], [alts[pass % alts.length], (1 - p0) * 0.55], [alts[(pass + 3) % alts.length], (1 - p0) * 0.25]];
          const a = smooth((pT - 0.62) / 0.14);
          const bx = Math.max(gx0, Math.min(gx1 - (narrow ? 200 : 270), activeX - 24));
          const by = y1 + 30;
          ctx.strokeStyle = `rgba(160,185,255,${0.35 * a})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(activeX, y1 - 2);
          ctx.lineTo(activeX, by - 18);
          ctx.stroke();
          const bw = narrow ? 90 : 150;
          rows.forEach(([w, p], n) => {
            const y = by + n * 24;
            ctx.textAlign = "left";
            ctx.fillStyle = n === 0 ? `rgba(240,244,252,${a})` : `rgba(140,150,172,${a})`;
            ctx.fillText(w, bx, y);
            ctx.fillStyle = n === 0 ? `rgba(160,185,255,${0.9 * a})` : `rgba(110,120,145,${0.6 * a})`;
            ctx.fillRect(bx + 70, y - 8, bw * p, 5);
            ctx.fillStyle = `rgba(140,150,172,${a})`;
            ctx.fillText(`${Math.round(p * 100)}%`, bx + 70 + bw * p + 10, y);
          });
        }

        // 4. the answer so far, and what it cost
        const ansSize = narrow ? 17 : 21;
        const ansY = T + SH - (narrow ? 72 : 66);
        ctx.font = `500 ${ansSize}px ${font}`;
        ctx.textAlign = "left";
        const text = made > 0 ? answer.slice(0, aT[made - 1].end) : "";
        const words = text.split(" ");
        let l1 = "", l2 = "";
        for (const w of words) {
          const tryL = l1 ? `${l1} ${w}` : w;
          if (!l2 && ctx.measureText(tryL).width <= SW - 8) l1 = tryL;
          else l2 = l2 ? `${l2} ${w}` : w;
        }
        ctx.fillStyle = "rgba(240,244,252,0.96)";
        ctx.fillText(l1, L, ansY);
        if (l2) ctx.fillText(l2, L, ansY + ansSize * 1.35);
        const secs = tau < T_RUN ? 0 : made * GPU_S_PER_TOKEN + (pass >= 0 ? pT * GPU_S_PER_TOKEN : 0) + 0.04 * Math.min(1, (tau - T_RUN) / durs[0]);
        // the bill: seconds of an H100, priced at today's hour
        const cost = price > 0 ? (secs * price) / 3600 : 0;
        const my = ansY + ansSize * 1.35 * 2 + 10;
        ctx.font = `500 ${narrow ? 15 : 17}px ${font}`;
        const head = `${secs.toFixed(2)} seconds of an H100`;
        ctx.fillStyle = "rgba(240,244,252,0.96)";
        ctx.fillText(head, L, my);
        if (price > 0) {
          // on a phone the cost goes on its own line
          const tail = `$${cost.toFixed(5)} at today's ${usd(price)} an hour`;
          ctx.fillStyle = "rgba(150,160,182,0.95)";
          if (narrow) ctx.fillText(tail, L, my + 22);
          else ctx.fillText(`  ·  ${tail}`, L + ctx.measureText(head).width, my);
        }

        ctx.globalAlpha = 1;
        // keep the words clear: the canvas fades toward the headline on a wide screen
        if (W > 900) {
          const g = ctx.createLinearGradient(0, 0, L, 0);
          g.addColorStop(0, "rgba(5,6,9,1)");
          g.addColorStop(1, "rgba(5,6,9,0)");
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, L, H);
        }
        const stp = tau < T_TOK ? 0 : tau < T_RUN ? 1 : tau < tDone ? 2 : 3;
        if (stp !== last) {
          last = stp;
          setStep(stp);
        }
      },
    });
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer]);

  return (
    <section className={`${k.hero} ${s.hero}`}>
      <Nav dark />
      <div className={s.body}>
        <div className={s.copy}>
          <h1 className={s.h1}>{CLAIM}</h1>
          <StepLine steps={STEPS} index={step} className={s.step} />
          <Cta />
        </div>
        <div className={s.slot}>
          <canvas ref={cv} className={s.gl} aria-hidden />
          <div ref={stage} className={s.stage} role="img" aria-label={`An AI answering "${question}": the words become tokens and numbers, run through the model layer by layer, and the answer "${answer}" is written word by word, each word a few hundredths of a second of GPU time.`} />
        </div>
      </div>
    </section>
  );
}
