import { AppProviders } from "@/components/app/AppProviders";
import { ConnectScreen } from "@/components/connect/ConnectScreen";
import { pageConfig } from "@/lib/mock/savedTheme";

// The Allow page. The path is fixed by Agate's server: /authorize sends an AI app's browser to /connect?request=<id>.
// Without a request it is "Connect your AI" from inside the app.
export default async function ConnectPage({ searchParams }: PageProps<"/app/connect">) {
  const sp = await searchParams;
  const raw = sp.request;
  const request = (Array.isArray(raw) ? raw[0] : raw) || null;
  // "Connect Hermes from here": the AI app already picked (?app=hermes)
  const app = (Array.isArray(sp.app) ? sp.app[0] : sp.app) || null;
  return (
    <AppProviders initial={await pageConfig(sp)}>
      <ConnectScreen requestId={request} app={app} />
    </AppProviders>
  );
}
