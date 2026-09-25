import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as SQLite } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../../src/db/metadata.ts";
import { DatabasesRepo, type DatabaseRow } from "../../src/db/repos/databases.ts";
import { WorkspacesRepo } from "../../src/db/repos/workspaces.ts";
import { TokensRepo } from "../../src/db/repos/tokens.ts";
import { RestoreService, litestreamReplicaUrl, resolveTxid, verifySqliteFile, type RunLitestream, type S3Like } from "../../src/backup/restore.ts";
import { sqldDataFile } from "../../src/backup/replicator.ts";
import { createRoutes } from "../../src/http/routes.ts";
import { loadConfig, type BackupConfig } from "../../src/config.ts";
import { createPortAllocator } from "../../src/supervisor/ports.ts";
import type { Supervisor } from "../../src/supervisor/supervisor.ts";
import type { Sampler } from "../../src/metrics/sampler.ts";

const cfg: BackupConfig = {
  endpoint: "https://s3.example.com", bucket: "sqlitend-backups", region: "auto", forcePathStyle: true,
  accessKeyId: "k", secretAccessKey: "s", prefix: "server-a", litestreamPath: "/x", snapshotInterval: "24h",
  retention: "168h", maxLagMs: 60_000, verifyAt: null, verifyMaxAgeMs: 48 * 3_600_000, control: null,
};

/** In-memory S3 with prefix/delimiter listing (preloaded with replica data for the test source). */
function fakeS3(): S3Like & { objects: Map<string, string> } {
  const objects = new Map<string, string>([["server-a/db/11111111-2222-3333-4444-555555555555/ltx/0/0000000000000001.ltx", "x"]]);
  return {
    objects,
    write: async (k, v) => void objects.set(k, v),
    file: (k) => ({ text: async () => objects.get(k)!, exists: async () => objects.has(k) }),
    list: async ({ prefix, delimiter }) => {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (!delimiter) return { contents: keys.map((key) => ({ key })) };
      const cps = new Set(keys.map((k) => prefix + k.slice(prefix.length).split(delimiter)[0] + delimiter));
      return { commonPrefixes: [...cps].map((p) => ({ prefix: p })) };
    },
  };
}

/** A real SQLite file with rows, standing in for what litestream would restore. */
function makeSqlite(file: string, rows: number) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new SQLite(file);
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)");
  for (let i = 0; i < rows; i++) db.query("INSERT INTO users(name) VALUES (?)").run(`u${i}`);
  db.close();
}

let dir: string;
let meta: Database;
let databases: DatabasesRepo;
let wsId: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sqlitend-restore-"));
  meta = openDb(path.join(dir, "metadata.sqlite"));
  migrate(meta);
  databases = new DatabasesRepo(meta);
  wsId = new WorkspacesRepo(meta).create({ id: crypto.randomUUID(), slug: "ws", name: "ws", createdAt: 0 }).id;
});
afterEach(() => {
  meta.close();
  rmSync(dir, { recursive: true, force: true });
});

const target = (slug = "bots-restored"): DatabaseRow =>
  databases.create({
    id: crypto.randomUUID(), workspace_id: wsId, slug, name: slug, status: "restoring", auto_start: 0,
    data_dir: path.join(dir, "ws", "dbs", slug), created_at: 0,
  });

function service(run: RunLitestream, over: Partial<ConstructorParameters<typeof RestoreService>[0]> = {}) {
  const started: string[] = [];
  const svc = new RestoreService({
    config: cfg, databases, s3: fakeS3(), run, log: () => {},
    startDatabase: async (row) => {
      started.push(row.id);
      databases.updateStatus(row.id, "running");
      return { ok: true };
    },
    ...over,
  });
  return { svc, started };
}

const LTX = [
  { level: 0, min_txid: "0000000000000001", max_txid: "0000000000000001", timestamp: "2026-09-25T08:00:10Z" },
  { level: 0, min_txid: "0000000000000002", max_txid: "0000000000000002", timestamp: "2026-09-25T08:05:00Z" },
  { level: 1, min_txid: "0000000000000001", max_txid: "0000000000000002", timestamp: "2026-09-25T08:05:30Z" },
];

/** Fake litestream: `ltx` lists LTX; `restore` writes a real SQLite file to the -o path. */
const writes = (rows: number, seen?: string[][]): RunLitestream => async (args) => {
  seen?.push(args);
  if (args[0] === "ltx") return { code: 0, output: JSON.stringify(LTX) };
  makeSqlite(args[args.indexOf("-o") + 1]!, rows);
  return { code: 0, output: "" };
};

describe("restore job", () => {
  test("restores, verifies, places the file where sqld expects it, enables auto_start, starts", async () => {
    const seen: string[][] = [];
    const { svc, started } = service(writes(42, seen));
    const t = target();
    svc.start("11111111-2222-3333-4444-555555555555", t, "2026-09-25T08:03:00Z");
    expect(svc.isRestoring(t.id)).toBe(true);
    await svc.settled(t.id);
    const row = databases.getById(t.id)!;
    expect(row.status).toBe("running");
    expect(row.auto_start).toBe(1);
    expect(started).toEqual([t.id]);
    const placed = new SQLite(sqldDataFile(t.data_dir), { readonly: true });
    expect((placed.query("SELECT count(*) n FROM users").get() as { n: number }).n).toBe(42);
    placed.close();
    expect(existsSync(`${t.data_dir}.restore`)).toBe(false);
    expect(seen[0]!.slice(0, 4)).toEqual(["ltx", "-level", "all", "-json"]);
    expect(seen[1]).toEqual([
      "restore", "-o", path.join(`${t.data_dir}.restore`, "data"), "-txid", "0000000000000001",
      litestreamReplicaUrl(cfg, "11111111-2222-3333-4444-555555555555"),
    ]);
    expect(seen[1]!.at(-1)).toContain("s3://sqlitend-backups/server-a/db/11111111-2222-3333-4444-555555555555?");
  });

  test("litestream failure → failed with its output; nothing placed; never started", async () => {
    const { svc, started } = service(async () => ({ code: 1, output: "cannot find max generation: no snapshots available" }));
    const t = target();
    svc.start("11111111-2222-3333-4444-555555555555", t);
    await svc.settled(t.id);
    const row = databases.getById(t.id)!;
    expect(row.status).toBe("failed");
    expect(row.auto_start).toBe(0);
    expect(row.failed_reason).toContain("no snapshots available");
    expect(started).toEqual([]);
    expect(existsSync(sqldDataFile(t.data_dir))).toBe(false);
  });

  test("no replica (exit 0, no file) → failed, not an empty database", async () => {
    const { svc, started } = service(async () => ({ code: 0, output: "" }));
    const t = target();
    svc.start("11111111-2222-3333-4444-555555555555", t);
    await svc.settled(t.id);
    expect(databases.getById(t.id)!.failed_reason).toContain("no replica data");
    expect(started).toEqual([]);
  });

  test("corrupt restored file fails verification and is not placed", async () => {
    const { svc, started } = service(async (args) => {
      const out = args[args.indexOf("-o") + 1]!;
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, "definitely not sqlite ".repeat(500));
      return { code: 0, output: "" };
    });
    const t = target();
    svc.start("11111111-2222-3333-4444-555555555555", t);
    await svc.settled(t.id);
    expect(databases.getById(t.id)!.status).toBe("failed");
    expect(databases.getById(t.id)!.failed_reason).toMatch(/cannot open restored file|integrity_check/);
    expect(started).toEqual([]);
    expect(existsSync(sqldDataFile(t.data_dir))).toBe(false);
  });

  test("refuses to merge with a leftover data file in the target directory", async () => {
    const { svc, started } = service(writes(1));
    const t = target();
    makeSqlite(sqldDataFile(t.data_dir), 1); // leftover of an earlier database
    svc.start("11111111-2222-3333-4444-555555555555", t);
    await svc.settled(t.id);
    expect(databases.getById(t.id)!.failed_reason).toContain("already contains a database file");
    expect(started).toEqual([]);
  });

  test("a failure after sqld started is logged, not marked failed", async () => {
    const logs: string[] = [];
    const { svc } = service(writes(1), { afterStart: async () => { throw new Error("dns boom"); }, log: (m) => logs.push(m) });
    const t = target();
    svc.start("11111111-2222-3333-4444-555555555555", t);
    await svc.settled(t.id);
    expect(databases.getById(t.id)!.status).toBe("running");
    expect(logs.some((l) => l.includes("post-start step failed") && l.includes("dns boom"))).toBe(true);
  });

  test("the row is handed to the supervisor as 'starting' (never started while 'restoring')", async () => {
    const seenStatus: string[] = [];
    const { svc } = service(writes(1), {
      startDatabase: async (row) => {
        seenStatus.push(row.status);
        databases.updateStatus(row.id, "running");
        return { ok: true };
      },
    });
    const t = target();
    svc.start("11111111-2222-3333-4444-555555555555", t);
    await svc.settled(t.id);
    expect(seenStatus).toEqual(["starting"]);
  });

  test("verifySqliteFile: ok for a good file", () => {
    const f = path.join(dir, "good.sqlite");
    makeSqlite(f, 3);
    expect(verifySqliteFile(f)).toBeNull();
  });
});

describe("resolveTxid", () => {
  const at = (s: string) => new Date(s);
  test("highest txid strictly before the time, across levels; latest time → latest txid", () => {
    expect(resolveTxid(LTX, at("2026-09-25T08:03:00Z"))).toEqual({ txid: "0000000000000001" });
    expect(resolveTxid(LTX, at("2026-09-25T08:05:00Z"))).toEqual({ txid: "0000000000000001" }); // same second → excluded
    expect(resolveTxid(LTX, at("2026-09-25T08:05:01Z"))).toEqual({ txid: "0000000000000002" });
    expect(resolveTxid(LTX, at("2026-09-26T00:00:00Z"))).toEqual({ txid: "0000000000000002" }); // after last write: fine
  });
  test("before the first backup → earliest restorable time; no files → null", () => {
    expect(resolveTxid(LTX, at("2026-09-25T07:00:00Z"))).toEqual({ earliest: "2026-09-25T08:00:11.000Z" });
    expect(resolveTxid([], at("2026-09-25T07:00:00Z"))).toEqual({ earliest: null });
  });
  test("job fails with the earliest time when asked for a time before any backup", async () => {
    const { svc, started } = service(writes(1));
    const t = target();
    svc.start("11111111-2222-3333-4444-555555555555", t, "2026-09-25T07:00:00Z");
    await svc.settled(t.id);
    expect(databases.getById(t.id)!.failed_reason).toContain("earliest restorable: 2026-09-25T08:00:11.000Z");
    expect(started).toEqual([]);
  });
});

describe("restore preflight", () => {
  test("unreachable store or missing replica fails fast, before litestream runs", async () => {
    const calls: string[][] = [];
    const s3: S3Like = { write: async () => {}, file: () => ({ text: async () => "", exists: async () => false }), list: () => new Promise(() => {}) };
    const { svc, started } = service(writes(1, calls), { s3, preflightTimeoutMs: 100 });
    const t = target();
    svc.start("11111111-2222-3333-4444-555555555555", t);
    await svc.settled(t.id);
    expect(databases.getById(t.id)!.failed_reason).toContain("backup store unreachable");
    expect(calls).toHaveLength(0);
    expect(started).toEqual([]);

    const t2 = target("second");
    const { svc: svc2 } = service(writes(1));
    svc2.start("99999999-2222-3333-4444-555555555555", t2); // no objects under this id
    await svc2.settled(t2.id);
    expect(databases.getById(t2.id)!.failed_reason).toContain("no replica found");
  });
});

describe("manifests + replica listing", () => {
  test("lists replicas under the prefix with manifests; flags deleted ones", async () => {
    const s3 = fakeS3();
    s3.objects.clear();
    const { svc } = service(writes(1), { s3 });
    const live = target("live");
    await svc.ensureManifest(live);
    await svc.ensureManifest(live); // idempotent
    s3.objects.set("server-a/db/dead0000-0000-0000-0000-000000000000/sqlitend.json", JSON.stringify({ id: "dead0000-0000-0000-0000-000000000000", slug: "old-bot", name: "Old bot" }));
    s3.objects.set("server-a/db/nomanifest-0000-0000-0000-000000000000/ltx/0/x", "x");
    s3.objects.set("server-b/db/other-server/sqlitend.json", "{}");
    const list = (await svc.listReplicas()).sort((a, b) => a.id.localeCompare(b.id));
    expect(list.map((r) => [r.id, r.slug ?? null, r.exists])).toEqual(
      [
        ["dead0000-0000-0000-0000-000000000000", "old-bot", false],
        [live.id, "live", true],
        ["nomanifest-0000-0000-0000-000000000000", null, false],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
  });
});

describe("replica listing pagination", () => {
  test("follows continuation tokens and de-duplicates ids", async () => {
    const pages = [
      { commonPrefixes: [{ prefix: "server-a/db/a/" }, { prefix: "server-a/db/b/" }], isTruncated: true, nextContinuationToken: "t1" },
      { commonPrefixes: [{ prefix: "server-a/db/b/" }, { prefix: "server-a/db/c/" }], isTruncated: false },
    ];
    const tokens: (string | undefined)[] = [];
    const s3: S3Like = {
      write: async () => {},
      file: () => ({ text: async () => "{}", exists: async () => false }),
      list: async (o) => {
        tokens.push(o.continuationToken);
        return pages[tokens.length - 1]!;
      },
    };
    const { svc } = service(writes(1), { s3 });
    expect((await svc.listReplicas()).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(tokens).toEqual([undefined, "t1"]);
  });
});

describe("restore routes", () => {
  function app(restore: RestoreService | null) {
    return createRoutes({
      config: loadConfig({}, { dataRoot: dir }),
      workspaces: new WorkspacesRepo(meta),
      databases,
      tokens: new TokensRepo(meta),
      supervisor: {
        portAllocator: createPortAllocator(loadConfig({}, { dataRoot: dir, portRange: { start: 27001, end: 27100 } }), { persistedInUse: () => new Set(), probe: async () => false }),
      } as unknown as Supervisor,
      sampler: {} as unknown as Sampler,
      sqldOk: true,
      sqldVersion: "f",
      version: "t",
      restore,
    });
  }
  const post = (a: ReturnType<typeof app>, p: string, body: unknown) =>
    a.request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const SRC = "11111111-2222-3333-4444-555555555555";

  test("202 + a restoring row with auto_start=0 and ports; job runs to running", async () => {
    const { svc } = service(writes(5));
    const a = app(svc);
    const res = await post(a, `/api/backups/${SRC}/restore`, { name: "Bots restored", workspaceId: wsId });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; status: string; slug: string; port: number; autoStart: boolean };
    expect(body).toMatchObject({ status: "restoring", slug: "bots-restored", autoStart: false });
    expect(body.port).toBeGreaterThan(0);
    await svc.settled(body.id);
    expect(databases.getById(body.id)!.status).toBe("running");
  });

  test("start/stop are refused while restoring and for a failed restore target", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { svc } = service(async (args) => {
      await gate;
      return { code: 1, output: "no matching backup files available" };
    });
    const a = app(svc);
    const { id } = (await (await post(a, `/api/backups/${SRC}/restore`, { name: "guarded", workspaceId: wsId })).json()) as { id: string };
    for (const action of ["start", "stop"]) {
      const r = await a.request(`/api/databases/${id}/${action}`, { method: "POST" });
      expect(r.status).toBe(409);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("restoring");
    }
    release();
    await svc.settled(id);
    expect(databases.getById(id)!.status).toBe("failed");
    const r = await a.request(`/api/databases/${id}/start`, { method: "POST" });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("restore_failed");
  });

  test("delete is refused while the restore job runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { svc } = service(async (args) => {
      await gate;
      return writes(1)(args, 0);
    });
    const a = app(svc);
    const { id } = (await (await post(a, `/api/backups/${SRC}/restore`, { name: "slow", workspaceId: wsId })).json()) as { id: string };
    expect(databases.getById(id)!.auto_start).toBe(0);
    expect((await a.request(`/api/databases/${id}`, { method: "DELETE" })).status).toBe(409);
    release();
    await svc.settled(id);
  });

  test("validation: disabled, bad id, bad timestamp, unknown workspace, slug conflict", async () => {
    expect((await post(app(null), `/api/backups/${SRC}/restore`, { name: "x", workspaceId: wsId })).status).toBe(409);
    const a = app(service(writes(1)).svc);
    expect((await post(a, `/api/backups/not-an-id/restore`, { name: "x", workspaceId: wsId })).status).toBe(400);
    expect((await post(a, `/api/backups/${SRC}/restore`, { name: "x", workspaceId: wsId, at: "yesterday" })).status).toBe(400);
    expect((await post(a, `/api/backups/${SRC}/restore`, { name: "x", workspaceId: crypto.randomUUID() })).status).toBe(404);
    target("taken");
    expect((await post(a, `/api/backups/${SRC}/restore`, { name: "taken", workspaceId: wsId })).status).toBe(409);
  });

  test("at accepts offsets; resolved in UTC (16:02+08:00 = 08:02Z → txid 1)", async () => {
    const seen: string[][] = [];
    const { svc } = service(writes(1, seen));
    const res = await post(app(svc), `/api/backups/${SRC}/restore`, { name: "pit", workspaceId: wsId, at: "2026-09-25T16:02:00+08:00" });
    const { id } = (await res.json()) as { id: string };
    await svc.settled(id);
    expect(seen[1]).toContain("0000000000000001");
  });
});
