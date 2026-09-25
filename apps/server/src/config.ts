import path from "node:path";
import os from "node:os";
import { parseHostTemplate } from "./gateway/gateway.ts";

// ---------------------------------------------------------------------------
// Configuration, hand-validated from env (see .env.example for the full set).
// All values have defaults; invalid values fail loudly at startup.
// (Validation is hand-rolled here — zod is used only for request bodies in
// packages/shared.)
// ---------------------------------------------------------------------------

export interface PortRange {
  start: number;
  end: number;
}

export interface Config {
  /** Control-plane listener bind address (default 0.0.0.0 — all interfaces). */
  port: number;
  host: string;
  /** Host advertised in database connection URLs (http/hrana/grpc) to clients.
   *  Default: 127.0.0.1, or the bind host when it is an explicit address — a
   *  wildcard bind (0.0.0.0) cannot be advertised, so SQLITEND_PUBLIC_HOST
   *  should be set to the machine's public address/hostname for remote clients. */
  publicHost: string;
  /** Range from which http+grpc port PAIRS are allocated per database. */
  portRange: PortRange;
  /** Root directory holding metadata.sqlite and all database data dirs. */
  dataRoot: string;
  /** Path to the pinned sqld binary. */
  sqldPath: string;
  /** Default token lifetime in hours. */
  tokenTtlHours: number;
  /** Metrics sampler interval, ms. The UI polls at this same cadence. */
  sampleIntervalMs: number;
  /** Launch ready-probe timeout, ms. */
  readyTimeoutMs: number;
  /** Max accepted JSON body size for mutating API calls, bytes. */
  maxBodyBytes: number;
  /** Gateway listener port; 0 = gateway disabled (default). */
  gatewayPort: number;
  /** Gateway bind address. Default 127.0.0.1 — expose via a tunnel/proxy. */
  gatewayHost: string;
  /** Public hostname template, e.g. "{db}-libsql.cloudsby.me"; null when disabled. */
  gatewayHostTemplate: string | null;
  /** Max proxied request body, bytes (Hrana batches can be large). */
  gatewayMaxBodyBytes: number;
  /** Control-plane login. false only for loopback-bound local development. */
  authEnabled: boolean;
  /** Client-IP source when the control plane sits behind a local proxy/tunnel:
   *  "off" = socket peer; "cloudflare" = CF-Connecting-IP; "xff" = last X-Forwarded-For hop.
   *  Headers are only honoured when the socket peer is loopback. */
  trustProxy: "off" | "cloudflare" | "xff";
  /** Session cookie Secure flag: "auto" = when the request is HTTPS; "on" = always. */
  cookieSecure: "auto" | "on";
  /** Cloudflare DNS automation; null when disabled. Requires the gateway. */
  cloudflareDns: { apiToken: string; zoneId: string; tunnelId: string; apiBase: string } | null;
}

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 6100;
const DEFAULT_PORT_RANGE: PortRange = { start: 6101, end: 6300 };
const DEFAULT_TOKEN_TTL_HOURS = 24;

// Repository root = <repo>/apps/server/src/config.ts -> up 3 dirs.
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");

function parsePortRange(raw: string): PortRange {
  const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(raw);
  if (!m) throw new Error(`invalid SQLITEND_PORT_RANGE: "${raw}" (expected "start-end")`);
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) {
    throw new Error(`invalid SQLITEND_PORT_RANGE: "${raw}"`);
  }
  return { start, end };
}

/** Strict integer env parse with bounds — NaN/garbage must fail at boot, not
 *  propagate (a NaN token TTL produced NaN expiry timestamps; a NaN sampler
 *  interval degenerated setInterval into a hot loop). */
function parsePositiveInt(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.length === 0) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`invalid ${name}: "${raw}" (expected an integer between ${min} and ${max})`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const port = parsePositiveInt("SQLITEND_PORT", env.SQLITEND_PORT, DEFAULT_PORT, 1, 65535);

  const dataRoot = env.SQLITEND_DATA_ROOT && env.SQLITEND_DATA_ROOT.length > 0
    ? env.SQLITEND_DATA_ROOT
    : path.join(os.homedir(), ".local", "share", "sqlitend");

  const host = env.SQLITEND_HOST && env.SQLITEND_HOST.trim().length > 0
    ? env.SQLITEND_HOST.trim()
    : DEFAULT_HOST;

  // Advertised connection host: explicit SQLITEND_PUBLIC_HOST wins; otherwise
  // fall back to the bind host when it names a real address (0.0.0.0/:: cannot
  // be advertised to clients); else the conventional loopback default.
  const wildcardHost = host === "0.0.0.0" || host === "::" || host === "*";
  const publicHost = env.SQLITEND_PUBLIC_HOST && env.SQLITEND_PUBLIC_HOST.trim().length > 0
    ? env.SQLITEND_PUBLIC_HOST.trim()
    : (wildcardHost ? "127.0.0.1" : host);

  return {
    port,
    host,
    publicHost,
    portRange: env.SQLITEND_PORT_RANGE ? parsePortRange(env.SQLITEND_PORT_RANGE) : DEFAULT_PORT_RANGE,
    dataRoot,
    sqldPath: (env.SQLITEND_SQLD_PATH && env.SQLITEND_SQLD_PATH.length > 0)
      ? env.SQLITEND_SQLD_PATH
      : path.join(repoRoot, "bin", "sqld"),
    tokenTtlHours: parsePositiveInt("SQLITEND_TOKEN_TTL_HOURS", env.SQLITEND_TOKEN_TTL_HOURS, DEFAULT_TOKEN_TTL_HOURS, 1, 24 * 365),
    sampleIntervalMs: parsePositiveInt("SQLITEND_SAMPLE_INTERVAL_MS", env.SQLITEND_SAMPLE_INTERVAL_MS, 5000, 250, 600_000),
    readyTimeoutMs: parsePositiveInt("SQLITEND_READY_TIMEOUT_MS", env.SQLITEND_READY_TIMEOUT_MS, 10_000, 500, 120_000),
    maxBodyBytes: parsePositiveInt("SQLITEND_MAX_BODY_BYTES", env.SQLITEND_MAX_BODY_BYTES, 1_000_000, 1024, 64 * 1024 * 1024),
    ...loadGatewayConfig(env),
    cloudflareDns: loadCloudflareDnsConfig(env),
    authEnabled: loadAuthEnabled(env, host),
    trustProxy: oneOf("SQLITEND_TRUST_PROXY", env.SQLITEND_TRUST_PROXY, ["off", "cloudflare", "xff"] as const, "off"),
    cookieSecure: oneOf("SQLITEND_COOKIE_SECURE", env.SQLITEND_COOKIE_SECURE, ["auto", "on"] as const, "auto"),
    ...overrides,
  };
}

function loadGatewayConfig(env: NodeJS.ProcessEnv): Pick<Config, "gatewayPort" | "gatewayHost" | "gatewayHostTemplate" | "gatewayMaxBodyBytes"> {
  const gatewayPort = parsePositiveInt("SQLITEND_GATEWAY_PORT", env.SQLITEND_GATEWAY_PORT, 0, 0, 65535);
  const template = env.SQLITEND_GATEWAY_HOST_TEMPLATE?.trim() || null;
  if (gatewayPort > 0 && !template) {
    throw new Error("SQLITEND_GATEWAY_PORT is set but SQLITEND_GATEWAY_HOST_TEMPLATE is empty (e.g. \"{db}-libsql.example.com\")");
  }
  if (gatewayPort > 0 && template) parseHostTemplate(template); // fail loudly at boot
  return {
    gatewayPort,
    gatewayHost: env.SQLITEND_GATEWAY_HOST?.trim() || "127.0.0.1",
    gatewayHostTemplate: gatewayPort > 0 ? template : null,
    gatewayMaxBodyBytes: parsePositiveInt("SQLITEND_GATEWAY_MAX_BODY_BYTES", env.SQLITEND_GATEWAY_MAX_BODY_BYTES, 32 * 1024 * 1024, 1024, 256 * 1024 * 1024),
  };
}

function loadCloudflareDnsConfig(env: NodeJS.ProcessEnv): Config["cloudflareDns"] {
  const apiToken = env.SQLITEND_CF_API_TOKEN?.trim() || "";
  const zoneId = env.SQLITEND_CF_ZONE_ID?.trim() || "";
  const tunnelId = env.SQLITEND_CF_TUNNEL_ID?.trim() || "";
  const set = [apiToken, zoneId, tunnelId].filter(Boolean).length;
  if (set === 0) return null;
  if (set !== 3) {
    throw new Error("Cloudflare DNS automation needs all of SQLITEND_CF_API_TOKEN, SQLITEND_CF_ZONE_ID and SQLITEND_CF_TUNNEL_ID");
  }
  if (!env.SQLITEND_GATEWAY_PORT || env.SQLITEND_GATEWAY_PORT === "0" || !env.SQLITEND_GATEWAY_HOST_TEMPLATE?.trim()) {
    throw new Error("Cloudflare DNS automation requires the gateway (SQLITEND_GATEWAY_PORT + SQLITEND_GATEWAY_HOST_TEMPLATE)");
  }
  if (!/^[0-9a-f-]{36}$/i.test(tunnelId)) throw new Error(`invalid SQLITEND_CF_TUNNEL_ID: "${tunnelId}" (expected the tunnel UUID)`);
  return { apiToken, zoneId, tunnelId, apiBase: env.SQLITEND_CF_API_BASE?.trim() || "https://api.cloudflare.com/client/v4" };
}

function loadAuthEnabled(env: NodeJS.ProcessEnv, host: string): boolean {
  const raw = (env.SQLITEND_AUTH ?? "on").trim().toLowerCase();
  if (raw === "on" || raw === "") return true;
  if (raw !== "off") throw new Error(`invalid SQLITEND_AUTH: "${env.SQLITEND_AUTH}" (expected on|off)`);
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error(`SQLITEND_AUTH=off is only allowed with a loopback SQLITEND_HOST (got ${host})`);
  }
  return false;
}

function oneOf<T extends string>(name: string, raw: string | undefined, allowed: readonly T[], fallback: T): T {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return fallback;
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`invalid ${name}: "${raw}" (expected ${allowed.join("|")})`);
  return v as T;
}
