import { readFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { DatabasesRepo } from "./repos/databases.ts";
import { AuthRepo } from "./repos/auth.ts";
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
  const files = ["001_init.sql", "002_failed_reason.sql", "003_dns.sql", "004_token_management.sql", "005_auth.sql", "006_backup_verify.sql", "007_db_name_per_workspace.sql", "008_token_value.sql"];
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
      // One statement at a time: bun:sqlite's exec() only surfaces an error
      // raised by the LAST statement of a multi-statement string (and none at
      // all when the text ends in whitespace), so a failing migration could
      // otherwise be recorded as applied.
      for (const stmt of splitSql(m.sql)) db.run(stmt);
      db.query("INSERT INTO schema_version(id, applied_at) VALUES (?, ?)").run(m.id, Date.now());
    })();
  }
}

/**
 * Split SQL text into statements at top-level `;`, honouring '…' and "…" / `…`
 * / […] quoting and -- / block comments. Trailing comments and whitespace are
 * dropped. No trigger bodies (BEGIN … END) are supported — none are used.
 */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  const n = sql.length;
  const push = () => {
    const stripped = cur.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim();
    if (stripped) out.push(cur.trim());
    cur = "";
  };
  while (i < n) {
    const c = sql[i]!;
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const j = end === -1 ? n : end;
      cur += sql.slice(i, j);
      i = j;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) throw new Error("unterminated /* comment in migration");
      cur += sql.slice(i, end + 2);
      i = end + 2;
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new Error(`unterminated ${c} quote in migration`);
        if (sql[j] === close) {
          if (close !== "]" && sql[j + 1] === close) { j += 2; continue; } // doubled quote = escaped
          break;
        }
        j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === ";") {
      push();
      i++;
    } else {
      cur += c;
      i++;
    }
  }
  push();
  return out;
}

/** Aggregate handle handed to the control plane: the open db plus its repos. */
export interface Metadata {
  db: Database;
  workspaces: WorkspacesRepo;
  databases: DatabasesRepo;
  tokens: TokensRepo;
  auth: AuthRepo;
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
    auth: new AuthRepo(db),
  };
}