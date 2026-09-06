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
});
export type Token = z.infer<typeof TokenSchema>;

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
