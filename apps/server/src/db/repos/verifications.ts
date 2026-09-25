import type { Database } from "bun:sqlite";

export interface VerificationRow {
  id: number;
  database_id: string;
  started_at: number;
  finished_at: number;
  outcome: "ok" | "failed";
  detail: string | null;
  restored_bytes: number | null;
  trigger: "schedule" | "manual";
}

export class VerificationsRepo {
  constructor(private readonly db: Database) {}

  record(r: Omit<VerificationRow, "id">): void {
    this.db
      .query(
        "INSERT INTO backup_verifications(database_id, started_at, finished_at, outcome, detail, restored_bytes, trigger) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(r.database_id, r.started_at, r.finished_at, r.outcome, r.detail, r.restored_bytes, r.trigger);
    // Keep the last 60 attempts per database.
    this.db
      .query(
        "DELETE FROM backup_verifications WHERE database_id = ? AND id NOT IN (SELECT id FROM backup_verifications WHERE database_id = ? ORDER BY id DESC LIMIT 60)",
      )
      .run(r.database_id, r.database_id);
  }

  latest(dbId: string): VerificationRow | null {
    return (this.db.query("SELECT * FROM backup_verifications WHERE database_id = ? ORDER BY id DESC LIMIT 1").get(dbId) as VerificationRow | undefined) ?? null;
  }

  latestOk(dbId: string): VerificationRow | null {
    return (
      (this.db.query("SELECT * FROM backup_verifications WHERE database_id = ? AND outcome = 'ok' ORDER BY id DESC LIMIT 1").get(dbId) as VerificationRow | undefined) ?? null
    );
  }

  history(dbId: string, limit = 20): VerificationRow[] {
    return this.db.query("SELECT * FROM backup_verifications WHERE database_id = ? ORDER BY id DESC LIMIT ?").all(dbId, limit) as VerificationRow[];
  }
}
