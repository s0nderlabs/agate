// The server's state in one bun:sqlite file (HOME/agate-server.db). Single process, synchronous sqlite: every
// read-modify-write below is atomic. Delegation materials (the delegated key share and the wallet API key Dynamic
// sends us) are sealed with AES-256-GCM under HOME/store.key before they touch disk, so the database alone yields
// nothing. Nothing in this file logs a value.
import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { HOME, ensureHome } from "./config.ts";

// ------------------------------------------------------------------ sealing

function storeKey(): Buffer {
  const f = join(HOME, "store.key");
  if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString("hex"), { mode: 0o600 });
  const k = Buffer.from(readFileSync(f, "utf8").trim(), "hex");
  if (k.length !== 32) throw new Error("store.key is not 32 bytes of hex");
  return k;
}

export class Sealer {
  constructor(private readonly key: Buffer) {}
  seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
  }
  open(sealed: string): string {
    const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
    const d = createDecipheriv("aes-256-gcm", this.key, iv!);
    d.setAuthTag(tag!);
    return Buffer.concat([d.update(body!), d.final()]).toString("utf8");
  }
}

// ------------------------------------------------------------------ rows

export type DelegationRow = {
  walletId: string;
  userId: string | null;
  address: Address;
  chain: string | null;
  shareSetId: string | null;
  status: "active" | "revoked";
  createdAt: number;
  revokedAt: number | null;
};
export type DelegationMaterials = { walletApiKey: string; keyShare: unknown };

export type GrantStatus = "pending" | "active" | "revoked" | "expired";
export type GrantRow = {
  id: string;
  userId: string;
  /** the AI app's name as the user saw it on the Allow page */
  label: string;
  /** the user's main smart account (Kernel index 0): the only payee the pocket may name */
  mainAccount: Address;
  /** the pocket: a Kernel (index 1) owned by the main wallet, holding the AI's budget */
  pocket: Address;
  /** the Assistant: the user's second embedded wallet, delegated to agate, signer of the pocket's session key */
  assistantWalletId: string;
  assistantAddress: Address;
  /** u (1e6 = $1) */
  budget: bigint;
  perTradeCap: bigint;
  /** base units: the onchain cap on one short (shortTokensCapFor(perTradeCap)) */
  shortTokensCap: bigint;
  /** the routers the pocket's session key may call */
  routers: Address[];
  /** which pocket of the main wallet (Kernel index) */
  pocketIndex: number;
  tradesPerDay: number;
  expiresAt: number;
  /** the serialized permission account (ZeroDev), with the main wallet's enable signature */
  permission: string | null;
  status: GrantStatus;
  createdAt: number;
};

export type IntentKind = "pocket-trade" | "pocket-enable" | "auto-roll" | "payer" | "test";
export type IntentRow = {
  id: string;
  kind: IntentKind;
  /** the Dynamic wallet that will sign it */
  walletId: string;
  /** the smart account (sender) the signature authorizes, or the EOA for a plain transaction */
  account: Address;
  /** what Transaction Review must see signed: a user operation hash, or a transaction hash */
  hash: Hex;
  /** the user operation's callData (or the transaction's data) */
  callData: Hex;
  grantId: string | null;
  createdAt: number;
  expiresAt: number;
  reviews: number;
};

export type StandingOrderStatus = "active" | "stopped";
/** An autopilot rule of one AI connection: "keep my hedge going" rolls the pocket's Long of `gpu` into the next listed
 *  month when the held month closes within `leadMinutes`. */
export type StandingOrderRow = {
  id: string;
  grantId: string;
  userId: string;
  kind: "roll_long";
  gpu: string;
  leadMinutes: number;
  status: StandingOrderStatus;
  createdAt: number;
  lastRunAt: number | null;
  lastResult: Record<string, unknown> | null;
};

export type ApprovalStatus = "pending" | "approved" | "denied" | "done" | "failed" | "expired";
export type ApprovalRow = {
  id: string;
  grantId: string;
  userId: string;
  /** the MCP tool the AI called and its arguments: the app re-plans them for the main account */
  action: string;
  params: Record<string, unknown>;
  summary: Record<string, unknown>;
  note: string | null;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  result: Record<string, unknown> | null;
};

const sha = (v: string) => createHash("sha256").update(v).digest("hex");

/** Why a pending approval ran out before its own time (ApprovalRow.result.reason). */
export const AI_DISCONNECTED = "the AI was disconnected";
export const AI_ENDED = "the AI's permission ended";

export type ReviewRow = {
  id: number;
  at: number;
  walletId: string | null;
  userId: string | null;
  shareSetType: string | null;
  contextKind: string | null;
  proceed: boolean;
  reason: string;
  intentId: string | null;
  ms: number;
};

// ------------------------------------------------------------------ store

export class Store {
  readonly db: Database;
  private readonly sealer: Sealer;

  constructor(path = join(HOME, "agate-server.db"), sealer?: Sealer) {
    if (path !== ":memory:") ensureHome();
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON;");
    this.sealer = sealer ?? new Sealer(path === ":memory:" ? randomBytes(32) : storeKey());
    this.migrate();
  }

  /** A consistent copy of the whole database (VACUUM INTO, safe while it is in use) at
   *  dir/agate-server-YYYY-MM-DD.db, mode 600, keeping the newest `keep` copies. Passkey accounts exist only here,
   *  so the server takes one a minute after start and then daily. Returns the file. */
  backup(dir = join(HOME, "backups"), keep = 7, now = Date.now()): string {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = join(dir, `agate-server-${new Date(now).toISOString().slice(0, 10)}.db`);
    rmSync(f, { force: true });
    this.db.query("VACUUM INTO ?").run(f);
    chmodSync(f, 0o600);
    const copies = readdirSync(dir).filter((n) => /^agate-server-\d{4}-\d{2}-\d{2}\.db$/.test(n)).sort();
    for (const n of copies.slice(0, Math.max(0, copies.length - keep))) rmSync(join(dir, n));
    return f;
  }

  private addColumn(table: string, col: string, ddl: string) {
    const cols = (this.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes(col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS delegations (
        wallet_id TEXT PRIMARY KEY,
        user_id TEXT,
        address TEXT NOT NULL,
        chain TEXT,
        share_set_id TEXT,
        sealed TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS grants (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        label TEXT NOT NULL,
        main_account TEXT NOT NULL,
        pocket TEXT NOT NULL,
        assistant_wallet_id TEXT NOT NULL,
        assistant_address TEXT NOT NULL,
        budget TEXT NOT NULL,
        per_trade_cap TEXT NOT NULL,
        trades_per_day INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        permission TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        short_tokens_cap TEXT NOT NULL DEFAULT '0',
        routers TEXT NOT NULL DEFAULT '[]',
        pocket_index INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS grants_user ON grants(user_id);
      CREATE TABLE IF NOT EXISTS intents (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        wallet_id TEXT NOT NULL,
        account TEXT NOT NULL,
        hash TEXT NOT NULL,
        call_data TEXT NOT NULL,
        grant_id TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        reviews INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS intents_wallet ON intents(wallet_id, expires_at);
      CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        wallet_id TEXT,
        user_id TEXT,
        share_set_type TEXT,
        context_kind TEXT,
        proceed INTEGER NOT NULL,
        reason TEXT NOT NULL,
        intent_id TEXT,
        ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        source TEXT NOT NULL,
        name TEXT NOT NULL,
        user_id TEXT,
        wallet_id TEXT,
        grant_id TEXT,
        detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_user ON events(user_id, at);
      CREATE INDEX IF NOT EXISTS events_grant ON events(grant_id, name, at);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        params TEXT NOT NULL,
        summary TEXT NOT NULL,
        note TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        result TEXT
      );
      CREATE INDEX IF NOT EXISTS approvals_user ON approvals(user_id, created_at);
      CREATE TABLE IF NOT EXISTS idempotency (
        grant_id TEXT NOT NULL,
        key TEXT NOT NULL,
        result TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (grant_id, key)
      );
      CREATE TABLE IF NOT EXISTS server_wallets (
        label TEXT PRIMARY KEY,
        wallet_id TEXT NOT NULL,
        address TEXT NOT NULL,
        sealed TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS seen_messages (
        message_id TEXT PRIMARY KEY,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS standing_orders (
        id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        gpu TEXT NOT NULL,
        lead_minutes INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_run_at INTEGER,
        last_result TEXT
      );
      CREATE INDEX IF NOT EXISTS standing_orders_grant ON standing_orders(grant_id);
    `);
    this.addColumn("grants", "short_tokens_cap", "short_tokens_cap TEXT NOT NULL DEFAULT '0'");
    this.addColumn("grants", "routers", "routers TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("grants", "pocket_index", "pocket_index INTEGER NOT NULL DEFAULT 1");
    this.addColumn("grants", "connector_hash", "connector_hash TEXT");
    this.addColumn("grants", "ended_connector_hash", "ended_connector_hash TEXT");
  }

  // ---- webhook idempotency

  /** true the first time a webhook message id is seen (Dynamic retries deliveries) */
  firstSight(messageId: string | undefined): boolean {
    if (!messageId) return true;
    const r = this.db.query("INSERT OR IGNORE INTO seen_messages (message_id, at) VALUES (?, ?)").run(messageId, Date.now());
    return r.changes === 1;
  }

  /** undo firstSight for a delivery that failed, so its retry is handled */
  forgetSight(messageId: string | undefined): void {
    if (messageId) this.db.query("DELETE FROM seen_messages WHERE message_id = ?").run(messageId);
  }

  // ---- delegations

  putDelegation(d: Omit<DelegationRow, "status" | "createdAt" | "revokedAt">, m: DelegationMaterials): void {
    this.db
      .query(
        `INSERT INTO delegations (wallet_id, user_id, address, chain, share_set_id, sealed, status, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL)
         ON CONFLICT(wallet_id) DO UPDATE SET user_id = excluded.user_id, address = excluded.address, chain = excluded.chain,
           share_set_id = excluded.share_set_id, sealed = excluded.sealed, status = 'active', created_at = excluded.created_at,
           revoked_at = NULL`,
      )
      .run(d.walletId, d.userId, d.address.toLowerCase(), d.chain, d.shareSetId, this.sealer.seal(JSON.stringify(m)), Date.now());
  }

  /** Marks a delegation revoked and drops its materials (the share is useless to Dynamic now, and to anyone). */
  revokeDelegation(walletId: string): boolean {
    const r = this.db.query("UPDATE delegations SET status = 'revoked', sealed = NULL, revoked_at = ? WHERE wallet_id = ? AND status = 'active'").run(Date.now(), walletId);
    return r.changes === 1;
  }

  delegation(walletId: string): DelegationRow | null {
    const r = this.db.query("SELECT * FROM delegations WHERE wallet_id = ?").get(walletId) as Record<string, unknown> | null;
    return r ? toDelegation(r) : null;
  }

  delegationByAddress(address: Address): DelegationRow | null {
    const r = this.db.query("SELECT * FROM delegations WHERE address = ? ORDER BY created_at DESC LIMIT 1").get(address.toLowerCase()) as Record<string, unknown> | null;
    return r ? toDelegation(r) : null;
  }

  delegationsOf(userId: string): DelegationRow[] {
    return (this.db.query("SELECT * FROM delegations WHERE user_id = ? ORDER BY created_at DESC").all(userId) as Record<string, unknown>[]).map(toDelegation);
  }

  materials(walletId: string): DelegationMaterials | null {
    const r = this.db.query("SELECT sealed FROM delegations WHERE wallet_id = ? AND status = 'active'").get(walletId) as { sealed: string | null } | null;
    return r?.sealed ? (JSON.parse(this.sealer.open(r.sealed)) as DelegationMaterials) : null;
  }

  // ---- grants

  putGrant(g: GrantRow): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO grants (id, user_id, label, main_account, pocket, assistant_wallet_id, assistant_address, budget,
           per_trade_cap, trades_per_day, expires_at, permission, status, created_at, short_tokens_cap, routers, pocket_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        g.id,
        g.userId,
        g.label,
        g.mainAccount.toLowerCase(),
        g.pocket.toLowerCase(),
        g.assistantWalletId,
        g.assistantAddress.toLowerCase(),
        g.budget.toString(),
        g.perTradeCap.toString(),
        g.tradesPerDay,
        g.expiresAt,
        g.permission,
        g.status,
        g.createdAt,
        g.shortTokensCap.toString(),
        JSON.stringify(g.routers.map((r) => r.toLowerCase())),
        g.pocketIndex,
      );
  }

  grant(id: string): GrantRow | null {
    const r = this.db.query("SELECT * FROM grants WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? toGrant(r) : null;
  }

  grantsOf(userId: string): GrantRow[] {
    return (this.db.query("SELECT * FROM grants WHERE user_id = ? ORDER BY created_at DESC").all(userId) as Record<string, unknown>[]).map(toGrant);
  }

  grantsOfAssistant(walletId: string): GrantRow[] {
    return (this.db.query("SELECT * FROM grants WHERE assistant_wallet_id = ?").all(walletId) as Record<string, unknown>[]).map(toGrant);
  }

  setGrantStatus(id: string, status: GrantStatus): void {
    this.db.query("UPDATE grants SET status = ? WHERE id = ?").run(status, id);
  }

  // ---- intents

  putIntent(i: Omit<IntentRow, "reviews">): void {
    this.db
      .query(
        `INSERT INTO intents (id, kind, wallet_id, account, hash, call_data, grant_id, created_at, expires_at, reviews)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(i.id, i.kind, i.walletId, i.account.toLowerCase(), i.hash.toLowerCase(), i.callData.toLowerCase(), i.grantId, i.createdAt, i.expiresAt);
  }

  /** The live intents of a wallet (not expired), newest first. */
  liveIntents(walletId: string, now = Date.now()): IntentRow[] {
    return (this.db.query("SELECT * FROM intents WHERE wallet_id = ? AND expires_at > ? ORDER BY created_at DESC").all(walletId, now) as Record<string, unknown>[]).map(toIntent);
  }

  markReviewed(id: string): void {
    this.db.query("UPDATE intents SET reviews = reviews + 1 WHERE id = ?").run(id);
  }

  dropIntent(id: string): void {
    this.db.query("DELETE FROM intents WHERE id = ?").run(id);
  }

  pruneIntents(now = Date.now()): void {
    this.db.query("DELETE FROM intents WHERE expires_at < ?").run(now - 3_600_000);
  }

  // ---- server wallets (agate's own Dynamic MPC wallets, e.g. the payer): metadata + our key shares, sealed

  putServerWallet(label: string, walletId: string, address: Address, materials: unknown): void {
    this.db
      .query("INSERT INTO server_wallets (label, wallet_id, address, sealed, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(label, walletId, address.toLowerCase(), this.sealer.seal(JSON.stringify(materials)), Date.now());
  }

  serverWallet(label: string): { walletId: string; address: Address; materials: unknown } | null {
    const r = this.db.query("SELECT * FROM server_wallets WHERE label = ?").get(label) as Record<string, unknown> | null;
    return r ? { walletId: String(r.wallet_id), address: r.address as Address, materials: JSON.parse(this.sealer.open(String(r.sealed))) } : null;
  }

  serverWalletIds(): Set<string> {
    return new Set((this.db.query("SELECT wallet_id FROM server_wallets").all() as { wallet_id: string }[]).map((r) => r.wallet_id));
  }

  // ---- connector secrets (the secret-URL lane: https://host/c/<secret>/mcp)

  /** Mints a new connector secret for a grant (the old one stops working) and returns it raw, once. */
  newConnectorSecret(grantId: string): string {
    const raw = `agt_c_${randomBytes(32).toString("base64url")}`;
    this.db.query("UPDATE grants SET connector_hash = ? WHERE id = ?").run(sha(raw), grantId);
    return raw;
  }

  /** Ends a grant's connector URL for good: a new secret nobody sees replaces it, and the old one is remembered so a
   *  call on it can be told it was disconnected (only a hash is kept). */
  endConnector(grantId: string): void {
    this.db.query("UPDATE grants SET ended_connector_hash = connector_hash WHERE id = ? AND connector_hash IS NOT NULL AND ended_connector_hash IS NULL").run(grantId);
    this.newConnectorSecret(grantId);
  }

  /** True if this is a connector URL a disconnect ended. */
  isEndedConnector(raw: string): boolean {
    return this.db.query("SELECT 1 FROM grants WHERE ended_connector_hash = ?").get(sha(raw)) !== null;
  }

  grantByConnector(raw: string): GrantRow | null {
    const r = this.db.query("SELECT * FROM grants WHERE connector_hash = ?").get(sha(raw)) as Record<string, unknown> | null;
    return r ? toGrant(r) : null;
  }

  // ---- approvals (over-cap trades the person approves in the app)

  putApproval(a: Omit<ApprovalRow, "id" | "status" | "createdAt" | "result">): ApprovalRow {
    const row: ApprovalRow = { ...a, id: randomUUID(), status: "pending", createdAt: Date.now(), result: null };
    this.db
      .query("INSERT INTO approvals (id, grant_id, user_id, action, params, summary, note, status, created_at, expires_at, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")
      .run(row.id, row.grantId, row.userId, row.action, JSON.stringify(row.params), JSON.stringify(row.summary), row.note, row.status, row.createdAt, row.expiresAt);
    return row;
  }

  approval(id: string): ApprovalRow | null {
    const r = this.db.query("SELECT * FROM approvals WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!r) return null;
    const a = toApproval(r);
    if (a.status !== "pending") return a;
    // a pending approval runs out with its own time, and with its AI: past the end date the person gave it, or
    // disconnected (endGrant expires them at that moment; this catches a grant gone or revoked before it did). An
    // expired one can still be reported done or failed until its own time plus REPORT_GRACE_MS
    const now = Date.now();
    if (a.expiresAt <= now) return this.expireApproval(a, null);
    const g = this.grant(a.grantId);
    const reason = g && g.expiresAt <= now ? AI_ENDED : !g || g.status !== "active" ? AI_DISCONNECTED : null;
    return reason ? this.expireApproval(a, reason) : a;
  }

  /** Every pending approval of a connection that ends now (endGrant), with why; returns the ones it expired. */
  expireApprovalsOfGrant(grantId: string, reason: string): ApprovalRow[] {
    const rows = this.db.query("SELECT * FROM approvals WHERE grant_id = ? AND status = 'pending'").all(grantId) as Record<string, unknown>[];
    return rows.map((r) => this.expireApproval(toApproval(r), reason));
  }

  private expireApproval(a: ApprovalRow, reason: string | null): ApprovalRow {
    const result = reason ? { reason } : null;
    this.setApproval(a.id, "expired", result);
    return { ...a, status: "expired", result };
  }

  approvalsOf(userId: string, limit = 50): ApprovalRow[] {
    return (this.db.query("SELECT * FROM approvals WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, limit) as Record<string, unknown>[]).map(toApproval);
  }

  setApproval(id: string, status: ApprovalStatus, result: Record<string, unknown> | null): void {
    this.db.query("UPDATE approvals SET status = ?, result = ? WHERE id = ?").run(status, result ? JSON.stringify(result) : null, id);
  }

  // ---- standing orders (autopilot: "keep my hedge going" rolls a pocket's Long before its month closes)

  putStandingOrder(o: Omit<StandingOrderRow, "id" | "status" | "createdAt" | "lastRunAt" | "lastResult">): StandingOrderRow {
    const row: StandingOrderRow = { ...o, id: randomUUID(), status: "active", createdAt: Date.now(), lastRunAt: null, lastResult: null };
    this.db
      .query("INSERT INTO standing_orders (id, grant_id, user_id, kind, gpu, lead_minutes, status, created_at, last_run_at, last_result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)")
      .run(row.id, row.grantId, row.userId, row.kind, row.gpu, row.leadMinutes, row.status, row.createdAt);
    return row;
  }

  standingOrder(id: string): StandingOrderRow | null {
    const r = this.db.query("SELECT * FROM standing_orders WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? toStandingOrder(r) : null;
  }

  standingOrdersOf(filter: { userId?: string; grantId?: string; status?: StandingOrderStatus }): StandingOrderRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.userId) (where.push("user_id = ?"), args.push(filter.userId));
    if (filter.grantId) (where.push("grant_id = ?"), args.push(filter.grantId));
    if (filter.status) (where.push("status = ?"), args.push(filter.status));
    const sql = `SELECT * FROM standing_orders${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT 200`;
    return (this.db.query(sql).all(...args) as Record<string, unknown>[]).map(toStandingOrder);
  }

  setStandingOrder(id: string, patch: { status?: StandingOrderStatus; lastRunAt?: number; lastResult?: Record<string, unknown> }): void {
    if (patch.status) this.db.query("UPDATE standing_orders SET status = ? WHERE id = ?").run(patch.status, id);
    if (patch.lastRunAt !== undefined) this.db.query("UPDATE standing_orders SET last_run_at = ?, last_result = ? WHERE id = ?").run(patch.lastRunAt, patch.lastResult ? JSON.stringify(patch.lastResult) : null, id);
  }

  // ---- idempotency (money tools take an idempotency key)

  idem(grantId: string, key: string): Record<string, unknown> | null {
    const r = this.db.query("SELECT result FROM idempotency WHERE grant_id = ? AND key = ?").get(grantId, key) as { result: string } | null;
    return r ? (JSON.parse(r.result) as Record<string, unknown>) : null;
  }

  putIdem(grantId: string, key: string, result: Record<string, unknown>): void {
    this.db.query("INSERT OR REPLACE INTO idempotency (grant_id, key, result, at) VALUES (?, ?, ?, ?)").run(grantId, key, JSON.stringify(result), Date.now());
  }

  /** Operations the AI made from a pocket in the last 24 h (the onchain limit counts per day from its first use). */
  tradesSince(grantId: string, sinceMs: number): number {
    const r = this.db.query("SELECT COUNT(*) AS n FROM events WHERE grant_id = ? AND name = 'pocket.trade' AND at >= ?").get(grantId, sinceMs) as { n: number };
    return Number(r.n);
  }

  // ---- reviews and events

  logReview(r: Omit<ReviewRow, "id">): void {
    this.db
      .query("INSERT INTO reviews (at, wallet_id, user_id, share_set_type, context_kind, proceed, reason, intent_id, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(r.at, r.walletId, r.userId, r.shareSetType, r.contextKind, r.proceed ? 1 : 0, r.reason, r.intentId, r.ms);
  }

  reviews(limit = 50): ReviewRow[] {
    return (this.db.query("SELECT * FROM reviews ORDER BY id DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id),
      at: Number(r.at),
      walletId: (r.wallet_id as string) ?? null,
      userId: (r.user_id as string) ?? null,
      shareSetType: (r.share_set_type as string) ?? null,
      contextKind: (r.context_kind as string) ?? null,
      proceed: r.proceed === 1,
      reason: String(r.reason),
      intentId: (r.intent_id as string) ?? null,
      ms: Number(r.ms),
    }));
  }

  event(e: { source: string; name: string; userId?: string | null; walletId?: string | null; grantId?: string | null; detail: Record<string, unknown> }): void {
    this.db
      .query("INSERT INTO events (at, source, name, user_id, wallet_id, grant_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(Date.now(), e.source, e.name, e.userId ?? null, e.walletId ?? null, e.grantId ?? null, JSON.stringify(e.detail));
  }

  events(filter: { userId?: string; grantId?: string; limit?: number } = {}): { at: number; source: string; name: string; walletId: string | null; grantId: string | null; detail: Record<string, unknown> }[] {
    const limit = filter.limit ?? 100;
    const rows = filter.grantId
      ? this.db.query("SELECT * FROM events WHERE grant_id = ? ORDER BY id DESC LIMIT ?").all(filter.grantId, limit)
      : filter.userId
        ? this.db.query("SELECT * FROM events WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(filter.userId, limit)
        : this.db.query("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit);
    return (rows as Record<string, unknown>[]).map((r) => ({
      at: Number(r.at),
      source: String(r.source),
      name: String(r.name),
      walletId: (r.wallet_id as string) ?? null,
      grantId: (r.grant_id as string) ?? null,
      detail: JSON.parse(String(r.detail)),
    }));
  }
}

function toDelegation(r: Record<string, unknown>): DelegationRow {
  return {
    walletId: String(r.wallet_id),
    userId: (r.user_id as string) ?? null,
    address: r.address as Address,
    chain: (r.chain as string) ?? null,
    shareSetId: (r.share_set_id as string) ?? null,
    status: r.status as DelegationRow["status"],
    createdAt: Number(r.created_at),
    revokedAt: r.revoked_at == null ? null : Number(r.revoked_at),
  };
}

function toGrant(r: Record<string, unknown>): GrantRow {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    label: String(r.label),
    mainAccount: r.main_account as Address,
    pocket: r.pocket as Address,
    assistantWalletId: String(r.assistant_wallet_id),
    assistantAddress: r.assistant_address as Address,
    budget: BigInt(String(r.budget)),
    perTradeCap: BigInt(String(r.per_trade_cap)),
    tradesPerDay: Number(r.trades_per_day),
    expiresAt: Number(r.expires_at),
    permission: (r.permission as string) ?? null,
    status: r.status as GrantStatus,
    createdAt: Number(r.created_at),
    shortTokensCap: BigInt(String(r.short_tokens_cap ?? "0")),
    routers: JSON.parse(String(r.routers ?? "[]")) as Address[],
    pocketIndex: Number(r.pocket_index ?? 1),
  };
}

function toStandingOrder(r: Record<string, unknown>): StandingOrderRow {
  return {
    id: String(r.id),
    grantId: String(r.grant_id),
    userId: String(r.user_id),
    kind: r.kind as StandingOrderRow["kind"],
    gpu: String(r.gpu),
    leadMinutes: Number(r.lead_minutes),
    status: r.status as StandingOrderStatus,
    createdAt: Number(r.created_at),
    lastRunAt: r.last_run_at === null || r.last_run_at === undefined ? null : Number(r.last_run_at),
    lastResult: r.last_result ? JSON.parse(String(r.last_result)) : null,
  };
}

function toApproval(r: Record<string, unknown>): ApprovalRow {
  return {
    id: String(r.id),
    grantId: String(r.grant_id),
    userId: String(r.user_id),
    action: String(r.action),
    params: JSON.parse(String(r.params)),
    summary: JSON.parse(String(r.summary)),
    note: (r.note as string) ?? null,
    status: r.status as ApprovalStatus,
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    result: r.result ? JSON.parse(String(r.result)) : null,
  };
}

function toIntent(r: Record<string, unknown>): IntentRow {
  return {
    id: String(r.id),
    kind: r.kind as IntentKind,
    walletId: String(r.wallet_id),
    account: r.account as Address,
    hash: r.hash as Hex,
    callData: r.call_data as Hex,
    grantId: (r.grant_id as string) ?? null,
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    reviews: Number(r.reviews),
  };
}
