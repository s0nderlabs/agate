// The docs' share card (1200 x 630): the Agate lockup, a chapter's name large in Erode and its one line, on the site's
// paper and ink, inside a hairline frame with the landing's corner marks. Drawn by every docs share image (the
// contents page, each chapter, How Agate works), each written at build.
//
// Fonts: the renderer reads TTF, OTF or WOFF only, and the repo holds Apfel Grotezk as WOFF2 alone, so everything here
// is set in Erode, fetched once per build from Fontshare (its licence has it load from there, never from a copy in the
// repo). If that fetch fails the image still renders, in the renderer's own sans. The lockup is drawn from the logo's
// own vector paths, so it needs no font.
import { ImageResponse } from "next/og";
import { MARK, MARK_GAP, pointsOf } from "@/components/brand/fold";
import { PEBBLE_NAME } from "@/components/brand/pebble";

export const SHARE_SIZE = { width: 1200, height: 630 };
const size = SHARE_SIZE;

/** The docs' own line, for the contents page's image (no chapter). */
export const DOCS_LINE = "How the price of a GPU-hour is made, how its monthly market works, and every way in: the app, an AI, the API, the SDK and the contracts.";

// the light tokens (globals.css), written out: the renderer has no stylesheet
const PAPER = "#f6f5f1";
const INK = "#17171a";
const INK_2 = "#4b4a46";
const LINE = "rgba(23, 23, 26, 0.14)";
const MARKS = "rgba(23, 23, 26, 0.34)";

let erode: Promise<ArrayBuffer | null> | null = null;
/** Erode Regular as TTF, from the stylesheet Fontshare serves (its file addresses are not fixed, so they are read). */
function loadErode() {
  erode ??= (async () => {
    try {
      const css = await fetch("https://api.fontshare.com/v2/css?f[]=erode@400&display=swap", { cache: "force-cache", signal: AbortSignal.timeout(8000) });
      if (!css.ok) return null;
      const m = /url\(['"]?([^'")]+\.ttf)['"]?\)/.exec(await css.text());
      if (!m) return null;
      const file = await fetch(m[1].startsWith("//") ? `https:${m[1]}` : m[1], { cache: "force-cache", signal: AbortSignal.timeout(8000) });
      return file.ok ? await file.arrayBuffer() : null;
    } catch {
      return null;
    }
  })();
  return erode;
}

/** The folded A and AGATE as one SVG (the same geometry as the site's Lockup), in ink, as an image source. */
function lockup(height: number) {
  const nameX0 = Number(/translate\(([\d.]+)/.exec(PEBBLE_NAME.transform)?.[1] ?? 0);
  const nameX = MARK.nameAt + 22;
  const nameTf = PEBBLE_NAME.transform.replace(/translate\([\d.]+,/, `translate(${nameX.toFixed(3)},`);
  const x0 = 100 - MARK.width;
  const w = nameX + PEBBLE_NAME.width - nameX0 - x0;
  const faces = MARK.faces.map((f) => `<polygon points="${pointsOf(f, Math.max(MARK_GAP, 50 / height))}" fill="${INK}"/>`).join("");
  // a unit of room on every side, so nothing at the edge of the drawing is cut
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${(x0 - 1).toFixed(2)} -1 ${(w + 2).toFixed(2)} 102">${faces}<path transform="${nameTf}" d="${PEBBLE_NAME.d}" fill="${INK}"/></svg>`;
  return { src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, width: Math.round((height * (w + 2)) / 102), height };
}

/** The frame: 40 px in from the image's edges, with a 1 px line; its inside measures W x H. */
const INSET = 40;
const W = size.width - 2 * INSET - 2;
const H = size.height - 2 * INSET - 2;

/** The landing's frame corners: a short cross centred on each corner of the hairline frame (placed from the top left
 *  only, which the renderer handles most reliably). */
function Corners() {
  const arm = 13;
  const at = [
    { left: -7, top: -7 },
    { left: W - 6, top: -7 },
    { left: -7, top: H - 6 },
    { left: W - 6, top: H - 6 },
  ];
  return (
    <>
      {at.map((p, i) => (
        <div key={i} style={{ position: "absolute", width: arm, height: arm, display: "flex", ...p }}>
          <div style={{ position: "absolute", left: 6, top: 0, width: 1, height: arm, background: MARKS }} />
          <div style={{ position: "absolute", left: 0, top: 6, width: arm, height: 1, background: MARKS }} />
        </div>
      ))}
    </>
  );
}

/** The card for a page: its name and its one line. */
export async function shareCard(title: string, line: string) {
  const font = await loadErode();
  const logo = lockup(44);
  const big = title.length <= 12 ? 116 : title.length <= 18 ? 100 : 86;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", padding: INSET, background: PAPER, color: INK, fontFamily: font ? "Erode" : undefined }}>
        {/* the frame holds no padding, so the corner marks sit on its corners (the renderer places absolute children
            inside the padding) */}
        <div style={{ position: "relative", flex: 1, display: "flex", border: `1px solid ${LINE}` }}>
          <Corners />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "50px 60px 56px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logo.src} width={logo.width} height={logo.height} alt="" />
              <div style={{ display: "flex", fontSize: 32, color: INK_2 }}>Docs</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", fontSize: big, lineHeight: 1, letterSpacing: Math.round(big * -0.035), color: INK }}>{title}</div>
              <div style={{ display: "flex", marginTop: 26, maxWidth: 960, fontSize: 35, lineHeight: 1.32, color: INK_2 }}>{line.length > 170 ? `${line.slice(0, 168).replace(/\s+\S*$/, "")}...` : line}</div>
            </div>
          </div>
        </div>
      </div>
    ),
    { ...size, fonts: font ? [{ name: "Erode", data: font, weight: 400, style: "normal" }] : undefined },
  );
}
