import type { Database } from "bun:sqlite";

export interface MetricsHistoryRow {
  database_id: string;
  sampled_at: number;
  status: string;
  cpu_pct: number | null;
  memory_bytes: number;
  disk_bytes: number;
  wal_bytes: number;
  query_count: number;
  query_errors: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
}

export class MetricsRepo {
  constructor(private readonly db: Database) {}

  insertSample(row: MetricsHistoryRow): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO metrics_history(
           database_id, sampled_at, status, cpu_pct, memory_bytes, disk_bytes,
           wal_bytes, query_count, query_errors, p50_ms, p95_ms, p99_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.database_id,
        row.sampled_at,
        row.status,
        row.cpu_pct,
        row.memory_bytes,
        row.disk_bytes,
        row.wal_bytes,
        row.query_count,
        row.query_errors,
        row.p50_ms,
        row.p95_ms,
        row.p99_ms,
      );
  }

  listSince(dbId: string, sinceMs: number, maxPoints = 400): MetricsHistoryRow[] {
    const all = this.db
      .query(
        `SELECT * FROM metrics_history
         WHERE database_id = ? AND sampled_at >= ?
         ORDER BY sampled_at ASC`,
      )
      .all(dbId, sinceMs) as MetricsHistoryRow[];

    if (all.length <= maxPoints) return all;
    const step = all.length / maxPoints;
    const downsampled: MetricsHistoryRow[] = [];
    for (let i = 0; i < maxPoints; i++) {
      downsampled.push(all[Math.floor(i * step)]!);
    }
    if (downsampled.at(-1)?.sampled_at !== all.at(-1)?.sampled_at) {
      downsampled[downsampled.length - 1] = all.at(-1)!;
    }
    return downsampled;
  }

  recordCrash(dbId: string, at: number, reason: string | null): void {
    this.db
      .query("INSERT INTO crash_events(database_id, at, reason) VALUES (?, ?, ?)")
      .run(dbId, at, reason);
    this.db
      .query(
        "UPDATE databases SET crash_count = crash_count + 1, last_crash_at = ?, last_crash_reason = COALESCE(?, last_crash_reason) WHERE id = ?",
      )
      .run(at, reason, dbId);
  }

  countCrashesSince(dbId: string, sinceMs: number): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM crash_events WHERE database_id = ? AND at >= ?")
      .get(dbId, sinceMs) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  availabilitySince(dbId: string, sinceMs: number, currentStatus: string): number {
    const row = this.db
      .query(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN status IN ('crashed', 'failed') THEN 1 ELSE 0 END) AS faulted
         FROM metrics_history
         WHERE database_id = ? AND sampled_at >= ?`,
      )
      .get(dbId, sinceMs) as { total: number; running: number | null; faulted: number | null } | undefined;

    const total = Number(row?.total ?? 0);
    if (total === 0) {
      return currentStatus === "running" ? 100 : currentStatus === "stopped" ? 100 : 0;
    }
    const running = Number(row?.running ?? 0);
    const faulted = Number(row?.faulted ?? 0);
    const activeWindow = running + faulted;
    if (activeWindow === 0) return 100;
    return Number(((running / activeWindow) * 100).toFixed(2));
  }

  /** Prune samples older than 7 days and crash_events older than 30 days. */
  pruneOld(nowMs = Date.now()): void {
    const sevenDaysAgo = nowMs - 7 * 86_400_000;
    const thirtyDaysAgo = nowMs - 30 * 86_400_000;
    this.db.query("DELETE FROM metrics_history WHERE sampled_at < ?").run(sevenDaysAgo);
    this.db.query("DELETE FROM crash_events WHERE at < ?").run(thirtyDaysAgo);
  }
}
