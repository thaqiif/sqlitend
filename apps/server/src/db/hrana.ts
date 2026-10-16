// ---------------------------------------------------------------------------
// Server-side Hrana client & SQL query/table engine (Phase 1).
//
// Connects to a local running `sqld` instance (`http://127.0.0.1:<port>/v2/pipeline`)
// using a short-lived in-memory EdDSA JWT minted with the database's keypair.
// The JWT is NEVER written to the `tokens` table and NEVER leaves the server.
// ---------------------------------------------------------------------------

import type {
  ColumnInfo,
  DatabaseSchemaResponse,
  DeleteRowsRequest,
  FilterOp,
  ForeignKeyInfo,
  IndexInfo,
  InsertRowsRequest,
  MutateRowsResponse,
  QueryRequest,
  QueryResponse,
  SqlValue,
  StatementResult,
  TableFilter,
  TableRowsResponse,
  TableSchemaItem,
  UpdateRowsRequest,
  StorageStatsResponse,
} from "@sqlitend/shared";
import { mintToken } from "../auth/tokens.ts";
import { ApiError } from "../http/routes.ts";
import { dirBytes, walDirBytes } from "../metrics/sampler.ts";

export interface HranaPipelineReq {
  type: "execute" | "close";
  stmt?: {
    sql: string;
    args?: HranaValue[];
    named_args?: { name: string; value: HranaValue }[];
    want_rows?: boolean;
  };
}

export type HranaValue =
  | { type: "null" }
  | { type: "integer"; value: string }
  | { type: "float"; value: number }
  | { type: "text"; value: string }
  | { type: "blob"; base64: string };

export interface HranaStmtResult {
  cols: { name: string; decltype?: string | null }[];
  rows: HranaValue[][];
  affected_row_count: number;
  last_insert_rowid: string | null;
}

export interface HranaPipelineEntry {
  type: "ok" | "error";
  response?: {
    type: "execute" | "close";
    result?: HranaStmtResult;
  };
  error?: {
    message: string;
    code?: string;
  };
}

export interface HranaPipelineResponse {
  baton?: string | null;
  base_url?: string | null;
  results: HranaPipelineEntry[];
}

export interface RawExecResult {
  columns: string[];
  columnTypes: (string | null)[];
  rows: SqlValue[][];
  rowsAffected: number;
  lastInsertRowid: string | null;
  durationMs: number;
}

export interface HranaExecutor {
  /** Execute a batch of statements in a single Hrana pipeline call. */
  pipeline(
    db: { id: string; slug: string; port: number },
    stmts: { sql: string; args?: SqlValue[]; namedArgs?: Record<string, SqlValue>; wantRows?: boolean }[],
    opts?: { timeoutMs?: number },
  ): Promise<{ results: RawExecResult[]; totalDurationMs: number }>;
}

/** Optional observer hook so Phase 3 metrics can record every query's latency & error state. */
export type QueryObserver = (event: {
  dbId: string;
  durationMs: number;
  ok: boolean;
  isWrite: boolean;
}) => void;

export function toHranaValue(v: SqlValue): HranaValue {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "boolean") return { type: "integer", value: v ? "1" : "0" };
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return { type: "null" };
    if (Number.isInteger(v)) return { type: "integer", value: String(v) };
    return { type: "float", value: v };
  }
  return { type: "text", value: String(v) };
}

export function fromHranaValue(v: HranaValue | undefined): SqlValue {
  if (!v || v.type === "null") return null;
  if (v.type === "integer") {
    const n = Number(v.value);
    return Number.isSafeInteger(n) ? n : v.value;
  }
  if (v.type === "float") return Number(v.value);
  if (v.type === "text") return v.value;
  if (v.type === "blob") return `[BLOB ${ Math.floor((v.base64.length * 3) / 4) }B: ${v.base64.slice(0, 32)}${v.base64.length > 32 ? "…" : ""}]`;
  return null;
}

// Short-lived in-memory token cache per database (refreshed every 5 minutes, 1h TTL)
// so we don't re-read keys/<id>.key from disk on every single query.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getInternalToken(dataRoot: string, dbId: string, dbSlug: string): Promise<string> {
  const now = Date.now();
  const cached = tokenCache.get(dbId);
  if (cached && cached.expiresAt - now > 60_000) {
    return cached.token;
  }
  const issued = await mintToken({ dataRoot, dbId, dbSlug, scope: "full", expiresInHours: 1 }, 1);
  tokenCache.set(dbId, { token: issued.token, expiresAt: now + 5 * 60_000 });
  return issued.token;
}

export function createHttpHranaExecutor(
  dataRoot: string,
  opts: { upstreamHost?: string; fetchImpl?: typeof fetch; onQuery?: QueryObserver } = {},
): HranaExecutor {
  const host = opts.upstreamHost ?? "127.0.0.1";
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    async pipeline(db, stmts, callOpts = {}) {
      const timeoutMs = callOpts.timeoutMs ?? 10_000;
      const token = await getInternalToken(dataRoot, db.id, db.slug);
      const requests: HranaPipelineReq[] = stmts.map((s) => ({
        type: "execute",
        stmt: {
          sql: s.sql,
          ...(s.args && s.args.length > 0 ? { args: s.args.map(toHranaValue) } : {}),
          ...(s.namedArgs
            ? {
                named_args: Object.entries(s.namedArgs).map(([name, value]) => ({
                  name: name.replace(/^[:@$]/, ""),
                  value: toHranaValue(value),
                })),
              }
            : {}),
          want_rows: s.wantRows ?? true,
        },
      }));
      requests.push({ type: "close" });

      const t0 = performance.now();
      let res: Response;
      try {
        res = await doFetch(`http://${host}:${db.port}/v2/pipeline`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ requests }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const elapsed = performance.now() - t0;
        opts.onQuery?.({ dbId: db.id, durationMs: elapsed, ok: false, isWrite: false });
        if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") {
          throw new ApiError(408, "query_timeout", `query timed out after ${timeoutMs}ms`);
        }
        throw new ApiError(502, "sqld_unreachable", `could not reach database process on port ${db.port}`);
      }

      if (!res.ok) {
        const elapsed = performance.now() - t0;
        opts.onQuery?.({ dbId: db.id, durationMs: elapsed, ok: false, isWrite: false });
        const text = (await res.text().catch(() => "")).slice(0, 500);
        throw new ApiError(502, "sqld_error", `sqld HTTP ${res.status}`, text || undefined);
      }

      const body = (await res.json()) as HranaPipelineResponse;
      const totalDurationMs = Number((performance.now() - t0).toFixed(2));
      const perStmtMs = stmts.length > 0 ? Number((totalDurationMs / stmts.length).toFixed(2)) : 0;

      const out: RawExecResult[] = [];
      for (let i = 0; i < stmts.length; i++) {
        const entry = body.results[i];
        if (!entry) {
          opts.onQuery?.({ dbId: db.id, durationMs: totalDurationMs, ok: false, isWrite: false });
          throw new ApiError(502, "sqld_error", "incomplete pipeline response from sqld");
        }
        if (entry.type === "error" || !entry.response?.result) {
          opts.onQuery?.({ dbId: db.id, durationMs: totalDurationMs, ok: false, isWrite: false });
          const msg = entry.error?.message ?? "SQL execution failed";
          throw new ApiError(400, "sql_error", msg, entry.error?.code);
        }
        const r = entry.response.result;
        out.push({
          columns: r.cols.map((c) => c.name ?? ""),
          columnTypes: r.cols.map((c) => c.decltype ?? null),
          rows: r.rows.map((row) => row.map(fromHranaValue)),
          rowsAffected: r.affected_row_count ?? 0,
          lastInsertRowid: r.last_insert_rowid ?? null,
          durationMs: perStmtMs,
        });
      }

      opts.onQuery?.({
        dbId: db.id,
        durationMs: totalDurationMs,
        ok: true,
        isWrite: out.some((x) => x.rowsAffected > 0),
      });
      return { results: out, totalDurationMs };
    },
  };
}

// ---------------------------------------------------------------------------
// SQL Statement Splitter & Read-Only Guard
// ---------------------------------------------------------------------------

/**
 * Splits a SQL script into individual statements while respecting:
 *   • 'single-quoted' strings, "double-quoted" identifiers, `backtick` and [bracket] identifiers
 *   • -- line comments and /* block comments * /
 *   • CREATE TRIGGER ... BEGIN ... END; blocks (semicolons inside BEGIN..END do not split)
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  let inTriggerBegin = 0;

  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"' || ch === "`") {
      const q = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === q) {
          if (sql[i + 1] === q) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
    } else if (ch === "[") {
      const end = sql.indexOf("]", i + 1);
      i = end === -1 ? sql.length : end + 1;
    } else if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i + 2);
      i = nl === -1 ? sql.length : nl + 1;
    } else if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (/[A-Za-z_]/.test(ch)) {
      const wordStart = i;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i]!)) i++;
      const word = sql.slice(wordStart, i).toUpperCase();
      if (word === "BEGIN") {
        // Check if preceding tokens in this statement contain CREATE [TEMP] TRIGGER
        const prefix = stripSqlComments(sql.slice(start, wordStart)).toUpperCase();
        if (/\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/.test(prefix)) {
          inTriggerBegin++;
        }
      } else if (word === "END" && inTriggerBegin > 0) {
        inTriggerBegin--;
      }
    } else if (ch === ";" && inTriggerBegin === 0) {
      const stmt = sql.slice(start, i).trim();
      if (stripSqlComments(stmt).length > 0) out.push(stmt);
      start = i + 1;
      i++;
    } else {
      i++;
    }
  }
  const tail = sql.slice(start).trim();
  if (stripSqlComments(tail).length > 0) out.push(tail);
  return out;
}

/** Remove comments and string literals so keyword inspection cannot be fooled. */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"' || ch === "`") {
      const q = ch;
      out += " ";
      i++;
      while (i < sql.length) {
        if (sql[i] === q) {
          if (sql[i + 1] === q) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
    } else if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i + 2);
      out += " ";
      i = nl === -1 ? sql.length : nl + 1;
    } else if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      out += " ";
      i = end === -1 ? sql.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out.trim();
}

const READ_PRAGMAS = new Set([
  "table_info",
  "table_xinfo",
  "table_list",
  "index_list",
  "index_info",
  "index_xinfo",
  "foreign_key_list",
  "foreign_key_check",
  "database_list",
  "compile_options",
  "collation_list",
  "function_list",
  "module_list",
  "pragma_list",
  "page_count",
  "page_size",
  "freelist_count",
  "journal_mode",
  "synchronous",
  "user_version",
  "application_id",
  "schema_version",
  "data_version",
  "encoding",
  "auto_vacuum",
  "cache_size",
  "busy_timeout",
  "foreign_keys",
  "integrity_check",
  "quick_check",
  "stats",
]);

const WRITE_KEYWORDS_RE = /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE|VACUUM|ATTACH|DETACH|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/**
 * Returns null if `stmt` is strictly read-only, or an explanation string if
 * it may mutate state.
 */
export function checkReadOnlyStatement(stmt: string): string | null {
  const cleaned = stripSqlComments(stmt);
  if (!cleaned) return null;
  const firstMatch = /^([A-Za-z]+)/.exec(cleaned);
  if (!firstMatch) return "unrecognized SQL statement";
  const verb = firstMatch[1]!.toUpperCase();

  if (verb === "PRAGMA") {
    // Allow read-only PRAGMA <name> or PRAGMA <name>(arg), but forbid `=` assignment or mutating pragmas.
    if (cleaned.includes("=")) {
      return "PRAGMA assignment is not allowed in read-only mode";
    }
    const m = /^PRAGMA\s+(?:[A-Za-z0-9_]+\.)?([A-Za-z0-9_]+)/i.exec(cleaned);
    const pragmaName = m?.[1]?.toLowerCase() ?? "";
    if (!READ_PRAGMAS.has(pragmaName)) {
      return `PRAGMA ${pragmaName || "(unknown)"} is not allowed in read-only mode`;
    }
    return null;
  }

  if (verb !== "SELECT" && verb !== "VALUES" && verb !== "EXPLAIN" && verb !== "WITH") {
    return `${verb} statements are blocked when readOnly is true`;
  }

  if (WRITE_KEYWORDS_RE.test(cleaned)) {
    const hit = WRITE_KEYWORDS_RE.exec(cleaned)?.[1]?.toUpperCase() ?? "WRITE";
    return `${hit} is blocked when readOnly is true`;
  }

  return null;
}

/** Quote a validated SQLite identifier (`"` -> `""`). */
export function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// High-Level Operations: Query, Schema, and Structured Table Rows
// ---------------------------------------------------------------------------

export async function runSqlQuery(
  executor: HranaExecutor,
  db: { id: string; slug: string; port: number },
  req: QueryRequest,
): Promise<QueryResponse> {
  const statements = splitSqlStatements(req.sql);
  if (statements.length === 0) {
    throw new ApiError(400, "bad_request", "SQL query contains no executable statements");
  }
  if (statements.length > 50) {
    throw new ApiError(400, "bad_request", "at most 50 statements allowed per request");
  }

  const readOnly = req.readOnly ?? true;
  if (readOnly) {
    for (const s of statements) {
      const violation = checkReadOnlyStatement(s);
      if (violation) {
        throw new ApiError(403, "read_only_violation", violation);
      }
    }
  }

  const posArgs = Array.isArray(req.params) ? req.params : undefined;
  const namedArgs = req.params && !Array.isArray(req.params) ? req.params : undefined;

  // When readOnly is true, wrap the pipeline in PRAGMA query_only = ON / OFF
  // so SQLite itself enforces read-only execution at the engine level.
  const pipelineStmts: { sql: string; args?: SqlValue[]; namedArgs?: Record<string, SqlValue>; wantRows?: boolean }[] = [];
  if (readOnly) {
    pipelineStmts.push({ sql: "PRAGMA query_only = ON", wantRows: false });
  }
  for (const s of statements) {
    pipelineStmts.push({
      sql: s,
      ...( statements.length === 1 && posArgs ? { args: posArgs } : {}),
      ...( statements.length === 1 && namedArgs ? { namedArgs } : {}),
      wantRows: true,
    });
  }
  if (readOnly) {
    pipelineStmts.push({ sql: "PRAGMA query_only = OFF", wantRows: false });
  }

  const { results: rawResults, totalDurationMs } = await executor.pipeline(db, pipelineStmts, {
    timeoutMs: req.timeoutMs ?? 10_000,
  });

  const userResults = readOnly ? rawResults.slice(1, 1 + statements.length) : rawResults;
  const limit = Math.min(10_000, Math.max(1, req.limit ?? 1000));

  const results: StatementResult[] = userResults.map((r, idx) => {
    const truncated = r.rows.length > limit;
    const rows = truncated ? r.rows.slice(0, limit) : r.rows;
    return {
      statement: statements[idx]!,
      columns: r.columns,
      columnTypes: r.columnTypes,
      rows,
      rowsAffected: r.rowsAffected,
      lastInsertRowid: r.lastInsertRowid,
      durationMs: r.durationMs,
      truncated,
    };
  });

  return { results, totalDurationMs };
}

export async function inspectDatabaseSchema(
  executor: HranaExecutor,
  db: { id: string; slug: string; port: number },
): Promise<DatabaseSchemaResponse> {
  // Step 1: fetch all user tables, views, and indexes from sqlite_schema
  const { results: initRes } = await executor.pipeline(db, [
    {
      sql: `SELECT type, name, tbl_name, sql FROM sqlite_schema
            WHERE type IN ('table', 'view', 'index')
              AND name NOT LIKE 'sqlite_%'
              AND name NOT LIKE '_litestream_%'
            ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name COLLATE NOCASE`,
    },
  ]);

  const schemaRows = initRes[0]!.rows;
  const tablesAndViews: { type: "table" | "view"; name: string; sql: string | null }[] = [];
  const indexSqlByName = new Map<string, string | null>();

  for (const r of schemaRows) {
    const type = String(r[0]);
    const name = String(r[1]);
    const sql = r[3] === null ? null : String(r[3]);
    if (type === "table" || type === "view") {
      tablesAndViews.push({ type, name, sql });
    } else if (type === "index") {
      indexSqlByName.set(name, sql);
    }
  }

  if (tablesAndViews.length === 0) {
    return { tables: [], refreshedAt: Date.now() };
  }

  // Step 2: in one pipeline, query table_info, index_list, foreign_key_list, and bounded row count for each table/view
  const perTableStmts: { sql: string }[] = [];
  for (const t of tablesAndViews) {
    const qName = quoteIdent(t.name);
    perTableStmts.push({ sql: `PRAGMA table_info(${qName})` });
    perTableStmts.push({ sql: `PRAGMA index_list(${qName})` });
    perTableStmts.push({ sql: `PRAGMA foreign_key_list(${qName})` });
    perTableStmts.push({
      sql: t.type === "table" ? `SELECT COUNT(*) FROM (SELECT 1 FROM ${qName} LIMIT 100000)` : `SELECT NULL`,
    });
  }

  const { results: detailRes } = await executor.pipeline(db, perTableStmts);

  // Collect index names that need PRAGMA index_info
  const indexNamesToInspect: string[] = [];
  for (let i = 0; i < tablesAndViews.length; i++) {
    const idxListRows = detailRes[i * 4 + 1]!.rows;
    for (const ir of idxListRows) {
      indexNamesToInspect.push(String(ir[1]));
    }
  }

  const indexColsMap = new Map<string, string[]>();
  if (indexNamesToInspect.length > 0) {
    const idxInfoStmts = indexNamesToInspect.map((idxName) => ({
      sql: `PRAGMA index_info(${quoteIdent(idxName)})`,
    }));
    const { results: idxInfoRes } = await executor.pipeline(db, idxInfoStmts);
    for (let k = 0; k < indexNamesToInspect.length; k++) {
      const cols = idxInfoRes[k]!.rows
        .map((r) => (r[2] === null ? "" : String(r[2])))
        .filter(Boolean);
      indexColsMap.set(indexNamesToInspect[k]!, cols);
    }
  }

  const items: TableSchemaItem[] = tablesAndViews.map((t, i) => {
    const colRows = detailRes[i * 4]!.rows;
    const idxRows = detailRes[i * 4 + 1]!.rows;
    const fkRows = detailRes[i * 4 + 2]!.rows;
    const countRow = detailRes[i * 4 + 3]!.rows[0];

    const columns: ColumnInfo[] = colRows.map((c) => ({
      cid: Number(c[0]),
      name: String(c[1]),
      type: String(c[2] ?? ""),
      notnull: Number(c[3]) === 1,
      defaultValue: c[4] === null ? null : String(c[4]),
      pk: Number(c[5] ?? 0),
    }));

    const primaryKey = columns
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);

    const withoutRowid =
      t.type === "table" && !!t.sql && /\bWITHOUT\s+ROWID\b/i.test(stripSqlComments(t.sql));

    const indexes: IndexInfo[] = idxRows.map((ir) => {
      const idxName = String(ir[1]);
      return {
        name: idxName,
        unique: Number(ir[2]) === 1,
        origin: String(ir[3] ?? "c"),
        partial: Number(ir[4]) === 1,
        columns: indexColsMap.get(idxName) ?? [],
        sql: indexSqlByName.get(idxName) ?? null,
      };
    });

    const foreignKeys: ForeignKeyInfo[] = fkRows.map((fr) => ({
      id: Number(fr[0]),
      seq: Number(fr[1]),
      table: String(fr[2]),
      from: String(fr[3]),
      to: String(fr[4] ?? ""),
      onUpdate: String(fr[5] ?? "NO ACTION"),
      onDelete: String(fr[6] ?? "NO ACTION"),
    }));

    const rawCount = countRow?.[0];
    const rowCountEstimate = typeof rawCount === "number" ? rawCount : null;

    return {
      name: t.name,
      type: t.type,
      sql: t.sql,
      withoutRowid,
      rowCountEstimate,
      columns,
      primaryKey,
      indexes,
      foreignKeys,
    };
  });

  return { tables: items, refreshedAt: Date.now() };
}

/** Verify `:table` exists in `sqlite_schema` and return its columns, PKs, and rowid support. */
async function resolveTableMeta(
  executor: HranaExecutor,
  db: { id: string; slug: string; port: number },
  tableName: string,
): Promise<{
  name: string;
  type: "table" | "view";
  columns: ColumnInfo[];
  primaryKey: string[];
  hasRowid: boolean;
  allowedColumns: Set<string>;
}> {
  const { results } = await executor.pipeline(db, [
    {
      sql: `SELECT type, name, sql FROM sqlite_schema WHERE type IN ('table', 'view') AND name = ?`,
      args: [tableName],
    },
  ]);

  const match = results[0]!.rows[0];
  if (!match) {
    throw new ApiError(400, "bad_request", `unknown table or view: "${tableName}"`);
  }
  const type = String(match[0]) as "table" | "view";
  const exactName = String(match[1]);
  const createSql = match[2] === null ? "" : String(match[2]);
  const withoutRowid = type === "table" && /\bWITHOUT\s+ROWID\b/i.test(stripSqlComments(createSql));
  const hasRowid = type === "table" && !withoutRowid;

  const { results: infoRes } = await executor.pipeline(db, [
    { sql: `PRAGMA table_info(${quoteIdent(exactName)})` },
  ]);

  const columns: ColumnInfo[] = infoRes[0]!.rows.map((c) => ({
    cid: Number(c[0]),
    name: String(c[1]),
    type: String(c[2] ?? ""),
    notnull: Number(c[3]) === 1,
    defaultValue: c[4] === null ? null : String(c[4]),
    pk: Number(c[5] ?? 0),
  }));

  const primaryKey = columns
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);

  const allowedColumns = new Set(columns.map((c) => c.name));
  if (hasRowid) {
    allowedColumns.add("_rowid_");
    allowedColumns.add("rowid");
  }

  return {
    name: exactName,
    type,
    columns,
    primaryKey: primaryKey.length > 0 ? primaryKey : hasRowid ? ["_rowid_"] : [],
    hasRowid,
    allowedColumns,
  };
}

function buildWhereClause(
  filters: TableFilter[],
  allowedColumns: Set<string>,
): { whereSql: string; args: SqlValue[] } {
  if (filters.length === 0) return { whereSql: "", args: [] };
  const clauses: string[] = [];
  const args: SqlValue[] = [];

  for (const f of filters) {
    if (!allowedColumns.has(f.col)) {
      throw new ApiError(400, "bad_request", `unknown filter column: "${f.col}"`);
    }
    const qCol = quoteIdent(f.col);
    const op: FilterOp = f.op;
    switch (op) {
      case "isnull":
        clauses.push(`${qCol} IS NULL`);
        break;
      case "notnull":
        clauses.push(`${qCol} IS NOT NULL`);
        break;
      case "=":
      case "!=":
      case "<":
      case "<=":
      case ">":
      case ">=": {
        if (f.value === undefined || Array.isArray(f.value)) {
          throw new ApiError(400, "bad_request", `operator "${op}" requires a scalar value`);
        }
        if (f.value === null) {
          clauses.push(op === "=" ? `${qCol} IS NULL` : op === "!=" ? `${qCol} IS NOT NULL` : `${qCol} ${op} ?`);
          if (op !== "=" && op !== "!=") args.push(null);
        } else {
          clauses.push(`${qCol} ${op} ?`);
          args.push(f.value);
        }
        break;
      }
      case "like": {
        if (typeof f.value !== "string" && typeof f.value !== "number") {
          throw new ApiError(400, "bad_request", `operator "like" requires a string value`);
        }
        clauses.push(`${qCol} LIKE ?`);
        args.push(String(f.value));
        break;
      }
      case "in": {
        const list = Array.isArray(f.value)
          ? f.value
          : typeof f.value === "string"
            ? f.value.split(",").map((s) => s.trim())
            : f.value !== undefined
              ? [f.value]
              : [];
        if (list.length === 0) {
          throw new ApiError(400, "bad_request", `operator "in" requires a non-empty value list`);
        }
        const placeholders = list.map(() => "?").join(", ");
        clauses.push(`${qCol} IN (${placeholders})`);
        args.push(...list);
        break;
      }
    }
  }

  return {
    whereSql: `WHERE ${clauses.join(" AND ")}`,
    args,
  };
}

export async function browseTableRows(
  executor: HranaExecutor,
  db: { id: string; slug: string; port: number },
  tableName: string,
  opts: {
    limit: number;
    offset: number;
    sort?: string;
    dir?: "asc" | "desc";
    filters?: TableFilter[];
  },
): Promise<TableRowsResponse> {
  const meta = await resolveTableMeta(executor, db, tableName);
  const limit = Math.min(1000, Math.max(1, opts.limit));
  const offset = Math.max(0, opts.offset);

  if (opts.sort && !meta.allowedColumns.has(opts.sort)) {
    throw new ApiError(400, "bad_request", `unknown sort column: "${opts.sort}"`);
  }
  const { whereSql, args } = buildWhereClause(opts.filters ?? [], meta.allowedColumns);

  const dirSql = opts.dir === "desc" ? "DESC" : "ASC";
  let orderBySql = "";
  if (opts.sort) {
    orderBySql = `ORDER BY ${quoteIdent(opts.sort)} ${dirSql}`;
  } else if (meta.primaryKey.length > 0) {
    orderBySql = `ORDER BY ${meta.primaryKey.map(quoteIdent).join(", ")} ASC`;
  }

  // Include _rowid_ when the table has no explicit primary key so rows remain editable/deletable
  const needsHiddenRowid = meta.hasRowid && !meta.columns.some((c) => c.pk > 0);
  const selectCols = needsHiddenRowid
    ? `_rowid_ AS "_rowid_", ${meta.columns.map((c) => quoteIdent(c.name)).join(", ")}`
    : meta.columns.map((c) => quoteIdent(c.name)).join(", ");

  const dataSql = `SELECT ${selectCols} FROM ${quoteIdent(meta.name)} ${whereSql} ${orderBySql} LIMIT ? OFFSET ?`;
  const countSql = `SELECT COUNT(*) FROM (SELECT 1 FROM ${quoteIdent(meta.name)} ${whereSql} LIMIT 50001)`;

  const { results, totalDurationMs } = await executor.pipeline(db, [
    { sql: dataSql, args: [...args, limit + 1, offset] },
    { sql: countSql, args },
  ]);

  const rawRows = results[0]!.rows;
  const colNames = results[0]!.columns;
  const hasMore = rawRows.length > limit;
  const sliced = hasMore ? rawRows.slice(0, limit) : rawRows;

  const rows: Record<string, SqlValue>[] = sliced.map((r) => {
    const obj: Record<string, SqlValue> = {};
    for (let i = 0; i < colNames.length; i++) {
      obj[colNames[i]!] = r[i] ?? null;
    }
    return obj;
  });

  const rawCount = Number(results[1]!.rows[0]?.[0] ?? 0);
  const total = rawCount <= 50_000 ? rawCount : null;

  return {
    table: meta.name,
    columns: meta.columns,
    primaryKey: meta.primaryKey,
    hasRowid: meta.hasRowid,
    rows,
    total,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
    durationMs: totalDurationMs,
  };
}

export async function insertTableRows(
  executor: HranaExecutor,
  db: { id: string; slug: string; port: number },
  tableName: string,
  req: InsertRowsRequest,
): Promise<MutateRowsResponse> {
  const meta = await resolveTableMeta(executor, db, tableName);
  if (meta.type !== "table") {
    throw new ApiError(400, "bad_request", `cannot insert into view "${meta.name}"`);
  }
  const colSet = new Set(meta.columns.map((c) => c.name));

  const stmts: { sql: string; args?: SqlValue[]; wantRows?: boolean }[] = [
    { sql: "BEGIN IMMEDIATE", wantRows: false },
  ];

  for (const row of req.rows) {
    const keys = Object.keys(row);
    for (const k of keys) {
      if (!colSet.has(k)) {
        throw new ApiError(400, "bad_request", `unknown column "${k}" on table "${meta.name}"`);
      }
    }
    if (keys.length === 0) {
      stmts.push({ sql: `INSERT INTO ${quoteIdent(meta.name)} DEFAULT VALUES`, wantRows: false });
    } else {
      const colsSql = keys.map(quoteIdent).join(", ");
      const placeholders = keys.map(() => "?").join(", ");
      const vals = keys.map((k) => row[k] ?? null);
      stmts.push({
        sql: `INSERT INTO ${quoteIdent(meta.name)} (${colsSql}) VALUES (${placeholders})`,
        args: vals,
        wantRows: false,
      });
    }
  }
  stmts.push({ sql: "COMMIT", wantRows: false });

  const { results, totalDurationMs } = await executor.pipeline(db, stmts);
  const execResults = results.slice(1, 1 + req.rows.length);
  const affected = execResults.reduce((acc, r) => acc + r.rowsAffected, 0);
  const lastInsertRowid = execResults.at(-1)?.lastInsertRowid ?? null;

  return { affected, lastInsertRowid, durationMs: totalDurationMs };
}

export async function updateTableRows(
  executor: HranaExecutor,
  db: { id: string; slug: string; port: number },
  tableName: string,
  req: UpdateRowsRequest,
): Promise<MutateRowsResponse> {
  const meta = await resolveTableMeta(executor, db, tableName);
  if (meta.type !== "table") {
    throw new ApiError(400, "bad_request", `cannot update view "${meta.name}"`);
  }
  const colSet = new Set(meta.columns.map((c) => c.name));

  const stmts: { sql: string; args?: SqlValue[]; wantRows?: boolean }[] = [
    { sql: "BEGIN IMMEDIATE", wantRows: false },
  ];

  for (const item of req.updates) {
    const pkEntries = Object.entries(item.pk);
    const valEntries = Object.entries(item.values);
    if (pkEntries.length === 0) {
      throw new ApiError(400, "bad_request", "update requires at least one primary key / rowid column");
    }
    if (valEntries.length === 0) {
      throw new ApiError(400, "bad_request", "update requires at least one column value to change");
    }
    for (const [k] of pkEntries) {
      if (!meta.allowedColumns.has(k)) {
        throw new ApiError(400, "bad_request", `unknown key column "${k}" on table "${meta.name}"`);
      }
    }
    for (const [k] of valEntries) {
      if (!colSet.has(k)) {
        throw new ApiError(400, "bad_request", `unknown column "${k}" on table "${meta.name}"`);
      }
    }

    const setSql = valEntries.map(([k]) => `${quoteIdent(k)} = ?`).join(", ");
    const setArgs = valEntries.map(([, v]) => v ?? null);

    const whereParts: string[] = [];
    const whereArgs: SqlValue[] = [];
    for (const [k, v] of pkEntries) {
      if (v === null) {
        whereParts.push(`${quoteIdent(k)} IS NULL`);
      } else {
        whereParts.push(`${quoteIdent(k)} = ?`);
        whereArgs.push(v);
      }
    }

    stmts.push({
      sql: `UPDATE ${quoteIdent(meta.name)} SET ${setSql} WHERE ${whereParts.join(" AND ")}`,
      args: [...setArgs, ...whereArgs],
      wantRows: false,
    });
  }

  stmts.push({ sql: "COMMIT", wantRows: false });
  const { results, totalDurationMs } = await executor.pipeline(db, stmts);
  const execResults = results.slice(1, 1 + req.updates.length);
  const affected = execResults.reduce((acc, r) => acc + r.rowsAffected, 0);

  return { affected, durationMs: totalDurationMs };
}

export async function deleteTableRows(
  executor: HranaExecutor,
  db: { id: string; slug: string; port: number },
  tableName: string,
  req: DeleteRowsRequest,
): Promise<MutateRowsResponse> {
  const meta = await resolveTableMeta(executor, db, tableName);
  if (meta.type !== "table") {
    throw new ApiError(400, "bad_request", `cannot delete from view "${meta.name}"`);
  }

  const stmts: { sql: string; args?: SqlValue[]; wantRows?: boolean }[] = [
    { sql: "BEGIN IMMEDIATE", wantRows: false },
  ];

  for (const pk of req.pks) {
    const pkEntries = Object.entries(pk);
    if (pkEntries.length === 0) {
      throw new ApiError(400, "bad_request", "delete requires at least one primary key / rowid column");
    }
    for (const [k] of pkEntries) {
      if (!meta.allowedColumns.has(k)) {
        throw new ApiError(400, "bad_request", `unknown key column "${k}" on table "${meta.name}"`);
      }
    }

    const whereParts: string[] = [];
    const whereArgs: SqlValue[] = [];
    for (const [k, v] of pkEntries) {
      if (v === null) {
        whereParts.push(`${quoteIdent(k)} IS NULL`);
      } else {
        whereParts.push(`${quoteIdent(k)} = ?`);
        whereArgs.push(v);
      }
    }

    stmts.push({
      sql: `DELETE FROM ${quoteIdent(meta.name)} WHERE ${whereParts.join(" AND ")}`,
      args: whereArgs,
      wantRows: false,
    });
  }

  stmts.push({ sql: "COMMIT", wantRows: false });
  const { results, totalDurationMs } = await executor.pipeline(db, stmts);
  const execResults = results.slice(1, 1 + req.pks.length);
  const affected = execResults.reduce((acc, r) => acc + r.rowsAffected, 0);

  return { affected, durationMs: totalDurationMs };
}

export async function inspectDatabaseStorage(
  executor: HranaExecutor,
  db: { id: string; slug: string; port: number; dataDir: string },
): Promise<StorageStatsResponse> {
  const { results: pragmaRes } = await executor.pipeline(db, [
    { sql: "PRAGMA page_count" },
    { sql: "PRAGMA page_size" },
    { sql: "PRAGMA freelist_count" },
    {
      sql: `SELECT name FROM sqlite_schema
            WHERE type = 'table'
              AND name NOT LIKE 'sqlite_%'
              AND name NOT LIKE '_litestream_%'
            ORDER BY name COLLATE NOCASE`,
    },
  ]);

  const pageCount = Number(pragmaRes[0]!.rows[0]?.[0] ?? 0);
  const pageSize = Number(pragmaRes[1]!.rows[0]?.[0] ?? 4096);
  const freelistCount = Number(pragmaRes[2]!.rows[0]?.[0] ?? 0);
  const tableNames = pragmaRes[3]!.rows.map((r) => String(r[0]));

  const tableRowCounts: { name: string; count: number }[] = [];
  if (tableNames.length > 0) {
    const countStmts = tableNames.map((name) => ({
      sql: `SELECT COUNT(*) FROM ${quoteIdent(name)}`,
    }));
    const { results: countRes } = await executor.pipeline(db, countStmts);
    for (let i = 0; i < tableNames.length; i++) {
      tableRowCounts.push({
        name: tableNames[i]!,
        count: Number(countRes[i]!.rows[0]?.[0] ?? 0),
      });
    }
  }

  return {
    pageCount,
    pageSize,
    freelistCount,
    walBytes: walDirBytes(db.dataDir),
    diskBytes: dirBytes(db.dataDir),
    tableRowCounts,
  };
}
