import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as SQLite } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../../src/db/metadata.ts";
import { VerificationsRepo, type VerificationRow } from "../../src/db/repos/verifications.ts";
import type { DatabaseRow } from "../../src/db/repos/databases.ts";
import { VerifyService, nextRunAt, schemaOf, verifyHealth } from "../../src/backup/verify.ts";
import { sqldDataFile } from "../../src/backup/replicator.ts";
import type { RunLitestream, S3Like } from "../../src/backup/restore.ts";
import { loadConfig, type BackupConfig } from "../../src/config.ts";

const cfg: BackupConfig = {
  endpoint: "https://s3.example.com", bucket: "sqlitend-backups", region: "auto", forcePathStyle: true, accessKeyId: "k",
  secretAccessKey: "s", prefix: "server-a", litestreamPath: "/x", snapshotInterval: "24h", retention: "168h", maxLagMs: 60_000,
  verifyAt: "03:30", verifyMaxAgeMs: 48 * 3_600_000,
};

function makeDb(file: string, schema: string[], rows = 10) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new SQLite(file);
  for (const sql of schema) db.exec(sql);
  if (schema.some((x) => x.includes("TABLE users"))) for (let i = 0; i < rows; i++) db.query("INSERT INTO users(name) VALUES (?)").run(`u${i}`);
  db.close();
}
const SCHEMA = ["CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)", "CREATE INDEX idx_users_name ON users(name)", "CREATE TABLE goals(id INTEGER PRIMARY KEY)"];

let dir: string;
let meta: Database;
let results: VerificationsRepo;
let rows: DatabaseRow[];

const row = (slug: string, over: Partial<DatabaseRow> = {}): DatabaseRow => ({
  id: crypto.randomUUID(), workspace_id: "w", slug, name: slug, status: "running", pid: 1, start_time: 0, port: 1, grpc_port: 2,
  data_dir: path.join(dir, "dbs", slug), auth_key: null, auto_start: 1, sqld_version: null, failed_reason: null,
  dns_hostname: null, dns_record_id: null, dns_status: null, dns_error: null, created_at: 0, ...over,
});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sqlitend-verify-"));
  meta = openDb(path.join(dir, "metadata.sqlite"));
  migrate(meta);
  results = new VerificationsRepo(meta);
  rows = [];
});
afterEach(() => {
  meta.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Fake litestream restore: produces `schema` (or garbage / failure) at -o. */
const restoring = (mode: { schema?: string[]; garbage?: boolean; exit?: number; nothing?: boolean }, calls?: string[][]): RunLitestream => async (args) => {
  calls?.push(args);
  if (mode.exit) return { code: mode.exit, output: "no matching backup files available" };
  const out = args[args.indexOf("-o") + 1]!;
  if (mode.nothing) return { code: 0, output: "" };
  if (mode.garbage) {
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, "not a database ".repeat(1000));
  } else makeDb(out, mode.schema ?? SCHEMA);
  return { code: 0, output: "" };
};

const replicaS3 = (mode: "exists" | "empty" | "hang" | "error" = "exists"): S3Like => ({
  write: async () => {},
  file: () => ({ text: async () => "{}", exists: async () => false }),
  list: async (o) => {
    if (mode === "hang") return new Promise(() => {});
    if (mode === "error") throw new Error("ECONNREFUSED 127.0.0.1:6150");
    return { contents: mode === "exists" ? [{ key: `${o.prefix}ltx/0/0000000000000001.ltx` }] : [] };
  },
});

const svc = (run: RunLitestream, over: Partial<ConstructorParameters<typeof VerifyService>[0]> = {}) =>
  new VerifyService({ config: cfg, dataRoot: dir, listDatabases: () => rows, results, run, s3: replicaS3(), scheduleAt: null, log: () => {}, freeBytes: () => 1e12, ...over });

describe("helpers", () => {
  test("schemaOf lists user objects only, sorted", () => {
    const f = path.join(dir, "s.db");
    makeDb(f, SCHEMA);
    expect(schemaOf(f)).toEqual(["index:idx_users_name", "table:goals", "table:users"]);
  });

  test("nextRunAt: later today, else tomorrow (local time)", () => {
    const now = new Date(2026, 8, 25, 2, 0, 0);
    expect(nextRunAt("03:30", now)).toEqual(new Date(2026, 8, 25, 3, 30, 0));
    expect(nextRunAt("01:00", now)).toEqual(new Date(2026, 8, 26, 1, 0, 0));
    expect(nextRunAt("02:00", now)).toEqual(new Date(2026, 8, 26, 2, 0, 0)); // exactly now → tomorrow
  });

  test("verifyHealth", () => {
    const H = 3_600_000;
    const v = (outcome: "ok" | "failed", finished_at: number) => ({ outcome, finished_at }) as VerificationRow;
    const now = 100 * H;
    expect(verifyHealth(v("ok", now - H), v("ok", now - H), 0, now, 48 * H)).toBe("ok");
    expect(verifyHealth(v("failed", now - H), v("ok", now - 2 * H), 0, now, 48 * H)).toBe("failed");
    expect(verifyHealth(v("ok", now - 49 * H), v("ok", now - 49 * H), 0, now, 48 * H)).toBe("stale");
    expect(verifyHealth(null, null, now - 5 * H, now, 48 * H)).toBe("pending");
    expect(verifyHealth(null, null, now - 49 * H, now, 48 * H)).toBe("stale");
    // upgrade: an old database, but the verifier started 1 h ago → pending, not stale
    expect(verifyHealth(null, null, Math.max(0, now - H), now, 48 * H)).toBe("pending");
  });

  test("config: default 03:30, off, validated, max age", () => {
    const exe = path.join(dir, "ls");
    writeFileSync(exe, "#!/bin/sh\n");
    Bun.spawnSync(["chmod", "+x", exe]);
    const env = {
      SQLITEND_LITESTREAM_PATH: exe, SQLITEND_BACKUP_S3_ENDPOINT: "https://s3.example.com", SQLITEND_BACKUP_S3_BUCKET: "sqlitend-b",
      SQLITEND_BACKUP_S3_ACCESS_KEY_ID: "k", SQLITEND_BACKUP_S3_SECRET_ACCESS_KEY: "s",
    };
    expect(loadConfig(env).backup!).toMatchObject({ verifyAt: "03:30", verifyMaxAgeMs: 48 * 3_600_000 });
    expect(loadConfig({ ...env, SQLITEND_BACKUP_VERIFY_AT: "off" }).backup!.verifyAt).toBeNull();
    expect(loadConfig({ ...env, SQLITEND_BACKUP_VERIFY_AT: "23:05", SQLITEND_BACKUP_VERIFY_MAX_AGE_HOURS: "30" }).backup!).toMatchObject({ verifyAt: "23:05", verifyMaxAgeMs: 30 * 3_600_000 });
    expect(() => loadConfig({ ...env, SQLITEND_BACKUP_VERIFY_AT: "3:30am" })).toThrow(/VERIFY_AT/);
    expect(() => loadConfig({ ...env, SQLITEND_BACKUP_VERIFY_AT: "24:00" })).toThrow(/VERIFY_AT/);
  });
});

describe("VerifyService", () => {
  test("ok: restores latest, integrity + schema match, records ok, removes the scratch copy", async () => {
    const r = row("bots");
    makeDb(sqldDataFile(r.data_dir), SCHEMA);
    rows = [r, row("stopped", { status: "stopped" })];
    const calls: string[][] = [];
    await svc(restoring({}, calls)).runAll("schedule");
    expect(calls).toHaveLength(1); // stopped databases are skipped
    expect(calls[0]!.slice(0, 3)).toEqual(["restore", "-o", path.join(dir, "verify", r.id, "data")]);
    expect(calls[0]).not.toContain("-timestamp");
    const v = results.latest(r.id)!;
    expect(v).toMatchObject({ outcome: "ok", trigger: "schedule", detail: "3 schema objects, integrity ok" });
    expect(v.restored_bytes).toBeGreaterThan(0);
    expect(existsSync(path.join(dir, "verify", r.id))).toBe(false);
  });

  test("schema mismatch (valid SQLite, wrong data) fails", async () => {
    const r = row("bots");
    makeDb(sqldDataFile(r.data_dir), SCHEMA);
    rows = [r];
    await svc(restoring({ schema: ["CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)", "CREATE TABLE stray(x)"] })).runAll("manual");
    const v = results.latest(r.id)!;
    expect(v.outcome).toBe("failed");
    expect(v.detail).toBe("schema differs from live: missing index:idx_users_name, table:goals; extra table:stray");
  });

  test("corrupt file, restore failure and 'no replica' all fail with a reason", async () => {
    for (const [mode, expected] of [
      [{ garbage: true }, /cannot open restored file|integrity_check/],
      [{ exit: 1 }, /restore exited 1: no matching backup files available/],
      [{ nothing: true }, /no file/],
    ] as const) {
      const r = row(`db-${Math.random().toString(36).slice(2, 8)}`);
      makeDb(sqldDataFile(r.data_dir), SCHEMA);
      rows = [r];
      await svc(restoring(mode)).runAll("manual");
      expect(results.latest(r.id)!.outcome).toBe("failed");
      expect(results.latest(r.id)!.detail).toMatch(expected);
      expect(existsSync(path.join(dir, "verify", r.id))).toBe(false);
    }
  });

  test("preflight: unreachable store fails fast (no litestream run); missing replica fails", async () => {
    const r = row("bots");
    makeDb(sqldDataFile(r.data_dir), SCHEMA);
    rows = [r];
    for (const [mode, expected] of [["hang", /unreachable: no answer within 0.2s/], ["error", /unreachable: ECONNREFUSED/], ["empty", /no replica found/]] as const) {
      const calls: string[][] = [];
      const t0 = Date.now();
      await svc(restoring({}, calls), { s3: replicaS3(mode), preflightTimeoutMs: 200 }).runAll("schedule");
      expect(Date.now() - t0).toBeLessThan(2_000);
      expect(calls).toHaveLength(0);
      expect(results.latest(r.id)!.detail).toMatch(expected);
    }
  });

  test("not enough free disk: fails without restoring", async () => {
    const r = row("big");
    makeDb(sqldDataFile(r.data_dir), SCHEMA);
    rows = [r];
    const calls: string[][] = [];
    await svc(restoring({}, calls), { freeBytes: () => 10 * 1024 * 1024 }).runAll("schedule");
    expect(calls).toHaveLength(0);
    expect(results.latest(r.id)!.detail).toContain("not enough free disk");
  });

  test("single flight: concurrent runAll calls share one run; manual one-off queues behind it", async () => {
    const r = row("bots");
    makeDb(sqldDataFile(r.data_dir), SCHEMA);
    rows = [r];
    let n = 0;
    const slow: RunLitestream = async (args, t) => {
      n++;
      await Bun.sleep(100);
      return restoring({})(args, t);
    };
    const s = svc(slow);
    await Promise.all([s.runAll("schedule"), s.runAll("manual"), s.runAll("manual")]);
    expect(n).toBe(1);
    const res = await s.verifyOneQueued(r);
    expect(res.outcome).toBe("ok");
    expect(n).toBe(2);
    expect(results.history(r.id).map((h) => h.trigger)).toEqual(["manual", "schedule"]);
  });

  test("review regressions: never two verifies at once; same id shares; a batch is never swallowed", async () => {
    const a = row("a");
    const b = row("b");
    for (const r of [a, b]) makeDb(sqldDataFile(r.data_dir), SCHEMA);
    rows = [a, b];
    let active = 0;
    let maxActive = 0;
    let n = 0;
    const slow: RunLitestream = async (args, t) => {
      n++;
      active++;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(60);
      active--;
      return restoring({})(args, t);
    };
    const s = svc(slow);
    // same id twice → one run; different id → queued, not parallel
    const [r1, r2, r3] = await Promise.all([s.verifyOneQueued(a), s.verifyOneQueued(a), s.verifyOneQueued(b)]);
    expect([r1.outcome, r2.outcome, r3.outcome]).toEqual(["ok", "ok", "ok"]);
    expect(n).toBe(2);
    expect(maxActive).toBe(1);
    // a batch requested while a single verify runs still verifies everything
    n = 0;
    const single = s.verifyOneQueued(a);
    const batch = s.runAll("schedule");
    await Promise.all([single, batch]);
    expect(n).toBe(2); // batch's "a" joins the in-flight single "a" (same result), then "b"
    expect(maxActive).toBe(1);
    expect(results.history(b.id).map((h) => h.trigger)).toEqual(["schedule", "manual"]);
  });

  test("leftover scratch copies from a crash are removed at startup", () => {
    const stale = path.join(dir, "verify", "old-db", "data");
    mkdirSync(path.dirname(stale), { recursive: true });
    writeFileSync(stale, "x".repeat(1000));
    svc(restoring({}));
    expect(existsSync(path.join(dir, "verify"))).toBe(false);
  });

  test("stop(): no timer is armed after stop, even when a run finishes later", async () => {
    let fired = 0;
    const s = svc(restoring({}), { scheduleAt: "03:30", log: (m) => void (m.includes("next restore-verify") && fired++) });
    s.start();
    expect(fired).toBe(1);
    s.stop();
    await s.runAll("manual");
    await Bun.sleep(20);
    expect(fired).toBe(1);
  });

  test("a live file that cannot be read is reported distinctly, not as a bad backup", async () => {
    const r = row("nolive"); // no live data file at all
    rows = [r];
    await svc(restoring({})).runAll("manual");
    expect(results.latest(r.id)!.detail).toContain("live schema could not be read");
  });

  test("history is capped at 60 per database", () => {
    for (let i = 0; i < 70; i++) results.record({ database_id: "x", started_at: i, finished_at: i, outcome: "ok", detail: null, restored_bytes: null, trigger: "schedule" });
    expect(results.history("x", 1000)).toHaveLength(60);
    expect(results.latest("x")!.finished_at).toBe(69);
  });
});
