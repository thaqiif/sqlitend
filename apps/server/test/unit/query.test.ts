import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database as BunSqlite } from "bun:sqlite";
import { loadConfig, assertStartupAuth } from "../../src/config.ts";
import { openMetadata, type Metadata } from "../../src/db/metadata.ts";
import { Supervisor } from "../../src/supervisor/supervisor.ts";
import { Sampler } from "../../src/metrics/sampler.ts";
import { ApiError, createRoutes } from "../../src/http/routes.ts";
import { AuthService } from "../../src/auth/session.ts";
import { CSRF_HEADER } from "../../src/http/auth-routes.ts";
import {
  checkReadOnlyStatement,
  createHttpHranaExecutor,
  evaluateBatchCondition,
  splitSqlStatements,
  type HranaBatchStepOutcome,
  type HranaExecutor,
  type RawExecResult,
  type SqlValue,
} from "../../src/db/hrana.ts";

function execOneSqliteStmt(
  db: BunSqlite,
  s: { sql: string; args?: SqlValue[]; namedArgs?: Record<string, SqlValue>; wantRows?: boolean },
): RawExecResult {
  const st0 = performance.now();
  const q = db.query(s.sql);
  const columns = q.columnNames;
  let rawRows: unknown[][] = [];
  if (columns.length > 0 && s.wantRows !== false) {
    if (s.namedArgs) {
      const prefixed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s.namedArgs)) {
        prefixed[`:${k}`] = v;
        prefixed[`$${k}`] = v;
        prefixed[`@${k}`] = v;
      }
      rawRows = q.values(prefixed as never);
    } else {
      rawRows = q.values(...((s.args ?? []) as never[]));
    }
  } else {
    if (s.namedArgs) {
      const prefixed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s.namedArgs)) {
        prefixed[`:${k}`] = v;
      }
      q.run(prefixed as never);
    } else {
      q.run(...((s.args ?? []) as never[]));
    }
  }
  const changes = db.query("SELECT changes(), last_insert_rowid()").values()[0] as [number, number];
  const isSelect = columns.length > 0;
  return {
    columns,
    columnTypes: columns.map(() => null),
    rows: (rawRows ?? []).map((r) =>
      r.map((cell) => {
        if (cell === null || cell === undefined) return null;
        if (typeof cell === "bigint") return Number(cell);
        if (typeof cell === "number" || typeof cell === "string" || typeof cell === "boolean") return cell;
        return String(cell);
      }),
    ),
    rowsAffected: isSelect ? 0 : Number(changes[0] ?? 0),
    lastInsertRowid: isSelect ? null : String(changes[1] ?? 0),
    durationMs: Number((performance.now() - st0).toFixed(2)),
  };
}

/**
 * In-memory SQLite-backed HranaExecutor that faithfully emulates real `sqld`:
 *   • In `pipeline()` mode, a failed statement does NOT stop subsequent
 *     statements from executing (matching sqld's `/v2/pipeline` `execute` behavior).
 *   • In `batch()` mode, each step's `condition` (`ok`, `error`, `not`, `and`,
 *     `or`, `is_autocommit`) is evaluated against prior step outcomes and
 *     `!db.inTransaction`.
 */
function createSqliteHranaExecutor(): { executor: HranaExecutor; getSqlite: (id: string) => BunSqlite; closeAll: () => void } {
  const dbs = new Map<string, BunSqlite>();
  const getSqlite = (id: string) => {
    let db = dbs.get(id);
    if (!db) {
      db = new BunSqlite(":memory:");
      db.run("PRAGMA foreign_keys = ON");
      dbs.set(id, db);
    }
    return db;
  };
  return {
    getSqlite,
    closeAll: () => {
      for (const db of dbs.values()) db.close();
      dbs.clear();
    },
    executor: {
      async pipeline(target, stmts) {
        const db = getSqlite(target.id);
        const t0 = performance.now();
        const entries: ({ ok: true; result: RawExecResult } | { ok: false; message: string })[] = [];
        for (const s of stmts) {
          try {
            entries.push({ ok: true, result: execOneSqliteStmt(db, s) });
          } catch (err) {
            // Keep executing subsequent statements in pipeline mode, matching real sqld!
            entries.push({ ok: false, message: (err as Error).message });
          }
        }
        const firstErr = entries.find((e) => !e.ok);
        if (firstErr && !firstErr.ok) {
          throw new ApiError(400, "sql_error", firstErr.message);
        }
        return {
          results: entries.map((e) => (e as { ok: true; result: RawExecResult }).result),
          totalDurationMs: Number((performance.now() - t0).toFixed(2)),
        };
      },

      async batch(target, steps) {
        const db = getSqlite(target.id);
        const t0 = performance.now();
        const outcomes: HranaBatchStepOutcome[] = [];
        for (const step of steps) {
          const shouldRun = evaluateBatchCondition(step.condition, outcomes, () => !db.inTransaction);
          if (!shouldRun) {
            outcomes.push({ result: null, error: null });
            continue;
          }
          try {
            const result = execOneSqliteStmt(db, step.stmt);
            outcomes.push({ result, error: null });
          } catch (err) {
            outcomes.push({
              result: null,
              error: { message: (err as Error).message },
            });
          }
        }
        return {
          outcomes,
          totalDurationMs: Number((performance.now() - t0).toFixed(2)),
        };
      },
    },
  };
}

describe("Phase 1: SQL statement splitter & read-only guard", () => {
  test("splits multi-statement SQL while preserving semicolons in strings, comments, and CREATE TRIGGER BEGIN..END", () => {
    const sql = `
      -- comment with ; inside
      CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT);
      INSERT INTO items (label) VALUES ('hello;world'), ("quoted;ident");
      /* block;comment */
      CREATE TRIGGER tr_items AFTER INSERT ON items BEGIN
        UPDATE items SET label = label || '!' WHERE id = NEW.id;
        INSERT INTO items (label) VALUES ('logged');
      END;
      SELECT * FROM items;
    `;
    const parts = splitSqlStatements(sql);
    expect(parts.length).toBe(4);
    expect(parts[0]).toContain("CREATE TABLE items");
    expect(parts[1]).toContain("'hello;world'");
    expect(parts[2]).toContain("CREATE TRIGGER tr_items");
    expect(parts[2]).toContain("END");
    expect(parts[3]).toBe("SELECT * FROM items");
  });

  test("checkReadOnlyStatement allows SELECT/EXPLAIN/VALUES/read-PRAGMAs and blocks mutations", () => {
    expect(checkReadOnlyStatement("SELECT * FROM users WHERE id = 1")).toBeNull();
    expect(checkReadOnlyStatement("WITH cte AS (SELECT 1) SELECT * FROM cte")).toBeNull();
    expect(checkReadOnlyStatement("EXPLAIN QUERY PLAN SELECT * FROM users")).toBeNull();
    expect(checkReadOnlyStatement('PRAGMA table_info("users")')).toBeNull();
    expect(checkReadOnlyStatement("PRAGMA page_count")).toBeNull();

    expect(checkReadOnlyStatement("INSERT INTO users VALUES (1)")).toMatch(/INSERT/);
    expect(checkReadOnlyStatement("UPDATE users SET name = 'x'")).toMatch(/UPDATE/);
    expect(checkReadOnlyStatement("DELETE FROM users")).toMatch(/DELETE/);
    expect(checkReadOnlyStatement("DROP TABLE users")).toMatch(/DROP/);
    expect(checkReadOnlyStatement("WITH cte AS (SELECT 1) DELETE FROM users")).toMatch(/DELETE/);
    expect(checkReadOnlyStatement("PRAGMA writable_schema = ON")).toMatch(/PRAGMA/);
    expect(checkReadOnlyStatement("PRAGMA wal_checkpoint(TRUNCATE)")).toMatch(/PRAGMA/);
    expect(checkReadOnlyStatement("VACUUM")).toMatch(/VACUUM/);
  });
});

describe("Phase 1: SQLITEND_ADMIN_TOKEN & startup enforcement", () => {
  test("assertStartupAuth refuses non-loopback bind without SQLITEND_ADMIN_TOKEN or admin password", () => {
    const cfgNonLoopback = loadConfig({ SQLITEND_HOST: "0.0.0.0" });
    expect(() => assertStartupAuth(cfgNonLoopback, false)).toThrow(/SQLITEND_ADMIN_TOKEN/);
    expect(() => assertStartupAuth(cfgNonLoopback, true)).not.toThrow();

    const cfgWithToken = loadConfig({ SQLITEND_HOST: "0.0.0.0", SQLITEND_ADMIN_TOKEN: "secret-admin-token-123" });
    expect(() => assertStartupAuth(cfgWithToken, false)).not.toThrow();

    const cfgLoopback = loadConfig({ SQLITEND_HOST: "127.0.0.1" });
    expect(() => assertStartupAuth(cfgLoopback, false)).not.toThrow();
  });
});

describe("Phase 1: Schema, Query & Table Rows API + Auth", () => {
  let tmp: string;
  let meta: Metadata;
  let sqliteHrana: ReturnType<typeof createSqliteHranaExecutor>;
  let dbId: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "sqlitend-query-test-"));
    meta = openMetadata(path.join(tmp, "metadata.sqlite"));
    sqliteHrana = createSqliteHranaExecutor();

    const ws = meta.workspaces.create({
      id: "00000000-0000-4000-8000-000000000001",
      slug: "default",
      name: "Default",
      createdAt: Date.now(),
    });
    const row = meta.databases.create({
      id: "00000000-0000-4000-8000-000000000002",
      workspace_id: ws.id,
      slug: "testdb123456",
      name: "Test DB",
      status: "running",
      data_dir: path.join(tmp, "workspaces", "default", "dbs", "testdb123456"),
      auth_key: "keys/00000000-0000-4000-8000-000000000002.pub",
      auto_start: 1,
      created_at: Date.now(),
    });
    meta.databases.updateRuntime(row.id, { port: 6101, grpc_port: 6102, status: "running", pid: process.pid });
    dbId = row.id;
  });

  afterEach(() => {
    sqliteHrana.closeAll();
    meta.db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function buildApp(adminToken: string | null = "super-secret-admin-token") {
    const config = loadConfig({
      SQLITEND_DATA_ROOT: tmp,
      SQLITEND_HOST: "127.0.0.1",
      ...(adminToken ? { SQLITEND_ADMIN_TOKEN: adminToken } : {}),
    });
    const supervisor = new Supervisor({ config, databases: meta.databases });
    const sampler = new Sampler(60_000, tmp);
    const authService = new AuthService(meta.auth);
    return createRoutes({
      config,
      workspaces: meta.workspaces,
      databases: meta.databases,
      tokens: meta.tokens,
      supervisor,
      sampler,
      sqldOk: true,
      sqldVersion: "0.24.32",
      version: "0.1.4-test",
      auth: {
        service: authService,
        repo: meta.auth,
        adminToken: config.adminToken,
      },
      hrana: sqliteHrana.executor,
    });
  }

  test("missing or wrong token returns 401; Bearer SQLITEND_ADMIN_TOKEN and login cookie succeed", async () => {
    const app = buildApp("my-operator-token-xyz");

    // 1. Missing token -> 401
    const r1 = await app.request(`/api/databases/${dbId}/schema`);
    expect(r1.status).toBe(401);

    // 2. Wrong Bearer token -> 401
    const r2 = await app.request(`/api/databases/${dbId}/schema`, {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(r2.status).toBe(401);

    // 3. Correct Bearer token -> 200 (even on POST without CSRF header)
    const r3 = await app.request(`/api/databases/${dbId}/query`, {
      method: "POST",
      headers: {
        authorization: "Bearer my-operator-token-xyz",
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql: "SELECT 1 AS x" }),
    });
    expect(r3.status).toBe(200);
    const qBody = (await r3.json()) as { results: { rows: unknown[][] }[] };
    expect(qBody.results[0]!.rows).toEqual([[1]]);

    // 4. Login via POST /api/auth/login with token issues HttpOnly session cookie
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: {
        [CSRF_HEADER]: "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ token: "my-operator-token-xyz" }),
    });
    expect(loginRes.status).toBe(200);
    const setCookieHeader = loginRes.headers.get("set-cookie") ?? "";
    expect(setCookieHeader).toContain("sqlitend_session=");
    expect(setCookieHeader).toContain("HttpOnly");
    const cookiePair = setCookieHeader.split(";")[0]!;

    const r4 = await app.request(`/api/databases/${dbId}/schema`, {
      headers: { cookie: cookiePair },
    });
    expect(r4.status).toBe(200);
  });

  test("POST /query enforces readOnly: true by default and allows writes only when readOnly: false", async () => {
    const app = buildApp("tok");
    const headers = {
      authorization: "Bearer tok",
      "content-type": "application/json",
    };

    // Blocked when readOnly is omitted (defaults to true)
    const blocked = await app.request(`/api/databases/${dbId}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)" }),
    });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("read_only_violation");

    // Allowed when readOnly: false
    const allowed = await app.request(`/api/databases/${dbId}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sql: `
          CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, age INTEGER DEFAULT 20);
          CREATE INDEX idx_users_age ON users(age);
          INSERT INTO users (email, age) VALUES ('alice@example.com', 30), ('bob@example.com', 25);
        `,
        readOnly: false,
      }),
    });
    expect(allowed.status).toBe(200);
    const createRes = (await allowed.json()) as { results: { rowsAffected: number }[] };
    expect(createRes.results).toHaveLength(3);
    expect(createRes.results[2]!.rowsAffected).toBe(2);

    // Schema endpoint reflects table, columns, PK, and index
    const schemaRes = await app.request(`/api/databases/${dbId}/schema`, { headers });
    expect(schemaRes.status).toBe(200);
    const schema = (await schemaRes.json()) as {
      tables: {
        name: string;
        rowCountEstimate: number;
        primaryKey: string[];
        columns: { name: string; pk: number; notnull: boolean }[];
        indexes: { name: string; unique: boolean; columns: string[] }[];
      }[];
    };
    expect(schema.tables).toHaveLength(1);
    const tbl = schema.tables[0]!;
    expect(tbl.name).toBe("users");
    expect(tbl.rowCountEstimate).toBe(2);
    expect(tbl.primaryKey).toEqual(["id"]);
    expect(tbl.columns.map((c) => c.name)).toEqual(["id", "email", "age"]);
    expect(tbl.indexes.some((i) => i.name === "idx_users_age" && i.columns.includes("age"))).toBe(true);
  });

  test("POST /query enforces row cap truncation (limit)", async () => {
    const app = buildApp("tok");
    const headers = {
      authorization: "Bearer tok",
      "content-type": "application/json",
    };

    const res = await app.request(`/api/databases/${dbId}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sql: "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM cnt WHERE x < 50) SELECT x FROM cnt",
        limit: 10,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { rows: unknown[][]; truncated: boolean }[] };
    expect(body.results[0]!.rows).toHaveLength(10);
    expect(body.results[0]!.truncated).toBe(true);
  });

  test("Table rows CRUD round-trip + pagination + filters + SQL injection rejection", async () => {
    const app = buildApp("tok");
    const headers = {
      authorization: "Bearer tok",
      "content-type": "application/json",
    };

    // Setup table
    await app.request(`/api/databases/${dbId}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sql: "CREATE TABLE products (id INTEGER PRIMARY KEY, title TEXT NOT NULL, price REAL NOT NULL, tag TEXT)",
        readOnly: false,
      }),
    });

    // 1. Insert rows via POST /tables/:table/rows
    const ins = await app.request(`/api/databases/${dbId}/tables/products/rows`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        rows: [
          { title: "Keyboard", price: 99.5, tag: "hw" },
          { title: "Mouse", price: 49.0, tag: "hw" },
          { title: "Monitor", price: 299.0, tag: "display" },
          { title: "Cable", price: 12.0, tag: null },
        ],
      }),
    });
    expect(ins.status).toBe(201);
    expect(((await ins.json()) as { affected: number }).affected).toBe(4);

    // 2. Browse rows with pagination and sorting
    const page1 = await app.request(
      `/api/databases/${dbId}/tables/products/rows?limit=2&offset=0&sort=price&dir=desc`,
      { headers },
    );
    expect(page1.status).toBe(200);
    const p1Body = (await page1.json()) as {
      rows: Record<string, unknown>[];
      total: number;
      hasMore: boolean;
      nextOffset: number;
    };
    expect(p1Body.total).toBe(4);
    expect(p1Body.hasMore).toBe(true);
    expect(p1Body.nextOffset).toBe(2);
    expect(p1Body.rows.map((r) => r.title)).toEqual(["Monitor", "Keyboard"]);

    // 3. Browse with structured filters (=, like, isnull, in)
    const filters = JSON.stringify([
      { col: "tag", op: "=", value: "hw" },
      { col: "price", op: ">=", value: 50 },
    ]);
    const filtered = await app.request(
      `/api/databases/${dbId}/tables/products/rows?filters=${encodeURIComponent(filters)}`,
      { headers },
    );
    expect(filtered.status).toBe(200);
    const fBody = (await filtered.json()) as { rows: Record<string, unknown>[] };
    expect(fBody.rows).toHaveLength(1);
    expect(fBody.rows[0]!.title).toBe("Keyboard");

    // 4. Update row via PATCH /tables/:table/rows
    const patch = await app.request(`/api/databases/${dbId}/tables/products/rows`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        updates: [{ pk: { id: 2 }, values: { price: 39.0, tag: "sale" } }],
      }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { affected: number }).affected).toBe(1);

    // 5. Delete row via DELETE /tables/:table/rows
    const del = await app.request(`/api/databases/${dbId}/tables/products/rows`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ pks: [{ id: 4 }] }),
    });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { affected: number }).affected).toBe(1);

    // 6. SQL injection attempts in table name, sort column, filter column, and update column must return 400
    const sqliTable = await app.request(
      `/api/databases/${dbId}/tables/${encodeURIComponent("products; DROP TABLE products--")}/rows`,
      { headers },
    );
    expect(sqliTable.status).toBe(400);

    const sqliSort = await app.request(
      `/api/databases/${dbId}/tables/products/rows?sort=${encodeURIComponent("price; DROP TABLE products--")}`,
      { headers },
    );
    expect(sqliSort.status).toBe(400);

    const sqliFilter = await app.request(
      `/api/databases/${dbId}/tables/products/rows?filters=${encodeURIComponent(
        JSON.stringify([{ col: "price) OR 1=1--", op: "=", value: 1 }]),
      )}`,
      { headers },
    );
    expect(sqliFilter.status).toBe(400);

    const sqliInsert = await app.request(`/api/databases/${dbId}/tables/products/rows`, {
      method: "POST",
      headers,
      body: JSON.stringify({ rows: [{ 'title"; DROP TABLE products--': "x" }] }),
    });
    expect(sqliInsert.status).toBe(400);

    // Verify products table is still intact with 3 rows
    const afterAll = await app.request(`/api/databases/${dbId}/tables/products/rows`, { headers });
    expect(((await afterAll.json()) as { total: number }).total).toBe(3);
  });

  test("timeout handling returns 408 query_timeout", async () => {
    const slowHrana = createHttpHranaExecutor(tmp, {
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            const err = new Error("The operation timed out");
            err.name = "TimeoutError";
            reject(err);
          });
        });
        return new Response("{}");
      }) as typeof fetch,
    });

    const config = loadConfig({ SQLITEND_DATA_ROOT: tmp, SQLITEND_HOST: "127.0.0.1", SQLITEND_ADMIN_TOKEN: "tok" });
    const app = createRoutes({
      config,
      workspaces: meta.workspaces,
      databases: meta.databases,
      tokens: meta.tokens,
      supervisor: new Supervisor({ config, databases: meta.databases }),
      sampler: new Sampler(60_000, tmp),
      sqldOk: true,
      sqldVersion: "0.24.32",
      version: "0.1.4-test",
      auth: { service: new AuthService(meta.auth), repo: meta.auth, adminToken: "tok" },
      hrana: slowHrana,
    });

    const res = await app.request(`/api/databases/${dbId}/query`, {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1", timeoutMs: 100 }),
    });
    expect(res.status).toBe(408);
    const errBody = (await res.json()) as { error: { code: string; message: string } };
    expect(errBody.error.code).toBe("query_timeout");
    expect(errBody.error.message).toMatch(/may still be running/i);
  });

  test("B1: insert, update, and delete are all-or-nothing when the 2nd row fails (NOT NULL / FK violation)", async () => {
    const app = buildApp("tok");
    const headers = {
      authorization: "Bearer tok",
      "content-type": "application/json",
    };

    // Setup parent + child tables with NOT NULL and ON DELETE RESTRICT FK
    const setupRes = await app.request(`/api/databases/${dbId}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sql: `
          CREATE TABLE parent (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
          CREATE TABLE child (
            id INTEGER PRIMARY KEY,
            parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE RESTRICT,
            note TEXT NOT NULL
          );
          INSERT INTO parent (id, label) VALUES (10, 'p10'), (20, 'p20');
          INSERT INTO child (id, parent_id, note) VALUES (1, 20, 'linked-to-20');
        `,
        readOnly: false,
      }),
    });
    expect(setupRes.status).toBe(200);

    // 1. Insert 2 rows where the 2nd violates NOT NULL -> 400 and 1st row is rolled back
    const insFail = await app.request(`/api/databases/${dbId}/tables/parent/rows`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        rows: [
          { id: 30, label: "should-be-rolled-back" },
          { id: 40, label: null },
        ],
      }),
    });
    expect(insFail.status).toBe(400);
    const afterIns = await app.request(`/api/databases/${dbId}/tables/parent/rows`, { headers });
    const afterInsRows = ((await afterIns.json()) as { rows: { id: number; label: string }[] }).rows;
    expect(afterInsRows).toEqual([
      { id: 10, label: "p10" },
      { id: 20, label: "p20" },
    ]);

    // 2. Update 2 rows where the 2nd violates NOT NULL or FK -> 400 and 1st update is rolled back
    const updFail = await app.request(`/api/databases/${dbId}/tables/parent/rows`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        updates: [
          { pk: { id: 10 }, values: { label: "mutated-10" } },
          { pk: { id: 20 }, values: { label: null } },
        ],
      }),
    });
    expect(updFail.status).toBe(400);
    const afterUpd = await app.request(`/api/databases/${dbId}/tables/parent/rows`, { headers });
    const afterUpdRows = ((await afterUpd.json()) as { rows: { id: number; label: string }[] }).rows;
    expect(afterUpdRows).toEqual([
      { id: 10, label: "p10" },
      { id: 20, label: "p20" },
    ]);

    // 3. Delete 2 rows where the 2nd violates FK (id=20 is referenced by child) -> 400 and id=10 is NOT deleted
    const delFail = await app.request(`/api/databases/${dbId}/tables/parent/rows`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({
        pks: [{ id: 10 }, { id: 20 }],
      }),
    });
    expect(delFail.status).toBe(400);
    const afterDel = await app.request(`/api/databases/${dbId}/tables/parent/rows`, { headers });
    const afterDelRows = ((await afterDel.json()) as { rows: { id: number; label: string }[] }).rows;
    expect(afterDelRows).toEqual([
      { id: 10, label: "p10" },
      { id: 20, label: "p20" },
    ]);
  });

  test("B1: write-mode SQL script stops at first failing statement, rolls back open user tx, and reports which statement failed & which were not executed", async () => {
    const app = buildApp("tok");
    const headers = {
      authorization: "Bearer tok",
      "content-type": "application/json",
    };

    await app.request(`/api/databases/${dbId}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sql: `
          CREATE TABLE x (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
          INSERT INTO x (id, name) VALUES (1, 'one'), (2, 'two');
        `,
        readOnly: false,
      }),
    });

    // Script with an error at statement index 1 (2nd statement) followed by DROP TABLE x
    const midFail = await app.request(`/api/databases/${dbId}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sql: `
          DELETE FROM x WHERE id = 1;
          SELECT * FROM missing_table_xyz;
          DROP TABLE x;
        `,
        readOnly: false,
      }),
    });
    expect(midFail.status).toBe(400);
    const midBody = (await midFail.json()) as {
      error: { code: string; message: string };
      failedStatementIndex: number;
      executedStatements: string[];
      notExecutedStatements: string[];
      results: { index: number; statement: string; status: string; error: string | null; rowsAffected: number }[];
    };
    expect(midBody.error.code).toBe("sql_error");
    expect(midBody.error.message).toContain("Statement 2 (index 1) failed");
    expect(midBody.error.message).toContain("missing_table_xyz");
    expect(midBody.failedStatementIndex).toBe(1);
    expect(midBody.executedStatements).toEqual(["DELETE FROM x WHERE id = 1"]);
    expect(midBody.notExecutedStatements).toEqual(["DROP TABLE x"]);
    expect(midBody.results).toHaveLength(3);
    expect(midBody.results[0]!.status).toBe("ok");
    expect(midBody.results[0]!.rowsAffected).toBe(1);
    expect(midBody.results[1]!.status).toBe("error");
    expect(midBody.results[1]!.error).toContain("missing_table_xyz");
    expect(midBody.results[2]!.status).toBe("not_executed");
    expect(midBody.results[2]!.error).toBe("not executed");

    // Verify DROP TABLE x did NOT run (table x still exists with row 2)
    const checkX = await app.request(`/api/databases/${dbId}/tables/x/rows`, { headers });
    expect(checkX.status).toBe(200);
    expect(((await checkX.json()) as { rows: { id: number; name: string }[] }).rows).toEqual([
      { id: 2, name: "two" },
    ]);

    // Also test when user opens an explicit BEGIN transaction and a step fails mid-transaction:
    // the open transaction is rolled back automatically.
    const txFail = await app.request(`/api/databases/${dbId}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sql: `
          BEGIN;
          INSERT INTO x (id, name) VALUES (3, 'three');
          INSERT INTO x (id, name) VALUES (4, NULL);
          COMMIT;
        `,
        readOnly: false,
      }),
    });
    expect(txFail.status).toBe(400);
    const txBody = (await txFail.json()) as {
      failedStatementIndex: number;
      results: { status: string; error: string | null }[];
    };
    expect(txBody.failedStatementIndex).toBe(2);
    expect(txBody.results[0]!.status).toBe("ok");
    expect(txBody.results[1]!.status).toBe("ok");
    expect(txBody.results[2]!.status).toBe("error");
    expect(txBody.results[3]!.status).toBe("not_executed");
    expect(txBody.results[3]!.error).toBe("not executed");

    // Row 3 was rolled back because the open BEGIN transaction was rolled back on failure
    const afterTxFail = await app.request(`/api/databases/${dbId}/tables/x/rows`, { headers });
    expect(((await afterTxFail.json()) as { rows: { id: number; name: string }[] }).rows).toEqual([
      { id: 2, name: "two" },
    ]);
  });

  test("B3: 20k-row table with limit 1000 caps at the source (SELECT * FROM (...) LIMIT 1001), falls back for PRAGMA/EXPLAIN, and guards response body size", async () => {
    const rawSqlite = sqliteHrana.getSqlite(dbId);
    rawSqlite.run("CREATE TABLE big_table (id INTEGER PRIMARY KEY, val TEXT)");
    const ins = rawSqlite.prepare("INSERT INTO big_table (val) VALUES (?)");
    const seed = rawSqlite.transaction(() => {
      for (let i = 1; i <= 20_000; i++) {
        ins.run(`row-${i}`);
      }
    });
    seed();

    const executedBatchSqls: string[] = [];
    const spyingExecutor: HranaExecutor = {
      pipeline: (t, stmts, opts) => sqliteHrana.executor.pipeline(t, stmts, opts),
      batch: async (t, steps, opts) => {
        for (const s of steps) executedBatchSqls.push(s.stmt.sql);
        return sqliteHrana.executor.batch(t, steps, opts);
      },
    };

    const config = loadConfig({ SQLITEND_DATA_ROOT: tmp, SQLITEND_HOST: "127.0.0.1", SQLITEND_ADMIN_TOKEN: "tok" });
    const app = createRoutes({
      config,
      workspaces: meta.workspaces,
      databases: meta.databases,
      tokens: meta.tokens,
      supervisor: new Supervisor({ config, databases: meta.databases }),
      sampler: new Sampler(60_000, tmp),
      sqldOk: true,
      sqldVersion: "0.24.32",
      version: "0.1.4-test",
      auth: { service: new AuthService(meta.auth), repo: meta.auth, adminToken: "tok" },
      hrana: spyingExecutor,
    });
    const headers = { authorization: "Bearer tok", "content-type": "application/json" };

    // 1. SELECT * FROM big_table with limit 1000 -> executor receives wrapped LIMIT 1001 SQL
    const res = await app.request(`/api/databases/${dbId}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sql: "SELECT * FROM big_table", limit: 1000 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { statement: string; rows: unknown[][]; truncated: boolean }[];
    };
    expect(body.results[0]!.statement).toBe("SELECT * FROM big_table");
    expect(body.results[0]!.rows).toHaveLength(1000);
    expect(body.results[0]!.truncated).toBe(true);
    expect(executedBatchSqls).toContain("SELECT * FROM (\nSELECT * FROM big_table\n) LIMIT 1001");

    // 2. Non-wrappable statement (PRAGMA / EXPLAIN) falls back to unwrapped SQL + post-slice
    executedBatchSqls.length = 0;
    const pragmaRes = await app.request(`/api/databases/${dbId}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sql: 'PRAGMA table_info("big_table")', limit: 1 }),
    });
    expect(pragmaRes.status).toBe(200);
    const pragmaBody = (await pragmaRes.json()) as {
      results: { rows: unknown[][]; truncated: boolean }[];
    };
    expect(pragmaBody.results[0]!.rows).toHaveLength(1);
    expect(pragmaBody.results[0]!.truncated).toBe(true);
    expect(executedBatchSqls).toContain('PRAGMA table_info("big_table")');

    // 3. Second guard: response body size limit in createHttpHranaExecutor returns 413 response_too_large
    const oversizedHrana = createHttpHranaExecutor(tmp, {
      maxResponseBytes: 256,
      fetchImpl: (async () => {
        const bigPayload = JSON.stringify({
          results: [
            {
              type: "ok",
              response: {
                type: "batch",
                result: {
                  step_results: [
                    { cols: [{ name: "x" }], rows: [[{ type: "text", value: "x".repeat(1024) }]], affected_row_count: 0, last_insert_rowid: null },
                  ],
                  step_errors: [null],
                },
              },
            },
          ],
        });
        return new Response(bigPayload, { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    });
    const appOversized = createRoutes({
      config,
      workspaces: meta.workspaces,
      databases: meta.databases,
      tokens: meta.tokens,
      supervisor: new Supervisor({ config, databases: meta.databases }),
      sampler: new Sampler(60_000, tmp),
      sqldOk: true,
      sqldVersion: "0.24.32",
      version: "0.1.4-test",
      auth: { service: new AuthService(meta.auth), repo: meta.auth, adminToken: "tok" },
      hrana: oversizedHrana,
    });
    const tooBigRes = await appOversized.request(`/api/databases/${dbId}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sql: "SELECT 1" }),
    });
    expect(tooBigRes.status).toBe(413);
    expect(((await tooBigRes.json()) as { error: { code: string } }).error.code).toBe("response_too_large");
  });
});

const sqldPath = path.resolve(import.meta.dir, "../../../../bin/sqld");

describe("B1 opt-in integration against real bin/sqld", () => {
  test.skipIf(!existsSync(sqldPath))(
    "real sqld: partial-commit reproduction is prevented on insertTableRows, updateTableRows, deleteTableRows, and write-mode runSqlQuery",
    async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), "sqlitend-real-sqld-b1-"));
      const meta = openMetadata(path.join(tmp, "metadata.sqlite"));
      const config = loadConfig(
        {
          SQLITEND_DATA_ROOT: tmp,
          SQLITEND_HOST: "127.0.0.1",
          SQLITEND_ADMIN_TOKEN: "real-sqld-tok",
          SQLITEND_SQLD_PATH: sqldPath,
        },
        { portRange: { start: 46501, end: 46520 } },
      );
      const supervisor = new Supervisor({ config, databases: meta.databases });
      const sampler = new Sampler(60_000, tmp);
      const authService = new AuthService(meta.auth);
      const app = createRoutes({
        config,
        workspaces: meta.workspaces,
        databases: meta.databases,
        tokens: meta.tokens,
        supervisor,
        sampler,
        sqldOk: true,
        sqldVersion: "0.24.32",
        version: "0.1.4-test",
        auth: {
          service: authService,
          repo: meta.auth,
          adminToken: config.adminToken,
        },
      });
      const headers = {
        authorization: "Bearer real-sqld-tok",
        "content-type": "application/json",
      };

      try {
        const wsRes = await app.request("/api/workspaces", {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "RealSqldWs" }),
        });
        expect(wsRes.status).toBe(201);
        const ws = (await wsRes.json()) as { id: string };

        const dbRes = await app.request(`/api/workspaces/${ws.id}/databases`, {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "RealSqldDb" }),
        });
        expect(dbRes.status).toBe(201);
        const db = (await dbRes.json()) as { id: string };

        // Create table t(id INTEGER PRIMARY KEY, v TEXT NOT NULL)
        const createRes = await app.request(`/api/databases/${db.id}/query`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL);",
            readOnly: false,
          }),
        });
        expect(createRes.status).toBe(200);

        // Attempt to insert 2 rows where row 2 violates NOT NULL
        const insRes = await app.request(`/api/databases/${db.id}/tables/t/rows`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            rows: [
              { id: 1, v: "a" },
              { id: 2, v: null },
            ],
          }),
        });
        expect(insRes.status).toBe(400);

        // Verify SELECT * FROM t is empty ([]) — row 1 was NOT committed!
        const selectRes = await app.request(`/api/databases/${db.id}/query`, {
          method: "POST",
          headers,
          body: JSON.stringify({ sql: "SELECT * FROM t" }),
        });
        expect(selectRes.status).toBe(200);
        const selectBody = (await selectRes.json()) as { results: { rows: unknown[][] }[] };
        expect(selectBody.results[0]!.rows).toEqual([]);

        // Verify write-mode script with error in the middle stops and rolls back open BEGIN tx
        const scriptRes = await app.request(`/api/databases/${db.id}/query`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            sql: `
              BEGIN;
              INSERT INTO t (id, v) VALUES (10, 'ten');
              INSERT INTO t (id, v) VALUES (20, NULL);
              DROP TABLE t;
            `,
            readOnly: false,
          }),
        });
        expect(scriptRes.status).toBe(400);
        const scriptBody = (await scriptRes.json()) as {
          failedStatementIndex: number;
          results: { status: string; error: string | null }[];
        };
        expect(scriptBody.failedStatementIndex).toBe(2);
        expect(scriptBody.results[0]!.status).toBe("ok");
        expect(scriptBody.results[1]!.status).toBe("ok");
        expect(scriptBody.results[2]!.status).toBe("error");
        expect(scriptBody.results[3]!.status).toBe("not_executed");
        expect(scriptBody.results[3]!.error).toBe("not executed");

        // Table t still exists and has 0 rows
        const checkAfter = await app.request(`/api/databases/${db.id}/query`, {
          method: "POST",
          headers,
          body: JSON.stringify({ sql: "SELECT * FROM t" }),
        });
        expect(checkAfter.status).toBe(200);
        expect(((await checkAfter.json()) as { results: { rows: unknown[][] }[] }).results[0]!.rows).toEqual([]);
      } finally {
        await supervisor.shutdown();
        meta.db.close();
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
