import { AppProviders } from "@/components/app/AppProviders";
import { TradeScreen } from "@/components/trade/TradeScreen";
import { pageConfig } from "@/lib/mock/savedTheme";

export default async function Home({ searchParams }: PageProps<"/">) {
  const initial = await pageConfig(searchParams);
  return (
    <AppProviders initial={initial}>
      <TradeScreen />
    </AppProviders>
  );
}
