# sqlitend

Single-operator, self-hosted management platform for [libSQL](https://libsql.org) / `sqld`.

Run `sqld` database instances as local subprocesses (no Docker) and manage them from a web
dashboard + REST API: create/browse/delete databases, issue connection URLs and access tokens,
and watch live process-resource metrics.

> **Killer workflow:** browse → create a database → get its connection URL + token → connect an
> external client → view live metrics → delete — full round-trip in under a minute.

## Runtime

- **Bun** (>= 1.1). SQLite via `bun:sqlite`, Hono via `@hono/bun`, tests via `bun test`.
- The external **`sqld`** binary is pinned and fetched by `scripts/fetch-sqld.sh` (see
  [Provisioning](#provisioning)).

## Getting started

**One-line install** (no root, everything under `$HOME`):

```sh
curl -fsSL https://raw.githubusercontent.com/thaqiif/sqlitend/main/scripts/install.sh | bash
```

This installs Bun if missing, downloads the repo, provisions the pinned `sqld` binary
(SHA-256 verified), builds the web UI, and puts a `sqlitend` launcher in `~/.local/bin`.
Then:

```sh
~/.local/bin/sqlitend          # start the control plane (http://127.0.0.1:6100)
```

Install options (`bash scripts/install.sh` docs for details): `SQLITEND_BRANCH`,
`SQLITEND_INSTALL_DIR`, `SQLITEND_BIN_DIR`, and `SQLITEND_SYSTEMD=1` (Linux → systemd `--user`
service). Everything — data, per-DB keys, databases — lives under
`~/.local/share/sqlitend` (the server data-root default).

**From source** (for development / forking):

```sh
# 1. Provision the pinned sqld binary
./scripts/fetch-sqld.sh

# 2. Install workspace deps
bun install

# 3. Run the control plane (API + UI) at http://127.0.0.1:6100
bun run dev
```

## Scripts

| Command | What it does |
|---------|--------------|
| `bun run dev` | Run the server on `127.0.0.1:6100` with watch |
| `bun run start` | Run the server without watch |
| `bun run test` | Unit + integration tests (`bun test`). Requires `gcc` on Linux: the supervisor suite compiles a tiny fake `sqld` at test time so orphan-sweep/pid-reuse tests can use a real subprocess. macOS/Windows skip those tests. |
| `bun run e2e` | Timed killer-workflow end-to-end script |
| `bun run build` | Build the web app (dev serves it through the API proxy; prod served by backend) |

## Configuration

All settings via environment variables (see [`.env.example`](.env.example)):

- `SQLITEND_PORT` – control plane listener port (default `6100`)
- `SQLITEND_HOST` – bind address (`0.0.0.0` = all interfaces, the default; `127.0.0.1` = localhost only)
- `SQLITEND_PUBLIC_HOST` – host advertised in database connection URLs (default: `127.0.0.1`; set to the machine's public address/hostname for remote clients)
- `SQLITEND_PORT_RANGE` – http+grpc port pair range per DB (default `6101-6300`)
- `SQLITEND_DATA_ROOT` – data root (`~/.local/share/sqlitend` default)
- `SQLITEND_SQLD_PATH` – path to the sqld binary (`<repo>/bin/sqld` default)
- `SQLITEND_TOKEN_TTL_HOURS` – default token lifetime (1–8760 hours, default `24`)
- `SQLITEND_SAMPLE_INTERVAL_MS` – metrics sampler + UI poll interval in MILLISECONDS (250–600000, default `5000`)
- `SQLITEND_READY_TIMEOUT_MS` – sqld launch ready probe timeout in MILLISECONDS (500–120000, default `10000`)
- `SQLITEND_MAX_BODY_BYTES` – maximum accepted JSON body size for mutating API calls, in bytes (default `1000000`)

### Control-plane access

The control plane (web UI + API) binds **`0.0.0.0` by default** — reachable on any interface
(e.g. `http://<machine-ip>:6100`). Set `SQLITEND_HOST=127.0.0.1` to restrict it to localhost.
Per-database `sqld` listeners bind the same address, so remote clients can connect to databases
too — connection URLs advertise `SQLITEND_PUBLIC_HOST` (set it to the machine's address, e.g.
your Tailscale IP or a DNS name).

The API answers only requests addressed to its listener **by IP or the configured host**; DNS
hostnames are refused (`403`), which blocks DNS-rebinding attacks. The management surface itself
has **no login in v1** — anyone who can reach the listener can manage workspaces/databases and
mint database tokens — so on a public network put it behind a firewall, an authenticated reverse
proxy, or a Tailscale ACL. Database access itself stays protected by the per-database signing
keys: connecting to a `sqld` port without that database's token is rejected (see
[Auth note](#auth-note)).

## Provisioning

`scripts/fetch-sqld.sh` downloads a pinned `sqld` release into `bin/` and verifies the **SHA-256 of
the extracted binary** on every run, including the fast path (a replaced binary that merely reports
the right version is detected and re-fetched). To upgrade sqld, bump `TAG` + the `PINNED_BIN_SHA256_*`
hashes in the script. Fallback: `cargo install libsql-server --bin sqld` (the crate that ships the `sqld` binary; a
compatible `sqld` on `PATH` also works via `SQLITEND_SQLD_PATH`).

## Data layout & backup

Under the data root (default `~/.local/share/sqlitend`):

```
<dataRoot>/
  metadata.sqlite        # control-plane metadata: workspaces, databases, tokens (WAL mode)
  metadata.sqlite-wal    # .. and -shm sidecars — COPY THESE TOO
  keys/<dbId>.key        # per-database Ed25519 private signing key (0600)
  keys/<dbId>.pub        # per-database public key fed to that DB's sqld
  workspaces/<wsSlug>/dbs/<dbSlug>/db.sqlite   # the actual libSQL database
```

On boot the control plane reconciles live `sqld` processes against `metadata.sqlite` (adopting
any it can verify, relaunching `auto_start=1` rows), sweeps orphaned `sqld` daemons it no longer
owns, and logs a `[boot] WARNING` for any data dir on disk that metadata does not reference. If
`metadata.sqlite` is lost or corrupted those otherwise-healthy databases become orphaned —
see the **Recovery** section in [docs/upgrade-sop.md](docs/upgrade-sop.md) to re-register them,
and back the data root up before any upgrade.

Backup: stop the control plane (or the specific database), then copy the entire data root
**including the `metadata.sqlite-wal` / `metadata.sqlite-shm` sidecars** (they hold recent writes
between SQLite checkpoints). Copying only the main file can silently lose the newest rows.

## Documentation

- Killer-workflow manual checklist (AC-W7): [docs/killer-workflow.md](docs/killer-workflow.md)
- Upgrading the pinned `sqld` binary (boot smoke, reconcile, rollback): [docs/upgrade-sop.md](docs/upgrade-sop.md)
- Deep-interview spec: `.omc/specs/deep-interview-sqlitend.md`
- Consensus plan (incl. architecture decisions): `.omc/plans/sqlitend-plan.md`

## Auth note

sqlitend mints **Ed25519 (EdDSA)** JWTs for database access. Each database gets its **own**
signing keypair at `<dataRoot>/keys/<dbId>.{key,pub}` (the private `.key` is 0600); that
database's `sqld` process receives **only its own** public key via `--auth-jwt-key-file`. A token
minted for one database is therefore cryptographically rejected by every other (verified live
against sqld 0.24.32).

Scope is **full-access only** in v1: sqld 0.24.32 cannot enforce per-request scopes and rejects
tokens carrying a `p` (permission) claim, so the API refuses anything other than `full` with a
`400`. Each database stays isolated by its own key *and* its own port pair. A request with no
token (or one not signed by that database's key) gets a `401`.

Because the signing keys are per-database, tokens minted by a previous version (which used a single
platform-wide key) stop working after an upgrade — operators must **re-mint tokens** (see
[docs/upgrade-sop.md](docs/upgrade-sop.md)).
