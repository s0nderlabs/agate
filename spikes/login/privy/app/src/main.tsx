import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider } from "@privy-io/react-auth";
import { App, SetupError } from "./App";
import { monadTestnet } from "./chain";
import "./styles.css";

const ids = __SPIKE_IDS__;
const root = createRoot(document.getElementById("root")!);

if (!ids.privyAppId) {
  root.render(<SetupError />);
} else {
  root.render(
    <StrictMode>
      <PrivyProvider
        appId={ids.privyAppId}
        {...(ids.privyClientId ? { clientId: ids.privyClientId } : {})}
        config={{
          loginMethods: ["email", "google", "passkey"],
          embeddedWallets: {
            ethereum: { createOnLogin: "users-without-wallets" },
            showWalletUIs: false,
          },
          defaultChain: monadTestnet,
          supportedChains: [monadTestnet],
        }}
      >
        <App />
      </PrivyProvider>
    </StrictMode>,
  );
}
