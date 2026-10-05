import { AppProviders } from "@/components/app/AppProviders";
import { AisScreen } from "@/components/ai/AisScreen";
import { parseConfig } from "@/lib/mock/config";

export default async function ConnectedAisPage({ searchParams }: PageProps<"/ai">) {
  const initial = parseConfig(await searchParams);
  return (
    <AppProviders initial={initial}>
      <AisScreen />
    </AppProviders>
  );
}
