import { AppProviders } from "@/components/app/AppProviders";
import { ApproveScreen } from "@/components/ai/ApproveScreen";
import { parseConfig } from "@/lib/mock/config";

// An AI asked for a trade above its limit and sent the person here (the server's approve_url).
export default async function ApprovePage({ searchParams }: PageProps<"/approve">) {
  const sp = await searchParams;
  const raw = sp.request;
  const request = (Array.isArray(raw) ? raw[0] : raw) || "";
  return (
    <AppProviders initial={parseConfig(sp)}>
      <ApproveScreen id={request} />
    </AppProviders>
  );
}
