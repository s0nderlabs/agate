// Every page's provider tree, in one place (wallet spec 2.2): the Mock controls' world, then the data source, then
// the account and its AIs (Agate's server, the pockets), then the Flow sheets around the screen, and the Mock
// controls panel when they are on.
import { TradeFlow } from "@/components/markets/Flow";
import { MockDock } from "@/components/mock/MockDock";
import { AccountProvider } from "@/lib/account";
import { AiProvider } from "@/lib/account/ai";
import { DataProvider } from "@/lib/data/provider";
import { MOCK_CONTROLS, type MockConfig } from "@/lib/mock/config";
import { MockProvider } from "@/lib/mock/store";

export function AppProviders({ initial, children }: { initial: MockConfig; children: React.ReactNode }) {
  return (
    <MockProvider initial={initial}>
      <DataProvider>
        <AccountProvider>
          <AiProvider>
            <TradeFlow>{children}</TradeFlow>
            {MOCK_CONTROLS && <MockDock />}
          </AiProvider>
        </AccountProvider>
      </DataProvider>
    </MockProvider>
  );
}
