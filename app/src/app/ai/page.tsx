import { AppProviders } from "@/components/app/AppProviders";
import { AisScreen } from "@/components/ai/AisScreen";
import { pageConfig } from "@/lib/mock/savedTheme";

export default async function ConnectedAisPage({ searchParams }: PageProps<"/ai">) {
  const initial = await pageConfig(searchParams);
  return (
    <AppProviders initial={initial}>
      <AisScreen />
    </AppProviders>
  );
}
