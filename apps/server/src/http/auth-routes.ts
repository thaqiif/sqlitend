// ---------------------------------------------------------------------------
// Control-plane auth: login/logout/session endpoints, the session gate for the
// rest of /api, a CSRF header requirement for state-changing calls, and an
// audit middleware recording every mutating call and its outcome.
// ---------------------------------------------------------------------------

import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AuthRepo } from "../db/repos/auth.ts";
import { AuthService, SESSION_COOKIE } from "../auth/session.ts";

/** Header every state-changing request must carry. A cross-site form cannot set
 *  custom headers, and a cross-site fetch that does triggers a CORS preflight
 *  this server never approves. */
export const CSRF_HEADER = "x-sqlitend-csrf";

export interface AuthDeps {
  service: AuthService;
  repo: AuthRepo;
  /** "on" forces the cookie Secure flag; "auto" sets it only for HTTPS requests. */
  cookieSecure?: "auto" | "on";
}

export type AppEnv = { Bindings: { ip?: string }; Variables: { actor: string } };

const LoginSchema = z.object({ password: z.string().min(1).max(1024), totp: z.string().max(16).optional() }).strict();

const PUBLIC_PATHS = new Set(["/api/auth/login", "/api/auth/session"]);

const ipOf = (c: Context<AppEnv>) => c.env?.ip ?? "unknown";
const isMutating = (method: string) => method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
// x-forwarded-proto is NOT trusted (any client can send it); use
// SQLITEND_COOKIE_SECURE=on when TLS terminates in front of the control plane.
const secureRequest = (c: Context) => new URL(c.req.url).protocol === "https:";

/** "POST /api/databases/:id/tokens" → "token.create", etc. */
const ACTIONS: Record<string, string> = {
  "POST /api/workspaces": "workspace.create",
  "DELETE /api/workspaces/:id": "workspace.delete",
  "POST /api/workspaces/:id/databases": "database.create",
  "POST /api/databases/:id/start": "database.start",
  "POST /api/databases/:id/stop": "database.stop",
  "DELETE /api/databases/:id": "database.delete",
  "POST /api/databases/:id/dns/sync": "dns.sync",
  "POST /api/backups/:id/restore": "database.restore",
  "POST /api/databases/:id/backup/verify": "backup.verify",
  "POST /api/backups/verify": "backup.verify_all",
  "POST /api/databases/:id/tokens": "token.create",
  "DELETE /api/databases/:id/tokens/:jti": "token.revoke",
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

export function installAuth(app: Hono<AppEnv>, auth: AuthDeps): void {
  const { service, repo } = auth;

  // ---- CSRF + session gate ------------------------------------------------
  const gate: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (isMutating(c.req.method) && c.req.header(CSRF_HEADER) !== "1") {
      return c.json({ error: { code: "csrf", message: `missing ${CSRF_HEADER} header` } }, 403);
    }
    if (PUBLIC_PATHS.has(c.req.path)) {
      c.set("actor", "anonymous");
      return next();
    }
    if (!service.setupDone) {
      return c.json({ error: { code: "setup_required", message: "no admin password set — run `sqlitend set-password` on the server" } }, 503);
    }
    if (!service.validate(getCookie(c, SESSION_COOKIE))) {
      return c.json({ error: { code: "unauthenticated", message: "login required" } }, 401);
    }
    c.set("actor", "admin");
    return next();
  };
  app.use("/api/*", gate);

  // ---- audit ---------------------------------------------------------------
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

  // ---- endpoints -------------------------------------------------------------
  app.get("/api/auth/session", (c) => {
    const s = service.setupDone ? service.validate(getCookie(c, SESSION_COOKIE)) : null;
    return c.json({
      setupRequired: !service.setupDone,
      authenticated: !!s,
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
    const ip = ipOf(c);
    const r = await service.login({ password: body.password, totp: body.totp, ip, userAgent: c.req.header("user-agent") });
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

  app.get("/api/audit", (c) => {
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100) || 100));
    const before = c.req.query("before");
    const rows = repo.listAudit(limit, before ? Number(before) : undefined);
    return c.json(rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor, ip: r.ip, action: r.action, target: r.target, outcome: r.outcome, detail: r.detail })));
  });
}
