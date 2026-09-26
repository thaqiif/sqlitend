import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Tokens. Rows cascade-delete with their database via the ON DELETE CASCADE FK.
// ---------------------------------------------------------------------------

/** A row from the `tokens` table (snake_case columns as stored). */
export interface TokenRow {
  jti: string;
  database_id: string;
  scope: string;
  created_at: number;
  expires_at: number;
  name: string | null;
  revoked_at: number | null;
  last_used_at: number | null;
  /** 1 when the JWT itself is stored (issued on/after migration 008). */
  has_value: number;
}

export interface CreateTokenInput {
  jti: string;
  databaseId: string;
  scope: string;
  createdAt: number;
  expiresAt: number;
  name?: string | null;
  /** The issued JWT, kept so it can be revealed again. */
  token?: string | null;
}

const COLUMNS = "jti, database_id, scope, created_at, expires_at, name, revoked_at, last_used_at";
const FIELDS = `${COLUMNS}, (token IS NOT NULL) AS has_value`;

export class TokensRepo {
  constructor(private readonly db: Database) {}

  create(input: CreateTokenInput): TokenRow {
    const { jti, databaseId, scope, createdAt, expiresAt } = input;
    const name = input.name ?? null;
    this.db
      .query(
        "INSERT INTO tokens(jti, database_id, scope, created_at, expires_at, name, token) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(jti, databaseId, scope, createdAt, expiresAt, name, input.token ?? null);
    return { jti, database_id: databaseId, scope, created_at: createdAt, expires_at: expiresAt, name, revoked_at: null, last_used_at: null, has_value: input.token ? 1 : 0 };
  }

  /** The stored JWT, or null (issued before 008). */
  valueOf(jti: string): string | null {
    const r = this.db.query("SELECT token FROM tokens WHERE jti = ?").get(jti) as { token: string | null } | undefined;
    return r?.token ?? null;
  }

  getByJti(jti: string): TokenRow | null {
    return (this.db.query(`SELECT ${FIELDS} FROM tokens WHERE jti = ?`).get(jti) as TokenRow | undefined) ?? null;
  }

  listByDatabase(databaseId: string): TokenRow[] {
    return this.db
      .query(`SELECT ${FIELDS} FROM tokens WHERE database_id = ? ORDER BY created_at`)
      .all(databaseId) as TokenRow[];
  }

  /** Non-revoked tokens expiring in [after, before) — `after` bounds how far
   *  back already-expired tokens are still reported. */
  listExpiringBetween(after: number, before: number): (TokenRow & { db_slug: string })[] {
    return this.db
      .query(
        `SELECT ${COLUMNS.split(", ").map((f) => `t.${f}`).join(", ")}, (t.token IS NOT NULL) AS has_value, d.slug AS db_slug
         FROM tokens t JOIN databases d ON d.id = t.database_id
         WHERE t.revoked_at IS NULL AND t.expires_at >= ? AND t.expires_at < ? ORDER BY t.expires_at`,
      )
      .all(after, before) as (TokenRow & { db_slug: string })[];
  }

  /** Idempotent: the first revocation time is kept. */
  revoke(jti: string, at: number): void {
    this.db.query("UPDATE tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE jti = ?").run(at, jti);
  }

  touchLastUsed(jti: string, at: number): void {
    this.db.query("UPDATE tokens SET last_used_at = ? WHERE jti = ?").run(at, jti);
  }

  deleteByJti(jti: string): void {
    this.db.query("DELETE FROM tokens WHERE jti = ?").run(jti);
  }
}
