// Ornn's free daily index for the comparison panel: H100, H200 and B200, the three Ornn agreed on Oct 1 2026 to have
// shown beside ours with credit. Read here on the server, because Ornn's API refuses a request a browser makes from
// another site. AGATE_ORNN_URL may name a copy of the same file kept by agate-1 (being added; leave it unset until it
// serves one). Both sources are read and the newer day wins per GPU, so a copy that falls behind never hides Ornn's
// own. Only a reading that parses is kept, an hour, for every visitor: a source that fails, answers late (five
// seconds) or answers something else keeps the last good reading, and with none at all the route answers 404 and the
// app keeps its dated reading. Display only, never an index input.
import { unstable_cache } from "next/cache";
import { newerOrnn, ornnIndexOf, type OrnnIndex } from "@/lib/peers";

const ORNN_API = "https://api.ornnai.com/api/daily-index/all";

/** One source's reading; it throws on anything but a good one, so the cache below never stores a bad answer. */
const readSource = unstable_cache(
  async (url: string): Promise<OrnnIndex> => {
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`Ornn source answered ${r.status}`);
    const index = ornnIndexOf(await r.json());
    if (!index) throw new Error("Ornn source answered something other than its daily index");
    return index;
  },
  ["ornn-daily-index"],
  { revalidate: 3600 },
);

export async function GET() {
  const copy = process.env.AGATE_ORNN_URL;
  const [fromCopy, fromOrnn] = await Promise.all([copy ? readSource(copy).catch(() => null) : null, readSource(ORNN_API).catch(() => null)]);
  const index = newerOrnn(fromCopy, fromOrnn);
  if (!index) return Response.json({ error: "no Ornn reading right now" }, { status: 404 });
  return Response.json(index);
}
