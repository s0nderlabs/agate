import { AppProviders } from "@/components/app/AppProviders";
import { HowScreen } from "@/components/how/HowScreen";
import { pageConfig } from "@/lib/mock/savedTheme";

export const metadata = { title: "How Agate works", description: "An open price for renting a GPU, traded by the month: twelve short parts, each worked on the real H100 market." };

export default async function HowPage({ searchParams }: PageProps<"/app/how">) {
  const initial = await pageConfig(searchParams);
  return (
    <AppProviders initial={initial}>
      <HowScreen />
    </AppProviders>
  );
}
