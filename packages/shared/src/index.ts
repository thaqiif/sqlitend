import { z } from "zod";

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------
export const WorkspaceSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(128),
  createdAt: z.number().int(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const CreateWorkspaceSchema = z.object({
  name: z.string().min(1).max(128),
});
export type CreateWorkspace = z.infer<typeof CreateWorkspaceSchema>;

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
export const DatabaseStatusSchema = z.enum([
  "starting",
  "running",
  "stopped",
  "crashed",
  "failed",
  "deleting",
  // Being restored from a backup replica (background job; auto_start stays 0
  // until the restored file is verified and in place).
  "restoring",
  // Read-coercion fallback for a corrupt/unparseable metadata row: the API
  // serves it visibly rather than 500ing the whole list. Never written by the
  // server — the supervisor only persists the six real states.
  "unknown",
]);
export type DatabaseStatus = z.infer<typeof DatabaseStatusSchema>;

export const DatabaseSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(128),
  status: DatabaseStatusSchema,
  pid: z.number().int().nullable(),
  port: z.number().int().nullable(),
  grpcPort: z.number().int().nullable(),
  dataDir: z.string(),
  autoStart: z.boolean().default(true),
  sqldVersion: z.string().nullable(),
  /** Last launch failure (sqld stderr tail) — null after a successful start. */
  failedReason: z.string().nullable(),
  /** Managed public DNS record; status null when DNS automation is off. */
  dns: z
    .object({
      hostname: z.string().nullable(),
      status: z.enum(["active", "error", "conflict"]).nullable(),
      error: z.string().nullable(),
    })
    .default({ hostname: null, status: null, error: null }),
  createdAt: z.number().int(),
});
export type Database = z.infer<typeof DatabaseSchema>;

export const CreateDatabaseSchema = z.object({
  name: z.string().min(1).max(128),
});
export type CreateDatabase = z.infer<typeof CreateDatabaseSchema>;

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
export const ConnectionSchema = z.object({
  httpUrl: z.string().url(),
  hranaUrl: z.string(),
  grpcUrl: z.string(),
  /** Public HTTPS URL via the gateway (e.g. https://<db>-libsql.example.com); null when the gateway is disabled. */
  publicUrl: z.string().url().nullable().default(null),
  dbName: z.string(),
});
export type Connection = z.infer<typeof ConnectionSchema>;

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------
export const TokenScopeSchema = z.enum(["full", "ro"]);
export type TokenScope = z.infer<typeof TokenScopeSchema>;

export const TokenSchema = z.object({
  jti: z.string().uuid(),
  databaseId: z.string().uuid(),
  scope: TokenScopeSchema,
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  /** Operator label, e.g. "worker-prod". Rotation = new token, same name. */
  name: z.string().nullable().default(null),
  /** Revoked tokens are refused by the gateway (sqld cannot revoke). */
  revokedAt: z.number().int().nullable().default(null),
  /** Last request seen through the gateway (throttled, ~1/min). */
  lastUsedAt: z.number().int().nullable().default(null),
});
export type Token = z.infer<typeof TokenSchema>;

export const ExpiringTokenSchema = TokenSchema.extend({ dbSlug: z.string(), expired: z.boolean() });
export type ExpiringToken = z.infer<typeof ExpiringTokenSchema>;

export const TokenIssuedSchema = TokenSchema.extend({
  token: z.string(),
  dbSlug: z.string(),
});
export type TokenIssued = z.infer<typeof TokenIssuedSchema>;

// Token minting is strict and v1 mints full-access tokens only: this sqld
// build cannot enforce per-request scopes (and rejects `p`-claimed tokens
// outright), so a requested "read-only" scope would silently grant full
// access. Anything else than omitted/"full" — including unknown keys — is a
// 400, never a silent default.
export const CreateTokenSchema = z
  .object({
    scope: z.literal("full").optional(),
    name: z.string().trim().min(1).max(64).optional(),
    expiresInHours: z.number().int().positive().max(24 * 365).optional(),
  })
  .strict();
export type CreateToken = z.infer<typeof CreateTokenSchema>;

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
export const MetricsSchema = z.object({
  cpuPct: z.number().nullable(),
  memoryBytes: z.number().int(),
  diskBytes: z.number().int(),
  uptimeSec: z.number().int(),
  status: DatabaseStatusSchema,
  sampledAt: z.number().int(),
});
export type Metrics = z.infer<typeof MetricsSchema>;

// ---------------------------------------------------------------------------
// System info
// ---------------------------------------------------------------------------
export const SystemInfoSchema = z.object({
  version: z.string(),
  // dataRoot/sqldPath are intentionally NOT exposed over the API.
  sqldVersion: z.string().nullable(),
  sqldOk: z.boolean(),
  sqldReason: z.string().nullable(),
  sqldBinarySha256: z.string().nullable(),
  /** Host advertised in database connection URLs (see config publicHost). */
  publicHost: z.string(),
  counts: z.object({
    workspaces: z.number().int(),
    databases: z.number().int(),
  }),
});
export type SystemInfo = z.infer<typeof SystemInfoSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    detail: z.string().optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

// ---------------------------------------------------------------------------
// Control-plane auth + audit
// ---------------------------------------------------------------------------
export const SessionInfoSchema = z.object({
  setupRequired: z.boolean(),
  authenticated: z.boolean(),
  totpEnabled: z.boolean(),
  expiresAt: z.number().int().nullable(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const AuditEntrySchema = z.object({
  id: z.number().int(),
  at: z.number().int(),
  actor: z.string(),
  ip: z.string().nullable(),
  action: z.string(),
  target: z.string().nullable(),
  outcome: z.enum(["ok", "denied", "error"]),
  detail: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

// ---------------------------------------------------------------------------
// Backups (Litestream → S3)
// ---------------------------------------------------------------------------
export const BackupStatusSchema = z.object({
  enabled: z.boolean(),
  state: z.enum(["disabled", "starting", "ok", "lagging", "error", "stopped"]),
  replicaUrl: z.string().nullable(),
  txidDb: z.string().nullable(),
  txidReplica: z.string().nullable(),
  lastSyncAt: z.number().int().nullable(),
  lastSnapshotAt: z.number().int().nullable(),
  behindSince: z.number().int().nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: z.number().int().nullable(),
  restarts: z.number().int(),
});
export type BackupStatus = z.infer<typeof BackupStatusSchema>;

export const RestoreRequestSchema = z
  .object({
    name: z.string().min(1).max(128),
    workspaceId: z.string().uuid(),
    /** Point in time (RFC 3339, e.g. 2026-09-25T08:00:00Z); omitted = latest. */
    at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type RestoreRequest = z.infer<typeof RestoreRequestSchema>;

export const ReplicaInfoSchema = z.object({
  id: z.string(),
  slug: z.string().optional(),
  name: z.string().optional(),
  workspaceId: z.string().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  exists: z.boolean(),
});
export type ReplicaInfo = z.infer<typeof ReplicaInfoSchema>;
