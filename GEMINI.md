# sqlitend — context for Gemini CLI

Single-operator, self-hosted control plane for libSQL `sqld`. Bun + Hono API, React 18 + Vite SPA.
Read `README.md` first. The current task brief is `docs/gemini/ui-db-client-prompt.md`.

## Layout
- `apps/server` — Bun/Hono API (`src/http/routes.ts`), metadata DB in `bun:sqlite` (`src/db`),
  sqld process supervisor (`src/supervisor`), per-DB JWT signing (`src/auth/tokens.ts`),
  /proc metrics sampler (`src/metrics/sampler.ts`).
- `apps/web` — React SPA (`src/pages`, `src/components`, `src/api/client.ts`, `src/styles.css`).
- `packages/shared` — zod schemas + types shared by server and web. Change API shapes here first.

## Commands (run from repo root)
- `bun install`
- `bun test apps/server` — unit/integration tests (needs `gcc` on Linux)
- `bunx tsc --noEmit -p apps/server/tsconfig.json` and `bunx tsc --noEmit -p apps/web/tsconfig.json`
- `bun run build` — build the SPA
- `bun run dev` — server + UI on http://127.0.0.1:6100 (needs `./scripts/fetch-sqld.sh` once)
- `bun run e2e` — killer-workflow end-to-end

CI (`.github/workflows`) runs exactly the tests, both typechecks and the build. All must pass.

## Hard rules
- Work on branch `feat/gemini-ui-db-client` only. Never push to `main`, never force-push.
- Never read, print or commit `.env` files, tokens or keys. Never connect to remote/production
  sqld URLs. Develop only against databases you create locally with `bun run dev`.
- Set `SQLITEND_DATA_ROOT` to a scratch dir (e.g. `/tmp/sqlitend-dev`) when running locally so
  you never touch a real data root.
- Never weaken existing safety guards (`assertInside`, the 409 `workspace_not_empty`, the
  kill-before-rm order in database delete).
- Small, reviewable commits. Each phase in the brief = its own commit(s) with tests passing.
