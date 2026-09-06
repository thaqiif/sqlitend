import type { Database, SQLQueryBindings } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

/** A row from the `databases` table (snake_case columns as stored). */
export interface DatabaseRow {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  status: string;
  pid: number | null;
  start_time: number | null;
  port: number | null;
  grpc_port: number | null;
  data_dir: string;
  auth_key: string | null;
  auto_start: number;
  sqld_version: string | null;
  failed_reason: string | null;
  created_at: number;
}

export interface CreateDatabaseInput {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  status?: string;
  pid?: number | null;
  start_time?: number | null;
  port?: number | null;
  grpc_port?: number | null;
  data_dir: string;
  auth_key?: string | null;
  auto_start?: number;
  sqld_version?: string | null;
  created_at: number;
}

/** Partial process facts persisted on every spawn / status change. */
export interface RuntimeUpdate {
  pid?: number | null;
  start_time?: number | null;
  sqld_version?: string | null;
  status?: string;
  port?: number | null;
  grpc_port?: number | null;
}

const SELECT_FIELDS =
  "id, workspace_id, slug, name, status, pid, start_time, port, grpc_port, " +
  "data_dir, auth_key, auto_start, sqld_version, failed_reason, created_at";

export class DatabasesRepo {
  constructor(private readonly db: Database) {}

  list(opts: { workspaceId?: string } = {}): DatabaseRow[] {
    if (opts.workspaceId) {
      return this.db
        .query(
          `SELECT ${SELECT_FIELDS} FROM databases WHERE workspace_id = ? ORDER BY created_at`,
        )
        .all(opts.workspaceId) as DatabaseRow[];
    }
    return this.db.query(`SELECT ${SELECT_FIELDS} FROM databases ORDER BY created_at`).all() as DatabaseRow[];
  }

  getById(id: string): DatabaseRow | null {
    const row = this.db.query(`SELECT ${SELECT_FIELDS} FROM databases WHERE id = ?`).get(id);
    return (row as DatabaseRow | undefined) ?? null;
  }

  getBySlug(slug: string): DatabaseRow | null {
    const row = this.db.query(`SELECT ${SELECT_FIELDS} FROM databases WHERE slug = ?`).get(slug);
    return (row as DatabaseRow | undefined) ?? null;
  }

  /** Insert a database. Throws (SlugExistsError) if the slug already exists. */
  create(input: CreateDatabaseInput): DatabaseRow {
    const row: DatabaseRow = {
      id: input.id,
      workspace_id: input.workspace_id,
      slug: input.slug,
      name: input.name,
      status: input.status ?? "stopped",
      pid: input.pid ?? null,
      start_time: input.start_time ?? null,
      port: input.port ?? null,
      grpc_port: input.grpc_port ?? null,
      data_dir: input.data_dir,
      auth_key: input.auth_key ?? null,
      auto_start: input.auto_start ?? 1,
      sqld_version: input.sqld_version ?? null,
      failed_reason: null,
      created_at: input.created_at,
    };
    try {
      this.db
        .query(
          `INSERT INTO databases(id, workspace_id, slug, name, status, pid, start_time, port, grpc_port, data_dir, auth_key, auto_start, sqld_version, failed_reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id, row.workspace_id, row.slug, row.name, row.status, row.pid,
          row.start_time, row.port, row.grpc_port, row.data_dir, row.auth_key,
          row.auto_start, row.sqld_version, row.failed_reason, row.created_at,
        );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new SlugExistsError(`database slug "${row.slug}" already exists`);
      }
      throw err;
    }
    return row;
  }

  delete(id: string): void {
    this.db.query("DELETE FROM databases WHERE id = ?").run(id);
  }

  /**
   * Persist live process facts. Every field is optional; a provided value is
   * written, a NULL is preserved (COALESCE), so facts are only ever set/updated
   * at spawn and never clobbered by a partial tick.
   */
  updateRuntime(dbId: string, update: RuntimeUpdate): void {
    const sets: string[] = [];
    const params: SQLQueryBindings[] = [];
    const add = (col: string, value: SQLQueryBindings) => {
      sets.push(`${col} = COALESCE(?, ${col})`);
      params.push(value);
    };
    if (update.pid !== undefined) add("pid", update.pid);
    if (update.start_time !== undefined) add("start_time", update.start_time);
    if (update.sqld_version !== undefined) add("sqld_version", update.sqld_version);
    if (update.status !== undefined) add("status", update.status);
    if (update.port !== undefined) add("port", update.port);
    if (update.grpc_port !== undefined) add("grpc_port", update.grpc_port);
    if (sets.length === 0) return;
    params.push(dbId);
    this.db
      .query(`UPDATE databases SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
  }

  /** Narrow status-only write (e.g. mark stopped/crashed/deleting). */
  updateStatus(dbId: string, status: string): void {
    this.db.query("UPDATE databases SET status = ? WHERE id = ?").run(status, dbId);
  }

  /**
   * Immediately clear the live-process facts (pid, start_time) to NULL. This is
   * a straight SET (NOT COALESCE) because updateRuntime deliberately preserves
   * NULLs, while stop / failed-spawn must clear a stale pid so the sampler and
   * uptime never read against a spent (possibly recycled) process.
   */
  clearRuntime(dbId: string): void {
    this.db.query("UPDATE databases SET pid = NULL, start_time = NULL WHERE id = ?").run(dbId);
  }

  /**
   * Overwrite the last launch-failure diagnostic (sqld stderr tail) with a
   * straight SET: unlike runtime facts, this value must be clearable — a
   * successful start erases the previous failure's noise.
   */
  setFailedReason(dbId: string, reason: string | null): void {
    this.db.query("UPDATE databases SET failed_reason = ? WHERE id = ?").run(reason, dbId);
  }

  get count(): number {
    const row = this.db.query("SELECT COUNT(*) AS n FROM databases").get() as { n: number };
    return Number(row.n);
  }
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg);
}

/** Raised by create() when the (globally unique) slug is already taken, so the
 *  API layer can answer 409 instead of 500. */
export class SlugExistsError extends Error {}