// ---------------------------------------------------------------------------
// SPA static serving with strict containment. Unknown routes fall back to
// index.html; any path escaping webDist falls back too (never a raw fs error).
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Security headers on every SPA response (the SPA is the only HTML surface). */
export function securityHeaders(): Record<string, string> {
  return {
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'",
  };
}

export type StaticHandler = (pathname: string) => Response;

export function createStaticHandler(webDist: string): StaticHandler {
  const dist = path.resolve(webDist);

  return function serveStatic(pathname: string): Response {
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    // Normalize collapses dot segments; the containment check rejects anything
    // that still resolves outside the dist dir (defense in depth — Bun's URL
    // parser already collapses dot segments, but do not rely on that alone).
    const safe = path.normalize(rel);
    const file = path.join(dist, safe);
    const inside = file === dist || file.startsWith(dist + path.sep);

    if (!inside || !existsSync(file) || statSync(file).isDirectory()) {
      // SPA fallback: serve index.html for any client route.
      return htmlFallback(dist);
    }
    return new Response(readFileSync(file), {
      headers: { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", ...securityHeaders() },
    });
  };
}

function htmlFallback(dist: string): Response {
  let body = "";
  try {
    body = readFileSync(path.join(dist, "index.html"), "utf8");
  } catch {
    body = "<!doctype html><title>sqlitend</title><p>UI build missing — run <code>bun run build</code>.</p>";
  }
  return new Response(body, { headers: { "content-type": MIME[".html"], ...securityHeaders() } });
}

/**
 * Host allowlist for the API surface: the control plane binds 127.0.0.1 and
 * must only accept requests addressed to it (blocks DNS-rebinding, where an
 * attacker page fetches `http://evil.example:<port>/api/...` — that request
 * arrives with attacker-controlled Host but still hits our listener).
 */
export function isAllowedHost(host: string, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}
