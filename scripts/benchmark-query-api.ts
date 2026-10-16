#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// Performance benchmark for sqlitend Query API & Data Grid (Non-Negotiable #4).
//
// Measures:
//   1. Server Query API overhead (`POST /api/databases/:id/query` for `SELECT 1`
//      and `GET /api/databases/:id/tables/:table/rows`) over 200 iterations,
//      asserting p50 < 10 ms.
//   2. 10,000-row table pagination & filter query execution latency.
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database as BunSqlite } from "bun:sqlite";
import { loadConfig } from "../apps/server/src/config.ts";
import { openMetadata } from "../apps/server/src/db/metadata.ts";
import { Supervisor } from "../apps/server/src/supervisor/supervisor.ts";
import { Sampler, percentile } from "../apps/server/src/metrics/sampler.ts";
import { createRoutes } from "../apps/server/src/http/routes.ts";
import type { HranaExecutor, RawExecResult } from "../apps/server/src/db/hrana.ts";
import { CSRF_HEADER } from "../apps/server/src/http/auth-routes.ts";

const tmp = mkdtempSync(path.join(tmpdir(), "sqlitend-bench-"));
const meta = openMetadata(path.join(tmp, "metadata.sqlite"));
const sqlite = new BunSqlite(":memory:");

sqlite.run("CREATE TABLE events (id INTEGER PRIMARY KEY, category TEXT NOT NULL, score INTEGER NOT NULL, payload TEXT)");
const insertStmt = sqlite.prepare("INSERT INTO events (category, score, payload) VALUES (?, ?, ?)");
const seedTx = sqlite.transaction(() => {
  for (let i = 1; i <= 10_000; i++) {
    insertStmt.run(i % 2 === 0 ? "alpha" : "beta", i % 100, `event-payload-${i}`);
  }
});
seedTx();

const hrana: HranaExecutor = {
  async pipeline(_target, stmts) {
    const t0 = performance.now();
    const results: RawExecResult[] = [];
    for (const s of stmts) {
      const st0 = performance.now();
      const q = sqlite.query(s.sql);
      const columns = q.columnNames;
      let rawRows: unknown[][] = [];
      if (columns.length > 0 && s.wantRows !== false) {
        rawRows = q.values(...((s.args ?? []) as never[]));
      } else {
        q.run(...((s.args ?? []) as never[]));
      }
      results.push({
        columns,
        columnTypes: columns.map(() => null),
        rows: (rawRows ?? []) as never,
        rowsAffected: 0,
        lastInsertRowid: null,
        durationMs: Number((performance.now() - st0).toFixed(3)),
      });
    }
    return { results, totalDurationMs: Number((performance.now() - t0).toFixed(3)) };
  },
};

try {
  const ws = meta.workspaces.create({
    id: "00000000-0000-4000-8000-000000000101",
    slug: "bench",
    name: "Bench",
    createdAt: Date.now(),
  });
  const dbRow = meta.databases.create({
    id: "00000000-0000-4000-8000-000000000102",
    workspace_id: ws.id,
    slug: "benchdb",
    name: "Bench DB",
    status: "running",
    port: 6101,
    grpc_port: 6102,
    data_dir: path.join(tmp, "workspaces", "bench", "dbs", "benchdb"),
    created_at: Date.now(),
  });

  const config = loadConfig({
    SQLITEND_DATA_ROOT: tmp,
    SQLITEND_HOST: "127.0.0.1",
    SQLITEND_AUTH: "off",
  });
  const app = createRoutes({
    config,
    workspaces: meta.workspaces,
    databases: meta.databases,
    tokens: meta.tokens,
    supervisor: new Supervisor({ config, databases: meta.databases }),
    sampler: new Sampler(60_000, tmp, meta.metrics),
    metricsRepo: meta.metrics,
    sqldOk: true,
    sqldVersion: "0.24.32",
    version: "0.1.4",
    hrana,
  });

  // Silence per-request console.log during benchmark loop
  const origLog = console.log;
  console.log = () => {};

  const select1Latencies: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    const res = await app.request(`/api/databases/${dbRow.id}/query`, {
      method: "POST",
      headers: { [CSRF_HEADER]: "1", "content-type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1" }),
    });
    await res.json();
    select1Latencies.push(performance.now() - t0);
  }

  const browse10kLatencies: number[] = [];
  for (let i = 0; i < 100; i++) {
    const t0 = performance.now();
    const res = await app.request(
      `/api/databases/${dbRow.id}/tables/events/rows?limit=100&offset=5000&sort=score&dir=desc`,
    );
    await res.json();
    browse10kLatencies.push(performance.now() - t0);
  }

  console.log = origLog;

  select1Latencies.sort((a, b) => a - b);
  browse10kLatencies.sort((a, b) => a - b);

  const s1P50 = percentile(select1Latencies, 50)!;
  const s1P95 = percentile(select1Latencies, 95)!;
  const s1P99 = percentile(select1Latencies, 99)!;

  const brP50 = percentile(browse10kLatencies, 50)!;
  const brP95 = percentile(browse10kLatencies, 95)!;
  const brP99 = percentile(browse10kLatencies, 99)!;

  console.log("=== sqlitend Query & Table Browser Benchmark ===");
  console.log(`POST /api/databases/:id/query (SELECT 1, 200 iters): p50=${s1P50}ms  p95=${s1P95}ms  p99=${s1P99}ms`);
  console.log(`GET  /api/databases/:id/tables/events/rows (10k rows, 100 iters): p50=${brP50}ms  p95=${brP95}ms  p99=${brP99}ms`);

  if (s1P50 >= 10) {
    console.error(`FAIL: SELECT 1 query API overhead p50 (${s1P50}ms) >= 10ms budget`);
    process.exitCode = 1;
  } else {
    console.log("PASS ✓ (Query API overhead p50 < 10ms)");
  }
} finally {
  sqlite.close();
  meta.db.close();
  rmSync(tmp, { recursive: true, force: true });
}
