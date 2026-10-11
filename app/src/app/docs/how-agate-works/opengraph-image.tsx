import { HOW_DESCRIPTION, HOW_TITLE } from "@/lib/docs/explainer";
import { SHARE_SIZE, shareCard } from "@/lib/docs/shareCard";

// How Agate works' share image: the chapters' card with its name and line. Written at build like theirs.

export const alt = "How Agate works, a chapter of the Agate docs";
export const size = SHARE_SIZE;
export const contentType = "image/png";
export const dynamic = "force-static";

export default function Image() {
  return shareCard(HOW_TITLE, HOW_DESCRIPTION);
}
