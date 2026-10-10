import { AppProviders } from "@/components/app/AppProviders";
import { ApproveScreen } from "@/components/ai/ApproveScreen";
import { pageConfig } from "@/lib/mock/savedTheme";

// An AI asked for a trade above its limit and sent the person here (the server's approve_url).
export default async function ApprovePage({ searchParams }: PageProps<"/app/approve">) {
  const sp = await searchParams;
  const raw = sp.request;
  const request = (Array.isArray(raw) ? raw[0] : raw) || "";
  return (
    <AppProviders initial={await pageConfig(sp)}>
      <ApproveScreen id={request} />
    </AppProviders>
  );
}
