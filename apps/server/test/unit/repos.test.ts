import { mkdtempSync } from "node:fs";
import { chmodSync } from "node:fs";
import { rmSync } from "node:fs";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, migrations, openDb } from "../../src/db/metadata.ts";
import { DatabasesRepo } from "../../src/db/repos/databases.ts";
import { TokensRepo } from "../../src/db/repos/tokens.ts";
import { WorkspacesRepo } from "../../src/db/repos/workspaces.ts";

let dir: string;
let db: Database;
let workspaces: WorkspacesRepo;
let databases: DatabasesRepo;
let tokens: TokensRepo;

const uid = () => crypto.randomUUID();

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sqlitend-test-"));
  db = openDb(path.join(dir, "metadata.sqlite"));
  migrate(db);
  workspaces = new WorkspacesRepo(db);
  databases = new DatabasesRepo(db);
  tokens = new TokensRepo(db);
});

afterEach(() => {
  db.close();
});

const ws = (slug: string) => ({
  id: uid(),
  slug,
  name: `Workspace ${slug}`,
  createdAt: Date.now(),
});

const dbRow = (workspaceId: string, slug: string, over: Partial<Parameters<DatabasesRepo["create"]>[0]> = {}) => ({
  id: uid(),
  workspace_id: workspaceId,
  slug,
  name: `DB ${slug}`,
  data_dir: path.join(dir, "dbs", slug),
  created_at: Date.now(),
  ...over,
});

describe("workspaces repo", () => {
  test("create -> list -> get -> delete", () => {
    expect(workspaces.count).toBe(0);
    const created = workspaces.create(ws("main"));
    expect(workspaces.count).toBe(1);
    expect(workspaces.list()).toHaveLength(1);
    expect(workspaces.getById(created.id)).toMatchObject({ slug: "main" });
    expect(workspaces.getBySlug("main")).toMatchObject({ id: created.id });
    workspaces.delete(created.id);
    expect(workspaces.count).toBe(0);
    expect(workspaces.getById(created.id)).toBeNull();
    expect(workspaces.getBySlug("main")).toBeNull();
  });

  test("slug collision throws", () => {
    workspaces.create(ws("dup"));
    expect(() => workspaces.create(ws("dup"))).toThrow(/already exists/);
  });
});

describe("databases repo", () => {
  test("create -> list -> get -> delete", () => {
    const w = workspaces.create(ws("main"));
    const created = databases.create(dbRow(w.id, "demo"));
    expect(databases.count).toBe(1);
    expect(databases.list()).toHaveLength(1);
    expect(databases.list({ workspaceId: w.id })![0]!.id).toBe(created.id);
    expect(databases.list({ workspaceId: uid() })).toHaveLength(0);
    expect(databases.getById(created.id)).toMatchObject({ slug: "demo" });
    expect(databases.getBySlug("demo")).toMatchObject({ id: created.id });
    databases.delete(created.id);
    expect(databases.count).toBe(0);
    expect(databases.getById(created.id)).toBeNull();
  });

  test("slug collision throws", () => {
    const w = workspaces.create(ws("main"));
    databases.create(dbRow(w.id, "collide"));
    expect(() => databases.create(dbRow(w.id, "collide"))).toThrow(/already exists/);
  });

  test("updateRuntime round-trips process facts", () => {
    const w = workspaces.create(ws("main"));
    const created = databases.create(dbRow(w.id, "demo"));

    databases.updateRuntime(created.id, {
      pid: 4242,
      start_time: 1_700_000_000_000,
      port: 6101,
      grpc_port: 6102,
      sqld_version: "v0.24.32",
      status: "running",
    });

    const row = databases.getById(created.id)!;
    expect(row.pid).toBe(4242);
    expect(row.start_time).toBe(1_700_000_000_000);
    expect(row.port).toBe(6101);
    expect(row.grpc_port).toBe(6102);
    expect(row.sqld_version).toBe("v0.24.32");
    expect(row.status).toBe("running");

    // COALESCE: a null field does NOT clobber an existing value.
    databases.updateRuntime(created.id, { pid: null, status: "stopped" });
    const after = databases.getById(created.id)!;
    expect(after.pid).toBe(4242);
    expect(after.status).toBe("stopped");
  });

  test("clearRuntime clears pid/start_time (unlike COALESCE updateRuntime)", () => {
    const w = workspaces.create(ws("main"));
    const created = databases.create(dbRow(w.id, "demo"));
    databases.updateRuntime(created.id, {
      pid: 4242,
      start_time: 1_700_000_000_000,
      port: 6101,
      grpc_port: 6102,
      sqld_version: "v0.24.32",
      status: "running",
    });

    // stop/relaunch-failure path: pid and start_time must be NULLED, not kept.
    databases.clearRuntime(created.id);
    const row = databases.getById(created.id)!;
    expect(row.pid).toBeNull();
    expect(row.start_time).toBeNull();
    // other fields (port, sqld_version, status) are untouched.
    expect(row.port).toBe(6101);
    expect(row.grpc_port).toBe(6102);
    expect(row.sqld_version).toBe("v0.24.32");
    expect(row.status).toBe("running");
  });

  test("updateStatus narrow write", () => {
    const w = workspaces.create(ws("main"));
    const created = databases.create(dbRow(w.id, "demo"));
    databases.updateStatus(created.id, "crashed");
    expect(databases.getById(created.id)!.status).toBe("crashed");
  });
});

describe("tokens repo", () => {
  const tok = (databaseId: string) => ({
    jti: uid(),
    databaseId,
    scope: "full" as const,
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
  });

  test("create + listByDatabase + deleteByJti", () => {
    const w = workspaces.create(ws("main"));
    const d = databases.create(dbRow(w.id, "demo"));
    const t = tokens.create(tok(d.id));
    expect(tokens.listByDatabase(d.id)).toHaveLength(1);
    expect(tokens.listByDatabase(uid())).toHaveLength(0);
    tokens.deleteByJti(t.jti);
    expect(tokens.listByDatabase(d.id)).toHaveLength(0);
  });

  test("tokens cascade-delete when a database is deleted", () => {
    const w = workspaces.create(ws("main"));
    const d = databases.create(dbRow(w.id, "demo"));
    tokens.create(tok(d.id));
    tokens.create(tok(d.id));
    expect(tokens.listByDatabase(d.id)).toHaveLength(2);

    databases.delete(d.id);
    expect(tokens.listByDatabase(d.id)).toHaveLength(0);
  });

  test("workspace delete cascades databases and their tokens", () => {
    const w = workspaces.create(ws("main"));
    const d = databases.create(dbRow(w.id, "demo"));
    tokens.create(tok(d.id));
    workspaces.delete(w.id);
    expect(databases.getById(d.id)).toBeNull();
    expect(tokens.listByDatabase(d.id)).toHaveLength(0);
  });
});

describe("migration", () => {
  test("re-running migrate on an already-migrated DB is a no-op", () => {
    const versions = () =>
      db.query("SELECT id FROM schema_version ORDER BY id")
        .all().map((r) => (r as { id: string }).id);

    const before = versions();
    expect(before).toEqual(["001_init", "002_failed_reason", "003_dns", "004_token_management", "005_auth", "006_backup_verify", "007_db_name_per_workspace"]);
    migrate(db);
    migrate(db);
    expect(versions()).toEqual(before);
  });

  test("openDb+migrate leaves metadata.sqlite mode 0600", () => {
    const file = path.join(dir, "metadata.sqlite");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("migrate creates tables on a fresh db", () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all().map((r) => (r as { name: string }).name);
    expect(tables).toContain("workspaces");
    expect(tables).toContain("databases");
    expect(tables).toContain("tokens");
    expect(tables).toContain("schema_version");
    // 002 dropped the never-used config table…
    expect(tables).not.toContain("config");
    // …and added the launch-failure diagnostic column.
    const cols = db
      .query("SELECT name FROM pragma_table_info('databases')")
      .all().map((r) => (r as { name: string }).name);
    expect(cols).toContain("failed_reason");
  });

  test("chmod is idempotent", () => {
    chmodSync(path.join(dir, "metadata.sqlite"), 0o600);
    expect(statSync(path.join(dir, "metadata.sqlite")).mode & 0o777).toBe(0o600);
  });
});


/** Apply ONLY the first migration (001) to a fresh database — simulates a DB
 *  that was created when 001 was the latest schema, before 002 shipped. */
function migrate001only(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version(id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  for (const m of migrations().slice(0, 1)) {
    const recorded = db.query("SELECT 1 AS applied FROM schema_version WHERE id = ?").get(m.id);
    if (recorded) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.query("INSERT INTO schema_version(id, applied_at) VALUES (?, ?)").run(m.id, Date.now());
    })();
  }
}

describe("migration-on-data (001 → full migrate)", () => {
  test("data inserted under migration 001 survives the full migrate() run intact", () => {
    // Build a schema using ONLY migration 001, insert real rows, then run the
    // remaining migrations (002…) and assert the data is preserved and both
    // migration ids are recorded.
    const stale = mkdtempSync(path.join(tmpdir(), "sqlitend-mig-"));
    const db001 = openDb(path.join(stale, "meta.sqlite"));
    migrate001only(db001);
    const wRepo = new WorkspacesRepo(db001);
    const tRepo = new TokensRepo(db001);
    const ws = wRepo.create({ id: uid(), slug: "legacy", name: "Legacy", createdAt: Date.now() });

    // The 001 schema has NO failed_reason column, so the DatabasesRepo cannot
    // INSERT into it (create() would reference the 002-only column). Insert the
    // database row via raw SQL against the 001 columns exactly as they existed.
    const row = { id: uid(), wsId: ws.id, slug: "legacy-db", dataDir: path.join(stale, "dbs", "legacy-db") };
    db001.query(
      `INSERT INTO databases
        (id, workspace_id, slug, name, status, pid, start_time, port, grpc_port,
         data_dir, auth_key, auto_start, sqld_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, row.wsId, row.slug, "Legacy DB",
      "running", 4242, 1_700_000_000_000, 6101, 6102,
      row.dataDir, "", 0, "v0.24.32", Date.now(),
    );
    // Same for tokens: 001 has no name/revoked_at/last_used_at columns.
    const tok = { jti: uid() };
    db001
      .query("INSERT INTO tokens(jti, database_id, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(tok.jti, row.id, "full", Date.now(), Date.now() + 3600_000);

    // Apply the REAL migrations (001 skipped as already recorded, 002 applied).
    migrate(db001);
    const dRepo = new DatabasesRepo(db001); // constructs against the upgraded 002 schema

    const versions = db001
      .query("SELECT id FROM schema_version ORDER BY id")
      .all().map((r) => (r as { id: string }).id);
    expect(versions).toEqual(["001_init", "002_failed_reason", "003_dns", "004_token_management", "005_auth", "006_backup_verify", "007_db_name_per_workspace"]);

    // Data from the 001-era schema is intact after the upgrade.
    const w2 = wRepo.getById(ws.id)!;
    expect(w2.slug).toBe("legacy");
    const d2 = dRepo.getById(row.id)!;
    expect(d2.slug).toBe("legacy-db");
    expect(d2.status).toBe("running");
    expect(dRepo.getById(row.id)!.failed_reason).toBeNull(); // 002 added the column, default NULL
    const t2 = tRepo.listByDatabase(row.id);
    expect(t2).toHaveLength(1);
    expect(t2[0]!.jti).toBe(tok.jti);
    expect(t2[0]!.revoked_at).toBeNull(); // 004 added the column, default NULL

    db001.close();
    rmSync(stale, { recursive: true, force: true });
  });
});

describe("migration runner (bun:sqlite exec swallows non-final errors)", () => {
  test("splitSql honours quotes and comments", async () => {
    const { splitSql } = await import("../../src/db/metadata.ts");
    expect(splitSql("-- a; b\nCREATE TABLE a(x TEXT DEFAULT ';'); /* ; */ INSERT INTO a VALUES('it''s;');\n-- tail\n")).toEqual([
      "-- a; b\nCREATE TABLE a(x TEXT DEFAULT ';')",
      "/* ; */ INSERT INTO a VALUES('it''s;')",
    ]);
    expect(splitSql("  \n-- only a comment\n")).toEqual([]);
  });

  test("a failing statement that is not the last one aborts the migration and is not recorded", async () => {
    const { splitSql } = await import("../../src/db/metadata.ts");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_version(id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    expect(() =>
      db.transaction(() => {
        for (const s of splitSql("CREATE TABLE a(x); INSERT INTO nope VALUES (1); CREATE TABLE b(x);\n")) db.run(s);
        db.run("INSERT INTO schema_version VALUES ('x', 0)");
      })(),
    ).toThrow(/no such table: nope/);
    expect(db.query("SELECT count(*) n FROM sqlite_master WHERE name IN ('a','b')").get()).toEqual({ n: 0 });
    expect(db.query("SELECT count(*) n FROM schema_version").get()).toEqual({ n: 0 });
  });

  test("007 renames pre-existing same-name databases in a workspace, then enforces uniqueness", () => {
    const db = openDb(":memory:");
    migrate(db);
    db.exec("DROP INDEX idx_databases_workspace_name");
    db.query("DELETE FROM schema_version WHERE id = '007_db_name_per_workspace'").run();
    db.query("INSERT INTO workspaces(id,slug,name,created_at) VALUES ('w','w','w',0), ('v','v','v',0)").run();
    const ins = db.query("INSERT INTO databases(id,workspace_id,slug,name,data_dir,created_at) VALUES (?,?,?,?,?,0)");
    ins.run("11111111-a", "w", "a", "Bots", "/x/a");
    ins.run("22222222-b", "w", "b", "bots", "/x/b");
    ins.run("33333333-c", "v", "c", "Bots", "/x/c"); // other workspace: untouched
    migrate(db);
    const names = db.query("SELECT id, name FROM databases ORDER BY id").all();
    expect(names).toEqual([
      { id: "11111111-a", name: "Bots" },
      { id: "22222222-b", name: "bots (22222222)" },
      { id: "33333333-c", name: "Bots" },
    ]);
    expect(db.query("SELECT 1 AS ok FROM sqlite_master WHERE name = 'idx_databases_workspace_name'").get()).toEqual({ ok: 1 });
    expect(() => ins.run("44444444-d", "w", "d", "BOTS", "/x/d")).toThrow(/UNIQUE/);
  });
});
