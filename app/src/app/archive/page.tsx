import { notFound } from "next/navigation";
import { Markets } from "@/components/markets/Markets";
import { TradeFlow } from "@/components/markets/Flow";
import { MockDock } from "@/components/mock/MockDock";
import { MOCK_CONTROLS, parseConfig } from "@/lib/mock/config";
import { MockProvider } from "@/lib/mock/store";

// The first round (A Editorial, B Object, C Statement), kept as the judging archive. Rejected Oct 3:
// "it's like landing page being converted to an app".
export default async function Archive({ searchParams }: PageProps<"/archive">) {
  if (!MOCK_CONTROLS) notFound();
  const initial = parseConfig(await searchParams);
  return (
    <MockProvider initial={initial}>
      <TradeFlow>
        <Markets />
      </TradeFlow>
      {MOCK_CONTROLS && <MockDock screen="archive" />}
    </MockProvider>
  );
}
