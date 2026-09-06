// ---------------------------------------------------------------------------
// sqld launcher — spawns and supervises one sqld subprocess per database.
//
// ════════════════════════════════════════════════════════════════════════════
// STEP-1 SPIKE FINDINGS (validated empirically against the real binary)
// Binary: sqld 0.24.32 (libsql-server-v0.24.32, fetched by scripts/fetch-sqld.sh)
// ==================================================================
// Flags (file-backed single-DB mode), all CONFIRMED working:
//   --db-path <path>                    file-backed DB; the path appears in
//                                       argv → used as the orphan-scan marker.
//   --http-listen-addr <host:port>      HTTP + Hrana listener.
//   --grpc-listen-addr <host:port>      accepts an EXPLICIT port and binds it
//                                       (verified: port opened). grpcUrl uses this.
//   --auth-jwt-key-file <file>          Ed25519 PUBLIC key: PKCS#8 PEM, or the
//                                       raw Ed25519 public key bytes in URL-safe
//                                       base64. Env alias: SQLD_AUTH_JWT_KEY.
//                                       sqlitend passes the PER-DATABASE
//                                       keys/<dbId>.pub here (see auth/tokens.ts
//                                       for why the key is not platform-wide).
//   --no-welcome                        suppress welcome banner.
//
// Readiness: GET /health returns 200 once up. Root / returns 404 (NOT a ready
// signal). Wait-for-ready = TCP connect to the http port then GET /health,
// within the readyTimeout budget (default 10s). On timeout the child is
// reaped (TERM → KILL) and the result carries the captured stderr tail; the
// SUPERVISOR persists that tail to databases.failed_reason.
//
// Hrana path: /v2/pipeline is the Hrana-over-HTTP endpoint @libsql/client
// speaks. httpUrl = http://127.0.0.1:<port>; hranaUrl = ws://127.0.0.1:<port>;
// grpcUrl = http://127.0.0.1:<grpc_port> (all backed by persisted ports).
//
// AUTH MODEL: one Ed25519 keypair PER DATABASE (auth/tokens.ts); every sqld
// only ever sees its own database's public key, so a token minted for DB A is
// rejected by DB B (claims are not enforced by sqld — the key is the scope).
//
// USER_HZ / CLK_TCK note: /proc/<pid>/stat field 22 (starttime) is expressed in
// USER_HZ clock ticks since boot (typically 100 on Linux, CLK_TCK), NOT ms.
// Converting to epoch ms is  starttime / CLK_TCK * 1000 + btime_ms. The SAME
// CLK_TCK constant and conversion MUST be shared by the launcher (where
// databases.start_time is written), reconcile (pid-reuse compare), and sampler
// (uptimeSec) or the values drift by a tick-scale factor.
// ════════════════════════════════════════════════════════════════════════════
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import path from "node:path";
import { assertInside } from "../util/paths.ts";
import type { Config } from "../config.ts";

/** Unix USER_HZ = number of clock ticks per second (CLK_TCK). On Linux this
 *  is almost always 100. */
export const CLK_TCK = 100;

let bootEpochSecCache: number | null = null;
export function bootEpochMs(): number {
  if (bootEpochSecCache == null) {
    // /proc/stat second line "btime <unix-seconds>".
    const stat = readFileSync("/proc/stat", "utf8");
    const m = /^btime\s+(\d+)$/m.exec(stat);
    bootEpochSecCache = m ? Number(m[1]) * 1000 : Date.now();
  }
  return bootEpochSecCache;
}

/** Epoch-ms of process start for /proc/<pid>, from stat field 22 + btime.
 *  The SAME function is used by launcher, reconcile, and sampler so the
 *  pid-reuse compare and uptime math never drift. Returns 0 if unreadable. */
export function procStartEpochMs(pid: number): number {
  let stat = "";
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return 0;
  }
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const startTicks = Number(fields[19]); // field 22 → idx 19 (offset-3 after comm's close paren)
  if (!Number.isFinite(startTicks)) return 0;
  const btimeSec = bootEpochMs() / 1000;
  return Math.round((btimeSec + startTicks / CLK_TCK) * 1000);
}

/** Return the set of PIDs currently alive in /proc. */
export function livePids(): Set<number> {
  const out = new Set<number>();
  let entries: string[] = [];
  try {
    entries = readdirSync("/proc", { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const n of entries) out.add(Number(n));
  return out;
}

export type DatabaseStatusValue =
  | "starting"
  | "running"
  | "stopped"
  | "crashed"
  | "failed"
  | "deleting";

export interface LauncherDeps {
  config: Config;
}

export function sqldVersion(sqldPath: string): string {
  try {
    const out = Bun.spawnSync([sqldPath, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 2000 });
    return out.stdout.toString().trim() || out.stderr.toString().trim();
  } catch {
    return "";
  }
}

async function probeHttp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  // Each probe must fit inside the launcher's remaining budget. The old fixed
  // 2s socket/fetch timeouts could make a 500ms configured ready timeout take
  // several seconds per attempt, defeating both the config and failure tests.
  const probeTimeout = Math.max(1, Math.min(2000, timeoutMs));
  // TCP connect first.
  const tcp = await new Promise<boolean>((resolve) => {
    const sock = createConnection({ host, port, timeout: probeTimeout });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
    sock.once("error", () => resolve(false));
  });
  if (!tcp) return false;
  // Then the /health check.
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(probeTimeout) });
    return res.status === 200;
  } catch {
    return false;
  }
}

export interface LaunchSpec {
  dataDir: string;
  port: number;
  grpcPort: number;
  /** THIS database's public-key file (per-DB signing key, auth/tokens.ts). */
  authPubFile: string;
}

export interface LaunchHooks {
  /**
   * Invoked SYNCHRONOUSLY after spawn, before the readiness wait, with the
   * live child + pid. The supervisor uses it to register the child and
   * persist pid/start_time immediately, so a control-plane crash during the
   * readiness wait can never leave a live, untracked sqld behind.
   */
  onSpawn?: (child: import("node:child_process").ChildProcess, pid: number) => void;
}

/** Read at a call boundary so TS flow analysis cannot conclude the callback-
 *  assigned variable is statically null. */
function spawnErrorMessage(err: Error | null): string | null {
  return err ? err.message : null;
}

export interface LaunchResult {
  ok: boolean;
  child?: import("node:child_process").ChildProcess;
  stderrTail?: string;
  sqldVersionAtLaunch: string;
  pid?: number;
  startTimeMs?: number;
  error?: string;
}

/** Spawn sqld for one database and wait until it is ready (or failed). */
export async function launchSqld(
  deps: LauncherDeps,
  spec: LaunchSpec,
  hooks: LaunchHooks = {},
): Promise<LaunchResult> {
  const { config } = deps;
  const { dataDir, port, grpcPort, authPubFile } = spec;

  // Guard the binary FIRST — a missing/unusable sqld must fail with a clear
  // error here, never reach spawn() (whose async "error" event would otherwise
  // surface as an uncaught exception on the control plane).
  const ver = sqldVersion(config.sqldPath);
  if (!ver || config.sqldPath.length === 0) {
    return {
      ok: false,
      sqldVersionAtLaunch: "",
      error: `sqld binary not found or unusable at ${config.sqldPath} — run scripts/fetch-sqld.sh`,
    };
  }

  // A corrupted data_dir must never be mkdir'd (or rm'd, or read recursively)
  // outside the data root.
  assertInside(config.dataRoot, dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  // sqld binds the same address as the control plane (0.0.0.0 by default), so
  // databases are reachable wherever the dashboard is. Readiness still probes
  // loopback — a wildcard listener answers on it too.
  const listenHost = (config.host === "::" || config.host === "*") ? "0.0.0.0" : config.host;
  const args = [
    "--db-path", path.join(dataDir, "db.sqlite"),
    "--http-listen-addr", `${listenHost}:${port}`,
    "--grpc-listen-addr", `${listenHost}:${grpcPort}`,
    "--no-welcome",
  ];
  if (authPubFile && authPubFile.length > 0) {
    args.push("--auth-jwt-key-file", authPubFile);
  }

  let stderr = "";
  let spawnError: Error | null = null;
  const child = spawn(config.sqldPath, args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  // Without this handler a spawn failure (ENOENT, EACCES, EMFILE) escapes as
  // an uncaught "error" event and takes the control plane down.
  child.on("error", (err: Error) => {
    spawnError = err;
  });
  child.stderr?.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4096);
  });

  const pid = child.pid;
  if (pid && hooks.onSpawn) hooks.onSpawn(child, pid);

  const deadline = Date.now() + config.readyTimeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode != null || spawnError) break; // exited early / never started
    if (await probeHttp("127.0.0.1", port, config.readyTimeoutMs)) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!ready) {
    // Reap the failed child so it never lingers as an untracked process holding
    // the data-dir lock or the port: TERM, short grace, then KILL, awaiting exit.
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((r) => child.once("exit", () => r())),
      new Promise<boolean>((r) => setTimeout(() => r(true), 2000)),
    ]);
    if (child.exitCode == null) {
      child.kill("SIGKILL");
      await Promise.race([
        new Promise<void>((r) => child.once("exit", () => r())),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
    }
    return {
      ok: false,
      child,
      stderrTail: stderr.slice(-1024),
      sqldVersionAtLaunch: ver,
      pid,
      error: spawnErrorMessage(spawnError) ?? `sqld did not become ready on :${port} within ${config.readyTimeoutMs}ms`,
    };
  }

  const startTimeMs = (pid ? procStartEpochMs(pid) : 0) || Date.now();
  return { ok: true, child, sqldVersionAtLaunch: ver, pid, startTimeMs };
}
