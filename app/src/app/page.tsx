import { TradeFlow } from "@/components/markets/Flow";
import { MockDock } from "@/components/mock/MockDock";
import { TradeSwitch } from "@/components/trade/TradeSwitch";
import { MOCK_CONTROLS, parseConfig } from "@/lib/mock/config";
import { MockProvider } from "@/lib/mock/store";

export default async function Home({ searchParams }: PageProps<"/">) {
  const initial = parseConfig(await searchParams);
  return (
    <MockProvider initial={initial}>
      <TradeFlow>
        <TradeSwitch />
      </TradeFlow>
      {MOCK_CONTROLS && <MockDock screen="trade" />}
    </MockProvider>
  );
}
