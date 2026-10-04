import { TradeFlow } from "@/components/markets/Flow";
import { MockDock } from "@/components/mock/MockDock";
import { TradeScreen } from "@/components/trade/TradeScreen";
import { MOCK_CONTROLS, parseConfig } from "@/lib/mock/config";
import { MockProvider } from "@/lib/mock/store";

export default async function Home({ searchParams }: PageProps<"/">) {
  const initial = parseConfig(await searchParams);
  return (
    <MockProvider initial={initial}>
      <TradeFlow>
        <TradeScreen />
      </TradeFlow>
      {MOCK_CONTROLS && <MockDock />}
    </MockProvider>
  );
}
