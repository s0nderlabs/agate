import { getSearchIndex } from "@/lib/docs/content";

// The docs search's index (every chapter's title, description, headings and text), written at build and fetched by
// the browser the first time someone searches.
export const dynamic = "force-static";

export function GET() {
  return Response.json(getSearchIndex());
}
