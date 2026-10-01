import { DynamicProvider } from "@dynamic-labs-sdk/react-hooks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createClient, loadIds } from "./dynamic";
import "./metrics";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
const fatal = (msg: string) =>
  root.render(
    <main>
      <h1>agate login spike: Dynamic</h1>
      <div className="error">{msg}</div>
    </main>,
  );

const ids = await loadIds();
if (!ids.dynamicEnvironmentId) {
  fatal(
    "Missing dynamicEnvironmentId: shared/ids.json does not have it yet (and VITE_DYNAMIC_ENVIRONMENT_ID is unset). Add it and reload.",
  );
} else {
  try {
    const client = await createClient(ids.dynamicEnvironmentId);
    root.render(
      <StrictMode>
        <QueryClientProvider client={new QueryClient()}>
          <DynamicProvider client={client}>
            <App client={client} ids={ids} />
          </DynamicProvider>
        </QueryClientProvider>
      </StrictMode>,
    );
  } catch (e) {
    fatal(`Dynamic client failed to initialize: ${(e as Error).message}`);
  }
}
