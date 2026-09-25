import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { rm, rmdir } from "node:fs/promises";
import { ZodError } from "zod";
import {
  CreateDatabaseSchema,
  CreateTokenSchema,
  CreateWorkspaceSchema,
  DatabaseSchema,
  type CreateWorkspace,
  type DatabaseStatus,
  type Database as DatabaseDto,
  type Connection,
  type ErrorBody,
  type Metrics,
  type SystemInfo,
  type Workspace,
} from "@sqlitend/shared";
import type { Config } from "../config.ts";
import type { WorkspacesRepo } from "../db/repos/workspaces.ts";
import type { DatabasesRepo, DatabaseRow as DbRow } from "../db/repos/databases.ts";
import { SlugExistsError } from "../db/repos/databases.ts";
import type { TokenRow, TokensRepo } from "../db/repos/tokens.ts";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Supervisor } from "../supervisor/supervisor.ts";
import type { Sampler } from "../metrics/sampler.ts";
import { PortExhaustedError } from "../supervisor/ports.ts";
import { mintToken, dbKeyRelPath } from "../auth/tokens.ts";
import { assertInside } from "../util/paths.ts";
import type { DnsManager } from "../dns/manager.ts";
import type { Replicator } from "../backup/replicator.ts";
import type { BackupStatus } from "@sqlitend/shared";
import { installAuth, type AppEnv, type AuthDeps } from "./auth-routes.ts";
import { maxSlugLength, parseHostTemplate, publicKeyFor, renderHost } from "../gateway/gateway.ts";

// ---------------------------------------------------------------------------
// DTO mappers (snake_case rows -> camelCase shared DTOs)
// ---------------------------------------------------------------------------
type WorkspaceRow = { id: string; slug: string; name: string; created_at: number };
function rowToWorkspace(r: WorkspaceRow): Workspace {
  return { id: r.id, slug: r.slug, name: r.name, createdAt: r.created_at };
}

/** Read-safe status coercion: a corrupt `status` value in metadata must not
 *  500 the whole list/metrics endpoints — it is served as `unknown` instead
 *  (never written back; the supervisor only persists the six real states). */
function coerceStatus(raw: string): DatabaseStatus {
  const result = DatabaseSchema.shape.status.safeParse(raw);
  return result.success ? result.data : "unknown";
}

function rowToDatabase(r: DbRow): DatabaseDto {
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
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export class ApiError extends Error {
  status: number;
  code: string;
  detail?: string;
  constructor(status: number, code: string, message: string, detail?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
  body(): ErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) } };
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
  /** Control-plane login; absent only with SQLITEND_AUTH=off (loopback dev). */
  auth?: AuthDeps | null;
}

export function createRoutes(d: RoutesDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const hostTemplate = d.config.gatewayHostTemplate ? parseHostTemplate(d.config.gatewayHostTemplate) : null;

  // Request log — every API call leaves one line (method, path, status, ms).
  app.use("*", async (c, next) => {
    const t0 = Date.now();
    await next();
    console.log(`[api] ${c.req.method} ${c.req.path} -> ${c.res.status} (${Date.now() - t0}ms)`);
  });

  if (d.auth) installAuth(app, d.auth);

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

  app.delete("/api/workspaces/:id", (c) => {
    const ws = d.workspaces.getById(c.req.param("id"));
    if (!ws) throw new ApiError(404, "not_found", "workspace not found");
    const dbs = d.databases.list({ workspaceId: ws.id });
    if (dbs.length > 0) {
      throw new ApiError(409, "workspace_not_empty", "workspace still contains databases", dbs.map((x) => x.slug).join(", "));
    }
    d.workspaces.delete(ws.id);
    return c.body(null, 204);
  });

  // ---- databases ----------------------------------------------------------
  app.get("/api/databases", (c) => {
    const wsId = c.req.query("workspaceId");
    const rows = d.databases.list(wsId ? { workspaceId: wsId } : {});
    return c.json(rows.map(rowToDatabase));
  });

  app.get("/api/databases/:id", (c) => c.json(rowToDatabase(requireDb(c.req.param("id")))));

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

    const slug = slugify(body.name);
    if (hostTemplate && slug.length > maxSlugLength(hostTemplate)) {
      throw new ApiError(
        400,
        "name_too_long",
        `name is too long for a public hostname: slug "${slug}" exceeds ${maxSlugLength(hostTemplate)} characters`,
      );
    }
    const id = randomUUID();
    const dataDir = path.join(d.config.dataRoot, "workspaces", ws.slug, "dbs", slug);

    // Reserve the explicit http+grpc pair before creating the row/spawning.
    const pair = await d.supervisor.portAllocator.allocatePair();

    let row: DbRow;
    try {
      row = d.databases.create({
        id,
        workspace_id: ws.id,
        slug,
        name: body.name,
        status: "starting",
        data_dir: dataDir,
        auth_key: dbKeyRelPath(id), // documentation of the per-DB pub-file location
        auto_start: 1,
        created_at: Date.now(),
      });
    } catch (err) {
      // The pair was reserved but no row will ever own it — release or the
      // pool permanently shrinks by two ports per collision.
      d.supervisor.portAllocator.release(pair);
      if (err instanceof SlugExistsError) {
        // Slugs are globally UNIQUE (across workspaces) — say so explicitly.
        throw new ApiError(
          409,
          "slug_conflict",
          `a database with slug "${slug}" already exists (slugs are global across workspaces)`,
        );
      }
      throw err;
    }
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
    return c.json(rowToDatabase(fresh!), 201);
  });

  app.post("/api/databases/:id/start", async (c) => {
    const row = requireDb(c.req.param("id"));
    if (!d.sqldOk) throw new ApiError(503, "sqld_unavailable", `sqld binary not usable — run scripts/fetch-sqld.sh`);
    if (!row.port || !row.grpc_port) throw new ApiError(409, "no_ports", "database has no allocated ports");
    if (row.status === "deleting") throw new ApiError(409, "deleting", "database is being deleted");
    const r = await d.supervisor.startDatabase(row.id, { port: row.port, grpcPort: row.grpc_port, dataDir: row.data_dir });
    if (!r.ok) {
      const fresh = d.databases.getById(row.id);
      throw new ApiError(502, "start_failed", r.error ?? "failed to start sqld", fresh?.failed_reason ?? r.stderrTail);
    }
    if (r.alreadyRunning) {
      throw new ApiError(409, "already_running", "database is already running");
    }
    return c.json(rowToDatabase(d.databases.getById(row.id)!));
  });

  app.post("/api/databases/:id/stop", async (c) => {
    const row = requireDb(c.req.param("id"));
    if (row.status === "deleting") throw new ApiError(409, "deleting", "database is being deleted");
    await d.supervisor.stopDatabase(row.id);
    return c.json(rowToDatabase(d.databases.getById(row.id)!));
  });

  app.delete("/api/databases/:id", async (c) => {
    const row = requireDb(c.req.param("id"));
    d.databases.updateStatus(row.id, "deleting");
    // killByDbId is serialized per-dbId (an in-flight start completes first)
    // and covers ADOPTED processes — the process MUST be dead before the data
    // dir is removed, or we rm -rf a database that is being written.
    await d.supervisor.killByDbId(row.id);
    // Flush + stop replication before the files go. The replica itself is kept
    // in S3 (retention applies), so a deleted database stays recoverable.
    await d.backup?.stop(row.id, { removeConfig: true });
    assertInside(d.config.dataRoot, row.data_dir);
    await rm(row.data_dir, { recursive: true, force: true });
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
          await rmdir(dir); // only removes empty dirs; non-empty throws ENOTEMPTY
        } catch {
          // ENOTEMPTY (a sibling database or the workspace root) — stop climbing.
          break;
        }
      }
    }
    // Drop the per-database signing keypair too: keys are derived from the row
    // id, which is never reused (new DBs get fresh UUIDs), so orphaned key
    // files are dead weight. Guarded the same as data_dir.
    {
      const keyRel = dbKeyRelPath(row.id).replace(/\.pub$/, ".key");
      const pubRel = dbKeyRelPath(row.id);
      assertInside(d.config.dataRoot, path.join(d.config.dataRoot, keyRel));
      await rm(path.join(d.config.dataRoot, keyRel), { force: true });
      await rm(path.join(d.config.dataRoot, pubRel), { force: true });
    }
    if (d.dns) await d.dns.remove(row);
    if (row.port && row.grpc_port) d.supervisor.portAllocator.release({ http: row.port, grpc: row.grpc_port });
    d.databases.delete(row.id);
    return c.body(null, 204);
  });

  app.get("/api/databases/:id/connection", (c) => {
    const row = requireDb(c.req.param("id"));
    if (!row.port || !row.grpc_port) throw new ApiError(409, "not_ready", "database has no allocated endpoints yet");
    const conn: Connection = {
      httpUrl: `http://${d.config.publicHost}:${row.port}`,
      hranaUrl: `ws://${d.config.publicHost}:${row.port}`,
      grpcUrl: `http://${d.config.publicHost}:${row.grpc_port}`,
      publicUrl: hostTemplate ? `https://${renderHost(hostTemplate, publicKeyFor(hostTemplate, row))}` : null,
      dbName: row.slug,
    };
    return c.json(conn);
  });

  // ---- backups ------------------------------------------------------------
  const backupStatus = (id: string): BackupStatus => {
    if (!d.backup) {
      return { enabled: false, state: "disabled", replicaUrl: null, txidDb: null, txidReplica: null, lastSyncAt: null,
        lastSnapshotAt: null, behindSince: null, lastError: null, lastErrorAt: null, restarts: 0 };
    }
    const { pid: _pid, ...s } = d.backup.status(id);
    return { enabled: true, ...s };
  };

  app.get("/api/databases/:id/backup", (c) => c.json(backupStatus(requireDb(c.req.param("id")).id)));

  app.get("/api/backups", (c) =>
    c.json(d.databases.list().map((r) => ({ databaseId: r.id, slug: r.slug, ...backupStatus(r.id) }))),
  );

  // ---- dns ----------------------------------------------------------------
  app.post("/api/databases/:id/dns/sync", async (c) => {
    const row = requireDb(c.req.param("id"));
    if (!d.dns) throw new ApiError(409, "dns_disabled", "Cloudflare DNS automation is not configured");
    await d.dns.sync(row);
    return c.json(rowToDatabase(d.databases.getById(row.id)!));
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
    });
    return c.json(issued, 201);
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

  function requireDb(id: string): DbRow {
    const row = d.databases.getById(id);
    if (!row) throw new ApiError(404, "not_found", "database not found");
    return row;
  }
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
