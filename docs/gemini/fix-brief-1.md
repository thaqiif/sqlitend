# Fix brief 1: review findings on `feat/gemini-ui-db-client`

Paste into Gemini CLI from the repo root (on branch `feat/gemini-ui-db-client`, after `git pull`):

> Read GEMINI.md and docs/gemini/fix-brief-1.md, then fix every item in order.

Reviewed at commit `0e972f7`. Gates were green (268 tests pass, both typechecks clean, build OK,
initial JS 102.8 KB gz). The problems below are behavioural, and the current tests cannot see
them. Same working rules as `ui-db-client-prompt.md` §0: prove claims with commands, check
library APIs against `node_modules` types, paste real gate output, commit per item, do not push.

---

## B1 (BLOCKING): pipelines keep running after a failed statement → partial commits

**Fact (verified against the real `bin/sqld`):** in a Hrana `/v2/pipeline` request, a failed
`execute` does **not** stop later requests. Reproduction:

```
POST /v2/pipeline
  BEGIN IMMEDIATE
  INSERT INTO t(id,v) VALUES (1,'a')    -> ok
  INSERT INTO t(id,v) VALUES (2,NULL)   -> error NOT NULL
  COMMIT                                -> ok   ← commits row 1
SELECT * FROM t  -> [1,'a']
```

Our API returns 400 for that request, but row 1 has been saved. Affected:

1. `insertTableRows`, `updateTableRows`, `deleteTableRows` (`apps/server/src/db/hrana.ts`
   ~L831–992). Each must be all-or-nothing.
2. `runSqlQuery` with `readOnly: false`: a script like `DELETE …; <syntax error>; DROP TABLE x`
   still runs the `DROP`. Execution must stop at the first failing statement (like every SQL
   client). Report which statement failed (index + message) and which ones ran before it.

**Required fix:** use a Hrana `batch` request (`{"type":"batch","batch":{"steps":[…]}}`) with
step conditions, the same way `@libsql/client` does it:
- step 0 `BEGIN IMMEDIATE`; step *i* runs only if `{"type":"ok","step":i-1}`;
- `COMMIT` runs only if the last statement succeeded;
- a final `ROLLBACK` step runs on `{"type":"not","cond":{"type":"ok","step":<commit step>}}`.
- For the write-mode SQL console: no implicit transaction (the user may write their own
  BEGIN/COMMIT), but each step must be conditioned on the previous one being ok, so nothing
  runs after an error. If a step failed while the user's transaction is still open, roll it
  back (`ROLLBACK` conditioned on `not ok` plus `{"type":"is_autocommit"}` being false). Read the
  Hrana spec / `node_modules/@libsql/hrana-client` types for the exact condition shapes.
  Do not guess them.
- Parse `batch` results (`step_results[]`, `step_errors[]`) and map them back to statements.
  Steps that did not run (null result and null error) must be reported as "not executed".

**Tests:**
- Change the fake executor in `apps/server/test/unit/query.test.ts` so it behaves like real
  sqld: **keep executing after an error** in pipeline mode, and implement batch conditions
  faithfully. A fake that is stricter than the real server is what hid this bug.
- Add tests: insert of 2 rows where the 2nd violates NOT NULL → table unchanged, 400 returned.
  The same for update and delete (e.g. an FK violation). A write-mode script with an error in
  the middle → statements after it did not run, and the response says which one failed.
- Add an **opt-in integration test** that runs against the real `bin/sqld` when it is present
  (`test.skipIf(!existsSync(sqldPath))`), covering the partial-commit scenario above. Run it and
  paste the output.

## B2: query timeout does not stop the query inside sqld

`AbortSignal.timeout` only aborts our HTTP request. sqld keeps executing (e.g. a runaway
`WITH RECURSIVE`). Find out what sqld 0.24.x offers (check its flags, `--help`, and the docs
for a per-query or per-connection timeout). If sqld has nothing usable, document that in
plan.md "known gaps" and make the API response say the query may still be running. Do not
claim it is fixed unless a test against the real sqld shows the query stopped.

## B3: row cap is applied after fetching every row

`runSqlQuery` slices `r.rows` after sqld has returned the whole result (`hrana.ts` ~L470).
`SELECT * FROM big_table` loads everything into the control plane's memory. Fix: for
statements that return rows, cap at the source. Prefer wrapping read statements
(`SELECT`/`WITH`/`VALUES`) as `SELECT * FROM (<stmt>) LIMIT <cap+1>`, and fall back to the
current behaviour only for statements that can't be wrapped (PRAGMA, EXPLAIN). Keep
`truncated` accurate. Test: a 20k-row table with limit 1000 → executor receives the limited SQL.
Also limit the size of the response body read from sqld as a second guard.

## B4: admin-token login skips TOTP

`loginWithAdminToken` issues a session without TOTP even when TOTP is enabled. Decide
explicitly: either require TOTP for the cookie login too when `totpEnabled` (Bearer API use
can stay token-only), or keep it and document it in README under auth. Ask me if unsure.
Default recommendation: require TOTP for the cookie login when it's enabled.

## B5: raw admin token accepted as a session cookie

`isAuthenticated` in `auth-routes.ts` accepts the admin token itself as the `sqlitend_session`
cookie value. Remove that branch: the cookie must only ever hold a session id. Add a test
showing the raw token in the cookie → 401.

## B6: restart_count only counts restarts after a crash

`supervisor.ts` ~L684 increments `restart_count` only when `crash_count > 0`. Count every
successful start from a stopped/crashed/failed state, or rename the field to what it
actually measures. Update the UI label to match.

---

## Done means
- B1–B6 fixed or (B2 only) honestly documented as a gap, each in its own commit.
- `bun test apps/server`, both `tsc --noEmit`, `bun run build`: real output pasted, plus the
  real-sqld integration test output.
- `docs/gemini/plan.md` "known gaps" updated. No TODOs, skips (other than the platform /
  sqld-present guards), or stubs.
