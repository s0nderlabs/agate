"use client";
// Hero "The hour" (Oct 8, the third compute hero): the product itself, one GPU-hour.
// A dial of 3,600 cells, one per second of one H100's hour. A hand sweeps it and each second fills with the work
// someone bought: training a model, answering questions, rendering video. The full hour gets its price (today's H100
// hour, live). Then the dial resets and the camera pulls back: it is one of next month's hours, a calendar of them,
// every one priced now, and the lock price stamps across the month. Hairlines and type on a 2D canvas.
import { useEffect, useRef, useState } from "react";
import { stillMode } from "@/components/lab/data";
import { runCanvas } from "./gl";
import { CLAIM, Cta, Nav, StepLine, k, useHero, usd } from "./kit";
import s from "./h17.module.css";

const LOOP = 21;
const T_RUN = 2.4, T_FULL = 9.0, T_ZOOM = 12.0, T_GRID = 13.9, T_LOCK = 14.3;
// 360 columns of 10 seconds around the dial, each column filled from the inside out
const COLS = 360, RINGS = 10;
// what the hour did, in seconds: 0 training a model, 1 answering questions, 2 rendering video
const PLAN: [number, number][] = [[0, 840], [1, 300], [2, 180], [1, 420], [0, 660], [2, 240], [1, 360], [0, 600]];
const KIND = ["Training a model", "Answering questions", "Rendering video"];
const RGB: [number, number, number][] = [[126, 146, 255], [226, 233, 255], [236, 180, 112]];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const hash = (a: number, b: number) => {
  const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return v - Math.floor(v);
};
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const daysIn = (name: string) => {
  const i = MONTHS.indexOf(name);
  if (i < 0) return 30;
  const now = new Date();
  return new Date(i < now.getMonth() ? now.getFullYear() + 1 : now.getFullYear(), i + 1, 0).getDate();
};
const clock = (sec: number) => {
  const v = Math.floor(sec);
  return [Math.floor(v / 3600), Math.floor(v / 60) % 60, v % 60].map((n) => String(n).padStart(2, "0")).join(":");
};

export function H17Dial() {
  const r = useHero();
  const cv = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const h1 = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState(0);
  const price = r.h.price;
  const lock = r.m?.long ?? 0;
  const month = r.month;
  const days = daysIn(month);
  const hours = days * 24;
  const steps = [
    "One hour of an H100: 3,600 seconds.",
    "Every second of it does work someone pays for.",
    price > 0 ? `So the hour has a price. Today it is ${usd(price)}.` : "So the hour has a price.",
    lock > 0 ? `${month} is ${hours} more of them. Lock in ${usd(lock)} an hour now, or trade them.` : "Next month's hours are priced now. Lock them in, or trade them.",
  ];

  useEffect(() => {
    const c = cv.current, st = stage.current;
    if (!c || !st) return;
    const still = stillMode();
    const font = getComputedStyle(document.body).fontFamily;
    const disp = h1.current ? getComputedStyle(h1.current).fontFamily : font;
    const kind = new Uint8Array(3600);
    let s0 = 0;
    for (const [kd, n] of PLAN) {
      kind.fill(kd, s0, s0 + n);
      s0 += n;
    }
    // how bright a worked second is: a training run steady, answers many small and uneven, video in frame-like bands
    const tone = (sec: number) => {
      const kd = kind[sec];
      return kd === 0 ? 0.78 + 0.08 * Math.sin(sec * 0.05) : kd === 1 ? 0.42 + 0.55 * hash(sec, 3.7) : 0.66 + 0.24 * ((Math.floor(sec / 6) % 2));
    };
    // text drawn in fixed slots, so a running clock does not jitter
    const slots = (ctx: CanvasRenderingContext2D, text: string, x: number, y: number) => {
      const dw = ctx.measureText("0").width, cw = ctx.measureText(":").width;
      const total = [...text].reduce((a, ch) => a + (ch === ":" ? cw : dw), 0);
      let px = x - total / 2;
      ctx.textAlign = "center";
      for (const ch of text) {
        const w = ch === ":" ? cw : dw;
        ctx.fillText(ch, px + w / 2, y);
        px += w;
      }
    };
    let last = -1;
    const stop = runCanvas(c, {
      still,
      dprMax: 2,
      draw: (ctx, t0, W, H) => {
        const t = t0 < 0 ? 11 : t0;
        const tau = ((t % LOOP) + LOOP) % LOOP;
        const sr = st.getBoundingClientRect(), cr = c.getBoundingClientRect();
        const L = sr.left - cr.left, T = sr.top - cr.top, SW = sr.width, SH = sr.height;
        const narrow = SW < 600;
        const A = 1 - smooth((tau - (LOOP - 0.8)) / 0.8);
        const base = ctx.getTransform();

        // the hour so far; at the end of the price beat the hand runs back to zero (a new hour)
        const run = Math.max(0, Math.min(1, (tau - T_RUN) / (T_FULL - T_RUN)));
        const back = ease((tau - (T_ZOOM - 0.7)) / 0.8);
        const sec = 3600 * run * (1 - back);
        const drawIn = ease(tau / 1.4);

        // next month as a calendar of hours: days across, hours down (turned on a phone)
        const gc = narrow ? 24 : days, gr = narrow ? days : 24;
        const padL = narrow ? 4 : 64, padT = narrow ? 100 : 92;
        const cell = Math.min((SW - padL) / gc, (SH - padT - 8) / gr);
        const gx = L + padL + (SW - padL - cell * gc) / 2, gy = T + padT;
        const cellAt = (d: number, h: number): [number, number] => (narrow ? [gx + (h + 0.5) * cell, gy + (d + 0.5) * cell] : [gx + (d + 0.5) * cell, gy + (h + 0.5) * cell]);
        const [c0x, c0y] = cellAt(0, 0);
        const rMini = cell * 0.4;
        // the dial at full size, and the camera that pulls back from it to the month
        const R = narrow ? Math.min(SW * 0.4, SH * 0.36) : Math.min(SW, SH) * 0.4;
        const cx = L + SW / 2, cy = T + SH * (narrow ? 0.46 : 0.5);
        const z = ease((tau - T_ZOOM) / (T_GRID - T_ZOOM));
        const Z = Math.exp(Math.log(R / rMini) * (1 - z));
        const Sx = cx + (c0x - cx) * z, Sy = cy + (c0y - cy) * z;
        const toS = (x: number, y: number): [number, number] => [(x - c0x) * Z + Sx, (y - c0y) * Z + Sy];
        const Rd = rMini * Z;
        const lockAt = (d: number, h: number) => smooth((tau - T_LOCK - (d / days) * 1.7 - (h / 24) * 0.12) / 0.35);

        // one hour of the month: a hairline dial with a faint band; locking fills the band clockwise, like the hour above
        const hourAt = (x: number, y: number, rr: number, lk: number, a: number) => {
          const rad = rr * 0.86;
          ctx.lineWidth = rr * 0.17;
          ctx.strokeStyle = `rgba(200,210,236,${0.05 * a})`;
          ctx.beginPath();
          ctx.arc(x, y, rad - rr * 0.085, 0, Math.PI * 2);
          ctx.stroke();
          ctx.lineWidth = 1;
          ctx.strokeStyle = `rgba(200,210,236,${0.24 * a})`;
          ctx.beginPath();
          ctx.arc(x, y, rad, 0, Math.PI * 2);
          ctx.stroke();
          if (lk > 0) {
            const bw = Math.max(1.5, rr * 0.3);
            ctx.lineWidth = bw;
            ctx.strokeStyle = `rgba(132,150,255,${0.9 * a})`;
            ctx.beginPath();
            ctx.arc(x, y, rad - bw / 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * lk);
            ctx.stroke();
          }
        };

        ctx.save();
        ctx.beginPath();
        ctx.rect(L - 70, T - 70, SW + 140, SH + 140);
        ctx.clip();
        ctx.globalAlpha = A;

        // the other hours of the month, coming into view as the camera pulls back
        const ga = smooth((tau - T_ZOOM - 0.1) / 1.2);
        if (ga > 0) {
          const rr = rMini * Z;
          for (let d = 0; d < days; d++) {
            for (let h = 0; h < 24; h++) {
              if (d === 0 && h === 0) continue;
              const [wx, wy] = cellAt(d, h);
              const [x, y] = toS(wx, wy);
              if (x < L - rr - 70 || x > L + SW + rr + 70 || y < T - rr - 70 || y > T + SH + rr + 70) continue;
              hourAt(x, y, rr, lockAt(d, h), ga);
            }
          }
        }

        // the dial: this hour, second by second
        const lk0 = lockAt(0, 0);
        if (Rd > 46) {
          const bw = Rd * (narrow ? 0.2 : 0.17);
          const Ri = Rd - bw, pitch = bw / RINGS;
          for (let col = 0; col < COLS; col++) {
            const f = col / COLS;
            const ang = f * Math.PI * 2 - Math.PI / 2;
            ctx.setTransform(base);
            ctx.translate(Sx, Sy);
            ctx.rotate(ang);
            const shown = smooth((drawIn - f) * 12 + 1);
            for (let ring = 0; ring < RINGS; ring++) {
              const sc = col * 10 + ring;
              const rad = Ri + ring * pitch;
              const cw = ((Math.PI * 2 * (rad + pitch / 2)) / COLS) * 0.7;
              if (sc < sec) {
                const [cr0, cg0, cb0] = RGB[kind[sc]];
                const age = sec - sc;
                const b = Math.min(1.25, tone(sc) + (age < 260 ? 0.5 * (1 - age / 260) : 0));
                ctx.fillStyle = `rgba(${Math.min(255, cr0 * b) | 0},${Math.min(255, cg0 * b) | 0},${Math.min(255, cb0 * b) | 0},${A})`;
              } else {
                ctx.fillStyle = `rgba(${200 - 74 * lk0 | 0},${208 - 62 * lk0 | 0},${232 + 23 * lk0 | 0},${(0.07 + 0.6 * lk0) * shown * A})`;
              }
              ctx.fillRect(rad, -cw / 2, pitch * 0.74, cw);
            }
          }
          ctx.setTransform(base);
          // minutes: sixty ticks and every fifth numbered
          const big = Rd > 130;
          for (let m = 0; m < 60; m++) {
            const ang = (m / 60) * Math.PI * 2 - Math.PI / 2;
            const co = Math.cos(ang), si = Math.sin(ang);
            const five = m % 5 === 0;
            const sh = smooth((drawIn - m / 60) * 12 + 1);
            ctx.strokeStyle = `rgba(220,228,250,${(five ? 0.55 : 0.24) * sh * A})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Sx + co * (Rd + 5), Sy + si * (Rd + 5));
            ctx.lineTo(Sx + co * (Rd + (five ? 13 : 9)), Sy + si * (Rd + (five ? 13 : 9)));
            ctx.stroke();
            if (five && big) {
              ctx.font = `500 15px ${font}`;
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.fillStyle = `rgba(150,160,182,${sh * A * (1 - z)})`;
              ctx.fillText(String(m), Sx + co * (Rd + 30), Sy + si * (Rd + 30));
            }
          }
          // the hand
          if ((tau > T_RUN && tau < T_FULL + 0.4) || (back > 0 && back < 1)) {
            const ang = (sec / 3600) * Math.PI * 2 - Math.PI / 2;
            const co = Math.cos(ang), si = Math.sin(ang);
            const ha = (tau < T_FULL + 0.4 ? 1 - smooth((tau - T_FULL) / 0.4) : 1) * A;
            ctx.strokeStyle = `rgba(255,255,255,${0.9 * ha})`;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(Sx + co * (Ri - 14), Sy + si * (Ri - 14));
            ctx.lineTo(Sx + co * (Rd + 14), Sy + si * (Rd + 14));
            ctx.stroke();
            ctx.fillStyle = `rgba(255,255,255,${ha})`;
            ctx.beginPath();
            ctx.arc(Sx + co * (Rd + 14), Sy + si * (Rd + 14), 2.5, 0, Math.PI * 2);
            ctx.fill();
          }

          // the middle: the clock while it runs, the price once the hour is whole, and what the seconds went to
          const ca = (1 - smooth(z * 4)) * A;
          if (ca > 0) {
            ctx.textBaseline = "alphabetic";
            const priceOn = smooth((tau - T_FULL - 0.2) / 0.6) * (1 - back);
            const bigSize = Math.min(64, Rd * (narrow ? 0.24 : 0.2));
            const yTop = Sy - Ri * (narrow ? 0.24 : 0.18);
            ctx.font = `400 ${bigSize}px ${disp}`;
            ctx.fillStyle = `rgba(240,244,252,${ca * (1 - priceOn)})`;
            slots(ctx, clock(Math.min(3600, sec)), Sx, yTop);
            if (priceOn > 0 && price > 0) {
              ctx.fillStyle = `rgba(255,255,255,${ca * priceOn})`;
              ctx.textAlign = "center";
              ctx.fillText(usd(price), Sx, yTop);
            }
            ctx.font = `500 ${narrow ? 15 : 17}px ${font}`;
            ctx.textAlign = "center";
            ctx.fillStyle = `rgba(150,160,182,${ca})`;
            ctx.fillText(priceOn > 0.5 && price > 0 ? "this hour, today" : "of one H100", Sx, yTop + (narrow ? 26 : 32));
            // the legend
            const done = [0, 0, 0];
            for (let q = 0; q < Math.min(3600, sec); q++) done[kind[q]]++;
            const rowH = narrow ? 22 : 26;
            const lw = narrow ? 150 : 210;
            const lx = Sx - lw / 2 - 8, ly = Sy + Ri * (narrow ? 0.3 : 0.2);
            ctx.font = `500 15px ${font}`;
            KIND.forEach((name, n) => {
              const y = ly + n * rowH;
              const [cr0, cg0, cb0] = RGB[n];
              const la = ca * smooth((tau - T_RUN - 0.2 - n * 0.15) / 0.5) * (1 - back);
              ctx.fillStyle = `rgba(${cr0},${cg0},${cb0},${la})`;
              ctx.beginPath();
              ctx.roundRect(lx, y - 10, 9, 9, 2);
              ctx.fill();
              ctx.textAlign = "left";
              ctx.fillStyle = `rgba(214,220,236,${la})`;
              ctx.fillText(narrow ? name.split(" ")[0] : name, lx + 18, y);
              ctx.textAlign = "right";
              ctx.fillStyle = `rgba(150,160,182,${la})`;
              ctx.fillText(`${Math.floor(done[n] / 60)} min`, lx + lw + 16, y);
            });
          }
        } else {
          // small enough to be one hour of the month like the rest
          hourAt(Sx, Sy, Rd, lk0, 1);
        }

        // the month's labels
        if (ga > 0) {
          const la = smooth((tau - T_GRID + 0.3) / 0.6) * A;
          ctx.textBaseline = "alphabetic";
          ctx.textAlign = "left";
          ctx.font = `400 ${narrow ? 26 : 34}px ${disp}`;
          ctx.fillStyle = `rgba(240,244,252,${la})`;
          ctx.fillText(month, gx, gy - (narrow ? 62 : 44));
          const mw = ctx.measureText(month).width;
          ctx.font = `500 ${narrow ? 15 : 17}px ${font}`;
          ctx.fillStyle = `rgba(150,160,182,${la})`;
          // on a phone the count goes under the month's name
          const sub = `${hours} hours of one H100${lock > 0 ? `, ${usd(lock)} each` : ""}`;
          if (narrow) ctx.fillText(sub, gx, gy - 36);
          else ctx.fillText(sub, gx + mw + 14, gy - 44);
          ctx.font = `500 15px ${font}`;
          if (narrow) {
            ctx.textAlign = "center";
            [0, 6, 12, 18].forEach((h) => ctx.fillText(`${String(h).padStart(2, "0")}:00`, gx + (h + 0.5) * cell, gy - 10));
          } else {
            ctx.textAlign = "center";
            [1, 8, 15, 22, 29].filter((d) => d <= days).forEach((d) => ctx.fillText(String(d), gx + (d - 0.5) * cell, gy - 12));
            ctx.textAlign = "right";
            ctx.textBaseline = "middle";
            [0, 6, 12, 18].forEach((h) => ctx.fillText(`${String(h).padStart(2, "0")}:00`, gx - 12, gy + (h + 0.5) * cell));
            ctx.textBaseline = "alphabetic";
          }
        }
        ctx.restore();

        const stp = tau < T_RUN ? 0 : tau < T_FULL ? 1 : tau < T_ZOOM ? 2 : 3;
        if (stp !== last) {
          last = stp;
          setStep(stp);
        }
        void W;
        void H;
      },
    });
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [price, lock, month]);

  return (
    <section className={`${k.hero} ${s.hero}`}>
      <Nav dark />
      <div className={s.body}>
        <div className={s.copy}>
          <h1 ref={h1} className={s.h1}>
            {CLAIM}
          </h1>
          <StepLine steps={steps} index={step} className={s.step} />
          <Cta />
        </div>
        <div className={s.slot}>
          <canvas ref={cv} className={s.gl} aria-hidden />
          <div ref={stage} className={s.stage} role="img" aria-label={`A dial of one H100 hour, 3,600 seconds, filling with work: training a model, answering questions, rendering video. ${price > 0 ? `Today that hour costs ${usd(price)}. ` : ""}Then ${month}: ${hours} hours, all priced now${lock > 0 ? ` at ${usd(lock)} an hour` : ""}.`} />
        </div>
      </div>
    </section>
  );
}
