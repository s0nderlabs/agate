import { llmsIndex } from "@/lib/docs/content";

// /llms.txt (llmstxt.org): the docs for agents, one line per chapter with its address. Written at build.
export const dynamic = "force-static";

export function GET() {
  return new Response(llmsIndex(), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
