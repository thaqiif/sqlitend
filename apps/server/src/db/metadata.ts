import { readFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { DatabasesRepo } from "./repos/databases.ts";
import { TokensRepo } from "./repos/tokens.ts";
import { WorkspacesRepo } from "./repos/workspaces.ts";

// ---------------------------------------------------------------------------
// Metadata layer — versioned, idempotent schema + typed repos on bun:sqlite.
// ---------------------------------------------------------------------------

/** One reversible-forward migration: an id recorded in schema_version, applied
 *  at most once per database file. */
export interface Migration {
  id: string;
  sql: string;
}

/** Ordered migration list. Each file is read from disk relative to this module
 *  so the exact SQL text lives in migrations/. */
export function migrations(): Migration[] {
  const dir = path.join(import.meta.dir, "migrations");
  const files = ["001_init.sql", "002_failed_reason.sql"];
  return files.map((f) => ({ id: f.replace(/\.sql$/, ""), sql: readFileSync(path.join(dir, f), "utf8") }));
}

/** Tighten permissions on the metadata file and its WAL sidecars. bun:sqlite
 *  does NOT set the file mode when it creates files, and the -wal/-shm
 *  sidecars (which hold row data between checkpoints) would otherwise inherit
 *  the process umask (commonly world-readable). */
function chmodMeta(dbPath: string): void {
  try {
    chmodSync(dbPath, 0o600);
  } catch {
    /* file vanished (should not happen) */
  }
  for (const suffix of ["-wal", "-shm"]) {
    try {
      chmodSync(dbPath + suffix, 0o600);
    } catch {
      /* sidecar not created yet — retried after migrate */
    }
  }
}

/**
 * Open (creating if needed) a bun:sqlite database at `dbPath`, enable WAL and
 * foreign keys, and tighten file permissions to 0600.
 */
export function openDb(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  chmodMeta(dbPath);
  return db;
}

/**
 * Apply any pending migrations in order. Idempotent: each migration's id is
 * recorded in `schema_version` after it succeeds, so re-running is a no-op.
 */
export function migrate(db: Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version(id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  for (const m of migrations()) {
    const recorded = db
      .query("SELECT 1 AS applied FROM schema_version WHERE id = ?")
      .get(m.id);
    if (recorded) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.query("INSERT INTO schema_version(id, applied_at) VALUES (?, ?)").run(m.id, Date.now());
    })();
  }
}

/** Aggregate handle handed to the control plane: the open db plus its repos. */
export interface Metadata {
  db: Database;
  workspaces: WorkspacesRepo;
  databases: DatabasesRepo;
  tokens: TokensRepo;
}

/** Convenience: open + migrate + wire up the three repos. */
export function openMetadata(dbPath: string): Metadata {
  const db = openDb(dbPath);
  migrate(db);
  chmodMeta(dbPath); // sidecars may have been created by the migration run
  return {
    db,
    workspaces: new WorkspacesRepo(db),
    databases: new DatabasesRepo(db),
    tokens: new TokensRepo(db),
  };
}