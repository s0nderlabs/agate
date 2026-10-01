/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string;
  readonly VITE_AGENT_ADDRESS?: string;
  readonly VITE_SESSION_MINUTES?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
