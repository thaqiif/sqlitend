// ---------------------------------------------------------------------------
// Gateway — host-routed HTTPS front for every database.
//
// One listener (SQLITEND_GATEWAY_PORT) serves all databases by Host header,
// rendered from SQLITEND_GATEWAY_HOST_TEMPLATE, e.g. "{db}-libsql.cloudsby.me":
//
//   https://bots-prod-libsql.cloudsby.me  -> 127.0.0.1:<port of slug "bots-prod">
//   https://<uuid>-libsql.cloudsby.me     -> 127.0.0.1:<port of that id>
//
// TLS terminates in front (Cloudflare Tunnel / reverse proxy); the gateway
// speaks plain HTTP on loopback. It adds NO authentication of its own: every
// request still needs that database's JWT, which sqld verifies. The gateway
// only decides WHERE a request goes, and refuses anything it cannot place
// with a uniform 404 (unknown and not-running look the same) so hostnames
// cannot be used to probe which DBs exist.
//
// v1 proxies Hrana-over-HTTP only (what `@libsql/client/web` uses for
// https:// URLs, incl. Cloudflare Workers). WebSocket upgrades get 501.
// ---------------------------------------------------------------------------

import type { DatabaseRow } from "../db/repos/databases.ts";

export const DB_PLACEHOLDER = "{db}";
/** Max DNS label length (RFC 1035). */
const MAX_LABEL = 63;
const KEY_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Hop-by-hop headers (RFC 9110 §7.6.1) never cross a proxy.
const HOP_BY_HOP = [
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host",
];

export interface HostTemplate {
  raw: string;
  prefix: string;
  suffix: string;
}

/**
 * Validate and split a host template. The placeholder must sit inside the
 * FIRST DNS label so a rendered hostname stays one level deep — that keeps it
 * covered by a free `*.<zone>` certificate (e.g. Cloudflare Universal SSL).
 */
export function parseHostTemplate(raw: string): HostTemplate {
  const t = raw.trim().toLowerCase();
  const at = t.indexOf(DB_PLACEHOLDER);
  if (at === -1 || t.indexOf(DB_PLACEHOLDER, at + 1) !== -1) {
    throw new Error(`invalid SQLITEND_GATEWAY_HOST_TEMPLATE: "${raw}" (must contain ${DB_PLACEHOLDER} exactly once)`);
  }
  const prefix = t.slice(0, at);
  const suffix = t.slice(at + DB_PLACEHOLDER.length);
  if (prefix.includes(".") || !suffix.includes(".") || !/^[a-z0-9.-]*$/.test(prefix + suffix)) {
    throw new Error(
      `invalid SQLITEND_GATEWAY_HOST_TEMPLATE: "${raw}" (${DB_PLACEHOLDER} must be in the first label, e.g. "${DB_PLACEHOLDER}-libsql.example.com")`,
    );
  }
  return { raw: t, prefix, suffix };
}

/** Length of the first label once `key` is substituted. */
function labelLength(tpl: HostTemplate, key: string): number {
  return (tpl.prefix + key + tpl.suffix.split(".")[0]).length;
}

/** Longest slug that still renders to a valid DNS label under this template. */
export function maxSlugLength(tpl: HostTemplate): number {
  return MAX_LABEL - labelLength(tpl, "");
}

export function renderHost(tpl: HostTemplate, key: string): string {
  return tpl.prefix + key + tpl.suffix;
}

/** Extract the database key (slug or id) from a Host header, or null. */
export function keyFromHost(tpl: HostTemplate, hostHeader: string | null): string | null {
  if (!hostHeader) return null;
  const host = hostHeader.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (!host.startsWith(tpl.prefix) || !host.endsWith(tpl.suffix)) return null;
  const key = host.slice(tpl.prefix.length, host.length - tpl.suffix.length);
  if (key.length === 0 || !KEY_RE.test(key) || labelLength(tpl, key) > MAX_LABEL) return null;
  return key;
}

export interface GatewayDeps {
  template: HostTemplate;
  /** Lookup by slug or id. */
  findDatabase: (key: string) => DatabaseRow | null;
  /** Address sqld is reachable on from this process (loopback for wildcard binds). */
  upstreamHost: string;
  maxBodyBytes: number;
  /** Upper bound for one proxied request, ms. */
  upstreamTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function lookupByKey(
  key: string,
  repo: { getById(id: string): DatabaseRow | null; getBySlug(slug: string): DatabaseRow | null },
): DatabaseRow | null {
  // A slug can never look like a UUID's 8-4-4-4-12 shape AND collide with an id
  // in practice, but ids win to keep the id URL stable even if such a slug exists.
  return (UUID_RE.test(key) ? repo.getById(key) : null) ?? repo.getBySlug(key);
}

/** Hop-by-hop list plus any header the sender named in `Connection`. */
function stripHopByHop(h: Headers): void {
  const named = (h.get("connection") ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const name of [...HOP_BY_HOP, ...named]) h.delete(name);
}

function plain(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export function createGatewayHandler(d: GatewayDeps): (req: Request) => Promise<Response> {
  const doFetch = d.fetchImpl ?? fetch;

  return async function gateway(req: Request): Promise<Response> {
    // Checked before lookup so the answer is identical for every hostname.
    if (req.headers.get("upgrade")) {
      return plain(501, "websocket not supported by the gateway; use an https:// URL (Hrana over HTTP)");
    }
    const key = keyFromHost(d.template, req.headers.get("host"));
    const row = key ? d.findDatabase(key) : null;
    // Unknown, stopped and port-less databases all answer the same 404, so
    // unauthenticated callers cannot enumerate which names exist.
    if (!row || !row.port || row.status !== "running") return plain(404, "not found");

    const cl = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(cl) && cl > d.maxBodyBytes) return plain(413, "payload too large");

    const url = new URL(req.url);
    const target = `http://${d.upstreamHost}:${row.port}${url.pathname}${url.search}`;

    const headers = new Headers(req.headers);
    stripHopByHop(headers);
    // Ask for identity: fetch transparently decodes compressed bodies, which
    // would leave a stale content-encoding on the relayed response.
    headers.set("accept-encoding", "identity");
    const hasBody = req.method !== "GET" && req.method !== "HEAD";

    let upstream: Response;
    try {
      upstream = await doFetch(target, {
        method: req.method,
        headers,
        body: hasBody ? await req.arrayBuffer() : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(d.upstreamTimeoutMs ?? 240_000),
      });
    } catch (err) {
      if ((err as Error).name === "TimeoutError") return plain(504, "database timed out");
      return plain(502, "database unreachable");
    }

    const out = new Headers(upstream.headers);
    stripHopByHop(out);
    out.delete("content-encoding");
    out.delete("content-length");
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  };
}

/** Public hostname key for a row: the slug when it fits a DNS label, else the id. */
export function publicKeyFor(tpl: HostTemplate, row: { id: string; slug: string }): string {
  return row.slug.length <= maxSlugLength(tpl) ? row.slug : row.id;
}
