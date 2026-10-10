"use client";
// The real product, staged (asset lab): the live app itself, not a mockup, running in a laptop screen and a phone on a
// lit stage. Same-origin frames, so the judging pill and the testnet banner can be hidden for the shot.
import { useEffect, useRef } from "react";
import s from "./lab.module.css";

const HIDE = '[class*="__notice"],[class*="MockDock-module"]{display:none!important}';

function Frame({ src, w, h, scale, title }: { src: string; w: number; h: number; scale: number; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const f = ref.current;
    if (!f) return;
    const clean = () => {
      try {
        const d = f.contentDocument;
        if (d && !d.getElementById("labhide")) {
          const st = d.createElement("style");
          st.id = "labhide";
          st.textContent = HIDE;
          d.head.appendChild(st);
        }
      } catch {}
    };
    f.addEventListener("load", clean);
    clean();
    return () => f.removeEventListener("load", clean);
  }, []);
  return (
    <div className={s.frameBox} style={{ width: w * scale, height: h * scale }}>
      <iframe ref={ref} src={src} title={title} tabIndex={-1} style={{ width: w, height: h, transform: `scale(${scale})` }} />
    </div>
  );
}

export function Staged({ theme }: { theme: "light" | "dark" }) {
  const q = `agentcheck=1&chk=labstage&logo=lace&source=live&theme=${theme}`;
  return (
    <div className={s.stage}>
      <div className={s.laptop}>
        <div className={s.screen}>
          <Frame src={`/?${q}`} w={1440} h={900} scale={0.5} title="Agate's market screen, live" />
        </div>
        <div className={s.base} />
      </div>
      <div className={s.phone}>
        <Frame src={`/?${q}&chk=labphone`} w={393} h={852} scale={0.62} title="Agate on a phone, live" />
      </div>
    </div>
  );
}
