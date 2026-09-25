// ---------------------------------------------------------------------------
// Replicator — continuous S3 backup of every running database via Litestream.
//
// ONE litestream process PER DATABASE (mirrors one-sqld-per-database):
//   • Litestream logs a database only by its file basename, and every sqld
//     data file is named `data` — a shared process could not attribute errors.
//   • A bad replica (wrong bucket, throttling) cannot stall other databases.
//   • Adding/removing a database never restarts anyone else's replication.
//
// Status comes from Litestream's own JSON log, not from polling S3:
//   "replica sync" {txid:{replica,db}}  → caught up / behind (logged ~every 1-2 s, also when idle)
//   "snapshot complete"                 → last snapshot time
//   level ERROR                         → last error
// This catches the failure mode documented in postgresql-db-infra: Litestream
// 0.5.x stays up (no exit, no restart) while every upload fails with 403.
//
// Replicas live at s3://<bucket>/<prefix>/db/<database id>. Credentials are
// passed via the process environment only — never written to disk.
// ---------------------------------------------------------------------------

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { BackupConfig } from "../config.ts";

export type ReplicaState = "starting" | "ok" | "lagging" | "error" | "stopped";

export interface ReplicaStatus {
  state: ReplicaState;
  txidDb: string | null;
  txidReplica: string | null;
  lastSyncAt: number | null;
  lastSnapshotAt: number | null;
  /** When the replica first fell behind the database (null when caught up). */
  behindSince: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  restarts: number;
  pid: number | null;
  replicaUrl: string;
}

export interface ReplicaTarget {
  id: string;
  status: string;
  data_dir: string;
}

/** sqld keeps the SQLite file at <--db-path>/dbs/default/data (launcher: --db-path <data_dir>/db.sqlite). */
export function sqldDataFile(dataDir: string): string {
  return path.join(dataDir, "db.sqlite", "dbs", "default", "data");
}

export function replicaPath(cfg: Pick<BackupConfig, "prefix">, dbId: string): string {
  return `${cfg.prefix}/db/${dbId}`;
}

/** Litestream config for one database. JSON is valid YAML: no escaping pitfalls. */
export function renderLitestreamConfig(cfg: BackupConfig, dbFile: string, dbId: string): string {
  return JSON.stringify(
    {
      logging: { type: "json", level: "info" },
      dbs: [
        {
          path: dbFile,
          snapshot: { interval: cfg.snapshotInterval, retention: cfg.retention },
          replica: {
            type: "s3",
            bucket: cfg.bucket,
            path: replicaPath(cfg, dbId),
            endpoint: cfg.endpoint,
            region: cfg.region,
            "force-path-style": cfg.forcePathStyle,
          },
        },
      ],
    },
    null,
    2,
  );
}

export function emptyStatus(replicaUrl: string): ReplicaStatus {
  return {
    state: "stopped",
    txidDb: null,
    txidReplica: null,
    lastSyncAt: null,
    lastSnapshotAt: null,
    behindSince: null,
    lastError: null,
    lastErrorAt: null,
    restarts: 0,
    pid: null,
    replicaUrl,
  };
}

/** Fold one Litestream JSON log line into the status (pure; ignores non-JSON). */
export function applyLogLine(s: ReplicaStatus, line: string, now: number): void {
  let e: { level?: string; msg?: string; error?: string; txid?: unknown };
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  if (e.level === "ERROR") {
    s.lastError = `${e.msg ?? "error"}${e.error ? `: ${e.error}` : ""}`.slice(0, 500);
    s.lastErrorAt = now;
    return;
  }
  if (e.msg === "replica sync" && e.txid && typeof e.txid === "object") {
    const t = e.txid as { replica?: string; db?: string };
    s.txidReplica = t.replica ?? s.txidReplica;
    s.txidDb = t.db ?? s.txidDb;
    s.lastSyncAt = now;
    const behind = !!(t.replica && t.db && t.replica < t.db); // fixed-width hex → lexical compare
    s.behindSince = behind ? (s.behindSince ?? now) : null;
    return;
  }
  if (e.msg === "snapshot complete") s.lastSnapshotAt = now;
}

/** Derive the state shown to operators and the health check. */
export function deriveState(s: ReplicaStatus, now: number, maxLagMs: number, running: boolean): ReplicaState {
  if (!running) return "stopped";
  if (s.lastErrorAt !== null && (s.lastSyncAt === null || s.lastErrorAt >= s.lastSyncAt)) return "error";
  if (s.lastSyncAt === null) return "starting";
  // Litestream logs a sync every 1-2 s even when idle; silence means it is stuck.
  if (now - s.lastSyncAt > maxLagMs) return "lagging";
  if (s.behindSince !== null && now - s.behindSince > maxLagMs) return "lagging";
  return "ok";
}

interface Proc {
  child: ChildProcess | null;
  status: ReplicaStatus;
  /** Consecutive failures since the last good sync — drives the backoff. */
  failures: number;
  stopping: boolean;
  restartTimer: ReturnType<typeof setTimeout> | null;
  exited: Promise<void>;
}

export interface ReplicatorDeps {
  config: BackupConfig;
  dataRoot: string;
  listDatabases: () => ReplicaTarget[];
  spawnImpl?: typeof spawn;
  now?: () => number;
  reconcileMs?: number;
  log?: (msg: string) => void;
  /** Called after a litestream process is spawned for a database. */
  onLaunch?: (dbId: string) => void;
}

export class Replicator {
  private readonly procs = new Map<string, Proc>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly d: ReplicatorDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((m) => console.log(m));
  }

  replicaUrl(dbId: string): string {
    return `s3://${this.d.config.bucket}/${replicaPath(this.d.config, dbId)}`;
  }

  private get configDir(): string {
    return path.join(this.d.dataRoot, "litestream");
  }

  /**
   * Stop litestream processes left over from a previous sqlitend that died
   * without shutdown (OOM, SIGKILL). They would otherwise keep writing to the
   * same replica path as the fresh ones — two writers on one replica. Matched
   * strictly: our binary AND a -config inside our config dir. Linux (/proc).
   */
  async sweepOrphans(procRoot = "/proc"): Promise<number> {
    // argv is [binary, replicate, -config, file] — or with a leading
    // interpreter when the binary is a script wrapper: [sh, binary, …].
    const mine = (argv: string[]) => {
      const i = argv[0] === this.d.config.litestreamPath ? 0 : argv[1] === this.d.config.litestreamPath ? 1 : -1;
      return (
        i !== -1 &&
        argv[i + 1] === "replicate" &&
        argv[i + 2] === "-config" &&
        !!argv[i + 3] &&
        path.dirname(argv[i + 3]!) === this.configDir
      );
    };
    const pids: number[] = [];
    let entries: string[] = [];
    try {
      entries = readdirSync(procRoot);
    } catch {
      return 0;
    }
    for (const e of entries) {
      if (!/^\d+$/.test(e) || Number(e) === process.pid) continue;
      try {
        const argv = readFileSync(path.join(procRoot, e, "cmdline"), "utf8").split("\0").filter(Boolean);
        if (mine(argv)) pids.push(Number(e));
      } catch {
        /* process vanished or not ours to read */
      }
    }
    for (const pid of pids) this.signal(pid, "SIGTERM");
    const deadline = Date.now() + 10_000;
    while (pids.some((p) => this.alive(p)) && Date.now() < deadline) await Bun.sleep(100);
    for (const pid of pids) if (this.alive(pid)) this.signal(pid, "SIGKILL");
    if (pids.length) this.log(`[backup] stopped ${pids.length} orphaned litestream process(es) from a previous run`);
    return pids.length;
  }

  private signal(pid: number, sig: NodeJS.Signals): void {
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  }

  private alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    await this.sweepOrphans();
    this.reconcile();
    this.timer = setInterval(() => this.reconcile(), this.d.reconcileMs ?? 5_000);
  }

  /** Replicate every running database; stop replication for the rest. */
  reconcile(): void {
    const rows = this.d.listDatabases();
    const running = new Set(rows.filter((r) => r.status === "running").map((r) => r.id));
    // A database with an entry is either running or waiting out its restart
    // backoff (the exit handler owns restarts) — only brand-new ones launch here.
    for (const r of rows) if (running.has(r.id) && !this.procs.has(r.id)) this.safeLaunch(r);
    for (const id of this.procs.keys()) if (!running.has(id)) void this.stop(id);
  }

  status(dbId: string): ReplicaStatus {
    const p = this.procs.get(dbId);
    if (!p) return emptyStatus(this.replicaUrl(dbId));
    return { ...p.status, state: deriveState(p.status, this.now(), this.d.config.maxLagMs, !!p.child && !p.stopping) };
  }

  /** Stop replicating one database. `removeConfig` when the database is deleted. */
  async stop(dbId: string, opts: { removeConfig?: boolean } = {}): Promise<void> {
    const p = this.procs.get(dbId);
    if (p) {
      p.stopping = true;
      if (p.restartTimer) clearTimeout(p.restartTimer);
      // SIGTERM lets litestream flush pending WAL to the replica before exiting.
      p.child?.kill("SIGTERM");
      const timeout = (ms: number) => new Promise((r) => setTimeout(r, ms));
      await Promise.race([p.exited, timeout(10_000)]);
      if (p.child) {
        p.child.kill("SIGKILL");
        // Wait for it to be gone, or a relaunch could overlap (two writers).
        await Promise.race([p.exited, timeout(5_000)]);
      }
      this.procs.delete(dbId);
    }
    if (opts.removeConfig) rmSync(path.join(this.configDir, `${dbId}.yml`), { force: true });
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.procs.keys()].map((id) => this.stop(id)));
  }

  /** launch() never throws into a timer: a failure (disk full, EACCES) is
   *  recorded on the database and retried with backoff. */
  private safeLaunch(row: ReplicaTarget, prev?: Proc): void {
    try {
      this.launch(row, prev);
    } catch (err) {
      const p = prev ?? this.placeholder(row.id);
      p.child = null;
      p.status.lastError = `could not start litestream: ${(err as Error).message}`;
      p.status.lastErrorAt = this.now();
      this.procs.set(row.id, p);
      this.scheduleRestart(row.id, p);
    }
  }

  private placeholder(dbId: string): Proc {
    return { child: null, status: emptyStatus(this.replicaUrl(dbId)), failures: 0, stopping: false, restartTimer: null, exited: Promise.resolve() };
  }

  private scheduleRestart(dbId: string, p: Proc): void {
    p.failures++;
    p.status.restarts++;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(p.failures, 6));
    this.log(`[backup] ${dbId}: restart #${p.status.restarts} in ${delay / 1000}s (${p.status.lastError})`);
    p.restartTimer = setTimeout(() => {
      const fresh = this.d.listDatabases().find((r) => r.id === dbId && r.status === "running");
      if (this.procs.get(dbId) !== p || p.stopping) return;
      if (fresh) this.safeLaunch(fresh, p);
      else this.procs.delete(dbId);
    }, delay);
  }

  private launch(row: ReplicaTarget, prev?: Proc): void {
    const cfg = this.d.config;
    const dir = this.configDir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const configFile = path.join(dir, `${row.id}.yml`);
    writeFileSync(configFile, renderLitestreamConfig(cfg, sqldDataFile(row.data_dir), row.id), { mode: 0o600 });

    const status = prev?.status ?? emptyStatus(this.replicaUrl(row.id));
    const doSpawn = this.d.spawnImpl ?? spawn;
    const child = doSpawn(cfg.litestreamPath, ["replicate", "-config", configFile], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/",
        LITESTREAM_ACCESS_KEY_ID: cfg.accessKeyId,
        LITESTREAM_SECRET_ACCESS_KEY: cfg.secretAccessKey,
      },
    });
    let resolveExit!: () => void;
    const p: Proc = {
      child,
      status,
      failures: prev?.failures ?? 0,
      stopping: false,
      restartTimer: null,
      exited: new Promise<void>((r) => (resolveExit = r)),
    };
    status.pid = child.pid ?? null;
    this.procs.set(row.id, p);
    this.d.onLaunch?.(row.id);

    for (const stream of [child.stdout, child.stderr]) {
      if (stream) {
        createInterface({ input: stream }).on("line", (l) => {
          applyLogLine(p.status, l, this.now());
          // A good sync ends a failure streak: the next crash backs off from 2 s again.
          if (p.status.lastSyncAt !== null && (p.status.lastErrorAt ?? 0) < p.status.lastSyncAt) p.failures = 0;
        });
      }
    }
    let ended = false;
    const onEnd = (why: string) => {
      if (ended) return;
      ended = true;
      p.child = null;
      status.pid = null;
      resolveExit();
      if (p.stopping) return;
      // Unexpected end (exit, or spawn failure such as a missing binary):
      // record it and restart with capped exponential backoff.
      status.lastError = why;
      status.lastErrorAt = this.now();
      this.scheduleRestart(row.id, p);
    };
    // ENOENT/EACCES fire 'error' without 'exit' — treat both as the end.
    child.on("error", (err) => onEnd(`litestream failed to start: ${err.message}`));
    child.on("exit", (code, signal) => onEnd(`litestream exited (${signal ?? `code ${code}`})`));
  }
}
