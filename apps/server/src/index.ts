// ---------------------------------------------------------------------------
// sqlitend control plane — entrypoint.
//
// Boot order:
//   1. load config (env / defaults) + create the data root (loud, actionable
//      errors on EACCES/ENOSPC)
//   2. open + migrate the metadata DB (dataRoot/metadata.sqlite)
//   3. boot smoke: read the target sqld binary version (drives /api/system)
//   4. construct Supervisor + Sampler (signing keys are PER DATABASE —
//      auth/tokens.ts ensureDbKey — and are created lazily per start/mint)
//   5. reconcile persisted databases (adopt live / relaunch auto_start)
//   6. sweep orphaned sqld processes left from a prior crash
//   7. warn about data dirs not referenced by metadata (recovery hook)
//   8. start the metrics sampler loop
//   9. bind the HTTP server (API under /api/* with host + size guards, SPA
//      from apps/web/dist with security headers)
//  10. wire SIGINT/SIGTERM -> graceful shutdown (TERM all spawned + adopted
//      sqld processes, close DB)
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { openMetadata, type Metadata } from "./db/metadata.ts";
import { Supervisor } from "./supervisor/supervisor.ts";
import { sqldVersion } from "./supervisor/launcher.ts";
import { Sampler, type SamplerRow } from "./metrics/sampler.ts";
import { createRoutes } from "./http/routes.ts";
import type { AppEnv } from "./http/auth-routes.ts";
import { createStaticHandler, isAllowedHost } from "./http/static.ts";
import { createGatewayHandler, lookupByKey, parseHostTemplate } from "./gateway/gateway.ts";
import { CloudflareDns } from "./dns/cloudflare.ts";
import { DnsManager } from "./dns/manager.ts";
import { createSignatureVerifier } from "./auth/verify.ts";
import { AuthService } from "./auth/session.ts";
import { clientIp } from "./http/client-ip.ts";
import { Replicator } from "./backup/replicator.ts";
import { RestoreService, realRunLitestream, s3ClientFor } from "./backup/restore.ts";
import { healthReport } from "./http/health.ts";

export const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Config + persistence (fail loudly and actionably on fs problems)
// ---------------------------------------------------------------------------
const config = loadConfig();
try {
  mkdirSync(config.dataRoot, { recursive: true, mode: 0o700 });
} catch (err) {
  console.error(
    `[boot] FATAL: cannot create data root ${config.dataRoot} — check permissions and free disk space (${(err as Error).message})`,
  );
  throw err;
}

const metadata: Metadata = await (async () => {
  try {
    return openMetadata(path.join(config.dataRoot, "metadata.sqlite"));
  } catch (err) {
    console.error(
      `[boot] FATAL: cannot open metadata DB at ${path.join(config.dataRoot, "metadata.sqlite")} — ` +
        `if the file is corrupt, restore it from backup; see docs/upgrade-sop.md (Recovery) (${(err as Error).message})`,
    );
    throw err;
  }
})();
const { workspaces, databases, tokens, auth: authRepo } = metadata;

// ---------------------------------------------------------------------------
// sqld boot smoke
// ---------------------------------------------------------------------------
let sqldVer: string | null = null;
try {
  sqldVer = sqldVersion(config.sqldPath) || null;
} catch {
  sqldVer = null;
}
const sqldOk = !!sqldVer;

// ---------------------------------------------------------------------------
// Supervisor + Sampler
// ---------------------------------------------------------------------------
const supervisor = new Supervisor({ config, databases });

const sampler = new Sampler(config.sampleIntervalMs, config.dataRoot);
const samplerProvider = (): SamplerRow[] =>
  databases.list().map((r) => ({
    dbId: r.id,
    pid: r.pid,
    startTimeMs: r.start_time,
    dataDir: r.data_dir,
    status: r.status,
  }));

// ---------------------------------------------------------------------------
// Boot reconciliation + orphan sweep + recovery hook
// ---------------------------------------------------------------------------
const reconcile = await supervisor.reconcile();
console.log(
  `[boot] reconciled: ${reconcile.adopted} adopted, ${reconcile.relaunched} relaunched, ` +
    `${reconcile.leftStopped} left stopped, ${reconcile.notAdopted} not adopted (see per-row lines above)`,
);
const swept = await supervisor.sweepOrphans();
if (swept > 0) console.log(`[boot] swept ${swept} orphaned sqld process(es)`);
warnUnregisteredDataDirs();
console.log(`[boot] sqld ${sqldVer ?? `UNAVAILABLE at ${config.sqldPath} — run scripts/fetch-sqld.sh`} | dataRoot=${config.dataRoot}`);

sampler.start(samplerProvider);

// ---------------------------------------------------------------------------
// API + static
// ---------------------------------------------------------------------------
const dns = config.cloudflareDns && config.gatewayHostTemplate
  ? new DnsManager({
      cf: new CloudflareDns({ apiToken: config.cloudflareDns.apiToken, zoneId: config.cloudflareDns.zoneId, apiBase: config.cloudflareDns.apiBase }),
      template: parseHostTemplate(config.gatewayHostTemplate),
      target: `${config.cloudflareDns.tunnelId}.cfargotunnel.com`,
      databases,
    })
  : null;
if (dns) {
  // Background: boot must not wait on the Cloudflare API.
  void dns.reconcileAll().then(
    (r) => console.log(`[dns] boot reconcile: ${r.synced} synced, ${r.failed} failed`),
    (err) => console.warn(`[dns] boot reconcile failed: ${(err as Error).message}`),
  );
}

// A restore interrupted by a restart never resumes: its row stays auto_start=0
// (so it was not launched empty) and is marked failed for the operator.
for (const r of databases.list()) {
  if (r.status === "restoring") {
    databases.updateStatus(r.id, "failed");
    databases.setFailedReason(r.id, "restore interrupted by a restart — delete this database and restore again");
    console.warn(`[restore] ${r.slug}: interrupted by restart, marked failed`);
  }
}

const restore = config.backup
  ? new RestoreService({
      config: config.backup,
      databases,
      s3: s3ClientFor(config.backup),
      run: realRunLitestream(config.backup),
      startDatabase: (row) =>
        supervisor.startDatabase(row.id, { port: row.port!, grpcPort: row.grpc_port!, dataDir: row.data_dir }),
      afterStart: async (row) => {
        await dns?.sync(row);
      },
    })
  : null;

const replicator = config.backup
  ? new Replicator({
      config: config.backup,
      dataRoot: config.dataRoot,
      listDatabases: () => databases.list(),
      onLaunch: (id) => {
        const row = databases.getById(id);
        if (row) restore!.ensureManifest(row).catch((err) => console.warn(`[backup] manifest for ${row.slug}: ${(err as Error).message}`));
      },
    })
  : null;
if (replicator) {
  await replicator.start(); // sweeps orphans from a crashed previous run first
  console.log(`[backup] continuous backup to s3://${config.backup!.bucket}/${config.backup!.prefix}/db/<id> (${config.backup!.endpoint})`);
} else {
  console.warn("[backup] WARNING: backups are not configured (SQLITEND_BACKUP_S3_*) — databases are not backed up");
}

const authService = config.authEnabled ? new AuthService(authRepo) : null;
if (!config.authEnabled) console.warn("[auth] WARNING: SQLITEND_AUTH=off — the control plane has no login (loopback dev only)");
else if (!authService!.setupDone) console.warn("[auth] no admin password yet — run `sqlitend set-password` to enable the dashboard");

const routes = createRoutes({
  backup: replicator,
  restore,
  auth: authService ? { service: authService, repo: authRepo, cookieSecure: config.cookieSecure } : null,
  dns,
  config,
  workspaces,
  databases,
  tokens,
  supervisor,
  sampler,
  sqldOk,
  sqldVersion: sqldVer,
  version: VERSION,
});
const api = new Hono<AppEnv>().route("/", routes);

// Serve the SPA build from apps/web/dist with an index.html fallback.
const serveStatic = createStaticHandler(path.resolve(import.meta.dir, "../../web/dist"));

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  // Hard cap even when a request sends no content-length (chunked bodies): the
  // per-request check below is fast-path, this is the floor.
  maxRequestBodySize: config.maxBodyBytes,
  fetch(req: Request, srv): Response | Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
      const report = healthReport({
        databases: databases.list(),
        backupState: replicator ? (id) => replicator.status(id).state : null,
        sqldOk,
      });
      return Response.json(report, { status: report.status === "ok" ? 200 : 503, headers: { "cache-control": "no-store" } });
    }
    if (url.pathname.startsWith("/api")) {
      // Host allowlist: the API answers only when addressed as this listener
      // (defeats DNS-rebinding, where the attacker's page reaches our socket
      // but presents their own hostname).
      if (!isAllowedHost(url.host, config.port, config.host)) return new Response("Forbidden", { status: 403 });
      // Browser-initiated cross-site requests announce themselves via
      // Sec-Fetch-Site (Chrome/Edge/Firefox); allow same-origin + direct tools.
      const sfs = req.headers.get("sec-fetch-site");
      if (sfs && sfs !== "same-origin" && sfs !== "none") return new Response("Forbidden", { status: 403 });
      // Cap request bodies well below Bun's default.
      const cl = Number(req.headers.get("content-length") ?? "0");
      if (Number.isFinite(cl) && cl > config.maxBodyBytes) {
        return new Response("Payload Too Large", { status: 413 });
      }
      if (req.method !== "GET" && req.method !== "HEAD" && rateLimited()) {
        return new Response("Too Many Requests", { status: 429 });
      }
      return api.fetch(req, { ip: clientIp(req, srv.requestIP(req)?.address ?? null, config.trustProxy) });
    }
    return serveStatic(url.pathname);
  },
});

// Minimal in-memory rate limit for state-changing API calls. A single global
// counter (not per-remote): the server is localhost-only, so this bounds
// runaway clients, not attackers — the comment must not overstate isolation.
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;
let rateWindowStart = Date.now();
let rateCount = 0;

function rateLimited(): boolean {
  const now = Date.now();
  if (now - rateWindowStart > RATE_WINDOW_MS) {
    rateWindowStart = now;
    rateCount = 0;
  }
  rateCount++;
  return rateCount > RATE_LIMIT;
}

console.log(`sqlitend ${VERSION} listening on http://${config.host}:${server.port}`);

// ---------------------------------------------------------------------------
// Gateway (optional): host-routed public front for all databases
// ---------------------------------------------------------------------------
const gatewayServer = config.gatewayPort > 0 && config.gatewayHostTemplate
  ? Bun.serve({
      port: config.gatewayPort,
      hostname: config.gatewayHost,
      maxRequestBodySize: config.gatewayMaxBodyBytes,
      // Bun's 10 s default would drop long Hrana pipelines (migrations, VACUUM).
      idleTimeout: 255,
      fetch: createGatewayHandler({
        template: parseHostTemplate(config.gatewayHostTemplate),
        findDatabase: (key) => lookupByKey(key, databases),
        // sqld binds config.host; a wildcard bind answers on loopback.
        upstreamHost: ["0.0.0.0", "::", "*"].includes(config.host) ? "127.0.0.1" : config.host,
        maxBodyBytes: config.gatewayMaxBodyBytes,
        upstreamTimeoutMs: 240_000,
        tokens: { lookup: (jti) => tokens.getByJti(jti), verifySignature: signatureVerifier(), onUsed: throttledTouch() },
      }),
    })
  : null;
if (gatewayServer && !["127.0.0.1", "::1", "localhost"].includes(config.host)) {
  console.warn(
    `[gateway] WARNING: SQLITEND_HOST=${config.host} exposes sqld ports directly; token revocation is only ` +
      `enforced through the gateway. Set SQLITEND_HOST=127.0.0.1 in production.`,
  );
}
if (gatewayServer) {
  console.log(`[gateway] listening on http://${config.gatewayHost}:${gatewayServer.port} for ${config.gatewayHostTemplate}`);
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[shutdown] stopping sqld processes (spawned + adopted)…");
  await supervisor.shutdown();
  await replicator?.shutdown(); // after sqld: final WAL flush to the replica
  sampler.stop();
  server.stop(true);
  gatewayServer?.stop(true);
  metadata.db.close();
  console.log("[shutdown] complete");
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// ---------------------------------------------------------------------------
// Recovery hook: warn about data dirs on disk that metadata does not know
// (metadata.sqlite lost/corrupted leaves otherwise-healthy sqld data orphaned).
// ---------------------------------------------------------------------------
function warnUnregisteredDataDirs(): void {
  try {
    const wsRoot = path.join(config.dataRoot, "workspaces");
    if (!existsSync(wsRoot)) return;
    const known = new Set(databases.list().map((r) => path.resolve(r.data_dir)));
    const orphans: string[] = [];
    for (const ws of readdirSync(wsRoot, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue;
      const dbsDir = path.join(wsRoot, ws.name, "dbs");
      if (!existsSync(dbsDir)) continue;
      for (const slug of readdirSync(dbsDir, { withFileTypes: true })) {
        if (!slug.isDirectory()) continue;
        const dir = path.resolve(path.join(dbsDir, slug.name));
        if (!known.has(dir)) orphans.push(dir);
      }
    }
    if (orphans.length > 0) {
      console.warn(
        `[boot] WARNING: ${orphans.length} data dir(s) on disk are not referenced by metadata.sqlite:\n` +
          orphans.map((o) => `  - ${o}`).join("\n") +
          `\n  If metadata was lost, see docs/upgrade-sop.md (Recovery) to re-register them.`,
      );
    }
  } catch {
    /* best-effort boot warning only */
  }
}

/** last_used_at writes at most once a minute per token. */
function throttledTouch(): (jti: string, at: number) => void {
  const last = new Map<string, number>();
  return (jti, at) => {
    if ((last.get(jti) ?? 0) > at - 60_000) return;
    last.set(jti, at);
    tokens.touchLastUsed(jti, at);
  };
}

function signatureVerifier() {
  return createSignatureVerifier(config.dataRoot);
}
