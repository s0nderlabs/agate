import { llmsFull } from "@/lib/docs/content";

// /llms-full.txt: every docs chapter's markdown in reading order, in one file for agents. Written at build.
export const dynamic = "force-static";

export function GET() {
  return new Response(llmsFull(), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
