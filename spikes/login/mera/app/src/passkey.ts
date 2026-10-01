// Browser-only Mera calls: passkey ceremonies, the account session, and the bonus PRF note vault.
import {
  createPasskeyWithPrfOutput,
  createSecp256k1SigningSession,
  createSecretVaultWithExistingPasskey,
  decryptSecretVaultWithPasskey,
  getEvmAddress,
  getPasskeyPrfOutput,
  isMeraError,
  type PasskeyCredentialMetadata,
  parseSecretVault,
  type Secp256k1SigningSession,
} from "@category-labs/mera";
import { prfOutputToEvmPrivateKey } from "./core/derive";
import { load, save } from "./store";

// rpId is the page's host. Passkeys and the accounts they derive are bound to it: localhost here, and moving
// to another domain later gives every user a new, empty account.
const rp = { id: location.hostname, name: "agate" };
const CREDENTIAL_KEY = "agate.spike.mera.credential";
const NOTE_KEY = "agate.spike.mera.noteVault";

/**
 * Counts every OS passkey sheet, including Mera's fallback second prompt on authenticators that do not return
 * PRF at creation. Mera calls navigator.credentials at call time, so wrapping the instance methods sees them all.
 */
export function installPromptCounter(onPrompt: (kind: "create" | "get") => void) {
  const c = globalThis.navigator?.credentials as (CredentialsContainer & { __agateCounted?: boolean }) | undefined;
  if (!c || c.__agateCounted) return;
  const create = c.create.bind(c);
  const get = c.get.bind(c);
  c.create = (o?: CredentialCreationOptions) => {
    if (o?.publicKey) onPrompt("create");
    return create(o);
  };
  c.get = (o?: CredentialRequestOptions) => {
    if (o?.publicKey) onPrompt("get");
    return get(o);
  };
  c.__agateCounted = true;
}

export type Unlocked = { session: Secp256k1SigningSession; address: `0x${string}`; credential: PasskeyCredentialMetadata };

export const savedCredential = () => load<PasskeyCredentialMetadata | undefined>(CREDENTIAL_KEY, undefined);

function open(prfOutput: Uint8Array, credential: PasskeyCredentialMetadata): Unlocked {
  const key = prfOutputToEvmPrivateKey(prfOutput);
  // The session copies the key into its own snapshot; zero ours right away.
  const session = createSecp256k1SigningSession({ privateKey: key });
  key.fill(0);
  save(CREDENTIAL_KEY, credential);
  return { session, address: getEvmAddress(session.publicKey), credential };
}

/** First visit: one passkey creation (a second prompt only on authenticators without create-time PRF). */
export async function createAccount(): Promise<Unlocked> {
  const created = await createPasskeyWithPrfOutput({
    rp,
    user: { name: "agate", displayName: `agate ${new Date().toLocaleString()}` },
  });
  const credential: PasskeyCredentialMetadata = created.transports
    ? { credentialId: created.credentialId, transports: created.transports }
    : { credentialId: created.credentialId };
  return open(created.prfOutput, credential);
}

/** Return visit or unlock: one assertion. With no pinned credential the OS shows its passkey picker. */
export async function signIn(pinned?: PasskeyCredentialMetadata): Promise<Unlocked> {
  const { prfOutput, credentialId } = await getPasskeyPrfOutput(pinned ? { rpId: rp.id, credential: pinned } : { rpId: rp.id });
  return open(prfOutput, pinned?.credentialId === credentialId ? pinned : { credentialId });
}

// ----- Bonus (Mera Keys bounty): a private trade note in its own PRF namespace ----------------------------
// createSecretVaultWithExistingPasskey evaluates the passkey with a FRESH random salt (not the account salt)
// and derives an AES-256-GCM key with HKDF info "mera.v1.encrypt.secret". Only ciphertext is stored.

export async function sealNote(credential: PasskeyCredentialMetadata, text: string) {
  const secret = new TextEncoder().encode(text);
  try {
    const vault = await createSecretVaultWithExistingPasskey({ rpId: rp.id, credential, secret });
    save(NOTE_KEY, vault);
    return vault;
  } finally {
    secret.fill(0);
  }
}

export const savedNoteVault = () => load<unknown>(NOTE_KEY, undefined);

export async function openNote(): Promise<string> {
  const raw = savedNoteVault();
  if (!raw) throw new Error("No sealed note on this device yet.");
  const bytes = await decryptSecretVaultWithPasskey({ rpId: rp.id, vault: parseSecretVault(raw) });
  try {
    return new TextDecoder().decode(bytes);
  } finally {
    bytes.fill(0);
  }
}

export function describeError(e: unknown): string {
  if (isMeraError(e)) {
    if (e.code === "PRF_UNAVAILABLE")
      return "This passkey provider does not support PRF (known failures: desktop Chrome local profile, Bitwarden, Dashlane). Try iCloud Keychain, Google Password Manager on a phone, or 1Password.";
    if (e.code === "PASSKEY_OPERATION_FAILED") return "The passkey prompt was cancelled or failed.";
    if (e.code === "SESSION_ENDED") return "Session ended. Unlock with your passkey.";
    return `${e.code}: ${e.message}`;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split("\n")[0] ?? msg;
}
