// ---------------------------------------------------------------------------
// Restore-verify — proves each backup is restorable, not just "uploading".
//
// A replica that uploads fine can still be useless (wrong prefix, truncated
// snapshot, a replica of an empty file). The only real proof is a restore, so
// once a day (SQLITEND_BACKUP_VERIFY_AT, server-local HH:MM) and on demand,
// for each running database, one at a time:
//   1. free-space check (a verify must never fill the disk live DBs need)
//   2. litestream restore (latest) → <dataRoot>/verify/<id>/data
//   3. PRAGMA integrity_check = ok
//   4. schema check: restored tables/views/indexes/triggers == the live DB's
//      (catches "valid SQLite, wrong or empty data")
//   5. delete the scratch copy; record the result
// /healthz turns degraded when a database's latest verify failed or its last
// successful one is older than SQLITEND_BACKUP_VERIFY_MAX_AGE_HOURS.
// ---------------------------------------------------------------------------

import { Database as SQLite } from "bun:sqlite";
import { mkdirSync, rmSync, statfsSync, statSync } from "node:fs";
import path from "node:path";
import type { BackupConfig } from "../config.ts";
import type { DatabaseRow } from "../db/repos/databases.ts";
import type { VerificationRow, VerificationsRepo } from "../db/repos/verifications.ts";
import { sqldDataFile } from "./replicator.ts";
import { litestreamReplicaUrl, preflightReplica, verifySqliteFile, type RunLitestream, type S3Like } from "./restore.ts";

/** User schema objects as "type:name", sorted (sqlite_* and litestream internals excluded). */
export function schemaOf(file: string): string[] {
  const db = new SQLite(file, { readonly: true });
  try {
    return (
      db
        .query(
          "SELECT type || ':' || name AS o FROM sqlite_master WHERE type IN ('table','view','index','trigger') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream_%' AND name NOT LIKE 'libsql_%' ORDER BY 1",
        )
        .all() as { o: string }[]
    ).map((r) => r.o);
  } finally {
    db.close();
  }
}

function fileSize(f: string): number {
  try {
    return statSync(f).size;
  } catch {
    return 0;
  }
}

/** Bytes a restore of this database may need: data file + WAL, ×1.2 headroom. */
export function spaceNeeded(liveFile: string): number {
  return Math.ceil((fileSize(liveFile) + fileSize(`${liveFile}-wal`)) * 1.2);
}

export function freeBytes(dir: string): number {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/** Next local HH:MM after `now` (the verify schedule). */
export function nextRunAt(hhmm: string, now: Date): Date {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

export interface VerifyDeps {
  config: BackupConfig;
  dataRoot: string;
  listDatabases: () => DatabaseRow[];
  results: VerificationsRepo;
  run: RunLitestream;
  s3: S3Like;
  preflightTimeoutMs?: number;
  /** "HH:MM" server-local, or null to disable the schedule. */
  scheduleAt: string | null;
  now?: () => Date;
  freeBytes?: (dir: string) => number;
  timeoutMs?: number;
  log?: (m: string) => void;
  onResult?: (row: Omit<VerificationRow, "id">) => void;
}

export class VerifyService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Every verify goes through this serial queue: never two at once (shared
   *  disk budget, scratch dirs), whatever mix of schedule / API calls. */
  private tail: Promise<unknown> = Promise.resolve();
  private batch: Promise<void> | null = null;
  private readonly inQueue = new Map<string, Promise<Omit<VerificationRow, "id">>>();
  private pending = 0;
  private readonly now: () => Date;
  private readonly log: (m: string) => void;
  /** Health grace starts here too, so an upgrade/enable is not instantly "stale". */
  readonly startedAt: number;

  constructor(private readonly d: VerifyDeps) {
    this.now = d.now ?? (() => new Date());
    this.log = d.log ?? ((m) => console.log(m));
    this.startedAt = this.now().getTime();
    // Nothing can be verifying at construction: drop scratch copies a crash left behind.
    rmSync(path.join(d.dataRoot, "verify"), { recursive: true, force: true });
  }

  get busy(): boolean {
    return this.pending > 0;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++;
    const p = this.tail.then(fn).finally(() => this.pending--);
    this.tail = p.catch(() => {});
    return p;
  }

  start(): void {
    if (!this.d.scheduleAt) return;
    const schedule = () => {
      if (this.stopped) return;
      const at = nextRunAt(this.d.scheduleAt!, this.now());
      this.timer = setTimeout(() => {
        this.runAll("schedule")
          .catch((err) => this.log(`[verify] scheduled run failed: ${(err as Error).message}`))
          .finally(schedule);
      }, Math.max(1_000, at.getTime() - this.now().getTime()));
      this.log(`[verify] next restore-verify at ${at.toISOString()}`);
    };
    schedule();
  }

  /** Stop scheduling; an in-flight verify finishes its current database. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Verify every running database, one at a time. Concurrent callers share the batch. */
  runAll(trigger: "schedule" | "manual"): Promise<void> {
    if (this.batch) return this.batch;
    this.batch = (async () => {
      const rows = this.d.listDatabases().filter((r) => r.status === "running");
      let ok = 0;
      for (const row of rows) {
        if (this.stopped) break;
        if ((await this.verifyQueued(row, trigger)).outcome === "ok") ok++;
      }
      this.log(`[verify] ${trigger} run: ${ok}/${rows.length} ok`);
    })().finally(() => (this.batch = null));
    return this.batch;
  }

  /** Verify one database now (queued behind anything running). */
  verifyOneQueued(row: DatabaseRow): Promise<Omit<VerificationRow, "id">> {
    return this.verifyQueued(row, "manual");
  }

  /** Per-database dedupe: a second request for the same id joins the first. */
  private verifyQueued(row: DatabaseRow, trigger: "schedule" | "manual"): Promise<Omit<VerificationRow, "id">> {
    const existing = this.inQueue.get(row.id);
    if (existing) return existing;
    const p = this.enqueue(() => this.verifyOne(row, trigger)).finally(() => this.inQueue.delete(row.id));
    this.inQueue.set(row.id, p);
    return p;
  }

  private async verifyOne(row: DatabaseRow, trigger: "schedule" | "manual"): Promise<Omit<VerificationRow, "id">> {
    const started = this.now().getTime();
    const scratch = path.join(this.d.dataRoot, "verify", row.id);
    const out = path.join(scratch, "data");
    const done = (outcome: "ok" | "failed", detail: string | null, bytes: number | null = null) => {
      rmSync(scratch, { recursive: true, force: true });
      const r = { database_id: row.id, started_at: started, finished_at: this.now().getTime(), outcome, detail, restored_bytes: bytes, trigger };
      this.d.results.record(r);
      this.d.onResult?.(r);
      if (outcome === "failed") this.log(`[verify] ${row.slug}: FAILED: ${detail}`);
      return r;
    };
    try {
      const live = sqldDataFile(row.data_dir);
      rmSync(scratch, { recursive: true, force: true });
      mkdirSync(scratch, { recursive: true, mode: 0o700 });
      const need = spaceNeeded(live);
      const free = (this.d.freeBytes ?? freeBytes)(scratch);
      if (free < need + 256 * 1024 * 1024) {
        return done("failed", `not enough free disk to verify safely (need ~${Math.ceil(need / 1e6)} MB + 256 MB reserve, free ${Math.floor(free / 1e6)} MB)`);
      }

      const pre = await preflightReplica(this.d.s3, this.d.config, row.id, this.d.preflightTimeoutMs);
      if (pre) return done("failed", pre);

      const r = await this.d.run(["restore", "-o", out, litestreamReplicaUrl(this.d.config, row.id)], this.d.timeoutMs ?? 60 * 60_000);
      if (r.code !== 0) return done("failed", `restore exited ${r.code}: ${r.output.trim().slice(-500)}`);
      if (!(await Bun.file(out).exists())) return done("failed", "restore produced no file (no replica?)");
      const bytes = fileSize(out);

      const bad = verifySqliteFile(out);
      if (bad) return done("failed", bad, bytes);

      // Schema must match the live database (read-only open of the live file is
      // safe beside sqld: WAL mode, shared readers).
      const restoredSchema = schemaOf(out);
      let liveSchema: string[];
      try {
        liveSchema = schemaOf(live);
      } catch (err) {
        // Not a backup problem: the live file could not be opened read-only
        // (e.g. its -shm is not readable by this user). Say so distinctly.
        return done("failed", `restored copy is valid, but the live schema could not be read to compare: ${(err as Error).message}`, bytes);
      }
      const missing = liveSchema.filter((o) => !restoredSchema.includes(o));
      const extra = restoredSchema.filter((o) => !liveSchema.includes(o));
      if (missing.length || extra.length) {
        // Note: a migration applied seconds before the verify can show up here
        // while the replica catches up; the next run clears it.
        return done(
          "failed",
          `schema differs from live: ${missing.length ? `missing ${missing.slice(0, 5).join(", ")}` : ""}${missing.length && extra.length ? "; " : ""}${extra.length ? `extra ${extra.slice(0, 5).join(", ")}` : ""}`,
          bytes,
        );
      }
      return done("ok", `${restoredSchema.length} schema objects, integrity ok`, bytes);
    } catch (err) {
      return done("failed", (err as Error).message.slice(0, 500));
    }
  }
}

/** Health view of verification for one database. */
/**
 * Health view of verification for one database. `graceFrom` is the later of
 * the database's creation and the verifier's start, so neither a new
 * database nor a fresh upgrade / enable is "stale" before its first run.
 */
export function verifyHealth(
  latest: VerificationRow | null,
  latestOk: VerificationRow | null,
  graceFrom: number,
  now: number,
  maxAgeMs: number,
): "ok" | "failed" | "stale" | "pending" {
  if (latest?.outcome === "failed") return "failed";
  if (latestOk && now - latestOk.finished_at <= maxAgeMs) return "ok";
  if (!latestOk && now - graceFrom <= maxAgeMs) return "pending";
  return "stale";
}
