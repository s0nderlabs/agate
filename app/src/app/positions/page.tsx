import { TradeFlow } from "@/components/markets/Flow";
import { MockDock } from "@/components/mock/MockDock";
import { PositionsScreen } from "@/components/positions/PositionsScreen";
import { DataProvider } from "@/lib/data/provider";
import { MOCK_CONTROLS, parseConfig } from "@/lib/mock/config";
import { MockProvider } from "@/lib/mock/store";

export default async function PositionsPage({ searchParams }: PageProps<"/positions">) {
  const initial = parseConfig(await searchParams);
  return (
    <MockProvider initial={initial}>
      <DataProvider>
        <TradeFlow>
          <PositionsScreen />
        </TradeFlow>
        {MOCK_CONTROLS && <MockDock />}
      </DataProvider>
    </MockProvider>
  );
}
