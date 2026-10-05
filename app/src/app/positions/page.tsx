import { AppProviders } from "@/components/app/AppProviders";
import { PositionsScreen } from "@/components/positions/PositionsScreen";
import { parseConfig } from "@/lib/mock/config";

export default async function PositionsPage({ searchParams }: PageProps<"/positions">) {
  const initial = parseConfig(await searchParams);
  return (
    <AppProviders initial={initial}>
      <PositionsScreen />
    </AppProviders>
  );
}
