import ChapterImage from "./[slug]/opengraph-image";

// The contents page's share image: the chapters' card with no chapter, so it reads "Agate docs" and the docs' own line.
// Written at build like the chapters' images.

export const alt = "Agate docs: how the price of a GPU-hour is made, its monthly market, and every way in";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const dynamic = "force-static";

export default function Image() {
  return ChapterImage({ params: Promise.resolve({ slug: "" }) });
}
