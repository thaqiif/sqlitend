import type {
  Connection,
  CreateDatabase,
  CreateToken,
  CreateWorkspace,
  Database,
  ErrorBody,
  Metrics,
  SystemInfo,
  Token,
  TokenIssued,
  Workspace,
} from "@sqlitend/shared";

const BASE = "/api";

/**
 * Raised for any non-2xx API response (and carries the shared ErrorBody shape)
 * so the UI can surface `{error:{code,message}}` consistently, including the
 * documented 501 `revocation_unsupported` case.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;

  constructor(status: number, code: string, message: string, detail?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });

  if (res.status === 204) {
    // No content; callers typed these as `void` (delete endpoints).
    return undefined as T;
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON (or empty) body; fall through to the generic error path below.
  }

  if (!res.ok) {
    const err = (body as ErrorBody | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? "request_failed",
      err?.message ?? `Request failed (${res.status} ${res.statusText})`,
      err?.detail,
    );
  }

  return body as T;
}

/** Typed client for the sqlitend control-plane API. */
export const api = {
  // -------------------------------------------------------------------------
  // Workspaces
  // -------------------------------------------------------------------------
  listWorkspaces: () => request<Workspace[]>("/workspaces"),

  createWorkspace: (body: CreateWorkspace) =>
    request<Workspace>("/workspaces", { method: "POST", body: JSON.stringify(body) }),

  deleteWorkspace: (id: string) =>
    request<void>(`/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" }),

  // -------------------------------------------------------------------------
  // Databases
  // -------------------------------------------------------------------------
  listDatabases: (workspaceId: string) =>
    request<Database[]>(`/databases?workspaceId=${encodeURIComponent(workspaceId)}`),

  getDatabase: (id: string) =>
    request<Database>(`/databases/${encodeURIComponent(id)}`),

  createDatabase: (workspaceId: string, body: CreateDatabase) =>
    request<Database>(`/workspaces/${encodeURIComponent(workspaceId)}/databases`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  startDatabase: (id: string) =>
    request<Database>(`/databases/${encodeURIComponent(id)}/start`, { method: "POST" }),

  stopDatabase: (id: string) =>
    request<Database>(`/databases/${encodeURIComponent(id)}/stop`, { method: "POST" }),

  deleteDatabase: (id: string) =>
    request<void>(`/databases/${encodeURIComponent(id)}`, { method: "DELETE" }),

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------
  getConnection: (id: string) =>
    request<Connection>(`/databases/${encodeURIComponent(id)}/connection`),

  // -------------------------------------------------------------------------
  // Tokens
  // -------------------------------------------------------------------------
  generateToken: (id: string, body: CreateToken) =>
    request<TokenIssued>(`/databases/${encodeURIComponent(id)}/tokens`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  listTokens: (id: string) =>
    request<Token[]>(`/databases/${encodeURIComponent(id)}/tokens`),

  revokeToken: (id: string, jti: string) =>
    request<void>(`/databases/${encodeURIComponent(id)}/tokens/${encodeURIComponent(jti)}`, {
      method: "DELETE",
    }),

  // -------------------------------------------------------------------------
  // Metrics / system
  // -------------------------------------------------------------------------
  getMetrics: (id: string) =>
    request<Metrics>(`/databases/${encodeURIComponent(id)}/metrics`),

  getSystemInfo: () => request<SystemInfo>("/system"),
};

