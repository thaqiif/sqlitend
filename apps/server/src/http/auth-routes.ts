// ---------------------------------------------------------------------------
// Control-plane auth: login/logout/session endpoints, the session gate for the
// rest of /api, a CSRF header requirement for state-changing calls, and an
// audit middleware recording every mutating call and its outcome.
// ---------------------------------------------------------------------------

import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AuthRepo } from "../db/repos/auth.ts";
import { AuthService, constantTimeTokenMatch, SESSION_COOKIE } from "../auth/session.ts";

/** Header every state-changing request must carry. A cross-site form cannot set
 *  custom headers, and a cross-site fetch that does triggers a CORS preflight
 *  this server never approves. */
export const CSRF_HEADER = "x-sqlitend-csrf";

export interface AuthDeps {
  service: AuthService;
  repo: AuthRepo;
  /** "on" forces the cookie Secure flag; "auto" sets it only for HTTPS requests. */
  cookieSecure?: "auto" | "on";
  /** Optional static operator token (SQLITEND_ADMIN_TOKEN). */
  adminToken?: string | null;
}

export type AppEnv = { Bindings: { ip?: string }; Variables: { actor: string } };

const LoginSchema = z
  .object({
    password: z.string().min(1).max(1024).optional(),
    token: z.string().min(1).max(1024).optional(),
    totp: z.string().max(16).optional(),
  })
  .strict();

const PUBLIC_PATHS = new Set(["/api/auth/login", "/api/auth/session"]);

const ipOf = (c: Context<AppEnv>) => c.env?.ip ?? "unknown";
const isMutating = (method: string) => method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
// x-forwarded-proto is NOT trusted (any client can send it); use
// SQLITEND_COOKIE_SECURE=on when TLS terminates in front of the control plane.
const secureRequest = (c: Context) => new URL(c.req.url).protocol === "https:";

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1]! : null;
}

/** "POST /api/databases/:id/tokens" → "token.create", etc. */
const ACTIONS: Record<string, string> = {
  "POST /api/workspaces": "workspace.create",
  "DELETE /api/workspaces/:id": "workspace.delete",
  "PATCH /api/workspaces/:id/protection": "workspace.protection",
  "POST /api/workspaces/:id/databases": "database.create",
  "POST /api/databases/:id/start": "database.start",
  "POST /api/databases/:id/stop": "database.stop",
  "DELETE /api/databases/:id": "database.delete",
  "PATCH /api/databases/:id/protection": "database.protection",
  "POST /api/databases/:id/dns/sync": "dns.sync",
  "POST /api/backups/:id/restore": "database.restore",
  "POST /api/databases/:id/backup/verify": "backup.verify",
  "POST /api/backups/verify": "backup.verify_all",
  "POST /api/backups/control": "backup.control",
  "POST /api/databases/:id/tokens": "token.create",
  "DELETE /api/databases/:id/tokens/:jti": "token.revoke",
  "POST /api/databases/:id/tokens/:jti/reveal": "token.reveal",
  "POST /api/databases/:id/query": "database.query",
  "POST /api/databases/:id/tables/:table/rows": "table.insert",
  "PATCH /api/databases/:id/tables/:table/rows": "table.update",
  "DELETE /api/databases/:id/tables/:table/rows": "table.delete",
  "POST /api/trash/:id/restore": "trash.restore",
  "DELETE /api/trash/:id": "trash.purge",
  "POST /api/auth/logout": "auth.logout",
};

// Compiled once: "/api/databases/:id/tokens/:jti" → regex with named groups.
const ACTION_MATCHERS = Object.entries(ACTIONS).map(([key, action]) => {
  const [method, pattern] = key.split(" ") as [string, string];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`);
  return { method, re, action };
});

function matchAction(method: string, path: string): { action: string; target: string | null } | null {
  for (const m of ACTION_MATCHERS) {
    if (m.method !== method) continue;
    const g = m.re.exec(path);
    if (g) return { action: m.action, target: g.groups?.jti ?? g.groups?.id ?? null };
  }
  return null;
}

/** Audit log of state-changing calls + its read endpoint (with or without login). */
export function installAudit(app: Hono<AppEnv>, repo: AuthDeps["repo"]): void {
  app.use("/api/*", async (c, next) => {
    await next();
    if (!isMutating(c.req.method)) return;
    const hit = matchAction(c.req.method, c.req.path);
    if (!hit) return; // login is audited explicitly with its reason
    const status = c.res.status;
    repo.audit({
      actor: c.get("actor") ?? "anonymous",
      ip: ipOf(c),
      action: hit.action,
      target: hit.target,
      outcome: status < 400 ? "ok" : status === 401 || status === 403 ? "denied" : "error",
      detail: status < 400 ? null : `HTTP ${status}`,
    });
  });


  app.get("/api/audit", (c) => {
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100) || 100));
    const before = c.req.query("before");
    const rows = repo.listAudit(limit, before ? Number(before) : undefined);
    return c.json(rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor, ip: r.ip, action: r.action, target: r.target, outcome: r.outcome, detail: r.detail })));
  });
}

/** SQLITEND_AUTH=off: no login, but state-changing calls still need the CSRF
 *  header, so a cross-site form/fetch riding on a Cloudflare Access cookie
 *  (SameSite=None) can't act on the dashboard. */
export function installCsrfOnly(app: Hono<AppEnv>, repo: AuthDeps["repo"] | null): void {
  app.use("/api/*", async (c, next) => {
    if (isMutating(c.req.method) && c.req.header(CSRF_HEADER) !== "1") {
      return c.json({ error: { code: "csrf", message: `missing ${CSRF_HEADER} header` } }, 403);
    }
    c.set("actor", "admin");
    return next();
  });
  if (repo) installAudit(app, repo);
}

export function installAuth(app: Hono<AppEnv>, auth: AuthDeps): void {
  const { service, repo } = auth;
  const adminToken = auth.adminToken ?? null;

  const isAuthSetup = () => service.setupDone || !!adminToken;

  const isAuthenticated = (c: Context<AppEnv>): { ok: boolean; session: ReturnType<AuthService["validate"]> } => {
    const bearer = extractBearer(c.req.header("authorization"));
    if (bearer && adminToken && constantTimeTokenMatch(bearer, adminToken)) {
      return { ok: true, session: null };
    }
    const cookieVal = getCookie(c, SESSION_COOKIE);
    const s = service.validate(cookieVal);
    return { ok: !!s, session: s };
  };

  // ---- CSRF + session gate ------------------------------------------------
  const gate: MiddlewareHandler<AppEnv> = async (c, next) => {
    const bearer = extractBearer(c.req.header("authorization"));
    const validBearer = !!(bearer && adminToken && constantTimeTokenMatch(bearer, adminToken));
    if (isMutating(c.req.method) && !validBearer && c.req.header(CSRF_HEADER) !== "1") {
      return c.json({ error: { code: "csrf", message: `missing ${CSRF_HEADER} header` } }, 403);
    }
    if (PUBLIC_PATHS.has(c.req.path)) {
      c.set("actor", "anonymous");
      return next();
    }
    if (!isAuthSetup()) {
      return c.json({ error: { code: "setup_required", message: "no admin password set — run `sqlitend set-password` on the server" } }, 503);
    }
    if (!validBearer && !isAuthenticated(c).ok) {
      return c.json({ error: { code: "unauthenticated", message: "login required" } }, 401);
    }
    c.set("actor", "admin");
    return next();
  };
  app.use("/api/*", gate);

  installAudit(app, repo);

  // ---- endpoints -------------------------------------------------------------
  app.get("/api/auth/session", (c) => {
    const setupDone = isAuthSetup();
    const { ok, session: s } = setupDone ? isAuthenticated(c) : { ok: false, session: null };
    return c.json({
      setupRequired: !setupDone,
      authenticated: ok,
      totpEnabled: service.totpEnabled,
      expiresAt: s ? Math.min(s.expires_at, s.last_seen_at + service.idleMs) : null,
    });
  });

  app.post("/api/auth/login", async (c) => {
    let body: z.infer<typeof LoginSchema>;
    try {
      body = LoginSchema.parse(await c.req.json());
    } catch {
      return c.json({ error: { code: "bad_request", message: "invalid login payload" } }, 400);
    }
    const candidateSecret = body.token ?? body.password;
    if (!candidateSecret) {
      return c.json({ error: { code: "bad_request", message: "password or token required" } }, 400);
    }
    const ip = ipOf(c);
    const userAgent = c.req.header("user-agent");

    // If SQLITEND_ADMIN_TOKEN is configured and either `token` was supplied or
    // `password` matches the adminToken (and no admin password row is needed),
    // verify against adminToken in constant time.
    let r: Awaited<ReturnType<AuthService["login"]>>;
    if (adminToken && (body.token !== undefined || (!service.setupDone && body.password !== undefined) || constantTimeTokenMatch(candidateSecret, adminToken))) {
      r = service.loginWithAdminToken({ token: candidateSecret, expectedToken: adminToken, totp: body.totp, ip, userAgent });
    } else {
      r = await service.login({ password: candidateSecret, totp: body.totp, ip, userAgent });
    }
    if (!r.ok) {
      if (r.reason !== "totp_required") {
        repo.audit({ actor: "anonymous", ip, action: "auth.login", target: null, outcome: "denied", detail: r.reason });
      }
      if (r.reason === "throttled") {
        c.header("retry-after", String(r.retryAfterSec ?? 60));
        return c.json({ error: { code: "throttled", message: `too many failed logins; retry in ${r.retryAfterSec}s` } }, 429);
      }
      if (r.reason === "setup_required") {
        return c.json({ error: { code: "setup_required", message: "no admin password set — run `sqlitend set-password` on the server" } }, 503);
      }
      if (r.reason === "totp_required") return c.json({ error: { code: "totp_required", message: "enter your authenticator code" } }, 401);
      return c.json({ error: { code: "invalid_credentials", message: "wrong password or code" } }, 401);
    }
    repo.audit({ actor: "admin", ip, action: "auth.login", target: null, outcome: "ok", detail: null });
    setCookie(c, SESSION_COOKIE, r.sessionId, {
      httpOnly: true,
      sameSite: "Strict",
      secure: auth.cookieSecure === "on" || secureRequest(c),
      path: "/",
      maxAge: Math.floor(service.absoluteMs / 1000),
    });
    return c.json({ authenticated: true, expiresAt: r.session.last_seen_at + service.idleMs });
  });

  app.post("/api/auth/logout", (c) => {
    service.logout(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.body(null, 204);
  });

}
