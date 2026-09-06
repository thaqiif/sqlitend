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
import { createStaticHandler, isAllowedHost } from "./http/static.ts";

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
const { workspaces, databases, tokens } = metadata;

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
const routes = createRoutes({
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
const api = new Hono().route("/", routes);

// Serve the SPA build from apps/web/dist with an index.html fallback.
const serveStatic = createStaticHandler(path.resolve(import.meta.dir, "../../web/dist"));

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  // Hard cap even when a request sends no content-length (chunked bodies): the
  // per-request check below is fast-path, this is the floor.
  maxRequestBodySize: config.maxBodyBytes,
  fetch(req: Request): Response | Promise<Response> {
    const url = new URL(req.url);
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
      return api.fetch(req);
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
// Graceful shutdown
// ---------------------------------------------------------------------------
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[shutdown] stopping sqld processes (spawned + adopted)…");
  await supervisor.shutdown();
  sampler.stop();
  server.stop(true);
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
