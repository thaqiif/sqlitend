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
}

export interface CreateTokenInput {
  jti: string;
  databaseId: string;
  scope: string;
  createdAt: number;
  expiresAt: number;
}

export class TokensRepo {
  constructor(private readonly db: Database) {}

  create(input: CreateTokenInput): TokenRow {
    const { jti, databaseId, scope, createdAt, expiresAt } = input;
    this.db
      .query(
        "INSERT INTO tokens(jti, database_id, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(jti, databaseId, scope, createdAt, expiresAt);
    return { jti, database_id: databaseId, scope, created_at: createdAt, expires_at: expiresAt };
  }

  listByDatabase(databaseId: string): TokenRow[] {
    return this.db
      .query(
        "SELECT jti, database_id, scope, created_at, expires_at FROM tokens WHERE database_id = ? ORDER BY created_at",
      )
      .all(databaseId) as TokenRow[];
  }

  deleteByJti(jti: string): void {
    this.db.query("DELETE FROM tokens WHERE jti = ?").run(jti);
  }
}