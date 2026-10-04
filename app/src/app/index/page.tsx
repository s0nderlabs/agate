import { TradeFlow } from "@/components/markets/Flow";
import { MockDock } from "@/components/mock/MockDock";
import { IndexScreen } from "@/components/indexpage/IndexScreen";
import { DataProvider } from "@/lib/data/provider";
import { MOCK_CONTROLS, parseConfig } from "@/lib/mock/config";
import { MockProvider } from "@/lib/mock/store";

export default async function IndexPage({ searchParams }: PageProps<"/index">) {
  const initial = parseConfig(await searchParams);
  return (
    <MockProvider initial={initial}>
      <DataProvider>
        <TradeFlow>
          <IndexScreen />
        </TradeFlow>
        {MOCK_CONTROLS && <MockDock />}
      </DataProvider>
    </MockProvider>
  );
}
