// A software passkey for the tests: a P-256 key that answers WebAuthn create() and get() the way a browser and a
// platform authenticator do (packed "none" attestation, user present + verified, synced), so the server's
// ceremonies run end to end without a browser.
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

const b64u = (b: Uint8Array) => isoBase64URL.fromBuffer(new Uint8Array(b));
const sha256 = (b: Uint8Array | string) => new Uint8Array(createHash("sha256").update(b).digest());
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) out.set(p, (i += p.length) - p.length);
  return out;
};

type Opts = { challenge: string; rp?: { id?: string }; rpId?: string; user?: { id: string } };
export type ClientData = { origin: string; type?: string; crossOrigin?: boolean; topOrigin?: string; challenge?: string };

export class FakePasskey {
  readonly id = b64u(randomBytes(16));
  private readonly key: KeyObject;
  private readonly pub: { x: Uint8Array; y: Uint8Array };
  userHandle: string | null = null;
  counter = 0;
  /** flags: user present 0x01, user verified 0x04, backup eligible 0x08, backed up 0x10 */
  flags = 0x01 | 0x04 | 0x08 | 0x10;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.key = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.pub = { x: isoBase64URL.toBuffer(jwk.x!), y: isoBase64URL.toBuffer(jwk.y!) };
  }

  private clientData(type: string, o: Opts, cd: ClientData) {
    return new TextEncoder().encode(JSON.stringify({ type: cd.type ?? type, challenge: cd.challenge ?? o.challenge, origin: cd.origin, crossOrigin: cd.crossOrigin ?? false, ...(cd.topOrigin ? { topOrigin: cd.topOrigin } : {}) }));
  }

  /** navigator.credentials.create(): the RegistrationResponseJSON a browser posts */
  create(o: Opts, cd: ClientData, more: { rk?: boolean; rpId?: string } = {}) {
    this.userHandle = o.user!.id;
    const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, this.pub.x], [-3, this.pub.y]]));
    const credId = isoBase64URL.toBuffer(this.id);
    const authData = cat(sha256(more.rpId ?? o.rp!.id!), new Uint8Array([this.flags | 0x40]), u32(this.counter), new Uint8Array(16), new Uint8Array([credId.length >> 8, credId.length & 255]), credId, cose);
    const attestationObject = isoCBOR.encode(new Map<string, string | Map<string, string> | Uint8Array<ArrayBuffer>>([["fmt", "none"], ["attStmt", new Map<string, string>()], ["authData", authData]]));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: { clientDataJSON: b64u(this.clientData("webauthn.create", o, cd)), attestationObject: b64u(attestationObject), transports: ["internal", "hybrid"] },
      clientExtensionResults: { credProps: { rk: more.rk ?? true } },
      authenticatorAttachment: "platform",
    };
  }

  /** navigator.credentials.get(): the AuthenticationResponseJSON a browser posts */
  get(o: Opts, cd: ClientData, more: { rpId?: string; userHandle?: string | null; counter?: number } = {}) {
    if (more.counter !== undefined) this.counter = more.counter;
    else if (this.counter > 0) this.counter += 1;
    const authData = cat(sha256(more.rpId ?? o.rpId!), new Uint8Array([this.flags]), u32(this.counter));
    const clientDataJSON = this.clientData("webauthn.get", o, cd);
    const signature = new Uint8Array(sign("sha256", cat(authData, sha256(clientDataJSON)), this.key));
    const userHandle = more.userHandle === undefined ? this.userHandle : more.userHandle;
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), ...(userHandle ? { userHandle } : {}) },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
