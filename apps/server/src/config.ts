import path from "node:path";
import os from "node:os";

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
  /** Control-plane listener bind address (host is fixed to 127.0.0.1). */
  port: number;
  host: string;
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
}

const DEFAULT_HOST = "127.0.0.1";
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

  return {
    port,
    host: DEFAULT_HOST,
    portRange: env.SQLITEND_PORT_RANGE ? parsePortRange(env.SQLITEND_PORT_RANGE) : DEFAULT_PORT_RANGE,
    dataRoot,
    sqldPath: (env.SQLITEND_SQLD_PATH && env.SQLITEND_SQLD_PATH.length > 0)
      ? env.SQLITEND_SQLD_PATH
      : path.join(repoRoot, "bin", "sqld"),
    tokenTtlHours: parsePositiveInt("SQLITEND_TOKEN_TTL_HOURS", env.SQLITEND_TOKEN_TTL_HOURS, DEFAULT_TOKEN_TTL_HOURS, 1, 24 * 365),
    sampleIntervalMs: parsePositiveInt("SQLITEND_SAMPLE_INTERVAL_MS", env.SQLITEND_SAMPLE_INTERVAL_MS, 5000, 250, 600_000),
    readyTimeoutMs: parsePositiveInt("SQLITEND_READY_TIMEOUT_MS", env.SQLITEND_READY_TIMEOUT_MS, 10_000, 500, 120_000),
    maxBodyBytes: parsePositiveInt("SQLITEND_MAX_BODY_BYTES", env.SQLITEND_MAX_BODY_BYTES, 1_000_000, 1024, 64 * 1024 * 1024),
    ...overrides,
  };
}
