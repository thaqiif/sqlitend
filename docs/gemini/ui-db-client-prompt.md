# Task brief: sqlitend UI redesign + built-in DB client

Paste into Gemini CLI from the repo root (on branch `feat/gemini-ui-db-client`):

> Read GEMINI.md and docs/gemini/ui-db-client-prompt.md, then do Phase 0 and stop for my review.

Written for **Gemini 4 Argon** (thinking: high). Argon is strong at long multi-step coding and
security work and can emit very long outputs — use that for complete files, not for skipping
verification. Its known weakness is confident hallucination, so the rules below require you to
*prove* claims with commands and to check library APIs against installed `node_modules` types,
not memory.

---

## 0. How to work

1. **Phase 0 first — read and plan, change nothing.** Read README, `apps/server/src/http/routes.ts`,
   `packages/shared/src/index.ts`, every file in `apps/web/src`, `src/auth/tokens.ts`,
   `src/metrics/sampler.ts`. Then write `docs/gemini/plan.md`: current architecture in 15 lines,
   the API additions you propose (method, path, request/response zod shape), the component tree,
   new dependencies with exact versions + gzipped size, risks, and the phase order. **Stop and
   wait for my approval.**
2. One phase at a time. After each phase run, and paste the real output of:
   `bun test apps/server`, both `tsc --noEmit` typechecks, `bun run build`.
   Never say "should pass" — run it. If something fails, fix it before moving on.
3. Before using any library API, open its `.d.ts` in `node_modules` to confirm the signature.
4. Commit per phase with a clear message. Do not push unless I say so.
5. If a requirement here conflicts with a hard rule in GEMINI.md, the hard rule wins — ask me.

## 1. Goals (my words)

- Full **UI redesign**, **mobile-first**.
- View and modify data **like DBeaver**: browse schema, view tables in a grid, filter, sort,
  edit cells, insert/delete rows, run SQL scripts and see results as tables.
- **Fast.** Perceived and measured.
- More **statistics and metrics** so I can see how stable each database is.
- **Deleting a workspace or a database must be hard** — I must not be able to do it by accident.

## 2. Proposed client stack (keep it lean — verify sizes in Phase 0)

Keep React 18 + Vite (no framework switch, no SSR). Add only:

| Need | Pick | Why |
|---|---|---|
| Data grid | `@tanstack/react-table` + `@tanstack/react-virtual` | headless, tiny, row+column virtualisation → 100k rows scroll at 60fps; we own the mobile layout |
| SQL editor | CodeMirror 6 (`@codemirror/view`, `state`, `lang-sql`, `autocomplete`) | ~10× smaller than Monaco, works on mobile touch, schema-aware autocomplete via SQLite dialect |
| Charts | `uplot` | ~45 KB, canvas, built for time series; handles thousands of points cheaply |
| Server state | `@tanstack/react-query` | caching, dedupe, background refetch, optimistic edits |

No CSS framework; plain CSS with custom properties (light/dark), container queries for the grid.
Lazy-load the editor and charts (`React.lazy`) so the database list loads with the base bundle.
**Budget:** initial JS ≤ 150 KB gzipped; editor/chart chunks loaded on demand. Report actual
numbers from `vite build` each phase. If you think a different library is clearly better
(e.g. Glide Data Grid), argue it in plan.md with numbers — do not just switch.

## 3. Server: query API (Phase 1) — security first

The control plane currently has **no operator auth** and binds `0.0.0.0` by default. A SQL console
turns that into "anyone on the network can read/write every database". So, before any SQL endpoint:

- Add operator authentication: `SQLITEND_ADMIN_TOKEN` env (required when host ≠ 127.0.0.1;
  refuse to start otherwise), checked as a bearer token or HttpOnly SameSite=Strict cookie set by
  a login page. Constant-time compare. Tests for: missing, wrong, right token; startup refusal.
- New endpoints (shapes in `packages/shared`, zod-validated, behind auth):
  - `GET  /api/databases/:id/schema` — tables, views, indexes, columns (type, pk, notnull, default),
    foreign keys, row-count estimate.
  - `POST /api/databases/:id/query` — `{ sql, params?, readOnly?: boolean, limit? }` →
    `{ columns, rows, rowsAffected, lastInsertRowid, durationMs, truncated }`. Supports multi-
    statement scripts (return one result per statement). Server-side hard row cap (default 1000,
    max 10000) and statement timeout. `readOnly` defaults to **true**; writes need explicit `false`.
  - `GET  /api/databases/:id/tables/:table/rows` — keyset/offset paging, `sort`, `dir`, and
    structured `filters` (`[{col, op, value}]`, ops: = != < <= > >= like isnull notnull in).
    **Build SQL with quoted identifiers validated against the schema + bound parameters. Never
    string-concatenate user values.** Return `total` only when cheap; otherwise `hasMore`.
  - `POST /api/databases/:id/tables/:table/rows` (insert), `PATCH` (update by rowid/pk),
    `DELETE` (by pk list) — each in a transaction, returns affected count.
- Talk to sqld over its HTTP Hrana pipeline using a short-lived token minted server-side with the
  existing `mintToken`; never send DB tokens to the browser for this.
- Tests: SQL-injection attempts via table/column/sort/filter names, row cap, timeout, read-only
  enforcement, pagination correctness, edit round-trip.

## 4. Web: DB client (Phase 2)

- **Explorer:** workspace → database → tables/views tree (drawer on mobile, sidebar ≥ 900px).
- **Data tab:** virtualised grid; sticky header; tap/click header to sort; filter bar with chips;
  inline cell edit (double-click / long-press) with pending-changes tray → "Review & apply"
  shows the generated SQL before commit; add/delete row; copy cell/row as JSON/CSV; export CSV.
  On phones (< 600px) show rows as cards with the PK + 3 chosen columns, tap to open full record.
- **SQL tab:** CodeMirror with schema autocomplete, run selection / run all (Ctrl/Cmd+Enter),
  results in the same grid, per-statement timing, history (localStorage, last 50), saved snippets.
  Write statements require toggling "Allow writes" for that run, and `DROP`/`DELETE` without
  `WHERE`/`TRUNCATE`-like statements show an extra confirm.
- **Structure tab:** columns, indexes, FKs, the `CREATE` SQL.

## 5. Stats & stability metrics (Phase 3)

Today only a single live sample is shown (cpu, rss, disk, uptime). Add:
- Server keeps a ring buffer per DB (e.g. 24 h at the sample interval, downsampled) — persisted
  to the metadata DB so it survives restart. Endpoint `GET /api/databases/:id/metrics/history?range=1h|24h|7d`.
- Track and show: CPU %, RSS, disk + growth rate, uptime, **restart/crash count and last crash
  reason**, time since last crash, availability % over range, query latency p50/p95/p99 and error
  rate (from the query API), row counts per table (on demand), WAL size, page_count/freelist
  (`PRAGMA`s via read-only query).
- Dashboard: system overview (all DBs: status, availability, sparkline) + per-DB charts (uPlot).
- A clear "Stability" badge per DB (e.g. green = 0 crashes 24 h and ≥ 99.9% up) with the rule shown.

## 6. Hard-to-delete workspaces and databases (Phase 4)

Defence in depth — UI alone is not enough:
1. **Protected flag** (default ON for new DBs and workspaces). Delete returns `423 protected`
   until protection is turned off, and turning it off is its own action.
2. **Type-to-confirm:** the delete request must carry `confirm: "<exact slug>"`; server rejects
   otherwise. The UI dialog requires typing the slug, shows size/row counts/last write, and the
   button is disabled for 5 s.
3. **Soft delete / trash:** delete stops sqld and *moves* the data dir to
   `<dataRoot>/trash/<id>-<timestamp>` (inside `assertInside`), keeps keys, marks row `trashed`.
   Restore within retention (`SQLITEND_TRASH_DAYS`, default 7). Permanent purge is a separate
   action with its own confirm. Port is released on trash and re-allocated on restore.
4. Delete is never in a list row or swipe action — only in a "Danger zone" at the bottom of the
   settings page.
5. Tests for every path (protected, wrong confirm, trash, restore, purge, retention sweep), and
   keep the existing kill-before-move ordering.

## 7. Design & mobile-first (throughout)

- Design at 360 px first, then 600/900/1280 breakpoints. Touch targets ≥ 44 px. No horizontal page
  scroll (only inside the grid). Bottom tab bar on phones (Databases · Explorer · SQL · Metrics).
- Light + dark via `prefers-color-scheme` and a toggle; accessible contrast (WCAG AA), visible focus,
  keyboard shortcuts on desktop, `aria-*` on grid and dialogs.
- Skeletons instead of spinners; optimistic UI for edits with rollback on error.

## 8. Performance acceptance (measure and report)

- Initial JS ≤ 150 KB gz; Lighthouse mobile performance ≥ 90 on the database list.
- Grid: 50k-row result scrolls without jank (virtualised); first page of a table < 150 ms locally.
- Query API overhead over raw sqld < 10 ms p50 (benchmark script under `scripts/`).

## 9. Done means

All phases committed; tests + typechecks + build green with output pasted; `docs/gemini/plan.md`
updated with what was built, measured numbers, and known gaps; README updated (new env vars,
auth, trash). No `TODO`, skipped tests, or stubbed endpoints left.
