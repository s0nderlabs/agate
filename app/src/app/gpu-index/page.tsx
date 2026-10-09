import { AppProviders } from "@/components/app/AppProviders";
import { IndexScreen } from "@/components/indexpage/IndexScreen";
import { pageConfig } from "@/lib/mock/savedTheme";

export default async function IndexPage({ searchParams }: PageProps<"/gpu-index">) {
  const initial = await pageConfig(searchParams);
  return (
    <AppProviders initial={initial}>
      <IndexScreen />
    </AppProviders>
  );
}
