import { AppProviders } from "@/components/app/AppProviders";
import { IndexScreen } from "@/components/indexpage/IndexScreen";
import { parseConfig } from "@/lib/mock/config";

export default async function IndexPage({ searchParams }: PageProps<"/index">) {
  const initial = parseConfig(await searchParams);
  return (
    <AppProviders initial={initial}>
      <IndexScreen />
    </AppProviders>
  );
}
