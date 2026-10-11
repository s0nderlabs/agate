import { AppProviders } from "@/components/app/AppProviders";
import { ConnectedAis } from "@/components/ai/ConnectedAis";
import { pageConfig } from "@/lib/mock/savedTheme";

export default async function ConnectedAisPage({ searchParams }: PageProps<"/app/ai">) {
  const initial = await pageConfig(searchParams);
  return (
    <AppProviders initial={initial}>
      <ConnectedAis />
    </AppProviders>
  );
}
