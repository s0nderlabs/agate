import { AppProviders } from "@/components/app/AppProviders";
import { AiCardScreen } from "@/components/ai/AiCard";
import { pageConfig } from "@/lib/mock/savedTheme";

export default async function AiPage({ params, searchParams }: PageProps<"/app/ai/[id]">) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const initial = await pageConfig(sp);
  return (
    <AppProviders initial={initial}>
      <AiCardScreen id={decodeURIComponent(id)} />
    </AppProviders>
  );
}
