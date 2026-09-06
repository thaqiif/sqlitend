# Killer workflow — manual checklist (AC-W7)

The one path this product is built around: from an empty dashboard to a *connected, measurable,
deleted* database in well under a minute. The automated version is `bun run e2e`; this is the
manual walkthrough for a human.

## Prereqs

- [ ] `./scripts/fetch-sqld.sh` fetched a working `bin/sqld`
- [ ] `bun install` done
- [ ] Control plane running: `bun run dev` → `http://127.0.0.1:6100`

## Walkthrough

**1. Create a workspace**
   - In the sidebar hit **+ Workspace**, name it (e.g. `acme`), save.
   - The workspace appears in the sidebar with its slug `acme`.

**2. Create a database**
   - Select the workspace → **+ Database**, name it `users`. Save.
   - Within ~1s the dashboard shows the DB as **running** with its endpoint and inline
     CPU/memory tiles. A `sqld` subprocess is live on its own http+grpc port pair.

**3. Get the connection URLs**
   - Open the database. The **Connection** panel lists three URLs:
     - `httpUrl` — REST / Hrana-over-HTTP
     - `hranaUrl` — WebSocket
     - `grpcUrl` — libSQL gRPC
   - Each has a copy button.

**4. Mint a token**
   - **Generate token** → set lifetime in hours (default 24 h) → a **full read + write** JWT is
     shown **once** in a reveal modal. Copy it. *(v1 mints full-access tokens only — sqld 0.24.32
     cannot enforce per-request scopes, and the per-database signing key is the scope.)*

**5. Connect an external client**
   ```sh
   export LIBSQL_URL=<httpUrl> LIBSQL_AUTH_TOKEN=<token>
   # or, in code:
   #   const { createClient } = require("@libsql/client");
   #   const c = createClient({ url, authToken });
   ```
   `SELECT 1` succeeds; a request **without** a token returns `401`. *(The JWT is bound to one
   database by its signing key — sqld never sees another DB's public key — and that DB is its
   own isolated process, so no claim check is required.)*

**6. Watch live metrics**
   - The dashboard's metric tiles (CPU %, memory, disk, uptime) refresh at
     `SQLITEND_SAMPLE_INTERVAL_MS` (default 5000 ms), read from `/proc` for the db's child
     process.

**7. Stop / start / delete**
   - **Stop** kills the process but keeps the data (and a previously issued token still works
     after **Start**, since the signing key is reused).
   - **Delete** (typed-confirm) stops the process, removes its data dir, and frees its ports.

**8. Done**
   - The database is gone; the workspace can now be deleted.

## Timing

Steps 1–6 (excluding step 7's stop/start) should finish in **well under 20 s**, almost all of it
sqld's ~1 s startup. `bun run e2e` asserts a <60 s ceiling and warns above 20 s. The automated
run boots the control plane on port `6190` and allocates database ports from `6510-6600`
(`scripts/e2e-killer-workflow.mjs`).
