# Gateway: one public HTTPS hostname per database

```
Worker / any libSQL client
   │  https://bots-prod-libsql.cloudsby.me   (Authorization: Bearer <db token>)
   ▼
Cloudflare edge (TLS: Universal SSL covers *.cloudsby.me)
   ▼  Cloudflare Tunnel (outbound-only, no open ports on the server)
cloudflared on server A  →  http://127.0.0.1:6080  (sqlitend gateway)
   ▼  Host header → database slug or id
sqld for that database on 127.0.0.1:<port>   (verifies the JWT)
```

The hostname format is `<slug-or-id>-libsql.cloudsby.me`. Since v0.1.3 a new database's slug is **12 random
characters** (e.g. `k7q2m9x4p1zd-libsql.cloudsby.me`), never derived from its name. Names only need to be
unique within a workspace, and hostnames reveal nothing about what's inside. Databases created earlier keep their
name-based slug, so their hostnames don't change. The hostname stays **one level deep**, so the free
Universal SSL certificate covers it. A two-level name like `bots.libsql.cloudsby.me` would need
Advanced Certificate Manager.

## 1. Enable the gateway

In sqlitend's environment (env file or systemd unit):

```ini
SQLITEND_HOST=127.0.0.1                       # control plane + sqld: loopback only
SQLITEND_GATEWAY_PORT=6080
SQLITEND_GATEWAY_HOST=127.0.0.1
SQLITEND_GATEWAY_HOST_TEMPLATE={db}-libsql.cloudsby.me
SQLITEND_TOKEN_TTL_HOURS=8760                 # default 1-year tokens for service clients
```

Restart. The boot log prints `[gateway] listening on http://127.0.0.1:6080 for {db}-libsql.cloudsby.me`.
Each database's connection panel now shows a **PUBLIC** URL.

## 2. Cloudflare Tunnel (one-time)

```sh
# on server A (Debian)
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install cloudflared

cloudflared tunnel login                 # pick the cloudsby.me zone
cloudflared tunnel create server-a       # prints the tunnel UUID + credentials file
```

`/etc/cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: /etc/cloudflared/<TUNNEL-UUID>.json
ingress:
  # sqlitend gateway: every *-libsql host. The gateway 404s names it does not know.
  - hostname: "*.cloudsby.me"
    service: http://127.0.0.1:6080
  - service: http_status:404
```

```sh
sudo cloudflared service install && sudo systemctl enable --now cloudflared
```

Later services on server A (tgbulk, the local Bot API server, gowa) go in as **explicit** hostname
rules *above* the wildcard (e.g. `hostname: tgbulk.cloudsby.me`). The first matching rule wins.

## 3. DNS: one record per database

### Automatic (recommended)

Give sqlitend a Cloudflare API token and it manages the records itself:

```ini
SQLITEND_CF_API_TOKEN=<token>        # Cloudflare dashboard → My Profile → API Tokens → Create
                                     # permission: Zone → DNS → Edit; zone resources: cloudsby.me only
SQLITEND_CF_ZONE_ID=<zone id>        # cloudsby.me → Overview → API → Zone ID
SQLITEND_CF_TUNNEL_ID=<TUNNEL-UUID>  # from `cloudflared tunnel create`
```

- **Create a database:** sqlitend creates a proxied CNAME `<slug>-libsql.cloudsby.me →
  <TUNNEL-UUID>.cfargotunnel.com` with the comment `managed-by:sqlitend db:<id>`.
- **Delete a database:** sqlitend deletes that record, but only if it still carries the comment.
- **Boot:** every database without an active record is synced in the background.
- **Failures never block the database.** The database panel shows `DNS …: error|conflict` with the
  reason and a **Retry DNS** button (`POST /api/databases/:id/dns/sync`).
- **Records sqlitend didn't create are never touched.** If a name is already taken by a hand-made
  record, the status is `conflict` and the record is left alone.

### Manual

Without the token, create each record yourself:

```sh
cloudflared tunnel route dns server-a bots-prod-libsql.cloudsby.me
```

This creates a proxied CNAME to the tunnel. (A wildcard `*` record would also work, but it would
send every unknown `*.cloudsby.me` name to server A.)

## 4. Connect

```ts
import { createClient } from "@libsql/client/web"; // also in Cloudflare Workers
const db = createClient({ url: "https://bots-prod-libsql.cloudsby.me", authToken: env.LIBSQL_AUTH_TOKEN });
```

Use `https://`, not `libsql://` or `wss://`. The gateway speaks Hrana over HTTP only and answers
WebSocket upgrades with 501.

## Tokens: naming, rotation, expiry

- Give every token a name when you issue it, e.g. `worker-prod` (UI, or
  `POST /api/databases/:id/tokens {"name":"worker-prod","expiresInHours":8760}`).
- **Rotate:** issue a replacement with the same name (the **Rotate** button prefills it), deploy it
  (`wrangler secret put LIBSQL_AUTH_TOKEN`), check that **Last used** moves to the new token, then
  **Revoke** the old one. Both tokens work in between.
- **Revoke** takes effect on the next request through the gateway.
- **Expiry alerts:** `GET /api/tokens/expiring?withinDays=14&expiredWithinDays=7` lists tokens
  across all databases that aren't revoked and either expire within the window or expired recently.
  Old expiries drop off the list, so the alert doesn't fire forever. Poll it from cron
  and alert when it returns anything. The UI marks these tokens *expires soon*.

## Reaching the dashboard through the tunnel

The control plane (`127.0.0.1:6100`) protects its API against DNS rebinding. It only answers requests
addressed as `localhost`, `127.0.0.1` or its bind address, and anything else gets `403 Forbidden`. To open
the dashboard under a hostname, **name it**, and put it behind Cloudflare Access. The dashboard has
admin power, so never publish it without Access.

```sh
SQLITEND_DASHBOARD_HOSTS=sqlitend.example.com   # comma-separated, exact names only (no wildcards)
SQLITEND_COOKIE_SECURE=on                        # TLS terminates at Cloudflare
```
Tunnel ingress: `sqlitend.example.com → http://127.0.0.1:6100`. Add an Access app for that hostname with
an allow policy on your email.

**Letting Cloudflare Access be the only login.** Set `SQLITEND_AUTH=off`. It is only accepted with a loopback
`SQLITEND_HOST`, which is how this setup runs. The dashboard then opens with no login screen. The CSRF header is still
required on every change, and the audit log still records everything. Boot prints a loud warning naming the
dashboard hostname. **Without Access in front, anyone who can reach that hostname is admin.**

## Behaviour and security notes

- **Two checks on every request.** The gateway lets a token through only if sqlitend issued it
  *for this database*, it is not revoked or expired, and its signature verifies against that
  database's key. sqld then verifies it again. Only that one `Authorization` header reaches sqld;
  the query string and any other auth-like headers are dropped.
- **Revocation works only through the gateway.** sqld cannot revoke a JWT, so a revoked token is
  still accepted on sqld's own port until it expires. Keep `SQLITEND_HOST=127.0.0.1` so the
  gateway is the only way in; sqlitend logs a boot warning otherwise.
- **A refused token gets the same `404 not found` as an unknown database.** The reason is logged
  on the server: `[gateway] denied <db>: token missing|malformed|unknown|wrong_database|revoked|expired|bad_signature|no_key`
  (rate-limited to one line per database and reason every 10 s, with a suppressed count).
- A hostname that doesn't match the template, names no database, or names a database that isn't
  running gets the same `404 not found`, so names can't be enumerated. An oversized body gets 413
  (`SQLITEND_GATEWAY_MAX_BODY_BYTES`, default 32 MiB), an unreachable sqld 502, and a request
  taking over 240 s 504. WebSocket upgrades get 501 for every host.
- Databases created before the gateway was on, with slugs too long for a DNS label, are published
  under their id (`https://<uuid>-libsql…`).
- The control plane (`:6100`) is **not** routed by the tunnel by default. Reach it over SSH/Tailscale, or publish
  exactly one named hostname through `SQLITEND_DASHBOARD_HOSTS` (above), behind Cloudflare Access. Never use a wildcard.
- Optional hardening: put a Cloudflare Access application with a *service token* on the libsql
  hostnames. The Worker then adds `CF-Access-Client-Id`/`CF-Access-Client-Secret` through a custom
  `fetch` passed to `createClient`.
