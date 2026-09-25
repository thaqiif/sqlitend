import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { migrate, openDb } from "../../src/db/metadata.ts";
import { DatabasesRepo, type DatabaseRow } from "../../src/db/repos/databases.ts";
import { TokensRepo } from "../../src/db/repos/tokens.ts";
import { WorkspacesRepo } from "../../src/db/repos/workspaces.ts";
import { createRoutes, type RoutesDeps } from "../../src/http/routes.ts";
import type { DnsManager } from "../../src/dns/manager.ts";
import { loadConfig } from "../../src/config.ts";
import { createPortAllocator } from "../../src/supervisor/ports.ts";
import type { Supervisor } from "../../src/supervisor/supervisor.ts";
import type { Sampler, SamplerRow } from "../../src/metrics/sampler.ts";

let dir: string;
let db: Database;
let workspaces: WorkspacesRepo;
let databases: DatabasesRepo;
let tokens: TokensRepo;

const uid = () => crypto.randomUUID();

type StartResult = { ok: boolean; error?: string; alreadyRunning?: boolean; pid?: number };
type StartMock = (dbId: string, opts: { port: number; grpcPort: number; dataDir: string }) => Promise<StartResult>;

/** A stub supervisor: real allocator, scriptable startDatabase. */
function stubSupervisor(over: { startDatabase?: StartMock } = {}): Supervisor {
  const allocator = createPortAllocator(
    loadConfig({}, { dataRoot: dir, portRange: { start: 26201, end: 26400 } }),
    { persistedInUse: () => new Set(), probe: async () => false },
  );
  const startMock: StartMock = over.startDatabase ?? (async () => ({ ok: true, pid: 9999 }));
  return {
    portAllocator: allocator,
    // Emulate the real supervisor's status transitions so the routes' contract
    // (running on success, failed + failed_reason on failure) is the thing
    // under test. Errors thrown by a scripted mock propagate untouched.
    startDatabase: async (dbId: string, opts: { port: number; grpcPort: number; dataDir: string }) => {
      const r: StartResult = await startMock(dbId, opts);
      if (!r.ok) {
        databases.updateStatus(dbId, "failed");
        databases.clearRuntime(dbId);
        databases.setFailedReason(dbId, r.error ?? "stub failure");
      } else if (!r.alreadyRunning) {
        databases.updateStatus(dbId, "running");
        databases.setFailedReason(dbId, null);
      }
      return r;
    },
    stopDatabase: async (id: string) => { databases.updateStatus(id, "stopped"); },
    killByDbId: async () => {},
    trackedDbIds: [],
    shutdown: async () => {},
    reconcile: async () => ({ adopted: 0, relaunched: 0, leftStopped: 0, notAdopted: 0 }),
    sweepOrphans: async () => 0,
  } as unknown as Supervisor;
}

const stubSampler: Sampler = {
  latestFor: () => undefined,
  sampleOne: (r: SamplerRow) => ({ cpuPct: null, memoryBytes: 0, diskBytes: 0, uptimeSec: 0, status: r.status, sampledAt: Date.now() }),
  set: () => {},
  start: () => {},
  stop: () => {},
} as unknown as Sampler;

function makeApp(over: {
  supervisor?: Supervisor;
  sampler?: Sampler;
  sqldOk?: boolean;
  publicHost?: string;
  gatewayHostTemplate?: string;
  dns?: RoutesDeps["dns"];
} = {}) {
  return createRoutes({
    config: loadConfig({}, {
      dataRoot: dir,
      ...(over.publicHost ? { publicHost: over.publicHost } : {}),
      ...(over.gatewayHostTemplate ? { gatewayPort: 6080, gatewayHostTemplate: over.gatewayHostTemplate } : {}),
    }),
    workspaces,
    databases,
    tokens,
    supervisor: over.supervisor ?? stubSupervisor(),
    sampler: over.sampler ?? stubSampler,
    sqldOk: over.sqldOk ?? true,
    sqldVersion: "fake",
    version: "test",
    dns: over.dns ?? null,
  });
}

const send = (app: ReturnType<typeof createRoutes>, method: string, pathname: string, body?: unknown) =>
  app.request(
    pathname,
    body === undefined
      ? { method }
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sqlitend-routes-"));
  db = openDb(path.join(dir, "metadata.sqlite"));
  migrate(db);
  workspaces = new WorkspacesRepo(db);
  databases = new DatabasesRepo(db);
  tokens = new TokensRepo(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const wsRow = (slug: string) => ({ id: uid(), slug, name: `Workspace ${slug}`, createdAt: Date.now() });
const wsId = () => workspaces.create(wsRow(`ws-${uid().slice(0, 8)}`)).id;
const dbRow = (workspaceId: string, over: Partial<Parameters<DatabasesRepo["create"]>[0]> = {}) => ({
  id: uid(),
  workspace_id: workspaceId,
  slug: `db-${uid().slice(0, 8)}`,
  name: "A database",
  data_dir: path.join(dir, "workspaces", "ws", "db"),
  created_at: Date.now(),
  ...over,
});

describe("workspaces routes", () => {
  test("POST /api/workspaces creates and returns the slug; invalid body is a 400", async () => {
    const app = makeApp();
    const res = await send(app, "POST", "/api/workspaces", { name: "My Workspace" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string };
    expect(body.slug).toBe("my-workspace");

    const bad = await send(app, "POST", "/api/workspaces", {});
    expect(bad.status).toBe(400);
    const errBody = (await bad.json()) as { error: { code: string } };
    expect(errBody.error.code).toBe("bad_request");
  });

  test("DELETE non-empty workspace -> 409 with db slugs; empty -> 204; unknown -> 404", async () => {
    const app = makeApp();
    const ws = workspaces.create(wsRow("main"));
    databases.create(dbRow(ws.id, { slug: "one" }));
    databases.create(dbRow(ws.id, { slug: "two" }));

    const conflict = await send(app, "DELETE", `/api/workspaces/${ws.id}`);
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { error: { detail?: string } };
    expect(body.error.detail).toContain("one");
    expect(body.error.detail).toContain("two");

    const emptyWs = workspaces.create(wsRow("empty"));
    const ok = await send(app, "DELETE", `/api/workspaces/${emptyWs.id}`);
    expect(ok.status).toBe(204);

    const missing = await send(app, "DELETE", `/api/workspaces/${uid()}`);
    expect(missing.status).toBe(404);
  });
});

describe("databases routes", () => {
  test("POST .../databases returns 503 sqld_unavailable when the binary is unusable", async () => {
    const app = makeApp({ sqldOk: false });
    const ws = workspaces.create(wsRow("main"));
    const res = await send(app, "POST", `/api/workspaces/${ws.id}/databases`, { name: "demo" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("sqld_unavailable");
  });

  test("POST .../databases -> 502 start_failed and the row is persisted failed with a reason", async () => {
    mkdirSync(path.join(dir, "workspaces", "ws", "dbs", "demo"), { recursive: true });
    const failLaunch = async () => ({ ok: false, error: "boom" });
    const app = makeApp({ supervisor: stubSupervisor({ startDatabase: failLaunch }) });
    const ws = workspaces.create(wsRow("main"));

    const res = await send(app, "POST", `/api/workspaces/${ws.id}/databases`, { name: "demo" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; detail?: string } };
    expect(body.error.code).toBe("start_failed");
    // The row is created (failed), and its failed_reason carries the diagnostic.
    const row = databases.getBySlug("demo");
    expect(row).not.toBeNull();
    expect(row!.status).toBe("failed");
    expect(row!.failed_reason).toBeTruthy();
  });

  test("POST .../databases duplicate slug -> 409 slug_conflict", async () => {
    const app = makeApp();
    const ws = workspaces.create(wsRow("main"));
    const first = await send(app, "POST", `/api/workspaces/${ws.id}/databases`, { name: "Demo DB" });
    expect(first.status).toBe(201);

    const second = await send(app, "POST", `/api/workspaces/${ws.id}/databases`, { name: "Demo DB" });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("slug_conflict");
  });

  test("POST .../databases happy path creates a running database", async () => {
    const app = makeApp();
    const ws = workspaces.create(wsRow("main"));
    const res = await send(app, "POST", `/api/workspaces/${ws.id}/databases`, { name: "demo" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string; slug: string };
    expect(body.slug).toBe("demo");
    expect(body.status).toBe("running");
  });
});

describe("start / stop routes", () => {
  const ws = () => workspaces.create(wsRow(`ws-${uid().slice(0, 8)}`));

  test("POST /api/databases/:id/stop -> 200", async () => {
    const app = makeApp();
    const d = databases.create(dbRow(ws().id, { status: "running" }));
    const res = await send(app, "POST", `/api/databases/${d.id}/stop`, {});
    expect(res.status).toBe(200);
    expect(databases.getById(d.id)?.status).toBe("stopped");
  });

  test("unknown database -> 404 with code not_found", async () => {
    const app = makeApp();
    const res = await send(app, "GET", `/api/databases/${uid()}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  test("GET /api/databases/:id/connection: not_ready without ports, 3 URLs with ports", async () => {
    const app = makeApp();
    const d = databases.create(dbRow(ws().id, {}));
    const notReady = await send(app, "GET", `/api/databases/${d.id}/connection`);
    expect(notReady.status).toBe(409);
    const notReadyBody = (await notReady.json()) as { error: { code: string } };
    expect(notReadyBody.error.code).toBe("not_ready");

    const d2 = databases.create(dbRow(ws().id, { port: 5001, grpc_port: 5002, status: "running" }));
    const ok = await send(app, "GET", `/api/databases/${d2.id}/connection`);
    expect(ok.status).toBe(200);
    const conn = (await ok.json()) as { httpUrl: string; hranaUrl: string; grpcUrl: string };
    expect(conn.httpUrl).toBe("http://127.0.0.1:5001");
    expect(conn.hranaUrl).toBe("ws://127.0.0.1:5001");
    expect(conn.grpcUrl).toBe("http://127.0.0.1:5002");
  });

  test("publicUrl is null without a gateway and https://<slug><suffix> with one", async () => {
    const d = databases.create(dbRow(ws().id, { slug: "bots-prod", port: 5001, grpc_port: 5002, status: "running" }));
    const off = (await (await send(makeApp(), "GET", `/api/databases/${d.id}/connection`)).json()) as { publicUrl: string | null };
    expect(off.publicUrl).toBeNull();
    const app = makeApp({ gatewayHostTemplate: "{db}-libsql.cloudsby.me" });
    const on = (await (await send(app, "GET", `/api/databases/${d.id}/connection`)).json()) as { publicUrl: string | null };
    expect(on.publicUrl).toBe("https://bots-prod-libsql.cloudsby.me");
  });

  test("create rejects names whose slug cannot fit a DNS label under the gateway template", async () => {
    const app = makeApp({ gatewayHostTemplate: "{db}-libsql.cloudsby.me" });
    const res = await send(app, "POST", `/api/workspaces/${ws().id}/databases`, { name: "x".repeat(57) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("name_too_long");
    const fits = await send(app, "POST", `/api/workspaces/${ws().id}/databases`, { name: "y".repeat(56) });
    expect(fits.status).toBe(201);
  });

  test("connection URLs advertise SQLITEND_PUBLIC_HOST when configured", async () => {
    const app = makeApp({ publicHost: "100.97.250.76" });
    const d = databases.create(dbRow(ws().id, { port: 7001, grpc_port: 7002, status: "running" }));
    const res = await send(app, "GET", `/api/databases/${d.id}/connection`);
    expect(res.status).toBe(200);
    const conn = (await res.json()) as { httpUrl: string; hranaUrl: string; grpcUrl: string };
    expect(conn.httpUrl).toBe("http://100.97.250.76:7001");
    expect(conn.hranaUrl).toBe("ws://100.97.250.76:7001");
    expect(conn.grpcUrl).toBe("http://100.97.250.76:7002");
  });

  test("/api/system exposes the advertised publicHost", async () => {
    const app = makeApp({ publicHost: "203.0.113.7" });
    const res = await send(app, "GET", "/api/system");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { publicHost: string };
    expect(body.publicHost).toBe("203.0.113.7");
  });

  test("POST /api/databases/:id/start: 409 already_running and 409 deleting and 503 when sqld unavailable", async () => {
    const runningApp = makeApp({
      supervisor: stubSupervisor({ startDatabase: async () => ({ ok: true, alreadyRunning: true }) }),
    });
    const running = databases.create(dbRow(ws().id, { port: 5001, grpc_port: 5002, status: "running" }));
    const already = await send(runningApp, "POST", `/api/databases/${running.id}/start`, {});
    expect(already.status).toBe(409);
    expect(((await already.json()) as { error: { code: string } }).error.code).toBe("already_running");

    const deleting = databases.create(dbRow(ws().id, { port: 5003, grpc_port: 5004, status: "deleting" }));
    const deleted = await send(runningApp, "POST", `/api/databases/${deleting.id}/start`, {});
    expect(deleted.status).toBe(409);
    expect(((await deleted.json()) as { error: { code: string } }).error.code).toBe("deleting");

    const unavailable = databases.create(dbRow(ws().id, { port: 5005, grpc_port: 5006, status: "stopped" }));
    const noSqld = await send(makeApp({ sqldOk: false }), "POST", `/api/databases/${unavailable.id}/start`, {});
    expect(noSqld.status).toBe(503);
    expect(((await noSqld.json()) as { error: { code: string } }).error.code).toBe("sqld_unavailable");
  });
});

describe("token management routes", () => {
  test("POST names the token; GET lists name/revokedAt/lastUsedAt; bad name is 400", async () => {
    const app = makeApp();
    const d = databases.create(dbRow(wsId(), { slug: "named" }));
    const res = await send(app, "POST", `/api/databases/${d.id}/tokens`, { name: "worker-prod", expiresInHours: 8760 });
    expect(res.status).toBe(201);
    const issued = (await res.json()) as { name: string; token: string; revokedAt: null };
    expect(issued.name).toBe("worker-prod");
    expect(issued.token.split(".")).toHaveLength(3);
    const list = (await (await send(app, "GET", `/api/databases/${d.id}/tokens`)).json()) as { name: string; revokedAt: null; lastUsedAt: null }[];
    expect(list).toEqual([expect.objectContaining({ name: "worker-prod", revokedAt: null, lastUsedAt: null })]);
    expect((await send(app, "POST", `/api/databases/${d.id}/tokens`, { name: "" })).status).toBe(400);
    expect((await send(app, "POST", `/api/databases/${d.id}/tokens`, { name: "x".repeat(65) })).status).toBe(400);
  });

  test("GET /api/tokens/expiring: within window, recent expiries only, excludes revoked", async () => {
    const app = makeApp();
    const d = databases.create(dbRow(wsId(), { slug: "exp" }));
    const now = Date.now();
    const mk = (jti: string, expiresAt: number) => tokens.create({ jti, databaseId: d.id, scope: "full", createdAt: now, expiresAt, name: jti });
    mk("soon", now + 3 * 86_400_000);
    mk("later", now + 60 * 86_400_000);
    mk("dead", now - 1000);
    mk("ancient", now - 30 * 86_400_000);
    mk("revoked", now + 86_400_000);
    tokens.revoke("revoked", now);
    const res = (await (await send(app, "GET", "/api/tokens/expiring")).json()) as { jti: string; dbSlug: string; expired: boolean }[];
    expect(res.map((t) => [t.jti, t.expired, t.dbSlug])).toEqual([["dead", true, "exp"], ["soon", false, "exp"]]);
    const wide = (await (await send(app, "GET", "/api/tokens/expiring?withinDays=90")).json()) as unknown[];
    expect(wide).toHaveLength(3);
    const withOld = (await (await send(app, "GET", "/api/tokens/expiring?expiredWithinDays=60")).json()) as { jti: string }[];
    expect(withOld.map((t) => t.jti)).toEqual(["ancient", "dead", "soon"]);
    expect((await send(app, "GET", "/api/tokens/expiring?withinDays=-1")).status).toBe(400);
  });
});

describe("delete / tokens / metrics routes", () => {
  test("DELETE /api/databases/:id -> 204 and removes the data dir; unknown -> 404; token revoke", async () => {
    const app = makeApp();
    const dataDir = path.join(dir, "workspaces", "ws", "dbs", "delme");
    mkdirSync(dataDir, { recursive: true });
    const d = databases.create(dbRow(wsId(), { slug: "delme", status: "running", port: 5005, grpc_port: 5006, data_dir: dataDir }));

    const ok = await send(app, "DELETE", `/api/databases/${d.id}`, {});
    expect(ok.status).toBe(204);
    expect(databases.getById(d.id)).toBeNull();
    expect(existsSync(dataDir)).toBe(false);
    // Now-empty parents (dbs/, then the workspace dir) are cleaned up too.
    expect(existsSync(path.dirname(dataDir))).toBe(false);
    expect(existsSync(path.dirname(path.dirname(dataDir)))).toBe(false);

    const missing = await send(app, "DELETE", `/api/databases/${uid()}`, {});
    expect(missing.status).toBe(404);

    const tok = databases.create(dbRow(wsId(), { slug: "tokdb" }));
    const t = tokens.create({ jti: uid(), databaseId: tok.id, scope: "full", createdAt: Date.now(), expiresAt: Date.now() + 3600_000 });
    const revoke = await send(app, "DELETE", `/api/databases/${tok.id}/tokens/${t.jti}`, {});
    expect(revoke.status).toBe(200);
    const revokedAt = ((await revoke.json()) as { revokedAt: number }).revokedAt;
    expect(revokedAt).toBeGreaterThan(0);
    // Idempotent: the first revocation time is kept.
    const again = (await (await send(app, "DELETE", `/api/databases/${tok.id}/tokens/${t.jti}`, {})).json()) as { revokedAt: number };
    expect(again.revokedAt).toBe(revokedAt);
    // A token of another database is not reachable through this one.
    const other = databases.create(dbRow(wsId(), { slug: "otherdb" }));
    expect((await send(app, "DELETE", `/api/databases/${other.id}/tokens/${t.jti}`, {})).status).toBe(404);
  });

  test("DELETE keeps parent dirs when a sibling database still exists", async () => {
    const app = makeApp();
    const ws = workspaces.create(wsRow("ws-sib"));
    const dbsDir = path.join(dir, "workspaces", "ws-sib", "dbs");
    const keepDir = path.join(dbsDir, "keep");
    const goneDir = path.join(dbsDir, "gone");
    mkdirSync(keepDir, { recursive: true });
    mkdirSync(goneDir, { recursive: true });
    const keep = databases.create(dbRow(ws.id, { slug: "keep", status: "running", data_dir: keepDir }));
    const gone = databases.create(dbRow(ws.id, { slug: "gone", status: "running", data_dir: goneDir }));

    const res = await send(app, "DELETE", `/api/databases/${gone.id}`, {});
    expect(res.status).toBe(204);
    expect(existsSync(goneDir)).toBe(false);
    // The dbs/ and workspace dirs survive because `keep` still lives there.
    expect(existsSync(dbsDir)).toBe(true);
    expect(existsSync(path.dirname(dbsDir))).toBe(true);
    expect(existsSync(path.join(keepDir, "db.sqlite"))).toBe(false); // just the dir
    expect(databases.getById(keep.id)).not.toBeNull();
  });

  // One corrupt metadata row must never take the whole list (or metrics) down:
  // GET /api/databases serves it as status "unknown" instead of 500ing.
  test("a corrupt status value is served as unknown and does not 500 the list", async () => {
    const app = makeApp();
    const ws = workspaces.create(wsRow("main"));
    const good = databases.create(dbRow(ws.id, { slug: "good", status: "running" }));
    const bad = databases.create(dbRow(ws.id, { slug: "bad", status: "running" }));
    // Simulate a manually edited / corrupted metadata row.
    databases.updateStatus(bad.id, "flying" as unknown as string);

    const res = await send(app, "GET", "/api/databases");
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string; status: string }[];
    expect(rows).toHaveLength(2);
    const badRow = rows.find((r) => r.id === bad.id)!;
    expect(badRow.status).toBe("unknown");
    const goodRow = rows.find((r) => r.id === good.id)!;
    expect(goodRow.status).toBe("running");

    // The metrics endpoint must survive the same corrupt row (sampleDto path).
    const met = await send(app, "GET", `/api/databases/${bad.id}/metrics`);
    expect(met.status).toBe(200);
    const metBody = (await met.json()) as { status: string };
    expect(metBody.status).toBe("unknown");
  });

  test("minting a token returns token + jti; bad scope is a 400", async () => {
    const app = makeApp();
    const d = databases.create(dbRow(wsId()));
    const good = await send(app, "POST", `/api/databases/${d.id}/tokens`, {});
    expect(good.status).toBe(201);
    const goodBody = (await good.json()) as { token: string; jti: string };
    expect(goodBody.token).toBeTruthy();
    expect(goodBody.jti).toBeTruthy();
    expect(tokens.listByDatabase(d.id)).toHaveLength(1);

    const bad = await send(app, "POST", `/api/databases/${d.id}/tokens`, { scope: "ro" });
    expect(bad.status).toBe(400);
  });

  test("a thrown non-ApiError from a stub surfaces as 500 {error:{code:'internal'}}", async () => {
    // startDatabase is called without a try/catch in the POST handler, so any
    // non-ApiError it throws bubbles to the global onError -> 500 internal.
    const boomApp = makeApp({
      supervisor: stubSupervisor({ startDatabase: async () => { throw new Error("unexpected booooom"); } }),
    });
    const ws2 = workspaces.create(wsRow("boom"));
    const res = await send(boomApp, "POST", `/api/workspaces/${ws2.id}/databases`, { name: "x" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("internal");
    expect(body.error.message).toBe("internal error");
    // The internals (stack / message) are NOT leaked to the client.
    expect(JSON.stringify(body)).not.toContain("booooom");
  });
});

describe("dns routes", () => {
  function fakeDns() {
    const log: string[] = [];
    const mgr = {
      sync: async (row: DatabaseRow) => {
        log.push(`sync ${row.slug}`);
        databases.setDns(row.id, { hostname: `${row.slug}-libsql.cloudsby.me`, recordId: "rec1", status: "active", error: null });
      },
      remove: async (row: DatabaseRow) => { log.push(`remove ${row.dns_record_id}`); },
    } as unknown as DnsManager;
    return { mgr, log };
  }

  test("create syncs DNS and returns the dns state; delete removes it", async () => {
    const { mgr, log } = fakeDns();
    const app = makeApp({ gatewayHostTemplate: "{db}-libsql.cloudsby.me", dns: mgr });
    const w = workspaces.create(wsRow(`ws-${uid().slice(0, 8)}`));
    const res = await send(app, "POST", `/api/workspaces/${w.id}/databases`, { name: "Bots Prod" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; dns: { hostname: string; status: string; error: string | null } };
    expect(body.dns).toEqual({ hostname: "bots-prod-libsql.cloudsby.me", status: "active", error: null });
    expect((await send(app, "DELETE", `/api/databases/${body.id}`)).status).toBe(204);
    expect(log).toEqual(["sync bots-prod", "remove rec1"]);
  });

  test("POST /dns/sync: 409 when disabled, re-syncs when enabled", async () => {
    const w = workspaces.create(wsRow(`ws-${uid().slice(0, 8)}`));
    const row = databases.create(dbRow(w.id, { slug: "x" }));
    const off = await send(makeApp(), "POST", `/api/databases/${row.id}/dns/sync`);
    expect(off.status).toBe(409);
    const { mgr, log } = fakeDns();
    const on = await send(makeApp({ dns: mgr }), "POST", `/api/databases/${row.id}/dns/sync`);
    expect(on.status).toBe(200);
    expect(((await on.json()) as { dns: { status: string } }).dns.status).toBe("active");
    expect(log).toEqual(["sync x"]);
  });
});
