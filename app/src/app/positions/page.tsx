import { AppProviders } from "@/components/app/AppProviders";
import { PositionsScreen } from "@/components/positions/PositionsScreen";
import { pageConfig } from "@/lib/mock/savedTheme";

export default async function PositionsPage({ searchParams }: PageProps<"/positions">) {
  const initial = await pageConfig(searchParams);
  return (
    <AppProviders initial={initial}>
      <PositionsScreen />
    </AppProviders>
  );
}
