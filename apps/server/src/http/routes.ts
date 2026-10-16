import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, rmdir } from "node:fs/promises";
import { ZodError } from "zod";
import {
  ConfirmSlugDeleteSchema,
  CreateDatabaseSchema,
  CreateTokenSchema,
  CreateWorkspaceSchema,
  DatabaseSchema,
  DeleteRowsRequestSchema,
  InsertRowsRequestSchema,
  MetricsRangeSchema,
  QueryRequestSchema,
  SetProtectionSchema,
  TableFilterSchema,
  UpdateRowsRequestSchema,
  type CreateWorkspace,
  type DatabaseMetricsSummary,
  type DatabaseStatus,
  type Database as DatabaseDto,
  type Connection,
  type DeletePreview,
  type DeleteRowsRequest,
  type ErrorBody,
  type InsertRowsRequest,
  type Metrics,
  type MetricsHistoryPoint,
  type MetricsHistoryResponse,
  type MetricsOverviewResponse,
  type MetricsRange,
  type QueryRequest,
  type StabilityBadge,
  type SystemInfo,
  type TableFilter,
  type TrashItem,
  type UpdateRowsRequest,
  type Workspace,
} from "@sqlitend/shared";
import { z } from "zod";
import {
  browseTableRows,
  createHttpHranaExecutor,
  deleteTableRows,
  inspectDatabaseSchema,
  inspectDatabaseStorage,
  insertTableRows,
  runSqlQuery,
  updateTableRows,
  type HranaExecutor,
} from "../db/hrana.ts";
import type { Config } from "../config.ts";
import type { WorkspacesRepo, WorkspaceRow } from "../db/repos/workspaces.ts";
import type { DatabasesRepo, DatabaseRow as DbRow } from "../db/repos/databases.ts";
import type { MetricsRepo, MetricsHistoryRow } from "../db/repos/metrics.ts";
import { NameExistsError, SlugExistsError } from "../db/repos/databases.ts";
import type { TokenRow, TokensRepo } from "../db/repos/tokens.ts";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Supervisor } from "../supervisor/supervisor.ts";
import { dirBytes, type Sampler } from "../metrics/sampler.ts";
import { PortExhaustedError } from "../supervisor/ports.ts";
import { mintToken, dbKeyRelPath } from "../auth/tokens.ts";
import { assertInside } from "../util/paths.ts";
import type { DnsManager } from "../dns/manager.ts";
import type { Replicator } from "../backup/replicator.ts";
import type { RestoreService } from "../backup/restore.ts";
import type { ImportService } from "../backup/import.ts";
import { verifyHealth, type VerifyService } from "../backup/verify.ts";
import type { VerificationsRepo } from "../db/repos/verifications.ts";
import type { ControlBackupService } from "../backup/control.ts";
import { ImportRequestSchema, RestoreRequestSchema, type BackupStatus, type ImportRequest, type RestoreRequest } from "@sqlitend/shared";
import { installAuth, installCsrfOnly, type AppEnv, type AuthDeps } from "./auth-routes.ts";
import { maxSlugLength, parseHostTemplate, publicKeyFor, renderHost } from "../gateway/gateway.ts";

// ---------------------------------------------------------------------------
// DTO mappers (snake_case rows -> camelCase shared DTOs)
// ---------------------------------------------------------------------------
function rowToWorkspace(r: WorkspaceRow): Workspace {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    protected: (r.protected ?? 1) === 1,
    createdAt: r.created_at,
  };
}

/** Read-safe status coercion: a corrupt `status` value in metadata must not
 *  500 the whole list/metrics endpoints — it is served as `unknown` instead
 *  (never written back; the supervisor only persists the six real states). */
function coerceStatus(raw: string): DatabaseStatus {
  const result = DatabaseSchema.shape.status.safeParse(raw);
  return result.success ? result.data : "unknown";
}

function rowToDatabase(r: DbRow): Omit<DatabaseDto, "publicUrl"> {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    slug: r.slug,
    name: r.name,
    status: coerceStatus(r.status),
    pid: r.pid,
    port: r.port,
    grpcPort: r.grpc_port,
    dataDir: r.data_dir,
    autoStart: r.auto_start === 1,
    protected: (r.protected ?? 1) === 1,
    trashedAt: r.trashed_at ?? null,
    lastWriteAt: r.last_write_at ?? null,
    sqldVersion: r.sqld_version,
    failedReason: r.failed_reason ?? null,
    dns: {
      hostname: r.dns_hostname ?? null,
      status: r.dns_status === "active" || r.dns_status === "error" || r.dns_status === "conflict" ? r.dns_status : null,
      error: r.dns_error ?? null,
    },
    createdAt: r.created_at,
  };
}

function rowToToken(r: TokenRow) {
  return {
    jti: r.jti,
    databaseId: r.database_id,
    scope: r.scope === "ro" ? ("ro" as const) : ("full" as const),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    name: r.name ?? null,
    revokedAt: r.revoked_at ?? null,
    lastUsedAt: r.last_used_at ?? null,
    copyable: !!r.has_value,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export class ApiError extends Error {
  status: number;
  code: string;
  detail?: string;
  extra?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, detail?: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.extra = extra;
  }
  body(): ErrorBody & Record<string, unknown> {
    return {
      error: { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) },
      ...(this.extra ?? {}),
    };
  }
}

/** Compact, client-useful summary of a zod failure ("what exactly was wrong"). */
function zodDetail(err: unknown): string | undefined {
  if (!(err instanceof ZodError)) return undefined;
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A database's public key: 12 random chars (~62 bits), starting with a letter.
 *  Never derived from the name, so names can repeat across workspaces and
 *  hostnames reveal nothing. */
export function randomDbSlug(): string {
  // Rejection sampling for both alphabets (26 letters first, then 36 chars),
  // refilling the buffer if it ever runs dry.
  let out = "";
  while (out.length < 12) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (out.length === 0) {
        if (b < 234) out += SLUG_ALPHABET[b % 26]!; // 234 = 9 × 26
      } else if (b < 252) {
        out += SLUG_ALPHABET[b % 36]!; // 252 = 7 × 36
      }
      if (out.length === 12) break;
    }
  }
  return out;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || randomUUID().slice(0, 8)
  );
}

export interface RoutesDeps {
  config: Config;
  workspaces: WorkspacesRepo;
  databases: DatabasesRepo;
  tokens: TokensRepo;
  supervisor: Supervisor;
  sampler: Sampler;
  /** Set true once the sqld binary has been smoke-tested at boot. */
  sqldOk: boolean;
  /** Version string of the target sqld binary, or null if unavailable. */
  sqldVersion: string | null;
  version: string;
  /** Cloudflare DNS automation; absent when disabled. */
  dns?: DnsManager | null;
  /** Continuous S3 backup; absent when not configured. */
  backup?: Replicator | null;
  restore?: RestoreService | null;
  importer?: ImportService | null;
  /** Audit sink when login is off (SQLITEND_AUTH=off); with login it comes via `auth`. */
  auditRepo?: AuthDeps["repo"] | null;
  control?: ControlBackupService | null;
  verify?: { service: VerifyService; results: VerificationsRepo; maxAgeMs: number; startedAt?: number } | null;
  /** Control-plane login; absent only with SQLITEND_AUTH=off (loopback dev). */
  auth?: AuthDeps | null;
  /** Optional custom Hrana executor (for tests or metrics hooks). */
  hrana?: HranaExecutor;
  /** Optional persisted metrics repo (Phase 3). */
  metricsRepo?: MetricsRepo | null;
}

export function createRoutes(d: RoutesDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const baseHrana =
    d.hrana ??
    createHttpHranaExecutor(d.config.dataRoot, {
      onQuery: (ev) => d.sampler.recordQuery(ev.dbId, ev.durationMs, ev.ok),
    });
  // Wrap any custom hrana executor so d.sampler.recordQuery is also invoked during tests
  const hrana: HranaExecutor = d.hrana
    ? {
        async pipeline(db, stmts, opts) {
          const t0 = performance.now();
          try {
            const res = await d.hrana!.pipeline(db, stmts, opts);
            d.sampler.recordQuery(db.id, res.totalDurationMs, true);
            return res;
          } catch (err) {
            d.sampler.recordQuery(db.id, Number((performance.now() - t0).toFixed(2)), false);
            throw err;
          }
        },
        async batch(db, steps, opts) {
          const t0 = performance.now();
          try {
            const res = await d.hrana!.batch(db, steps, opts);
            const hasErr = res.outcomes.some((o) => o.error !== null);
            d.sampler.recordQuery(db.id, res.totalDurationMs, !hasErr);
            return res;
          } catch (err) {
            d.sampler.recordQuery(db.id, Number((performance.now() - t0).toFixed(2)), false);
            throw err;
          }
        },
      }
    : baseHrana;
  const hostTemplate = d.config.gatewayHostTemplate ? parseHostTemplate(d.config.gatewayHostTemplate) : null;
  /** Database DTO plus its public gateway URL (null without a gateway). */
  const toDto = (r: DbRow): DatabaseDto => ({
    ...rowToDatabase(r),
    publicUrl: hostTemplate ? `https://${renderHost(hostTemplate, publicKeyFor(hostTemplate, r))}` : null,
  });

  // Request log — every API call leaves one line (method, path, status, ms).
  app.use("*", async (c, next) => {
    const t0 = Date.now();
    await next();
    console.log(`[api] ${c.req.method} ${c.req.path} -> ${c.res.status} (${Date.now() - t0}ms)`);
  });

  if (d.auth) installAuth(app, d.auth);
  else installCsrfOnly(app, d.auditRepo ?? null);

  // ---- system -------------------------------------------------------------
  // Note: dataRoot/sqldPath are deliberately NOT exposed over the API (an
  // operator reads them from boot logs / config; the API surface stays minimal).
  app.get("/api/system", (c) => {
    const sys: SystemInfo = {
      version: d.version,
      sqldVersion: d.sqldVersion,
      sqldOk: d.sqldOk,
      sqldReason: d.sqldOk ? null : `sqld binary not usable — run scripts/fetch-sqld.sh, then restart`,
      sqldBinarySha256: null,
      publicHost: d.config.publicHost,
      counts: { workspaces: d.workspaces.count, databases: d.databases.count },
    };
    return c.json(sys);
  });

  // ---- workspaces ---------------------------------------------------------
  app.get("/api/workspaces", (c) => c.json(d.workspaces.list().map(rowToWorkspace)));

  app.post("/api/workspaces", async (c) => {
    let body: CreateWorkspace;
    try {
      body = CreateWorkspaceSchema.parse(await c.req.json());
    } catch (err) {
      throw new ApiError(400, "bad_request", "invalid workspace payload", zodDetail(err));
    }
    const id = randomUUID();
    const row = d.workspaces.create({ id, slug: slugify(body.name), name: body.name, createdAt: Date.now() });
    return c.json(rowToWorkspace(row), 201);
  });

  app.patch("/api/workspaces/:id/protection", async (c) => {
    const ws = d.workspaces.getById(c.req.param("id"));
    if (!ws) throw new ApiError(404, "not_found", "workspace not found");
    let body: { protected: boolean };
    try {
      body = SetProtectionSchema.parse(await c.req.json());
    } catch (err) {
      throw new ApiError(400, "bad_request", "invalid protection payload", zodDetail(err));
    }
    d.workspaces.setProtected(ws.id, body.protected);
    return c.json(rowToWorkspace(d.workspaces.getById(ws.id)!));
  });

  app.delete("/api/workspaces/:id", async (c) => {
    const ws = d.workspaces.getById(c.req.param("id"));
    if (!ws) throw new ApiError(404, "not_found", "workspace not found");
    const dbs = d.databases.list({ workspaceId: ws.id, includeTrashed: true });
    if (dbs.length > 0) {
      throw new ApiError(409, "workspace_not_empty", "workspace still contains databases", dbs.map((x) => x.slug).join(", "));
    }
    if ((ws.protected ?? 1) === 1) {
      throw new ApiError(423, "protected", `workspace "${ws.slug}" has delete protection enabled — disable it in Settings first`);
    }
    let body: { confirm: string };
    try {
      body = ConfirmSlugDeleteSchema.parse(await c.req.json());
    } catch (err) {
      throw new ApiError(400, "bad_request", "delete confirmation payload required ({ confirm: \"<slug>\" })", zodDetail(err));
    }
    if (body.confirm !== ws.slug) {
      throw new ApiError(400, "confirm_mismatch", `confirmation string must exactly match workspace slug "${ws.slug}"`);
    }
    d.workspaces.delete(ws.id);
    return c.body(null, 204);
  });

  // ---- databases ----------------------------------------------------------
  app.get("/api/databases", (c) => {
    const wsId = c.req.query("workspaceId");
    const rows = d.databases.list(wsId ? { workspaceId: wsId } : {});
    return c.json(rows.map(toDto));
  });

  app.get("/api/databases/:id", (c) => c.json(toDto(requireDb(c.req.param("id")))));

  app.post("/api/workspaces/:id/databases", async (c) => {
    const ws = d.workspaces.getById(c.req.param("id"));
    if (!ws) throw new ApiError(404, "not_found", "workspace not found");
    if (!d.sqldOk) throw new ApiError(503, "sqld_unavailable", `sqld binary not usable — run scripts/fetch-sqld.sh`);

    let body: { name: string };
    try {
      body = CreateDatabaseSchema.parse(await c.req.json());
    } catch (err) {
      throw new ApiError(400, "bad_request", "invalid database payload", zodDetail(err));
    }

    const { row, pair } = await reserveDatabase(ws, body.name, { status: "starting", autoStart: 1 });
    const { id, data_dir: dataDir } = row;
    d.databases.updateRuntime(id, { port: pair.http, grpc_port: pair.grpc, status: "starting" });

    const started = await d.supervisor.startDatabase(id, {
      port: pair.http,
      grpcPort: pair.grpc,
      dataDir,
    });
    if (!started.ok) {
      // The row is persisted (status=failed + failed_reason) so the user can
      // retry `start`; the create itself failed: report 502, not 201, and carry
      // the sqld stderr tail so the failure is diagnosable from the client.
      const fresh = d.databases.getById(id);
      throw new ApiError(
        502,
        "start_failed",
        started.error ?? "sqld failed to become ready",
        fresh?.failed_reason ?? started.stderrTail,
      );
    }
    if (d.dns) await d.dns.sync(d.databases.getById(id)!);
    const fresh = d.databases.getById(id);
    return c.json(toDto(fresh!), 201);
  });

  app.post("/api/databases/:id/start", async (c) => {
    const row = requireDb(c.req.param("id"));
    if (!d.sqldOk) throw new ApiError(503, "sqld_unavailable", `sqld binary not usable — run scripts/fetch-sqld.sh`);
    if (!row.port || !row.grpc_port) throw new ApiError(409, "no_ports", "database has no allocated ports");
    if (row.status === "deleting") throw new ApiError(409, "deleting", "database is being deleted");
    assertNotRestoreTarget(row);
    const r = await d.supervisor.startDatabase(row.id, { port: row.port, grpcPort: row.grpc_port, dataDir: row.data_dir });
    if (!r.ok) {
      const fresh = d.databases.getById(row.id);
      throw new ApiError(502, "start_failed", r.error ?? "failed to start sqld", fresh?.failed_reason ?? r.stderrTail);
    }
    if (r.alreadyRunning) {
      throw new ApiError(409, "already_running", "database is already running");
    }
    return c.json(toDto(d.databases.getById(row.id)!));
  });

  app.post("/api/databases/:id/stop", async (c) => {
    const row = requireDb(c.req.param("id"));
    if (row.status === "deleting") throw new ApiError(409, "deleting", "database is being deleted");
    assertNotRestoreTarget(row);
    await d.supervisor.stopDatabase(row.id);
    return c.json(toDto(d.databases.getById(row.id)!));
  });

  app.patch("/api/databases/:id/protection", async (c) => {
    const row = requireDb(c.req.param("id"));
    let body: { protected: boolean };
    try {
      body = SetProtectionSchema.parse(await c.req.json());
    } catch (err) {
      throw new ApiError(400, "bad_request", "invalid protection payload", zodDetail(err));
    }
    d.databases.setProtected(row.id, body.protected);
    return c.json(toDto(d.databases.getById(row.id)!));
  });

  app.get("/api/databases/:id/delete-preview", async (c) => {
    const row = requireDb(c.req.param("id"));
    const diskBytes = dirBytes(row.data_dir);
    let tableCount = 0;
    let totalRows = 0;
    if (row.status === "running" && row.port) {
      try {
        const stats = await inspectDatabaseStorage(hrana, {
          id: row.id,
          slug: row.slug,
          port: row.port,
          dataDir: row.data_dir,
        });
        tableCount = stats.tableRowCounts.length;
        totalRows = stats.tableRowCounts.reduce((acc, t) => acc + t.count, 0);
      } catch {
        /* ignore if sqld isn't answering */
      }
    }
    const preview: DeletePreview = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      protected: (row.protected ?? 1) === 1,
      diskBytes,
      tableCount,
      totalRows,
      lastWriteAt: row.last_write_at ?? null,
    };
    return c.json(preview);
  });

  app.delete("/api/databases/:id", async (c) => {
    const row = requireDb(c.req.param("id"));
    if (d.restore?.isRestoring(row.id)) throw new ApiError(409, "restoring", "a restore into this database is still running");
    if (d.importer?.isImporting(row.id)) throw new ApiError(409, "importing", "an import into this database is still running");
    if ((row.protected ?? 1) === 1) {
      throw new ApiError(423, "protected", `database "${row.slug}" has delete protection enabled — disable it in Settings first`);
    }
    let body: { confirm: string };
    try {
      body = ConfirmSlugDeleteSchema.parse(await c.req.json());
    } catch (err) {
      throw new ApiError(400, "bad_request", "delete confirmation payload required ({ confirm: \"<slug>\" })", zodDetail(err));
    }
    if (body.confirm !== row.slug) {
      throw new ApiError(400, "confirm_mismatch", `confirmation string must exactly match database slug "${row.slug}"`);
    }

    d.databases.updateStatus(row.id, "deleting");
    // killByDbId is serialized per-dbId (an in-flight start completes first)
    // and covers ADOPTED processes — the process MUST be dead before the data
    // dir is moved to trash, or we move a database that is being written.
    await d.supervisor.killByDbId(row.id);
    // Flush + stop replication before moving files.
    await d.backup?.stop(row.id, { removeConfig: true });
    assertInside(d.config.dataRoot, row.data_dir);

    const trashedAt = Date.now();
    const trashRoot = path.join(d.config.dataRoot, "trash");
    const trashPath = path.join(trashRoot, `${row.id}-${trashedAt}`);
    assertInside(d.config.dataRoot, trashPath);
    await mkdir(trashRoot, { recursive: true, mode: 0o700 });

    if (existsSync(row.data_dir)) {
      await rename(row.data_dir, trashPath);
    } else {
      await mkdir(trashPath, { recursive: true, mode: 0o700 });
    }

    // Staging left by a restore/import interrupted by a crash.
    await rm(`${row.data_dir}.restore`, { recursive: true, force: true });
    await rm(`${row.data_dir}.import`, { recursive: true, force: true });

    // Remove now-empty parent directories (workspaces/<ws>/dbs, then the
    // workspace dir) — rmdir only deletes empty dirs, so a workspace with
    // other databases is preserved untouched.
    {
      const dataRoot = d.config.dataRoot;
      const dbsDir = path.dirname(row.data_dir);
      const wsDir = path.dirname(dbsDir);
      for (const dir of [dbsDir, wsDir]) {
        if (path.resolve(dir) === path.resolve(dataRoot)) break;
        try {
          await rmdir(dir);
        } catch {
          break;
        }
      }
    }

    if (d.dns) await d.dns.remove(row);
    if (row.port && row.grpc_port) d.supervisor.portAllocator.release({ http: row.port, grpc: row.grpc_port });
    d.databases.markTrashed(row.id, trashedAt, trashPath);
    return c.body(null, 204);
  });

  // ---- trash: list, restore, permanent purge ------------------------------
  app.get("/api/trash", (c) => {
    const retentionMs = d.config.trashDays * 86_400_000;
    const wsMap = new Map(d.workspaces.list().map((w) => [w.id, w.name]));
    const items: TrashItem[] = d.databases.listTrashed().map((r) => {
      const trashedAt = r.trashed_at ?? r.created_at;
      const diskBytes = r.trash_path ? dirBytes(r.trash_path) : 0;
      return {
        id: r.id,
        workspaceId: r.workspace_id,
        workspaceName: wsMap.get(r.workspace_id) ?? "Unknown",
        slug: r.slug,
        name: r.name,
        trashedAt,
        expiresAt: trashedAt + retentionMs,
        diskBytes,
      };
    });
    return c.json(items);
  });

  app.post("/api/trash/:id/restore", async (c) => {
    const row = d.databases.getById(c.req.param("id"));
    if (!row || row.status !== "trashed" || !row.trash_path) {
      throw new ApiError(404, "not_found", "trashed database not found");
    }
    assertInside(d.config.dataRoot, row.trash_path);
    assertInside(d.config.dataRoot, row.data_dir);

    const pair = await d.supervisor.portAllocator.allocatePair();
    try {
      await mkdir(path.dirname(row.data_dir), { recursive: true, mode: 0o700 });
      if (existsSync(row.trash_path)) {
        await rename(row.trash_path, row.data_dir);
      } else {
        await mkdir(row.data_dir, { recursive: true, mode: 0o700 });
      }
      d.databases.markRestoredFromTrash(row.id, pair.http, pair.grpc);
    } catch (err) {
      d.supervisor.portAllocator.release(pair);
      throw err;
    }

    if (row.auto_start === 1 && d.sqldOk) {
      await d.supervisor.startDatabase(row.id, {
        port: pair.http,
        grpcPort: pair.grpc,
        dataDir: row.data_dir,
      });
    }
    if (d.dns) await d.dns.sync(d.databases.getById(row.id)!);
    return c.json(toDto(d.databases.getById(row.id)!));
  });

  app.delete("/api/trash/:id", async (c) => {
    const row = d.databases.getById(c.req.param("id"));
    if (!row || row.status !== "trashed") {
      throw new ApiError(404, "not_found", "trashed database not found");
    }
    let body: { confirm: string };
    try {
      body = ConfirmSlugDeleteSchema.parse(await c.req.json());
    } catch (err) {
      throw new ApiError(400, "bad_request", "delete confirmation payload required ({ confirm: \"<slug>\" })", zodDetail(err));
    }
    if (body.confirm !== row.slug) {
      throw new ApiError(400, "confirm_mismatch", `confirmation string must exactly match database slug "${row.slug}"`);
    }

    await purgeTrashedDatabase(d.config.dataRoot, d.databases, row);
    return c.body(null, 204);
  });

  app.get("/api/databases/:id/connection", (c) => {
    const row = requireDb(c.req.param("id"));
    if (!row.port || !row.grpc_port) throw new ApiError(409, "not_ready", "database has no allocated endpoints yet");
    const conn: Connection = {
      httpUrl: `http://${d.config.publicHost}:${row.port}`,
      hranaUrl: `ws://${d.config.publicHost}:${row.port}`,
      grpcUrl: `http://${d.config.publicHost}:${row.grpc_port}`,
      publicUrl: toDto(row).publicUrl,
      dbName: row.slug,
    };
    return c.json(conn);
  });

  // ---- db client: schema, sql query, table rows ---------------------------
  app.get("/api/databases/:id/schema", async (c) => {
    const row = requireRunningDb(c.req.param("id"));
    const schema = await inspectDatabaseSchema(hrana, { id: row.id, slug: row.slug, port: row.port! });
    return c.json(schema);
  });

  app.post("/api/databases/:id/query", async (c) => {
    const row = requireRunningDb(c.req.param("id"));
    let body: QueryRequest;
    try {
      body = QueryRequestSchema.parse(await c.req.json());
    } catch (err) {
      throw new ApiError(400, "bad_request", "invalid query payload", zodDetail(err));
    }
    const res = await runSqlQuery(hrana, { id: row.id, slug: row.slug, port: row.port! }, body);
    if (!body.readOnly && res.results.some((r) => r.rowsAffected > 0)) {
      d.databases.touchLastWrite(row.id);
    }
    return c.json(res);
  });

  app.get("/api/databases/:id/tables/:table/rows", async (c) => {
    const row = requireRunningDb(c.req.param("id"));
    const table = c.req.param("table");
    const rawLimit = c.req.query("limit");
    const rawOffset = c.req.query("offset");
    const sort = c.req.query("sort") || undefined;
    const rawDir = c.req.query("dir");
    const rawFilters = c.req.query("filters");

    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new ApiError(400, "bad_request", "limit must be an integer between 1 and 1000");
    }
    const offset = rawOffset === undefined ? 0 : Number(rawOffset);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ApiError(400, "bad_request", "offset must be a non-negative integer");
    }
    if (rawDir !== undefined && rawDir !== "asc" && rawDir !== "desc") {
      throw new ApiError(400, "bad_request", "dir must be asc or desc");
    }

    let filters: TableFilter[] = [];
    if (rawFilters) {
      try {
        const parsed = JSON.parse(rawFilters);
        filters = z.array(TableFilterSchema).max(50).parse(parsed);
      } catch (err) {
        throw new ApiError(400, "bad_request", "invalid filters query parameter", zodDetail(err));
      }
    }

    const res = await browseTableRows(hrana, { id: row.id, slug: row.slug, port: row.port! }, table, {
      limit,
      offset,
      sort,
      dir: rawDir as "asc" | "desc" | undefined,
      filters,
    });
    return c.json(res);
  });

  app.post("/api/databases/:id/tables/:table/rows", async (c) => {
    const row = requireRunningDb(c.req.param("id"));
    const table = c.req.param("table");
    let body: InsertRowsRequest;
    try {
      body = InsertRowsRequestSchema.parse(await c.req.json());
    } catch (err) {
      throw new ApiError(400, "bad_request", "invalid insert rows payload", zodDetail(err));
    }
    const res = await insertTableRows(hrana, { id: row.id, slug: row.slug, port: row.port! }, table, body);
    if (res.affected > 0) d.databases.touchLastWrite(row.id);
    return c.json(res, 201);
  });

  app.patch("/api/databases/:id/tables/:table/rows", async (c) => {
    const row = requireRunningDb(c.req.param("id"));
    const table = c.req.param("table");
    let body: UpdateRowsRequest;
    try {
      body = UpdateRowsRequestSchema.parse(await c.req.json());
    } catch (err) {
      throw new ApiError(400, "bad_request", "invalid update rows payload", zodDetail(err));
    }
    const res = await updateTableRows(hrana, { id: row.id, slug: row.slug, port: row.port! }, table, body);
    if (res.affected > 0) d.databases.touchLastWrite(row.id);
    return c.json(res);
  });

  app.delete("/api/databases/:id/tables/:table/rows", async (c) => {
    const row = requireRunningDb(c.req.param("id"));
    const table = c.req.param("table");
    let body: DeleteRowsRequest;
    try {
      body = DeleteRowsRequestSchema.parse(await c.req.json());
    } catch (err) {
      throw new ApiError(400, "bad_request", "invalid delete rows payload", zodDetail(err));
    }
    const res = await deleteTableRows(hrana, { id: row.id, slug: row.slug, port: row.port! }, table, body);
    if (res.affected > 0) d.databases.touchLastWrite(row.id);
    return c.json(res);
  });

  // ---- backups ------------------------------------------------------------
  const backupStatus = (id: string): BackupStatus => {
    if (!d.backup) {
      return { enabled: false, state: "disabled", replicaUrl: null, txidDb: null, txidReplica: null, lastSyncAt: null,
        lastSnapshotAt: null, behindSince: null, lastError: null, lastErrorAt: null, restarts: 0, verify: null };
    }
    const { pid: _pid, ...s } = d.backup.status(id);
    return { enabled: true, ...s, verify: verifyStatus(id) };
  };

  const verifyStatus = (id: string): BackupStatus["verify"] => {
    if (!d.verify) return null;
    const row = d.databases.getById(id);
    const latest = d.verify.results.latest(id);
    const ok = d.verify.results.latestOk(id);
    return {
      health: verifyHealth(latest, ok, Math.max(row?.created_at ?? 0, d.verify.startedAt ?? 0), Date.now(), d.verify.maxAgeMs),
      lastAt: latest?.finished_at ?? null,
      lastOutcome: latest?.outcome ?? null,
      lastDetail: latest?.detail ?? null,
      lastOkAt: ok?.finished_at ?? null,
      restoredBytes: latest?.restored_bytes ?? null,
    };
  };

  // Restore-verify one database now (waits for the result).
  app.post("/api/databases/:id/backup/verify", async (c) => {
    const row = requireDb(c.req.param("id"));
    if (!d.verify) throw new ApiError(409, "backup_disabled", "backups are not configured");
    if (row.status !== "running") throw new ApiError(409, "not_running", "only running databases are verified");
    await d.verify.service.verifyOneQueued(row);
    return c.json(backupStatus(row.id));
  });

  // Restore-verify every running database in the background.
  app.post("/api/backups/verify", (c) => {
    if (!d.verify) throw new ApiError(409, "backup_disabled", "backups are not configured");
    const alreadyRunning = d.verify.service.busy;
    void d.verify.service.runAll("manual");
    return c.json({ started: !alreadyRunning, alreadyRunning }, 202);
  });

  // Encrypted control-plane backup (metadata + signing keys).
  app.get("/api/backups/control", (c) =>
    c.json(d.control ? d.control.status() : { enabled: false, lastAt: null, lastOkAt: null, lastKey: null, lastError: null, lastErrorAt: null }),
  );
  app.post("/api/backups/control", async (c) => {
    if (!d.control) throw new ApiError(409, "control_backup_disabled", "set SQLITEND_CONTROL_BACKUP_KEY to enable control-plane backups");
    try {
      await d.control.runNow();
    } catch (err) {
      throw new ApiError(502, "control_backup_failed", "control-plane backup failed", (err as Error).message.slice(0, 300));
    }
    return c.json(d.control.status());
  });

  app.get("/api/databases/:id/backup/verifications", (c) => {
    const row = requireDb(c.req.param("id"));
    return c.json(d.verify ? d.verify.results.history(row.id) : []);
  });

  // Replicas under this server's prefix, deleted databases included.
  app.get("/api/backups/replicas", async (c) => {
    if (!d.restore) throw new ApiError(409, "backup_disabled", "backups are not configured");
    try {
      return c.json(await d.restore.listReplicas());
    } catch (err) {
      throw new ApiError(502, "backup_store_error", "could not list replicas", (err as Error).message.slice(0, 300));
    }
  });

  // Restore replica :id (an existing or deleted database) AS A NEW database.
  app.post("/api/backups/:id/restore", async (c) => {
    if (!d.restore) throw new ApiError(409, "backup_disabled", "backups are not configured");
    if (!d.sqldOk) throw new ApiError(503, "sqld_unavailable", "sqld binary not usable — run scripts/fetch-sqld.sh");
    const sourceId = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/.test(sourceId)) throw new ApiError(400, "bad_request", "invalid replica id");
    let body: RestoreRequest;
    try {
      body = RestoreRequestSchema.parse(await c.req.json());
    } catch (err) {
      throw new ApiError(400, "bad_request", "invalid restore payload", zodDetail(err));
    }
    const ws = d.workspaces.getById(body.workspaceId);
    if (!ws) throw new ApiError(404, "not_found", "workspace not found");
    const { row } = await reserveDatabase(ws, body.name, { status: "restoring", autoStart: 0 });
    d.restore.start(sourceId, row, body.at ? new Date(body.at).toISOString().replace(/\.\d{3}Z$/, "Z") : undefined);
    return c.json(toDto(row), 202);
  });

  // ---- import ---------------------------------------------------------------
  app.get("/api/imports", (c) => {
    if (!d.importer) throw new ApiError(409, "import_disabled", "import is not available");
    return c.json({ dir: d.importer.dir, files: d.importer.list() });
  });

  app.post("/api/workspaces/:id/databases/import", async (c) => {
    if (!d.importer) throw new ApiError(409, "import_disabled", "import is not available");
    const ws = d.workspaces.getById(c.req.param("id"));
    if (!ws) throw new ApiError(404, "not_found", "workspace not found");
    if (!d.sqldOk) throw new ApiError(503, "sqld_unavailable", `sqld binary not usable — run scripts/fetch-sqld.sh`);
    let body: ImportRequest;
    try {
      body = ImportRequestSchema.parse(await c.req.json());
    } catch (err) {
      throw new ApiError(400, "bad_request", "invalid import payload", zodDetail(err));
    }
    const src = d.importer.resolve(body.file);
    if ("error" in src) throw new ApiError(400, "bad_file", src.error);
    const { row } = await reserveDatabase(ws, body.name, { status: "restoring", autoStart: 0 });
    d.importer.start(src.path, row);
    return c.json(toDto(row), 202);
  });

  app.get("/api/databases/:id/backup", (c) => c.json(backupStatus(requireDb(c.req.param("id")).id)));

  app.get("/api/backups", (c) =>
    c.json(d.databases.list().map((r) => ({ databaseId: r.id, slug: r.slug, ...backupStatus(r.id) }))),
  );

  // ---- dns ----------------------------------------------------------------
  app.post("/api/databases/:id/dns/sync", async (c) => {
    const row = requireDb(c.req.param("id"));
    if (!d.dns) throw new ApiError(409, "dns_disabled", "Cloudflare DNS automation is not configured");
    await d.dns.sync(row);
    return c.json(toDto(d.databases.getById(row.id)!));
  });

  // ---- tokens -------------------------------------------------------------
  app.get("/api/databases/:id/tokens", (c) => {
    const row = requireDb(c.req.param("id"));
    return c.json(d.tokens.listByDatabase(row.id).map(rowToToken));
  });

  app.post("/api/databases/:id/tokens", async (c) => {
    const row = requireDb(c.req.param("id"));
    // STRICT parse — a malformed scope or TTL must be a 400, never a silent
    // fallback to defaults (the old catch-all granted `full` for any parse
    // failure, silently upgrading an intended read-only request).
    let body: { scope?: "full"; name?: string; expiresInHours?: number };
    try {
      body = CreateTokenSchema.parse(await c.req.json());
    } catch (err) {
      throw new ApiError(400, "bad_request", "invalid token payload", zodDetail(err));
    }
    const issued = await mintToken({ dataRoot: d.config.dataRoot, dbSlug: row.slug, dbId: row.id, scope: body.scope ?? "full", expiresInHours: body.expiresInHours, name: body.name ?? null }, d.config.tokenTtlHours);
    d.tokens.create({
      jti: issued.jti,
      databaseId: row.id,
      scope: issued.scope,
      createdAt: issued.createdAt,
      expiresAt: issued.expiresAt,
      name: issued.name,
      token: issued.token,
    });
    return c.json(issued, 201);
  });

  // Show a stored token again (POST so it passes the CSRF gate and is audited).
  app.post("/api/databases/:id/tokens/:jti/reveal", (c) => {
    const row = requireDb(c.req.param("id"));
    const tok = d.tokens.getByJti(c.req.param("jti"));
    if (!tok || tok.database_id !== row.id) throw new ApiError(404, "not_found", "token not found");
    if (tok.revoked_at) throw new ApiError(409, "revoked", "this token is revoked");
    const value = d.tokens.valueOf(tok.jti);
    if (!value) throw new ApiError(409, "not_stored", "this token was issued before tokens were stored — rotate it to get one you can copy");
    return c.json({ jti: tok.jti, token: value });
  });

  // Revocation is enforced by the gateway: sqld validates JWTs statelessly and
  // cannot revoke, so direct sqld ports keep accepting a revoked token until it
  // expires (bind SQLITEND_HOST=127.0.0.1 so only the gateway is reachable).
  app.delete("/api/databases/:id/tokens/:jti", (c) => {
    const row = requireDb(c.req.param("id"));
    const tok = d.tokens.getByJti(c.req.param("jti"));
    if (!tok || tok.database_id !== row.id) throw new ApiError(404, "not_found", "token not found");
    d.tokens.revoke(tok.jti, Date.now());
    return c.json(rowToToken(d.tokens.getByJti(tok.jti)!));
  });

  // Tokens needing attention across all databases: non-revoked, expiring
  // within `withinDays` (default 14) or expired within the last
  // `expiredWithinDays` (default 7, so old expiries stop alerting). For alerts.
  app.get("/api/tokens/expiring", (c) => {
    const days = (name: string, fallback: number) => {
      const raw = c.req.query(name);
      const n = raw === undefined ? fallback : Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 3650) {
        throw new ApiError(400, "bad_request", `${name} must be an integer between 0 and 3650`);
      }
      return n;
    };
    const ahead = days("withinDays", 14);
    const back = days("expiredWithinDays", 7);
    const now = Date.now();
    return c.json(
      d.tokens.listExpiringBetween(now - back * 86_400_000, now + ahead * 86_400_000).map((r) => ({
        ...rowToToken(r),
        dbSlug: r.db_slug,
        expired: r.expires_at <= now,
      })),
    );
  });

  // ---- metrics ------------------------------------------------------------
  app.get("/api/databases/:id/metrics", (c) => {
    const row = requireDb(c.req.param("id"));
    let sample = d.sampler.latestFor(row.id);
    if (!sample) {
      sample = d.sampler.sampleOne({ dbId: row.id, pid: row.pid, startTimeMs: row.start_time, dataDir: row.data_dir, status: row.status });
      d.sampler.set(row.id, sample);
    }
    return c.json(sampleDto(sample));
  });

  app.get("/api/databases/:id/metrics/history", (c) => {
    const row = requireDb(c.req.param("id"));
    const rawRange = c.req.query("range") ?? "1h";
    let range: MetricsRange;
    try {
      range = MetricsRangeSchema.parse(rawRange);
    } catch {
      throw new ApiError(400, "bad_request", "range must be 1h, 24h, or 7d");
    }

    const now = Date.now();
    const windowMs = range === "1h" ? 3_600_000 : range === "24h" ? 86_400_000 : 7 * 86_400_000;
    const sinceMs = now - windowMs;

    const latest = d.sampler.latestFor(row.id) ?? d.sampler.sampleOne({
      dbId: row.id,
      pid: row.pid,
      startTimeMs: row.start_time,
      dataDir: row.data_dir,
      status: row.status,
    });
    d.sampler.set(row.id, latest);

    const rows: MetricsHistoryRow[] = d.metricsRepo
      ? d.metricsRepo.listSince(row.id, sinceMs, 360)
      : [];

    const points: MetricsHistoryPoint[] =
      rows.length > 0
        ? rows.map((r) => ({
            t: r.sampled_at,
            status: coerceStatus(r.status),
            cpuPct: r.cpu_pct,
            memoryBytes: r.memory_bytes,
            diskBytes: r.disk_bytes,
            walBytes: r.wal_bytes,
            queryCount: r.query_count,
            queryErrors: r.query_errors,
            p50Ms: r.p50_ms,
            p95Ms: r.p95_ms,
            p99Ms: r.p99_ms,
          }))
        : [
            {
              t: latest.sampledAt,
              status: coerceStatus(latest.status),
              cpuPct: latest.cpuPct,
              memoryBytes: latest.memoryBytes,
              diskBytes: latest.diskBytes,
              walBytes: latest.walBytes ?? 0,
              queryCount: 0,
              queryErrors: 0,
              p50Ms: null,
              p95Ms: null,
              p99Ms: null,
            },
          ];

    const diskGrowthBytesPerHour = computeDiskGrowthPerHour(points);
    const stability = buildStabilityBadge(row, d.metricsRepo ?? null, now);
    const latency = d.sampler.getQueryStats(row.id);

    const res: MetricsHistoryResponse = {
      range,
      points,
      diskGrowthBytesPerHour,
      stability,
      latency,
    };
    return c.json(res);
  });

  app.get("/api/databases/:id/storage", async (c) => {
    const row = requireRunningDb(c.req.param("id"));
    const stats = await inspectDatabaseStorage(hrana, {
      id: row.id,
      slug: row.slug,
      port: row.port!,
      dataDir: row.data_dir,
    });
    return c.json(stats);
  });

  app.get("/api/metrics/overview", (c) => {
    const now = Date.now();
    const since1h = now - 3_600_000;
    const allDbs = d.databases.list();

    let runningDbs = 0;
    let stoppedDbs = 0;
    let crashedOrFailedDbs = 0;
    let totalDiskBytes = 0;
    let totalWalBytes = 0;
    let totalMemoryBytes = 0;
    let totalQueries = 0;
    let totalErrors = 0;

    const summaries: Record<string, DatabaseMetricsSummary> = {};

    for (const row of allDbs) {
      if (row.status === "running") runningDbs++;
      else if (row.status === "stopped") stoppedDbs++;
      else if (row.status === "crashed" || row.status === "failed") crashedOrFailedDbs++;

      const latest = d.sampler.latestFor(row.id) ?? d.sampler.sampleOne({
        dbId: row.id,
        pid: row.pid,
        startTimeMs: row.start_time,
        dataDir: row.data_dir,
        status: row.status,
      });
      d.sampler.set(row.id, latest);

      const walBytes = latest.walBytes ?? 0;
      totalDiskBytes += latest.diskBytes;
      totalWalBytes += walBytes;
      totalMemoryBytes += latest.memoryBytes;

      const latency = d.sampler.getQueryStats(row.id);
      totalQueries += latency.totalQueries;
      totalErrors += latency.totalErrors;

      const histRows = d.metricsRepo ? d.metricsRepo.listSince(row.id, since1h, 40) : [];
      const points: MetricsHistoryPoint[] =
        histRows.length > 0
          ? histRows.map((r) => ({
              t: r.sampled_at,
              status: coerceStatus(r.status),
              cpuPct: r.cpu_pct,
              memoryBytes: r.memory_bytes,
              diskBytes: r.disk_bytes,
              walBytes: r.wal_bytes,
              queryCount: r.query_count,
              queryErrors: r.query_errors,
              p50Ms: r.p50_ms,
              p95Ms: r.p95_ms,
              p99Ms: r.p99_ms,
            }))
          : [
              {
                t: latest.sampledAt,
                status: coerceStatus(latest.status),
                cpuPct: latest.cpuPct,
                memoryBytes: latest.memoryBytes,
                diskBytes: latest.diskBytes,
                walBytes,
                queryCount: 0,
                queryErrors: 0,
                p50Ms: latency.p50Ms,
                p95Ms: latency.p95Ms,
                p99Ms: latency.p99Ms,
              },
            ];

      summaries[row.id] = {
        databaseId: row.id,
        stability: buildStabilityBadge(row, d.metricsRepo ?? null, now),
        walBytes,
        diskGrowthBytesPerHour: computeDiskGrowthPerHour(points),
        latency,
        sparkline: {
          t: points.map((p) => p.t),
          cpuPct: points.map((p) => p.cpuPct),
          memoryBytes: points.map((p) => p.memoryBytes),
          p95Ms: points.map((p) => p.p95Ms),
        },
      };
    }

    const overview: MetricsOverviewResponse = {
      totals: {
        runningDbs,
        stoppedDbs,
        crashedOrFailedDbs,
        totalDiskBytes,
        totalWalBytes,
        totalMemoryBytes,
        totalQueries,
        totalErrors,
      },
      databases: summaries,
    };
    return c.json(overview);
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.body(), err.status as ContentfulStatusCode);
    if (err instanceof PortExhaustedError) {
      return c.json(
        {
          error: {
            code: "port_exhausted",
            message: err.message,
            detail: "widen SQLITEND_PORT_RANGE (start-end) or free ports in the range, then retry",
          },
        } satisfies ErrorBody,
        503,
      );
    }
    // Never leak internals (fs paths, sqld output, stack traces) to clients —
    // log the full error server-side instead.
    console.error(`[error] ${c.req.method} ${c.req.path}:`, err);
    return c.json({ error: { code: "internal", message: "internal error" } } satisfies ErrorBody, 500);
  });

  return app;

  /** Validate name → slug, allocate the port pair and insert the row. Shared
   *  by create and restore so both enforce the same slug/hostname rules. */
  async function reserveDatabase(
    ws: { id: string; slug: string },
    name: string,
    o: { status: DatabaseStatus; autoStart: 0 | 1 },
  ): Promise<{ row: DbRow; pair: { http: number; grpc: number } }> {
    const id = randomUUID();
    // Reserve the explicit http+grpc pair before creating the row/spawning.
    const pair = await d.supervisor.portAllocator.allocatePair();
    try {
      for (let attempt = 0; ; attempt++) {
        const slug = randomDbSlug();
        try {
          const row = d.databases.create({
            id,
            workspace_id: ws.id,
            slug,
            name,
            status: o.status,
            data_dir: path.join(d.config.dataRoot, "workspaces", ws.slug, "dbs", slug),
            auth_key: dbKeyRelPath(id), // documentation of the per-DB pub-file location
            auto_start: o.autoStart,
            created_at: Date.now(),
          });
          d.databases.updateRuntime(id, { port: pair.http, grpc_port: pair.grpc });
          return { row: d.databases.getById(id)!, pair };
        } catch (err) {
          // A random-slug collision (~1 in 2^62) just draws again.
          if (err instanceof SlugExistsError && attempt < 5) continue;
          throw err;
        }
      }
    } catch (err) {
      // The pair was reserved but no row will ever own it — release or the
      // pool permanently shrinks by two ports per collision.
      d.supervisor.portAllocator.release(pair);
      if (err instanceof NameExistsError) {
        throw new ApiError(409, "name_conflict", `a database named "${name}" already exists in this workspace`);
      }
      throw err;
    }
  }

  /** A restore target must never be started/stopped by hand: while restoring it
   *  has no data file yet, and a failed restore has none either — starting it
   *  would publish (and replicate) an empty database under the restored name. */
  function assertNotRestoreTarget(row: DbRow): void {
    if (row.status === "restoring" || d.restore?.isRestoring(row.id) || d.importer?.isImporting(row.id)) {
      throw new ApiError(409, "restoring", "a restore or import into this database is still running");
    }
    if ((row.failed_reason ?? "").startsWith("restore pending")) {
      throw new ApiError(409, "restore_pending", "data not restored yet — run `sqlitend restore-data` with the server stopped");
    }
    if (row.status === "failed" && (row.failed_reason ?? "").startsWith("restore")) {
      throw new ApiError(409, "restore_failed", "this database is a failed restore target — delete it and restore again");
    }
    if (row.status === "failed" && (row.failed_reason ?? "").startsWith("import")) {
      throw new ApiError(409, "import_failed", "this database is a failed import target — delete it and import again");
    }
  }

  function requireDb(id: string): DbRow {
    const row = d.databases.getById(id);
    if (!row || row.status === "trashed") throw new ApiError(404, "not_found", "database not found");
    return row;
  }

  function requireRunningDb(id: string): DbRow {
    const row = requireDb(id);
    if (row.status !== "running" || !row.port) {
      throw new ApiError(409, "not_running", `database is ${row.status} — start it to inspect schema or run queries`);
    }
    return row;
  }
}

export async function purgeTrashedDatabase(
  dataRoot: string,
  databases: DatabasesRepo,
  row: DbRow,
): Promise<void> {
  if (row.trash_path) {
    assertInside(dataRoot, row.trash_path);
    await rm(row.trash_path, { recursive: true, force: true });
  }
  const keyRel = dbKeyRelPath(row.id).replace(/\.pub$/, ".key");
  const pubRel = dbKeyRelPath(row.id);
  assertInside(dataRoot, path.join(dataRoot, keyRel));
  await rm(path.join(dataRoot, keyRel), { force: true });
  await rm(path.join(dataRoot, pubRel), { force: true });
  databases.delete(row.id);
}

export async function sweepExpiredTrash(
  dataRoot: string,
  databases: DatabasesRepo,
  trashDays: number,
  now = Date.now(),
): Promise<number> {
  const cutoff = now - trashDays * 86_400_000;
  let purged = 0;
  for (const row of databases.listTrashed()) {
    const trashedAt = row.trashed_at ?? row.created_at;
    if (trashedAt <= cutoff) {
      await purgeTrashedDatabase(dataRoot, databases, row);
      purged++;
    }
  }
  return purged;
}

function sampleDto(s: { cpuPct: number | null; memoryBytes: number; diskBytes: number; uptimeSec: number; status: string; sampledAt: number }): Metrics {
  return {
    cpuPct: s.cpuPct,
    memoryBytes: s.memoryBytes,
    diskBytes: s.diskBytes,
    uptimeSec: s.uptimeSec,
    status: coerceStatus(s.status),
    sampledAt: s.sampledAt,
  };
}

export function computeDiskGrowthPerHour(points: { t: number; diskBytes: number }[]): number | null {
  if (points.length < 2) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const dtHours = (last.t - first.t) / 3_600_000;
  if (dtHours <= 0.001) return null;
  return Math.round((last.diskBytes - first.diskBytes) / dtHours);
}

export function buildStabilityBadge(
  row: DbRow,
  metricsRepo: MetricsRepo | null,
  now = Date.now(),
): StabilityBadge {
  const since24h = now - 86_400_000;
  const crashes24h = metricsRepo ? metricsRepo.countCrashesSince(row.id, since24h) : 0;
  const availabilityPct24h = metricsRepo
    ? metricsRepo.availabilitySince(row.id, since24h, row.status)
    : row.status === "running" || row.status === "stopped"
      ? 100
      : 0;
  const totalCrashes = row.crash_count ?? 0;
  const restartCount = row.restart_count ?? 0;
  const lastCrashAt = row.last_crash_at ?? null;
  const lastCrashReason = row.last_crash_reason ?? null;

  if (row.status === "crashed" || row.status === "failed" || crashes24h >= 2 || availabilityPct24h < 95) {
    return {
      level: "degraded",
      label: "Degraded",
      rule: "Process is crashed/failed, >= 2 crashes in 24h, or < 95% 24h availability",
      availabilityPct24h,
      crashes24h,
      totalCrashes,
      restartCount,
      lastCrashAt,
      lastCrashReason,
    };
  }

  if (row.status === "stopped") {
    return {
      level: "stopped",
      label: "Stopped",
      rule: "Database is intentionally stopped",
      availabilityPct24h,
      crashes24h,
      totalCrashes,
      restartCount,
      lastCrashAt,
      lastCrashReason,
    };
  }

  if (crashes24h === 1 || availabilityPct24h < 99.9) {
    return {
      level: "warning",
      label: "Warning",
      rule: "1 crash in last 24h or 24h availability between 95% and 99.9%",
      availabilityPct24h,
      crashes24h,
      totalCrashes,
      restartCount,
      lastCrashAt,
      lastCrashReason,
    };
  }

  return {
    level: "healthy",
    label: "Healthy",
    rule: "0 crashes in 24h and >= 99.9% availability",
    availabilityPct24h,
    crashes24h,
    totalCrashes,
    restartCount,
    lastCrashAt,
    lastCrashReason,
  };
}
