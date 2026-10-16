# sqlitend UI Redesign + Built-in DB Client — Phase 0 Plan

## 1. Current Architecture (15 lines)
1. **Runtime & Stack:** Bun (>=1.1) + Hono (`apps/server`) control plane; React 18 + Vite SPA (`apps/web`) served from `apps/web/dist`; shared Zod schemas & TypeScript types in `packages/shared`.
2. **Metadata Layer:** `bun:sqlite` in WAL mode (`<dataRoot>/metadata.sqlite`) with 8 idempotent forward migrations (`001_init.sql`..`008_token_value.sql`) and typed repos (`workspaces`, `databases`, `tokens`, `auth`, `verifications`).
3. **Process Supervisor:** `Supervisor` spawns one `sqld` subprocess per database with an allocated HTTP+gRPC port pair (`6101-6300`), tracks child/adopted PIDs via `/proc/<pid>/stat` `start_time`, reconciles on boot, and sweeps orphaned `sqld` processes.
4. **Database Isolation & Auth:** Each database gets an Ed25519 keypair at `<dataRoot>/keys/<dbId>.{key,pub}` (`0600`); `sqld` receives `--auth-jwt-key-file <dbId>.pub` and `mintToken()` signs EdDSA JWTs (`full` scope only, as `sqld` 0.24.32 rejects `p` claims).
5. **Control-Plane Auth & Security:** Single-operator Argon2id password + optional TOTP (`AuthService`, CLI-provisioned), HttpOnly `SameSite=Strict` session cookies (`sqlitend_session`), `X-Sqlitend-Csrf: 1` header gate on mutations, DNS-rebinding `Host` allowlist, `Sec-Fetch-Site` check, and `audit_log` table.
6. **Gateway & DNS:** Optional host-routed HTTP Hrana proxy (`src/gateway/gateway.ts`) validating token `jti`/expiry/revocation/signature before forwarding to `127.0.0.1:<port>`, paired with optional Cloudflare Tunnel CNAME sync (`src/dns`).
7. **Backups & Imports:** Optional Litestream S3 continuous replication (`src/backup/replicator.ts`), point-in-time restore into a new DB (`restore.ts`), scheduled restore-verification (`verify.ts`), AES-256-GCM control-plane snapshots (`control.ts`), and `<dataRoot>/imports/` file import (`import.ts`).
8. **Metrics Sampler:** `Sampler` (`src/metrics/sampler.ts`) polls `/proc/<pid>/stat` (CPU ticks delta), `/proc/<pid>/status` (`VmRSS`), and `dataDir` recursive byte sum every `sampleIntervalMs` (default 5s), keeping only the latest sample in memory per DB.
9. **Current Web UI:** State-switched views in `App.tsx` (`list`, `detail`, `activity`, `backups`), 5s polling on `DatabasesPage` and `DatabaseDetail`, plain dark CSS (`styles.css`), modals (`CreateWorkspaceDialog`, `CreateDatabaseDialog`, `RestoreDialog`, `TokenReveal`), and `AuthGate` session wrapper.
10. **Current Limitations:** No SQL query or schema inspection API, no table data viewer/editor, no persisted historical metrics or crash counters, workspace/DB deletion is immediate `rm -rf` with only a client-side name prompt, and layout is desktop-first (`260px` sidebar breaking at `720px`).

---

## 2. Proposed API Additions & Changes (`packages/shared/src/index.ts` + `apps/server`)

### 2.1 Operator Authentication Extension (`SQLITEND_ADMIN_TOKEN`)
The server already has session-cookie auth (`AuthService` + `installAuth`), and `SQLITEND_AUTH=off` is already refused unless `SQLITEND_HOST` is loopback (`127.0.0.1`, `::1`, `localhost`). To fulfill Phase 1's `SQLITEND_ADMIN_TOKEN` requirement while preserving existing session/TOTP login:
- **Config & Startup Rule:** Add `adminToken: string | null` from `SQLITEND_ADMIN_TOKEN`. When `host` is non-loopback (`!["127.0.0.1", "::1", "localhost"].includes(host)`), require either `SQLITEND_ADMIN_TOKEN` (non-empty) OR an existing admin password in `metadata.sqlite` — **and specifically if `SQLITEND_ADMIN_TOKEN` is required by the Phase 1 spec when `host !== "127.0.0.1"` and `authEnabled` is on without an admin row, refuse to start unless `SQLITEND_ADMIN_TOKEN` is set** (specifically: in `loadConfig`, if `host !== "127.0.0.1" && host !== "::1" && host !== "localhost"` and `!env.SQLITEND_ADMIN_TOKEN?.trim()`, throw a startup error unless explicitly overridden in test config).
- **Constant-Time Verification:** Compare `Authorization: Bearer <token>` or session cookie against `SQLITEND_ADMIN_TOKEN` using `crypto.timingSafeEqual` on SHA-256 digests (so token length is not leaked via early return).
- **Login Endpoint Support:** `POST /api/auth/login` accepts `{ token?: string, password?: string, totp?: string }`. When `token` matches `SQLITEND_ADMIN_TOKEN` (constant-time), set the HttpOnly `SameSite=Strict` cookie (`sqlitend_session`) so browser clients can log in with either the admin token or the Argon2id password. Bearer token on any `/api/*` request authenticates directly as `actor: "admin"`.

### 2.2 Server-Side Hrana Execution Helper (`apps/server/src/db/hrana.ts`)
- Mints a short-lived (60s TTL) in-memory JWT via `mintToken` (never persisted to `tokens` table, never sent to the browser) and calls `http://127.0.0.1:<db.port>/v2/pipeline` (sqld HTTP Hrana v2 protocol).
- Enforces statement timeout via `AbortSignal.timeout(timeoutMs)` (default `10_000` ms, max `60_000` ms).
- Records query execution duration and error status into the per-DB query latency/error tracker for Phase 3 metrics.

### 2.3 Endpoints & Zod Schemas

#### A. `GET /api/databases/:id/schema`
Introspects `sqlite_schema` and `PRAGMA table_info` / `PRAGMA index_list` / `PRAGMA index_info` / `PRAGMA foreign_key_list` via Hrana read-only pipeline, plus cheap row-count estimates (`SELECT count(*) FROM (SELECT 1 FROM "tbl" LIMIT 10001)` or `sqlite_stat1` when available).

```ts
export const ColumnInfoSchema = z.object({
  cid: z.number().int(),
  name: z.string(),
  type: z.string(),
  notnull: z.boolean(),
  defaultValue: z.string().nullable(),
  pk: z.number().int(), // 0 = not pk, 1..N = pk column order
});

export const ForeignKeyInfoSchema = z.object({
  id: z.number().int(),
  seq: z.number().int(),
  table: z.string(),
  from: z.string(),
  to: z.string(),
  onUpdate: z.string(),
  onDelete: z.string(),
});

export const IndexInfoSchema = z.object({
  name: z.string(),
  unique: z.boolean(),
  origin: z.string(), // 'c' | 'u' | 'pk'
  partial: z.boolean(),
  columns: z.array(z.string()),
  sql: z.string().nullable(),
});

export const TableSchemaItemSchema = z.object({
  name: z.string(),
  type: z.enum(["table", "view"]),
  sql: z.string().nullable(),
  withoutRowid: z.boolean(),
  rowCountEstimate: z.number().int().nullable(),
  columns: z.array(ColumnInfoSchema),
  primaryKey: z.array(z.string()), // ordered PK column names; empty if none (uses rowid)
  indexes: z.array(IndexInfoSchema),
  foreignKeys: z.array(ForeignKeyInfoSchema),
});

export const DatabaseSchemaResponseSchema = z.object({
  tables: z.array(TableSchemaItemSchema),
  refreshedAt: z.number().int(),
});
```

#### B. `POST /api/databases/:id/query`
Executes single or multi-statement SQL scripts (split with `splitSql`, extended to handle `BEGIN ... END` trigger blocks safely).
- `readOnly` defaults to `true`. When `readOnly: true`, each statement is checked against a strict read-only classifier (`SELECT`, `EXPLAIN`, safe read `PRAGMA`s, `VALUES`, `WITH ... SELECT`) AND wrapped in `BEGIN DEFERRED; ... ROLLBACK;` (or `PRAGMA query_only = ON`) so any write attempt is rejected before touching disk.
- Server-side hard row cap: default `1000`, max `10000`. Fetches `limit + 1` rows from Hrana stream or slices at `limit` and sets `truncated: true`.

```ts
export const SqlValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const QueryRequestSchema = z.object({
  sql: z.string().min(1).max(200_000),
  params: z.union([z.array(SqlValueSchema), z.record(z.string(), SqlValueSchema)]).optional(),
  readOnly: z.boolean().default(true),
  limit: z.number().int().min(1).max(10_000).default(1000),
  timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
}).strict();

export const StatementResultSchema = z.object({
  statement: z.string(),
  columns: z.array(z.string()),
  columnTypes: z.array(z.string().nullable()).optional(),
  rows: z.array(z.array(SqlValueSchema)),
  rowsAffected: z.number().int(),
  lastInsertRowid: z.string().nullable(),
  durationMs: z.number(),
  truncated: z.boolean(),
});

export const QueryResponseSchema = z.object({
  results: z.array(StatementResultSchema),
  totalDurationMs: z.number(),
});
```

#### C. `GET /api/databases/:id/tables/:table/rows`
Structured table browsing with validated identifiers and bound parameters.
- Validates `:table` against live `PRAGMA table_list` / `sqlite_schema` before building SQL.
- Validates `sort` column and every `filters[i].col` against `PRAGMA table_info(:table)` (plus `"rowid"` if not `WITHOUT ROWID`). Unknown column/table → `400 bad_request`.
- Quotes all identifiers with `"ident.replace(/"/g, '""')"` after allowlist verification, and binds all filter values as positional `?` parameters.
- Query params:
  - `limit`: `1..1000` (default `100`)
  - `offset`: `>= 0` (default `0`)
  - `cursor`: optional JSON-encoded keyset cursor for PK/rowid paging
  - `sort`: column name
  - `dir`: `"asc" | "desc"` (default `"asc"`)
  - `filters`: JSON-encoded `TableFilter[]`

```ts
export const FilterOpSchema = z.enum([
  "=", "!=", "<", "<=", ">", ">=", "like", "isnull", "notnull", "in",
]);

export const TableFilterSchema = z.object({
  col: z.string().min(1).max(128),
  op: FilterOpSchema,
  value: z.union([
    SqlValueSchema,
    z.array(SqlValueSchema).max(500),
  ]).optional(),
}).strict();

export const TableRowsResponseSchema = z.object({
  table: z.string(),
  columns: z.array(ColumnInfoSchema),
  primaryKey: z.array(z.string()), // if empty and not withoutRowid, ["_rowid_"] is included
  hasRowid: z.boolean(),
  rows: z.array(z.record(z.string(), SqlValueSchema)),
  total: z.number().int().nullable(), // populated when table is small/cheap, else null
  hasMore: z.boolean(),
  nextOffset: z.number().int().nullable(),
  durationMs: z.number(),
});
```

#### D. `POST /api/databases/:id/tables/:table/rows` (Insert)
#### E. `PATCH /api/databases/:id/tables/:table/rows` (Update by PK/rowid)
#### F. `DELETE /api/databases/:id/tables/:table/rows` (Delete by PK/rowid list)
All three run inside a single Hrana interactive transaction (`BEGIN IMMEDIATE ... COMMIT` in one pipeline batch), validate table & column names against schema, bind all values as parameters, and return `{ affected: number, durationMs: number, lastInsertRowid?: string | null }`.

```ts
export const InsertRowsRequestSchema = z.object({
  rows: z.array(z.record(z.string(), SqlValueSchema)).min(1).max(500),
}).strict();

export const UpdateRowsRequestSchema = z.object({
  updates: z.array(z.object({
    pk: z.record(z.string(), SqlValueSchema), // PK column(s) or { _rowid_: N }
    values: z.record(z.string(), SqlValueSchema),
  })).min(1).max(500),
}).strict();

export const DeleteRowsRequestSchema = z.object({
  pks: z.array(z.record(z.string(), SqlValueSchema)).min(1).max(1000),
}).strict();

export const MutateRowsResponseSchema = z.object({
  affected: z.number().int(),
  lastInsertRowid: z.string().nullable().optional(),
  durationMs: z.number(),
});
```

#### G. Phase 3 Metrics & Stability Endpoints
- Migration `009_metrics_and_stability.sql`:
  - Adds `crash_count INTEGER NOT NULL DEFAULT 0`, `last_crash_at INTEGER`, `last_crash_reason TEXT`, `restart_count INTEGER NOT NULL DEFAULT 0` to `databases`.
  - Creates `metrics_history(database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE, sampled_at INTEGER NOT NULL, status TEXT NOT NULL, cpu_pct REAL, memory_bytes INTEGER NOT NULL, disk_bytes INTEGER NOT NULL, wal_bytes INTEGER NOT NULL DEFAULT 0, query_count INTEGER NOT NULL DEFAULT 0, query_errors INTEGER NOT NULL DEFAULT 0, p50_ms REAL, p95_ms REAL, p99_ms REAL, PRIMARY KEY (database_id, sampled_at))` with pruning/downsampling in `Sampler` (keeps 5s samples for 1h, 1m rollups for 24h, 15m rollups for 7d).
- `GET /api/databases/:id/metrics/history?range=1h|24h|7d`
- `GET /api/databases/:id/storage` — on-demand `PRAGMA page_count`, `PRAGMA page_size`, `PRAGMA freelist_count`, `PRAGMA journal_mode`, WAL file bytes, and per-table row counts.
- `GET /api/metrics/overview` — batch summary for all databases (latest metrics, 24h availability %, crash count in 24h, stability badge state, and compact CPU/memory/latency sparkline arrays) so the dashboard loads in 1 request instead of `N` polling requests.

```ts
export const StabilityBadgeSchema = z.object({
  level: z.enum(["healthy", "warning", "degraded", "stopped"]),
  label: z.string(),
  rule: z.string(), // e.g. "0 crashes in 24h and >= 99.9% availability"
  availabilityPct24h: z.number(),
  crashes24h: z.number().int(),
  totalCrashes: z.number().int(),
  restartCount: z.number().int(),
  lastCrashAt: z.number().int().nullable(),
  lastCrashReason: z.string().nullable(),
});

export const MetricsHistoryPointSchema = z.object({
  t: z.number().int(), // epoch ms
  status: DatabaseStatusSchema,
  cpuPct: z.number().nullable(),
  memoryBytes: z.number().int(),
  diskBytes: z.number().int(),
  walBytes: z.number().int(),
  queryCount: z.number().int(),
  queryErrors: z.number().int(),
  p50Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
  p99Ms: z.number().nullable(),
});

export const MetricsHistoryResponseSchema = z.object({
  range: z.enum(["1h", "24h", "7d"]),
  points: z.array(MetricsHistoryPointSchema),
  diskGrowthBytesPerHour: z.number().nullable(),
  stability: StabilityBadgeSchema,
  latency: z.object({
    p50Ms: z.number().nullable(),
    p95Ms: z.number().nullable(),
    p99Ms: z.number().nullable(),
    totalQueries: z.number().int(),
    totalErrors: z.number().int(),
    errorRatePct: z.number(),
  }),
});

export const StorageStatsResponseSchema = z.object({
  pageCount: z.number().int(),
  pageSize: z.number().int(),
  freelistCount: z.number().int(),
  walBytes: z.number().int(),
  diskBytes: z.number().int(),
  tableRowCounts: z.array(z.object({ name: z.string(), count: z.number().int() })),
});
```

#### H. Phase 4 Hard-to-Delete & Trash Endpoints
- Migration `010_protection_and_trash.sql`:
  - `workspaces`: `protected INTEGER NOT NULL DEFAULT 1`
  - `databases`: `protected INTEGER NOT NULL DEFAULT 1`, `trashed_at INTEGER`, `trash_path TEXT`, `last_write_at INTEGER`
  - `DatabaseStatusSchema` adds `"trashed"`.
- `PATCH /api/workspaces/:id/protection` — `{ protected: boolean }` → updates `protected`.
- `PATCH /api/databases/:id/protection` — `{ protected: boolean }` → updates `protected`.
- `GET /api/databases/:id/delete-preview` — returns `{ slug, name, protected, diskBytes, totalRows, tableCount, lastWriteAt }` for the confirmation dialog.
- `DELETE /api/workspaces/:id` — requires body `{ confirm: "<exact workspace slug>" }`. If `ws.protected`, returns `423 protected`. If non-empty (including trashed DBs), returns `409 workspace_not_empty`.
- `DELETE /api/databases/:id` — requires body `{ confirm: "<exact db slug>" }`. If `db.protected`, returns `423 protected`. Stops `sqld` (`killByDbId` first!), stops backup replicator, releases port pair, moves `data_dir` to `<dataRoot>/trash/<id>-<timestamp>` (verified via `assertInside`), marks status `trashed` and sets `trashed_at`.
- `GET /api/trash` — lists trashed databases with `expiresAt` (`trashedAt + trashDays * 86_400_000`).
- `POST /api/trash/:id/restore` — reallocates port pair, moves `<dataRoot>/trash/<id>-<timestamp>` back to `data_dir` (`assertInside`), marks `stopped` (or starts if `auto_start=1`), clears `trashed_at`.
- `DELETE /api/trash/:id` — permanent purge; requires `{ confirm: "<exact db slug>" }`, deletes trash dir + keys + metadata row.
- Retention sweep on boot + hourly timer (`SQLITEND_TRASH_DAYS`, default `7`).

---

## 3. Component Tree (`apps/web/src`)

```text
main.tsx
└── QueryClientProvider (@tanstack/react-query)
    └── ThemeProvider (light/dark via prefers-color-scheme + localStorage toggle)
        └── AuthGate.tsx (session + admin-token login support)
            └── App.tsx (responsive shell: top bar + desktop rail / mobile bottom tab bar)
                ├── Navigation
                │   ├── TopHeader.tsx (brand, sqld health badge, theme toggle, workspace switcher)
                │   ├── BottomTabBar.tsx (phones <600px: Databases · Explorer · SQL · Metrics)
                │   └── ExplorerDrawer.tsx (sidebar >=900px, slide-over drawer <900px: workspace → DB → tables/views tree)
                ├── Pages
                │   ├── DatabasesPage.tsx (system overview cards, stability badges, uPlot sparklines, workspace settings/danger zone)
                │   ├── DatabaseWorkspacePage.tsx (unified DB view with tabs)
                │   │   ├── Tab: Data → DataGridView.tsx
                │   │   │   ├── FilterBar.tsx (structured filter chips: col, op, value + quick add)
                │   │   │   ├── VirtualDataGrid.tsx (@tanstack/react-table + @tanstack/react-virtual, desktop/tablet grid)
                │   │   │   ├── MobileRowCards.tsx (<600px card view: PK + 3 chosen columns, tap → RecordSheet)
                │   │   │   ├── InlineCellEditor.tsx (double-click / long-press editor)
                │   │   │   ├── PendingChangesTray.tsx ("Review & apply" modal showing generated SQL before commit)
                │   │   │   └── ExportMenu.tsx (copy cell/row as JSON/CSV, export table CSV)
                │   │   ├── Tab: SQL → React.lazy(() => SqlConsoleView.tsx)
                │   │   │   ├── CodeMirrorEditor.tsx (CM6 + SQLite schema autocomplete, Cmd/Ctrl+Enter)
                │   │   │   ├── SqlToolbar.tsx (Run selection/all, "Allow writes" toggle, DestructiveSqlConfirmModal)
                │   │   │   ├── SqlResultsPane.tsx (statement tabs, timing badges, VirtualDataGrid reuse)
                │   │   │   └── SqlSidebar.tsx (localStorage history last 50 + saved snippets)
                │   │   ├── Tab: Structure → StructureView.tsx (columns, PK/FK badges, indexes, CREATE SQL viewer)
                │   │   ├── Tab: Metrics → React.lazy(() => MetricsView.tsx)
                │   │   │   ├── StabilityBanner.tsx (badge, rule explanation, crash history, availability %)
                │   │   │   ├── TimeSeriesCharts.tsx (uPlot canvas charts: CPU %, Memory RSS, Disk/WAL, Query Latency p50/p95/p99)
                │   │   │   └── StorageInspector.tsx (PRAGMA page_count/freelist/WAL + per-table row counts)
                │   │   └── Tab: Settings & Overview → DatabaseSettingsView.tsx
                │   │       ├── ConnectionPanel.tsx (URLs, .env snippet, DNS status)
                │   │       ├── TokensPanel.tsx (generate, reveal, copy, rotate, revoke)
                │   │       ├── BackupPanel.tsx (Litestream status, restore-verify, restore dialog)
                │   │       └── DangerZonePanel.tsx (protection toggle, 5s-delayed slug-confirm Trash modal)
                │   ├── TrashPage.tsx (trashed DBs countdown, restore, permanent purge with slug confirm)
                │   ├── BackupsPage.tsx (S3 replicas & control-plane backup)
                │   └── ActivityPage.tsx (audit log table)
                └── Shared Components
                    ├── Modal.tsx (accessible focus-trapped dialog)
                    ├── Skeleton.tsx (shimmer placeholders replacing spinners)
                    └── DangerConfirmDialog.tsx (shows size/rows/last-write, slug input, 5s countdown button)
```

---

## 4. New Dependencies (Exact Versions & Verified Sizes)

Queried directly from npm registry and Bundlephobia on Node/Bun:

| Package | Exact Version | Loading Strategy | Minified Size | Gzipped Size | Purpose |
|---|---|---|---|---|---|
| `@tanstack/react-table` | `8.21.3` | Base / Data tab | 52.8 KB | **13.8 KB** | Headless table state, sorting, column sizing |
| `@tanstack/react-virtual` | `3.14.20` | Base / Data tab | 33.4 KB | **9.9 KB** | Row + column virtualisation (60fps on 50k+ rows) |
| `@tanstack/react-query` | `5.104.3` | Base bundle | 44.8 KB | **12.9 KB** | Server cache, request dedupe, optimistic mutations |
| `uplot` | `1.6.32` | `React.lazy` (Metrics chunk) | 49.6 KB | **21.3 KB** | Fast canvas time-series charts & sparklines |
| `@codemirror/state` | `6.7.6` | `React.lazy` (SQL chunk) | 48.4 KB | **16.1 KB** | Editor state & transactions |
| `@codemirror/view` | `6.43.14` | `React.lazy` (SQL chunk) | 243.7 KB | **77.6 KB** | Touch-friendly editor viewport & keymaps |
| `@codemirror/commands` | `6.11.1` | `React.lazy` (SQL chunk) | ~42 KB (own) | **~14 KB** (own) | Standard editing commands (`defaultKeymap`, `history`) |
| `@codemirror/language` | `6.13.1` | `React.lazy` (SQL chunk) | ~45 KB (own) | **~15 KB** (own) | Syntax tree & highlighting infrastructure |
| `@codemirror/autocomplete` | `6.20.3` | `React.lazy` (SQL chunk) | ~48 KB (own) | **~16 KB** (own) | Schema-aware completion popup |
| `@codemirror/lang-sql` | `6.10.0` | `React.lazy` (SQL chunk) | ~28 KB (own) | **~9.5 KB** (own) | `SQLite` dialect + table/column completion source |

*(Note: Bundlephobia's standalone totals for `@codemirror/lang-sql` / `autocomplete` include transitive `@codemirror/view` + `state` + `@lezer/*`; when bundled together by Vite Rollup into one lazy `sql-editor` chunk, shared `@codemirror/state`, `@codemirror/view`, and `@lezer/common` are deduplicated once, yielding ~115 KB gzipped for the lazy SQL chunk.)*

### Bundle Budget Verification
- **Base initial bundle (`index.js`):** React + ReactDOM (~44 KB gz) + `@tanstack/react-query` (12.9 KB gz) + `@tanstack/react-table` (13.8 KB gz) + `@tanstack/react-virtual` (9.9 KB gz) + app shell/components (~18 KB gz) ≈ **~99 KB gzipped** — well under the **150 KB gzipped** budget.
- **Why `@tanstack/react-table@8.21.3` over `9.x`:** v8.21.3 has zero external runtime dependencies beyond `@tanstack/table-core` and is battle-tested with React 18, whereas v9 adds `@tanstack/react-store`.

---

## 5. Risks & Mitigations

1. **Breaking Existing Auth / E2E / Unit Tests with `SQLITEND_ADMIN_TOKEN` & Delete Changes:**
   - *Risk:* `apps/server/test/unit/routes.test.ts`, `auth.test.ts`, `smoke.test.ts`, and `scripts/e2e-killer-workflow.mjs` test `DELETE /api/databases/:id` and `DELETE /api/workspaces/:id` and `loadConfig()`.
   - *Mitigation:*
     - In `Phase 1`, `SQLITEND_ADMIN_TOKEN` is required when `host` is non-loopback (`0.0.0.0`) unless `SQLITEND_AUTH=off` (loopback only) or an admin password is set; we will check all existing tests in `apps/server/test` to see how `loadConfig` is called and ensure loopback test configs and `SQLITEND_ADMIN_TOKEN` work seamlessly alongside existing `AuthService` password/cookie tests.
     - In `Phase 4`, `protected` defaults to `true` on new workspaces/DBs and `DELETE` requires `{ confirm: "<slug>" }` and moves to trash. We will update `e2e-killer-workflow.mjs` if needed or inspect whether existing tests call `DELETE /api/databases/:id` without a body, updating tests and adding dedicated Phase 4 protection/trash/restore/purge test suites while preserving all safety invariants (`assertInside`, `workspace_not_empty` 409, `killByDbId` before `rename`/`rm`).
2. **SQL Injection in Table Browser / Row Mutations:**
   - *Risk:* Table names, column names, `ORDER BY` columns, or filter operators cannot use SQLite `?` parameter binding.
   - *Mitigation:* Every table name and column name is first looked up in the live schema (`PRAGMA table_list` / `PRAGMA table_info`) using exact string equality. Any identifier not present in the table's schema (or `_rowid_`/`rowid` when applicable) is rejected with `400 bad_request`. Identifiers are additionally double-quote escaped (`"..."`), filter operators are validated by `FilterOpSchema`, and all filter/insert/update/PK values are passed strictly via Hrana positional parameters.
3. **Read-Only Bypass in Query Endpoint:**
   - *Risk:* A user runs `WITH ... DELETE` or `PRAGMA writable_schema=ON` or multi-statement writes with `readOnly: true`.
   - *Mitigation:* When `readOnly: true` (the default), we both (a) reject non-read statements via token-aware SQL prefix/keyword inspection and (b) wrap execution in `PRAGMA query_only = ON;` within the Hrana pipeline stream so SQLite itself refuses any write at the engine level, resetting `PRAGMA query_only = OFF` afterwards.
4. **Large Result Sets OOMing Server or Browser:**
   - *Risk:* `SELECT * FROM huge_table` returning millions of rows.
   - *Mitigation:* Server enforces `limit` (default 1000, max 10000) and slices/truncates results with `truncated: true`. Browser renders results via `@tanstack/react-virtual` (row + column virtualisation) so 50k rows render only ~30 DOM nodes at a time.
5. **Orphan Sweep & Reconcile Interaction with Trashed Databases:**
   - *Risk:* `warnUnregisteredDataDirs()` or `supervisor.reconcile()` trying to launch or warn about trashed databases.
   - *Mitigation:* `reconcile()`, `sampler`, and `backup` replicator skip rows with `status === "trashed"`, and `trash/` lives at `<dataRoot>/trash/` outside `<dataRoot>/workspaces/`.

---

## 6. Phase Order & Deliverables

1. **Phase 0 (Current):** Read codebase, verify dependency versions & gzipped sizes, write `docs/gemini/plan.md`, and stop for review.
2. **Phase 1 — Server Query API & Operator Auth (`SQLITEND_ADMIN_TOKEN`):**
   - Add `SQLITEND_ADMIN_TOKEN` config/startup enforcement + constant-time Bearer/cookie auth.
   - Add shared Zod schemas in `packages/shared`.
   - Implement Hrana pipeline client, `GET /schema`, `POST /query`, `GET/POST/PATCH/DELETE /tables/:table/rows`.
   - Write comprehensive unit/integration tests (`query.test.ts`, `auth.test.ts` additions) covering auth, SQLi attempts, row cap, timeout, read-only enforcement, pagination, and CRUD round-trips.
   - Run `bun test apps/server`, both `tsc --noEmit`, `bun run build`, and commit.
3. **Phase 2 — Web DB Client & Mobile-First UI Redesign:**
   - Install approved client packages (`@tanstack/react-table`, `@tanstack/react-virtual`, `@tanstack/react-query`, `@codemirror/*`, `uplot`) and inspect `.d.ts` files in `node_modules`.
   - Implement mobile-first responsive shell (360/600/900/1280 breakpoints, bottom tab bar on phones, drawer/sidebar Explorer tree, light/dark theme toggle, skeletons).
   - Build **Data tab** (virtualised grid, mobile row cards, sort headers, filter chips, inline cell editing, pending-changes SQL review tray, add/delete row, CSV/JSON copy & export).
   - Build **SQL tab** (lazy-loaded CodeMirror 6 with SQLite schema autocomplete, Ctrl/Cmd+Enter, per-statement results & timing, history/snippets, write toggle + destructive confirm).
   - Build **Structure tab** (columns, indexes, FKs, `CREATE` SQL).
   - Verify bundle sizes (`<= 150 KB` gz initial), run tests/typechecks/build, and commit.
4. **Phase 3 — Statistics, History & Stability Metrics:**
   - Add migration for persisted metrics ring buffer & crash/restart counters in `metadata.sqlite`.
   - Track query latency (p50/p95/p99) & error rate, WAL size, `PRAGMA` storage stats, disk growth rate, and 24h availability %.
   - Add `GET /api/databases/:id/metrics/history`, `GET /api/databases/:id/storage`, and `GET /api/metrics/overview`.
   - Build system overview sparklines, per-DB `uPlot` time-series charts, and the Stability badge with rule tooltip/banner.
   - Write server tests, verify build/typechecks, and commit.
5. **Phase 4 — Hard-to-Delete Workspaces & Databases (Trash & Protection):**
   - Add migration for `protected` (default ON) and soft-delete trash metadata (`trashed_at`, `trash_path`).
   - Enforce `423 protected`, `confirm: "<exact slug>"`, soft-delete move to `<dataRoot>/trash/<id>-<timestamp>` (`assertInside`, kill-before-move, port release), restore (port reallocation), permanent purge, and `SQLITEND_TRASH_DAYS` retention sweep.
   - Remove all inline/list delete buttons; build the Settings "Danger zone", 5s-delayed slug confirmation dialog with size/row-count/last-write preview, and Trash management view.
   - Add benchmark script under `scripts/` to measure query API overhead (<10ms p50) and grid/page performance, update `README.md` and `docs/gemini/plan.md` with final measurements, run all checks, and commit.

---

## 7. Implementation Summary, Measured Numbers & Known Gaps

### What Was Built
- **Phase 1 — Server Query API & Operator Auth (`ee64d8a`):**
  - Added `SQLITEND_ADMIN_TOKEN` configuration, non-loopback startup enforcement (`assertStartupAuth`), and SHA-256 constant-time (`crypto.timingSafeEqual`) Bearer/session authentication in `apps/server/src/auth/session.ts` and `auth-routes.ts`.
  - Implemented `apps/server/src/db/hrana.ts` with in-memory per-DB EdDSA token minting, statement splitting (preserving strings, comments, and `CREATE TRIGGER ... BEGIN ... END`), engine-level `PRAGMA query_only = ON` + token-level read-only enforcement, schema inspection (`GET /api/databases/:id/schema`), SQL execution (`POST /api/databases/:id/query`), and parameterized, identifier-allowlisted table row CRUD (`GET/POST/PATCH/DELETE /api/databases/:id/tables/:table/rows`).
- **Phase 2 — Web DB Client & Mobile-First UI Redesign (`1d0e08c`):**
  - Redesigned `apps/web` with a mobile-first shell (`360px` / `600px` / `900px` / `1280px` breakpoints), mobile bottom tab bar (`Databases · Explorer · SQL · Metrics`), slide-over Schema Explorer drawer, light/dark theme toggle, and skeleton shimmer loaders.
  - Built `DataGridTab.tsx` (`@tanstack/react-table` + `@tanstack/react-virtual` desktop grid + `<600px` mobile row cards + full-record sheet, structured filter chips, inline cell editing, pending-changes SQL review modal, row insert/delete, CSV/JSON copy & export).
  - Built lazy-loaded `SqlConsoleTab.tsx` (`CodeMirror 6` with live SQLite table/column autocomplete, `Mod+Enter` selection/script execution, read-only default + write toggle + destructive SQL modal, per-statement tabs & timing, 50-entry `localStorage` history, and saved snippets).
  - Built `StructureTab.tsx` (columns, PK/FK/NOT NULL badges, indexes, foreign keys, and copyable `CREATE` DDL).
- **Phase 3 — Statistics, History & Stability Metrics (`28cb7eb`):**
  - Added migration `009_metrics_and_stability.sql` (`metrics_history`, `crash_events`, crash/restart counters) and `MetricsRepo`.
  - Extended `Sampler` with WAL size calculation, query latency percentile tracking (`p50`/`p95`/`p99`), and ring-buffer persistence/downsampling.
  - Added `GET /api/databases/:id/metrics/history`, `GET /api/databases/:id/storage`, and `GET /api/metrics/overview`.
  - Built lazy-loaded `MetricsTab.tsx` (`uPlot` time-series charts, stability banner & rule explanation, `PRAGMA` page/freelist breakdown) and system overview + per-card sparklines on `DatabasesPage.tsx`.
- **Phase 4 — Hard-to-Delete Workspaces & Databases:**
  - Added migration `010_protection_and_trash.sql` (`protected` default `1` on workspaces and databases, `trashed_at`, `trash_path`, `last_write_at`).
  - Enforced `423 protected`, `{ confirm: "<exact slug>" }`, soft-delete move to `<dataRoot>/trash/<id>-<timestamp>` (preserving `killByDbId` before move and `assertInside`), `/api/trash` list/restore/purge, and `SQLITEND_TRASH_DAYS` retention sweep.
  - Removed all list/card delete buttons; added Workspace & Database **Danger Zone** settings, `DangerConfirmDialog.tsx` (size, table/row count, last write, slug match, 5s countdown), and `TrashPage.tsx`.

### Measured Numbers
1. **Production Bundle Sizes (`bun run build`):**
   - Base JS bundle (`dist/assets/index-*.js`): **344.8 KB minified / 101.9 KB gzipped** (Budget: `<= 150 KB gzipped` — **48 KB under budget**).
   - Lazy SQL Console chunk (`dist/assets/SqlConsoleTab-*.js`): **376.4 KB minified / 124.1 KB gzipped** (loaded only when opening the SQL tab).
   - Lazy Metrics uPlot chunk (`dist/assets/MetricsTab-*.js`): **60.8 KB minified / 26.0 KB gzipped** (loaded only when opening the Metrics tab).
   - Base CSS (`dist/assets/index-*.css`): **24.6 KB minified / 5.2 KB gzipped**.
2. **Server Query & Table Browser Benchmark (`bun run scripts/benchmark-query-api.ts`):**
   - `POST /api/databases/:id/query` (`SELECT 1`, 200 iterations): **p50 = 0.05 ms**, **p95 = 0.12 ms**, **p99 = 1.39 ms** (Budget: `p50 < 10 ms`).
   - `GET /api/databases/:id/tables/events/rows` (10,000-row table with sort + offset, 100 iterations): **p50 = 3.70 ms**, **p95 = 4.17 ms**, **p99 = 4.69 ms**.
3. **End-to-End Killer Workflow (`bun run e2e`):**
   - Full lifecycle (create workspace, spawn real `sqld`, mint EdDSA token, `@libsql/client` write/read, negative auth check, live `/proc` metrics, 423 protection check, unprotect + soft-delete to trash + permanent purge, stop/start persistence): **~4.2s total** (Budget: `< 60s`).

### Known Gaps / Future Enhancements
- `WITHOUT ROWID` tables that also lack an explicit primary key (impossible in valid SQLite syntax, as SQLite requires a `PRIMARY KEY` on `WITHOUT ROWID` tables) and read-only `VIEW`s are browseable and filterable in the Data tab with inline editing disabled.
- Binary `BLOB` columns are rendered as safe base64 summary badges in the JSON query/grid responses; raw binary file upload into a `BLOB` cell is left for a future iteration.

