// Passkey accounts: an agate account made from a passkey alone, with no email (Dynamic's Bring Your Own Auth). agate
// checks the passkey (WebAuthn) and signs Dynamic a short JWT naming the account's sub; Dynamic keeps the session and
// the wallets. Rides the server's bun:sqlite database. Only public keys are stored, so the database alone cannot sign
// anyone in. Single process + synchronous sqlite = the UPDATE ... WHERE guards below are atomic: a ceremony is
// claimed once, before its response is checked, so each challenge gets exactly one attempt.
import type { Database } from "bun:sqlite";

export type CeremonyKind = "register" | "signin" | "stepup";

export type Ceremony = {
  id: string;
  kind: CeremonyKind;
  challenge: string;
  origin: string;
  rpId: string;
  /** register: the sub, user handle and label the new account gets; stepup: the account and the Dynamic user */
  sub: string | null;
  userHandle: string | null;
  label: string | null;
  scope: string | null;
  dynamicUserId: string | null;
  expiresAt: number;
};

export type PasskeyAccount = { sub: string; userHandle: string; label: string; dynamicUserId: string | null; status: string; createdAt: number };

export type PasskeyCredential = {
  id: string;
  sub: string;
  /** base64url COSE public key */
  publicKey: string;
  counter: number;
  transports: string[];
  rpId: string;
  status: string;
};

export type NewCredential = Omit<PasskeyCredential, "status"> & { deviceType: string | null; backedUp: boolean; aaguid: string | null };

export class PasskeyStore {
  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS passkey_accounts (
        sub TEXT PRIMARY KEY,
        user_handle TEXT UNIQUE NOT NULL,
        label TEXT NOT NULL,
        dynamic_user_id TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        last_signin_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS passkey_credentials (
        id TEXT PRIMARY KEY,
        sub TEXT NOT NULL REFERENCES passkey_accounts(sub),
        public_key TEXT NOT NULL,
        counter INTEGER NOT NULL,
        transports TEXT NOT NULL DEFAULT '[]',
        rp_id TEXT NOT NULL,
        device_type TEXT,
        backed_up INTEGER,
        aaguid TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS passkey_credentials_sub ON passkey_credentials(sub);
      CREATE TABLE IF NOT EXISTS passkey_ceremonies (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        challenge TEXT NOT NULL,
        origin TEXT NOT NULL,
        rp_id TEXT NOT NULL,
        sub TEXT,
        user_handle TEXT,
        label TEXT,
        scope TEXT,
        dynamic_user_id TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS passkey_ceremonies_expires ON passkey_ceremonies(expires_at);
    `);
  }

  private lastSweep = 0;

  /** stores a new ceremony, and at most once a minute drops those that ended over an hour ago (so nothing else has
   *  to sweep them) */
  putCeremony(c: Ceremony, now: number): void {
    if (now - this.lastSweep >= 60_000) {
      this.lastSweep = now;
      this.db.query("DELETE FROM passkey_ceremonies WHERE expires_at < ?").run(now - 3_600_000);
    }
    this.db
      .query(
        `INSERT INTO passkey_ceremonies (id, kind, challenge, origin, rp_id, sub, user_handle, label, scope, dynamic_user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.id, c.kind, c.challenge, c.origin, c.rpId, c.sub, c.userHandle, c.label, c.scope, c.dynamicUserId, now, c.expiresAt);
  }

  /** marks the ceremony used and returns it, or null when it is unknown, of another kind, used or expired */
  claimCeremony(id: string, kind: CeremonyKind, now: number): Ceremony | null {
    const r = this.db.query("UPDATE passkey_ceremonies SET used = 1 WHERE id = ? AND kind = ? AND used = 0 AND expires_at > ?").run(id, kind, now);
    if (r.changes !== 1) return null;
    const row = this.db.query("SELECT * FROM passkey_ceremonies WHERE id = ?").get(id) as Record<string, unknown>;
    return {
      id: row.id as string,
      kind: row.kind as CeremonyKind,
      challenge: row.challenge as string,
      origin: row.origin as string,
      rpId: row.rp_id as string,
      sub: (row.sub as string) ?? null,
      userHandle: (row.user_handle as string) ?? null,
      label: (row.label as string) ?? null,
      scope: (row.scope as string) ?? null,
      dynamicUserId: (row.dynamic_user_id as string) ?? null,
      expiresAt: row.expires_at as number,
    };
  }

  /** the account and its first passkey, together or not at all */
  createAccount(a: { sub: string; userHandle: string; label: string }, cred: NewCredential, now: number): void {
    this.db.transaction(() => {
      this.db.query("INSERT INTO passkey_accounts (sub, user_handle, label, created_at, last_signin_at) VALUES (?, ?, ?, ?, ?)").run(a.sub, a.userHandle, a.label, now, now);
      this.db
        .query(
          `INSERT INTO passkey_credentials (id, sub, public_key, counter, transports, rp_id, device_type, backed_up, aaguid, created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(cred.id, a.sub, cred.publicKey, cred.counter, JSON.stringify(cred.transports), cred.rpId, cred.deviceType, cred.backedUp ? 1 : 0, cred.aaguid, now, now);
    })();
  }

  account(sub: string): PasskeyAccount | null {
    const r = this.db.query("SELECT * FROM passkey_accounts WHERE sub = ?").get(sub) as Record<string, unknown> | null;
    return r
      ? { sub: r.sub as string, userHandle: r.user_handle as string, label: r.label as string, dynamicUserId: (r.dynamic_user_id as string) ?? null, status: r.status as string, createdAt: r.created_at as number }
      : null;
  }

  /** the passkey account already tied to this Dynamic user (bound at its first step-up), if any */
  subOfDynamicUser(dynamicUserId: string): string | null {
    return (this.db.query("SELECT sub FROM passkey_accounts WHERE dynamic_user_id = ?").get(dynamicUserId) as { sub: string } | null)?.sub ?? null;
  }

  /** ties the account to its Dynamic user on first use; false when another Dynamic user already holds it */
  bindDynamicUser(sub: string, dynamicUserId: string): boolean {
    const r = this.db.query("UPDATE passkey_accounts SET dynamic_user_id = ? WHERE sub = ? AND (dynamic_user_id IS NULL OR dynamic_user_id = ?)").run(dynamicUserId, sub, dynamicUserId);
    return r.changes === 1;
  }

  credential(id: string): PasskeyCredential | null {
    const r = this.db.query("SELECT * FROM passkey_credentials WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? toCredential(r) : null;
  }

  credentialsOf(sub: string): PasskeyCredential[] {
    return (this.db.query("SELECT * FROM passkey_credentials WHERE sub = ? AND status = 'active' ORDER BY created_at").all(sub) as Record<string, unknown>[]).map(toCredential);
  }

  /** a passkey just signed in: its new counter, and the account's last sign-in */
  touchCredential(id: string, sub: string, counter: number, now: number): void {
    this.db.query("UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE id = ?").run(counter, now, id);
    this.db.query("UPDATE passkey_accounts SET last_signin_at = ? WHERE sub = ?").run(now, sub);
  }

  signupsSince(ms: number): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM passkey_accounts WHERE created_at > ?").get(ms) as { n: number }).n;
  }
}

function toCredential(r: Record<string, unknown>): PasskeyCredential {
  return {
    id: r.id as string,
    sub: r.sub as string,
    publicKey: r.public_key as string,
    counter: r.counter as number,
    transports: JSON.parse(r.transports as string) as string[],
    rpId: r.rp_id as string,
    status: r.status as string,
  };
}
