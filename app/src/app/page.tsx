import { AppProviders } from "@/components/app/AppProviders";
import { TradeScreen } from "@/components/trade/TradeScreen";
import { parseConfig } from "@/lib/mock/config";

export default async function Home({ searchParams }: PageProps<"/">) {
  const initial = parseConfig(await searchParams);
  return (
    <AppProviders initial={initial}>
      <TradeScreen />
    </AppProviders>
  );
}
