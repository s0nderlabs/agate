import { AppProviders } from "@/components/app/AppProviders";
import { ConnectScreen } from "@/components/connect/ConnectScreen";
import { parseConfig } from "@/lib/mock/config";

// The Allow page. The path is fixed by Agate's server: /authorize sends an AI app's browser to /connect?request=<id>.
// Without a request it is "Connect your AI" from inside the app.
export default async function ConnectPage({ searchParams }: PageProps<"/connect">) {
  const sp = await searchParams;
  const raw = sp.request;
  const request = (Array.isArray(raw) ? raw[0] : raw) || null;
  return (
    <AppProviders initial={parseConfig(sp)}>
      <ConnectScreen requestId={request} />
    </AppProviders>
  );
}
