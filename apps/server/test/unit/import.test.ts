import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as SQLite } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../../src/db/metadata.ts";
import { DatabasesRepo, type DatabaseRow } from "../../src/db/repos/databases.ts";
import { WorkspacesRepo } from "../../src/db/repos/workspaces.ts";
import { TokensRepo } from "../../src/db/repos/tokens.ts";
import { ImportService } from "../../src/backup/import.ts";
import { sqldDataFile } from "../../src/backup/replicator.ts";
import { createRoutes } from "../../src/http/routes.ts";
import { loadConfig } from "../../src/config.ts";
import { createPortAllocator } from "../../src/supervisor/ports.ts";
import type { Supervisor } from "../../src/supervisor/supervisor.ts";
import type { Sampler } from "../../src/metrics/sampler.ts";

let dir: string;
let meta: Database;
let databases: DatabasesRepo;
let wsId: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sqlitend-import-"));
  meta = openDb(path.join(dir, "metadata.sqlite"));
  migrate(meta);
  databases = new DatabasesRepo(meta);
  wsId = new WorkspacesRepo(meta).create({ id: crypto.randomUUID(), slug: "ws", name: "ws", createdAt: 0 }).id;
});
afterEach(() => {
  meta.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A source database left in WAL mode with rows still in the -wal (like a copied live sqld file). */
function makeWalSource(file: string, rows: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new SQLite(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  db.exec("CREATE TABLE ayat(id INTEGER PRIMARY KEY, text TEXT)");
  for (let i = 0; i < rows; i++) db.query("INSERT INTO ayat(text) VALUES (?)").run(`a${i}`);
  // Copy the files while the writer is still open (as a naive `cp` of a live db would): rows sit in the -wal.
  copyFileSync(file, `${file}.copy`);
  copyFileSync(`${file}-wal`, `${file}.copy-wal`);
  db.close();
  for (const ext of ["", "-wal", "-shm"]) rmSync(`${file}${ext}`, { force: true });
  renameSync(`${file}.copy`, file);
  renameSync(`${file}.copy-wal`, `${file}-wal`);
}

function service(over: Partial<ConstructorParameters<typeof ImportService>[0]> = {}) {
  const started: string[] = [];
  const synced: string[] = [];
  const svc = new ImportService({
    dataRoot: dir, databases, log: () => {},
    startDatabase: async (row) => {
      started.push(row.id);
      databases.updateStatus(row.id, "running");
      return { ok: true };
    },
    afterStart: async (row) => void synced.push(row.id),
    ...over,
  });
  svc.ensureDir();
  return { svc, started, synced };
}

const target = (slug = "quranready-prod"): DatabaseRow =>
  databases.create({
    id: crypto.randomUUID(), workspace_id: wsId, slug, name: slug, status: "restoring", auto_start: 0,
    data_dir: path.join(dir, "ws", "dbs", slug), created_at: 0,
  });

const count = (file: string) => {
  const db = new SQLite(file, { readonly: true });
  try {
    return (db.query("SELECT count(*) n FROM ayat").get() as { n: number }).n;
  } finally {
    db.close();
  }
};

describe("import job", () => {
  test("copies (WAL merged), verifies, places the file where sqld expects it, starts, runs afterStart", async () => {
    const { svc, started, synced } = service();
    const src = path.join(svc.dir, "quranready_prod.db");
    makeWalSource(src, 300);
    expect(existsSync(`${src}-wal`)).toBe(true);
    const t = target();
    svc.start(src, t);
    expect(svc.isImporting(t.id)).toBe(true);
    await svc.settled(t.id);
    const row = databases.getById(t.id)!;
    expect(row.status).toBe("running");
    expect(row.auto_start).toBe(1);
    expect(started).toEqual([t.id]);
    expect(synced).toEqual([t.id]);
    expect(count(sqldDataFile(t.data_dir))).toBe(300); // rows that lived only in the -wal are included
    expect(existsSync(`${sqldDataFile(t.data_dir)}-wal`)).toBe(false);
    expect(existsSync(`${t.data_dir}.import`)).toBe(false);
    expect(count(src)).toBe(300); // source untouched in content
  });

  test("not a SQLite file → failed, nothing placed, never started", async () => {
    const { svc, started } = service();
    const src = path.join(svc.dir, "junk.db");
    writeFileSync(src, "this is not sqlite".repeat(100));
    const t = target();
    svc.start(src, t);
    await svc.settled(t.id);
    const row = databases.getById(t.id)!;
    expect(row.status).toBe("failed");
    expect(row.failed_reason).toStartWith("import failed:");
    expect(started).toEqual([]);
    expect(existsSync(sqldDataFile(t.data_dir))).toBe(false);
  });

  test("integrity failure → failed with the reason", async () => {
    const { svc, started } = service({ verify: () => "integrity_check: page 3 is never used" });
    const src = path.join(svc.dir, "a.db");
    makeWalSource(src, 3);
    const t = target();
    svc.start(src, t);
    await svc.settled(t.id);
    expect(databases.getById(t.id)!.failed_reason).toContain("page 3 is never used");
    expect(started).toEqual([]);
  });

  test("never overwrites an existing data file", async () => {
    const { svc, started } = service();
    const src = path.join(svc.dir, "a.db");
    makeWalSource(src, 3);
    const t = target();
    mkdirSync(path.dirname(sqldDataFile(t.data_dir)), { recursive: true });
    writeFileSync(sqldDataFile(t.data_dir), "old");
    svc.start(src, t);
    await svc.settled(t.id);
    expect(databases.getById(t.id)!.failed_reason).toContain("already contains a database file");
    expect(started).toEqual([]);
  });

  test("sqld start failure → failed, reason says the data was imported", async () => {
    const { svc } = service({ startDatabase: async () => ({ ok: false, error: "port in use" }) });
    const src = path.join(svc.dir, "a.db");
    makeWalSource(src, 3);
    const t = target();
    svc.start(src, t);
    await svc.settled(t.id);
    expect(databases.getById(t.id)!.failed_reason).toContain("imported and verified, but sqld did not start: port in use");
  });
});

describe("resolve + list", () => {
  test("only plain names of regular files inside the import dir", () => {
    const { svc } = service();
    makeWalSource(path.join(svc.dir, "ok.db"), 1);
    writeFileSync(path.join(dir, "outside.db"), "x");
    symlinkSync(path.join(dir, "outside.db"), path.join(svc.dir, "link.db"));
    mkdirSync(path.join(svc.dir, "sub"));
    expect(svc.resolve("ok.db")).toEqual({ path: path.join(svc.dir, "ok.db") });
    for (const bad of ["../outside.db", "/etc/passwd", "sub/x.db", ".hidden", "", "a b.db"]) expect("error" in svc.resolve(bad)).toBe(true);
    expect(svc.resolve("link.db")).toEqual({ error: "file must be a regular file (no symlinks)" });
    expect(svc.resolve("sub")).toEqual({ error: "file must be a regular file (no symlinks)" });
    expect(svc.resolve("missing.db")).toMatchObject({ error: expect.stringContaining("no such file") });
  });

  test("list offers SQLite files only, skipping -wal/-shm, junk and symlinks", () => {
    const { svc } = service();
    makeWalSource(path.join(svc.dir, "ok.db"), 1);
    writeFileSync(path.join(svc.dir, "junk.txt"), "hello");
    writeFileSync(path.join(dir, "outside.db"), "x");
    symlinkSync(path.join(dir, "outside.db"), path.join(svc.dir, "link.db"));
    const files = svc.list();
    expect(files.map((f) => f.file)).toEqual(["ok.db"]);
    expect(files[0]!.tables).toBe(1);
  });
});

describe("import routes", () => {
  function app(importer: ImportService | null) {
    return createRoutes({
      config: loadConfig({}, { dataRoot: dir }),
      workspaces: new WorkspacesRepo(meta),
      databases,
      tokens: new TokensRepo(meta),
      supervisor: {
        portAllocator: createPortAllocator(loadConfig({}, { dataRoot: dir, portRange: { start: 27101, end: 27200 } }), { persistedInUse: () => new Set(), probe: async () => false }),
      } as unknown as Supervisor,
      sampler: {} as unknown as Sampler,
      sqldOk: true,
      sqldVersion: "f",
      version: "t",
      importer,
    });
  }
  const post = (a: ReturnType<typeof app>, p: string, body: unknown) =>
    a.request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("202 + a restoring row with ports; the job runs to running", async () => {
    const { svc } = service();
    makeWalSource(path.join(svc.dir, "quranready_prod.db"), 7);
    const a = app(svc);
    const res = await post(a, `/api/workspaces/${wsId}/databases/import`, { name: "quranready-prod", file: "quranready_prod.db" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; status: string; slug: string; port: number };
    expect(body).toMatchObject({ status: "restoring", slug: "quranready-prod" });
    expect(body.port).toBeGreaterThan(0);
    await svc.settled(body.id);
    expect(databases.getById(body.id)!.status).toBe("running");
  });

  test("bad file names are refused before any row is created", async () => {
    const { svc } = service();
    const a = app(svc);
    for (const file of ["../metadata.sqlite", "missing.db"]) {
      const res = await post(a, `/api/workspaces/${wsId}/databases/import`, { name: "x", file });
      expect(res.status).toBe(400);
    }
    expect(databases.list()).toHaveLength(0);
  });

  test("extra fields rejected; unknown workspace 404; delete blocked while importing", async () => {
    const { svc } = service({ startDatabase: () => new Promise(() => {}) }); // never finishes
    makeWalSource(path.join(svc.dir, "a.db"), 1);
    const a = app(svc);
    expect((await post(a, `/api/workspaces/${wsId}/databases/import`, { name: "x", file: "a.db", path: "/etc" })).status).toBe(400);
    expect((await post(a, `/api/workspaces/${crypto.randomUUID()}/databases/import`, { name: "x", file: "a.db" })).status).toBe(404);
    const { id } = (await (await post(a, `/api/workspaces/${wsId}/databases/import`, { name: "slow", file: "a.db" })).json()) as { id: string };
    await Bun.sleep(50);
    expect((await a.request(`/api/databases/${id}`, { method: "DELETE" })).status).toBe(409);
    expect((await post(a, `/api/databases/${id}/start`, {})).status).toBe(409);
  });

  test("GET /api/imports lists the drop dir", async () => {
    const { svc } = service();
    makeWalSource(path.join(svc.dir, "a.db"), 1);
    const r = (await (await app(svc).request("/api/imports")).json()) as { dir: string; files: { file: string }[] };
    expect(r.dir).toBe(svc.dir);
    expect(r.files.map((f) => f.file)).toEqual(["a.db"]);
  });
});
