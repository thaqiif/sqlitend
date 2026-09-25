import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Control-plane auth persistence: the single admin row, sessions, audit log.
// ---------------------------------------------------------------------------

export interface AdminRow {
  password_hash: string;
  totp_secret: string | null;
  totp_last_step: number | null;
  password_changed_at: number;
}

export interface SessionRow {
  id_hash: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
}

export interface AuditRow {
  id: number;
  at: number;
  actor: string;
  ip: string | null;
  action: string;
  target: string | null;
  outcome: string;
  detail: string | null;
}

export type AuditInput = Omit<AuditRow, "id" | "at"> & { at?: number };

export class AuthRepo {
  /** Observer for every audited event (the control-plane backup listens). */
  onAudit: ((e: AuditInput) => void) | null = null;

  constructor(private readonly db: Database) {}

  // ---- admin --------------------------------------------------------------
  getAdmin(): AdminRow | null {
    return (this.db.query("SELECT password_hash, totp_secret, totp_last_step, password_changed_at FROM admin WHERE id = 1").get() as AdminRow | undefined) ?? null;
  }

  /** Set/replace the password. Ends every session (a password change must log everyone out). */
  setPassword(hash: string, at: number): void {
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO admin(id, password_hash, totp_secret, password_changed_at) VALUES (1, ?, NULL, ?)
           ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, password_changed_at = excluded.password_changed_at`,
        )
        .run(hash, at);
      this.db.query("DELETE FROM sessions").run();
    })();
  }

  setTotpSecret(secret: string | null): void {
    this.db.transaction(() => {
      this.db.query("UPDATE admin SET totp_secret = ?, totp_last_step = NULL WHERE id = 1").run(secret);
      this.db.query("DELETE FROM sessions").run();
    })();
  }

  /** Atomically accept `step` only if it is newer than the last accepted one. */
  claimTotpStep(step: number): boolean {
    return (
      this.db
        .query("UPDATE admin SET totp_last_step = ? WHERE id = 1 AND (totp_last_step IS NULL OR totp_last_step < ?)")
        .run(step, step).changes === 1
    );
  }

  // ---- sessions -----------------------------------------------------------
  createSession(s: SessionRow): void {
    this.db
      .query("INSERT INTO sessions(id_hash, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)")
      .run(s.id_hash, s.created_at, s.last_seen_at, s.expires_at, s.ip, s.user_agent);
  }

  getSession(idHash: string): SessionRow | null {
    return (this.db.query("SELECT * FROM sessions WHERE id_hash = ?").get(idHash) as SessionRow | undefined) ?? null;
  }

  touchSession(idHash: string, at: number): void {
    this.db.query("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").run(at, idHash);
  }

  deleteSession(idHash: string): void {
    this.db.query("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
  }

  deleteAllSessions(): number {
    return this.db.query("DELETE FROM sessions").run().changes;
  }

  pruneSessions(now: number, idleMs: number): void {
    this.db.query("DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?").run(now, now - idleMs);
  }

  // ---- audit --------------------------------------------------------------
  audit(e: AuditInput): void {
    this.db
      .query("INSERT INTO audit_log(at, actor, ip, action, target, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(e.at ?? Date.now(), e.actor, e.ip, e.action, e.target, e.outcome, e.detail);
    try {
      this.onAudit?.(e);
    } catch {
      /* observers never break auditing */
    }
  }

  /** Newest first; `beforeId` pages backwards. */
  listAudit(limit: number, beforeId?: number): AuditRow[] {
    return (beforeId
      ? this.db.query("SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?").all(beforeId, limit)
      : this.db.query("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit)) as AuditRow[];
  }
}
