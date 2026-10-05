import { AppProviders } from "@/components/app/AppProviders";
import { AiCardScreen } from "@/components/ai/AiCard";
import { parseConfig } from "@/lib/mock/config";

export default async function AiPage({ params, searchParams }: PageProps<"/ai/[id]">) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const initial = parseConfig(sp);
  return (
    <AppProviders initial={initial}>
      <AiCardScreen id={decodeURIComponent(id)} />
    </AppProviders>
  );
}
