import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Replicator,
  applyLogLine,
  deriveState,
  emptyStatus,
  renderLitestreamConfig,
  sqldDataFile,
  type ReplicaTarget,
} from "../../src/backup/replicator.ts";
import { healthReport } from "../../src/http/health.ts";
import { loadConfig, type BackupConfig } from "../../src/config.ts";

const cfg = (over: Partial<BackupConfig> = {}): BackupConfig => ({
  endpoint: "https://s3.example.com",
  bucket: "sqlitend-backups",
  region: "auto",
  forcePathStyle: true,
  accessKeyId: "AKIA_TEST",
  secretAccessKey: "super-secret-value",
  prefix: "server-a",
  litestreamPath: "/nonexistent",
  snapshotInterval: "24h",
  retention: "168h",
  maxLagMs: 60_000,
  verifyAt: null,
  verifyMaxAgeMs: 48 * 3_600_000, control: null,
  ...over,
});

const sync = (replica: string, db: string) =>
  JSON.stringify({ level: "INFO", msg: "replica sync", db: "data", txid: { replica, db } });

describe("config rendering", () => {
  test("one db, replica at <prefix>/db/<id>, JSON-in-YAML, no secrets", () => {
    const out = renderLitestreamConfig(cfg(), "/d/db.sqlite/dbs/default/data", "abc");
    const parsed = JSON.parse(out);
    expect(parsed.logging).toEqual({ type: "json", level: "info" });
    expect(parsed.dbs).toHaveLength(1);
    expect(parsed.dbs[0]).toMatchObject({
      path: "/d/db.sqlite/dbs/default/data",
      snapshot: { interval: "24h", retention: "168h" },
      replica: { type: "s3", bucket: "sqlitend-backups", path: "server-a/db/abc", endpoint: "https://s3.example.com", "force-path-style": true },
    });
    expect(out).not.toContain("super-secret-value");
    expect(out).not.toContain("AKIA_TEST");
  });

  test("sqld data file location", () => {
    expect(sqldDataFile("/root/ws/dbs/x")).toBe("/root/ws/dbs/x/db.sqlite/dbs/default/data");
  });
});

describe("log parsing + state", () => {
  const NOW = 1_800_000_000_000;
  test("caught up → ok; behind past max lag → lagging; recovers", () => {
    const s = emptyStatus("s3://b/p");
    expect(deriveState(s, NOW, 60_000, true)).toBe("starting");
    applyLogLine(s, sync("0000000000000003", "0000000000000003"), NOW);
    expect(deriveState(s, NOW, 60_000, true)).toBe("ok");
    applyLogLine(s, sync("0000000000000003", "0000000000000005"), NOW + 1000);
    expect(s.behindSince).toBe(NOW + 1000);
    applyLogLine(s, sync("0000000000000003", "0000000000000006"), NOW + 70_000);
    expect(s.behindSince).toBe(NOW + 1000); // first time behind is kept
    expect(deriveState(s, NOW + 70_000, 60_000, true)).toBe("lagging");
    applyLogLine(s, sync("0000000000000006", "0000000000000006"), NOW + 71_000);
    expect(s.behindSince).toBeNull();
    expect(deriveState(s, NOW + 71_000, 60_000, true)).toBe("ok");
  });

  test("ERROR without a later sync → error (the silent-403 case); a later sync clears it", () => {
    const s = emptyStatus("s3://b/p");
    applyLogLine(s, sync("01", "01"), NOW);
    applyLogLine(s, JSON.stringify({ level: "ERROR", msg: "sync error", error: "StatusCode: 403, AccessDenied" }), NOW + 1000);
    expect(deriveState(s, NOW + 1000, 60_000, true)).toBe("error");
    expect(s.lastError).toBe("sync error: StatusCode: 403, AccessDenied");
    applyLogLine(s, sync("02", "02"), NOW + 2000);
    expect(deriveState(s, NOW + 2000, 60_000, true)).toBe("ok");
    expect(s.lastError).toContain("403"); // history kept for the UI
  });

  test("silence past max lag → lagging; snapshot tracked; junk ignored; not running → stopped", () => {
    const s = emptyStatus("s3://b/p");
    applyLogLine(s, sync("01", "01"), NOW);
    applyLogLine(s, JSON.stringify({ level: "INFO", msg: "snapshot complete", txid: "01" }), NOW);
    applyLogLine(s, "not json at all", NOW);
    expect(s.lastSnapshotAt).toBe(NOW);
    expect(deriveState(s, NOW + 61_000, 60_000, true)).toBe("lagging");
    expect(deriveState(s, NOW, 60_000, false)).toBe("stopped");
  });
});

describe("Replicator with a fake litestream", () => {
  let dir: string;
  let rows: ReplicaTarget[];
  let rep: Replicator | null;

  // Fake: records argv + env, prints log lines, honours SIGTERM, exits early if told to.
  const fake = (mode: "ok" | "crash" | "403") => {
    const f = path.join(dir, `fake-litestream-${mode}`);
    writeFileSync(
      f,
      `#!/usr/bin/env bash
cfg="$3"
echo "$@|$LITESTREAM_ACCESS_KEY_ID|$LITESTREAM_SECRET_ACCESS_KEY" >> "${dir}/calls.log"
trap 'echo "{\\"level\\":\\"INFO\\",\\"msg\\":\\"litestream shut down\\"}"; echo term >> "${dir}/calls.log"; exit 0' TERM
case "${mode}" in
  crash) echo '{"level":"ERROR","msg":"boom"}'; exit 3 ;;
  403) while true; do echo '{"level":"ERROR","msg":"sync error","error":"StatusCode: 403"}'; sleep 0.1; done ;;
  ok) while true; do echo '{"level":"INFO","msg":"replica sync","txid":{"replica":"0000000000000002","db":"0000000000000002"}}'; sleep 0.1; done ;;
esac
`,
    );
    chmodSync(f, 0o755);
    return f;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sqlitend-backup-"));
    rows = [];
    rep = null;
  });
  afterEach(async () => {
    await rep?.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  const make = (mode: "ok" | "crash" | "403") =>
    (rep = new Replicator({
      config: cfg({ litestreamPath: fake(mode) }),
      dataRoot: dir,
      listDatabases: () => rows,
      log: () => {},
    }));
  const calls = () => (existsSync(path.join(dir, "calls.log")) ? readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n") : []);

  test("replicates running databases only; creds via env; config file 0600 without secrets; ok state", async () => {
    rows = [
      { id: "db-run", status: "running", data_dir: path.join(dir, "run") },
      { id: "db-stop", status: "stopped", data_dir: path.join(dir, "stop") },
    ];
    const r = make("ok");
    r.reconcile();
    await Bun.sleep(400);
    const c = calls();
    expect(c).toHaveLength(1);
    expect(c[0]).toBe(`replicate -config ${path.join(dir, "litestream", "db-run.yml")}|AKIA_TEST|super-secret-value`);
    const conf = readFileSync(path.join(dir, "litestream", "db-run.yml"), "utf8");
    expect(conf).not.toContain("super-secret-value");
    expect((await Bun.file(path.join(dir, "litestream", "db-run.yml")).stat()).mode & 0o777).toBe(0o600);
    expect(r.status("db-run").state).toBe("ok");
    expect(r.status("db-run").txidReplica).toBe("0000000000000002");
    expect(r.status("db-stop").state).toBe("stopped");
  });

  test("a database that stops running gets its replicator SIGTERMed (flush) and removed", async () => {
    rows = [{ id: "a", status: "running", data_dir: dir }];
    const r = make("ok");
    r.reconcile();
    await Bun.sleep(300);
    rows = [{ id: "a", status: "stopped", data_dir: dir }];
    r.reconcile();
    await Bun.sleep(300);
    expect(calls()).toContain("term");
    expect(r.status("a").state).toBe("stopped");
  });

  test("continuous upload errors show as error even though the process stays up", async () => {
    rows = [{ id: "a", status: "running", data_dir: dir }];
    const r = make("403");
    r.reconcile();
    await Bun.sleep(400);
    const s = r.status("a");
    expect(s.state).toBe("error");
    expect(s.lastError).toContain("403");
    expect(s.restarts).toBe(0);
  });

  test("missing binary: recorded as error, retried with backoff, stop() does not hang", async () => {
    rows = [{ id: "a", status: "running", data_dir: dir }];
    const r = (rep = new Replicator({ config: cfg({ litestreamPath: path.join(dir, "missing") }), dataRoot: dir, listDatabases: () => rows, log: () => {} }));
    r.reconcile();
    await Bun.sleep(200);
    const s = r.status("a");
    expect(s.lastError).toContain("failed to start");
    expect(s.restarts).toBe(1);
    const t0 = Date.now();
    await r.stop("a");
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  test("delete removes the per-database config file", async () => {
    rows = [{ id: "gone", status: "running", data_dir: dir }];
    const r = make("ok");
    r.reconcile();
    await Bun.sleep(200);
    const f = path.join(dir, "litestream", "gone.yml");
    expect(existsSync(f)).toBe(true);
    await r.stop("gone", { removeConfig: true });
    expect(existsSync(f)).toBe(false);
  });

  test("boot sweep stops litestream orphans of a crashed previous run, and only those", async () => {
    const bin = fake("ok");
    mkdirSync(path.join(dir, "litestream"), { recursive: true });
    const ours = path.join(dir, "litestream", "x.yml");
    writeFileSync(ours, "{}");
    // Orphans: detached, not our children — like survivors of a SIGKILLed sqlitend.
    const orphan = Bun.spawn([bin, "replicate", "-config", ours], { stdout: "ignore", stderr: "ignore" });
    const foreign = Bun.spawn([bin, "replicate", "-config", path.join(dir, "elsewhere.yml")], { stdout: "ignore", stderr: "ignore" });
    orphan.unref();
    foreign.unref();
    await Bun.sleep(200);
    const r = (rep = new Replicator({ config: cfg({ litestreamPath: bin }), dataRoot: dir, listDatabases: () => [], log: () => {} }));
    expect(await r.sweepOrphans()).toBe(1);
    await orphan.exited;
    expect(orphan.killed || orphan.exitCode !== null).toBe(true);
    expect(foreign.exitCode).toBeNull(); // untouched
    foreign.kill();
  });

  test("unexpected exit is recorded and restarted with backoff (not re-launched by reconcile)", async () => {
    rows = [{ id: "a", status: "running", data_dir: dir }];
    const r = make("crash");
    r.reconcile();
    await Bun.sleep(300);
    expect(r.status("a").restarts).toBe(1);
    expect(r.status("a").state).toBe("stopped");
    r.reconcile(); // must not bypass the 2 s backoff
    await Bun.sleep(200);
    expect(calls()).toHaveLength(1);
    await Bun.sleep(2_200);
    expect(calls().length).toBeGreaterThanOrEqual(2);
  });
});

describe("healthz", () => {
  const dbs = [
    { id: "a", status: "running", auto_start: 1 },
    { id: "b", status: "running", auto_start: 1 },
  ];
  test("ok only when everything runs and every backup is ok", () => {
    expect(healthReport({ databases: dbs, backupState: () => "ok", sqldOk: true }).status).toBe("ok");
    expect(healthReport({ databases: dbs, backupState: () => "starting", sqldOk: true }).status).toBe("ok");
    const bad = healthReport({ databases: dbs, backupState: (id) => (id === "a" ? "error" : "ok"), sqldOk: true });
    expect(bad).toEqual({
      status: "degraded",
      sqld: { ok: true, running: 2, expected: 2 },
      backup: { enabled: true, ok: 1, failing: 1 },
      verify: { enabled: false, ok: 0, failing: 0 },
      control: null,
    });
    expect(healthReport({ databases: dbs, backupState: null, sqldOk: true }).status).toBe("degraded");
    expect(healthReport({ databases: [...dbs, { id: "c", status: "crashed", auto_start: 1 }], backupState: () => "ok", sqldOk: true }).status).toBe("degraded");
    expect(healthReport({ databases: dbs, backupState: () => "ok", sqldOk: false }).status).toBe("degraded");
  });

  test("restore-verify: failed or stale degrades; pending (new database) does not", () => {
    const base = { databases: dbs, backupState: () => "ok" as const, sqldOk: true };
    expect(healthReport({ ...base, verifyState: () => "ok" }).status).toBe("ok");
    expect(healthReport({ ...base, verifyState: () => "pending" }).status).toBe("ok");
    expect(healthReport({ ...base, verifyState: (id) => (id === "a" ? "failed" : "ok") }).verify).toEqual({ enabled: true, ok: 1, failing: 1 });
    expect(healthReport({ ...base, verifyState: () => "stale" }).status).toBe("degraded");
  });

  test("control-plane backup: disabled, failed or stale degrade; ok and pending do not", () => {
    const base = { databases: dbs, backupState: () => "ok" as const, sqldOk: true };
    for (const [c, status] of [["ok", "ok"], ["pending", "ok"], ["disabled", "degraded"], ["failed", "degraded"], ["stale", "degraded"]] as const) {
      expect(healthReport({ ...base, controlState: c }).status).toBe(status);
    }
  });
});

describe("backup config", () => {
  const exe = path.join(mkdtempSync(path.join(tmpdir(), "sqlitend-lsbin-")), "litestream");
  writeFileSync(exe, "#!/bin/sh\n");
  chmodSync(exe, 0o755);
  const base = {
    SQLITEND_LITESTREAM_PATH: exe,
    SQLITEND_BACKUP_S3_ENDPOINT: "https://abc.r2.cloudflarestorage.com",
    SQLITEND_BACKUP_S3_BUCKET: "sqlitend-backup-server-a",
    SQLITEND_BACKUP_S3_ACCESS_KEY_ID: "k",
    SQLITEND_BACKUP_S3_SECRET_ACCESS_KEY: "s",
  };
  test("off by default; all four or nothing; validated", () => {
    expect(loadConfig({}).backup).toBeNull();
    const c = loadConfig({ ...base, SQLITEND_BACKUP_PREFIX: "server-a" }).backup!;
    expect(c).toMatchObject({ region: "auto", forcePathStyle: true, prefix: "server-a", snapshotInterval: "24h", retention: "168h", maxLagMs: 300_000 });
    expect(() => loadConfig({ SQLITEND_BACKUP_S3_BUCKET: "x-bucket" })).toThrow(/missing: endpoint, accessKeyId, secretAccessKey/);
    expect(() => loadConfig({ ...base, SQLITEND_BACKUP_S3_ENDPOINT: "nope" })).toThrow(/ENDPOINT/);
    expect(() => loadConfig({ ...base, SQLITEND_BACKUP_S3_BUCKET: "Bad_Bucket" })).toThrow(/BUCKET/);
    expect(() => loadConfig({ ...base, SQLITEND_BACKUP_RETENTION: "7 days" })).toThrow(/RETENTION/);
    expect(loadConfig({ ...base, SQLITEND_BACKUP_S3_FORCE_PATH_STYLE: "false" }).backup!.forcePathStyle).toBe(false);
    expect(() => loadConfig({ ...base, SQLITEND_LITESTREAM_PATH: "/nonexistent/litestream" })).toThrow(/not executable/);
  });
});
