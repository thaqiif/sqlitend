import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as SQLite } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openMetadata } from "../../src/db/metadata.ts";
import {
  ControlBackupService,
  WrongKeyError,
  controlObjectKey,
  decryptBundle,
  encryptBundle,
  generateBackupKey,
  parseBackupKey,
  parseKeyTime,
  snapshotControlPlane,
  writeControlPlane,
  type ControlBundle,
} from "../../src/backup/control.ts";
import { ensureDbKey } from "../../src/auth/tokens.ts";
import type { S3Like } from "../../src/backup/restore.ts";

let dir: string;
beforeEach(() => (dir = mkdtempSync(path.join(tmpdir(), "sqlitend-control-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const bundle = (): ControlBundle => ({
  manifest: { format: 1, createdAt: 1, hostname: "h", sqlitendVersion: "t", databases: 0, tokens: 0, files: ["metadata.sqlite"], dataRoot: "/old" },
  files: { "metadata.sqlite": Buffer.from("x").toString("base64") },
});

describe("encryption", () => {
  const key = parseBackupKey(generateBackupKey());
  test("round-trips; ciphertext hides the content", () => {
    const b = bundle();
    b.files["keys/11111111-2222-3333-4444-555555555555.key"] = Buffer.from('{"d":"SECRET-PRIVATE-KEY"}').toString("base64");
    const blob = encryptBundle(b, key);
    expect(blob.subarray(0, 8).toString()).toBe("SQLTNDCB");
    expect(blob.toString("latin1")).not.toContain("SECRET");
    expect(decryptBundle(blob, key)).toEqual(b);
  });
  test("wrong key is named as such (fingerprint), not a generic error", () => {
    const blob = encryptBundle(bundle(), key);
    expect(() => decryptBundle(blob, parseBackupKey(generateBackupKey()))).toThrow(WrongKeyError);
  });
  test("tampering with body or header is detected", () => {
    const blob = encryptBundle(bundle(), key);
    const body = Buffer.from(blob);
    body[body.length - 20]! ^= 1;
    expect(() => decryptBundle(body, key)).toThrow(/authentication/);
    const hdr = Buffer.from(blob);
    hdr[20]! ^= 1; // nonce byte (part of AAD)
    expect(() => decryptBundle(hdr, key)).toThrow(/authentication/);
    expect(() => decryptBundle(Buffer.from("nope"), key)).toThrow(/not a sqlitend/);
  });
  test("key parsing", () => {
    expect(parseBackupKey(generateBackupKey())).toHaveLength(32);
    expect(() => parseBackupKey(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });
});

describe("snapshot + write", () => {
  test("snapshot holds a consistent metadata copy and every key; write restores, remaps, refuses", async () => {
    const src = path.join(dir, "src");
    mkdirSync(src, { recursive: true });
    const meta = openMetadata(path.join(src, "metadata.sqlite"));
    const wsId = crypto.randomUUID();
    meta.workspaces.create({ id: wsId, slug: "ws", name: "ws", createdAt: 0 });
    const dbId = crypto.randomUUID();
    meta.databases.create({ id: dbId, workspace_id: wsId, slug: "bots", name: "bots", data_dir: path.join(src, "workspaces/ws/dbs/bots"), created_at: 0 });
    meta.tokens.create({ jti: "j1", databaseId: dbId, scope: "full", createdAt: 0, expiresAt: 9e15, name: "worker" });
    await ensureDbKey(src, dbId);
    const b = snapshotControlPlane(src, meta.db, "test");
    meta.db.close();
    expect(b.manifest).toMatchObject({ databases: 1, tokens: 1, dataRoot: path.resolve(src) });
    expect(Object.keys(b.files).sort()).toEqual(["keys/" + dbId + ".key", "keys/" + dbId + ".pub", "metadata.sqlite"].sort());
    expect(readdirSync(src).filter((f) => f.startsWith(".control-snapshot"))).toEqual([]); // temp copy removed

    const dst = path.join(dir, "new-server");
    const r = writeControlPlane(b, dst);
    expect(r.remapped).toBe(1);
    const restored = new SQLite(path.join(dst, "metadata.sqlite"), { readonly: true });
    expect((restored.query("SELECT data_dir FROM databases").get() as { data_dir: string }).data_dir).toBe(path.join(path.resolve(dst), "workspaces/ws/dbs/bots"));
    expect((restored.query("SELECT name FROM tokens").get() as { name: string }).name).toBe("worker");
    restored.close();
    expect(readFileSync(path.join(dst, "keys", `${dbId}.key`), "utf8")).toBe(readFileSync(path.join(src, "keys", `${dbId}.key`), "utf8"));
    expect(statSync(path.join(dst, "keys", `${dbId}.key`)).mode & 0o777).toBe(0o600);

    expect(() => writeControlPlane(b, dst)).toThrow(/already exists/);
    const forced = writeControlPlane(b, dst, { force: true });
    expect(forced.movedAside).toMatch(/metadata\.sqlite\.before-restore-/);
    expect(existsSync(forced.movedAside!)).toBe(true);
  });

  test("refuses unexpected paths in a bundle (no traversal)", () => {
    const b = bundle();
    b.files["../../etc/cron.d/x"] = "eA==";
    expect(() => writeControlPlane(b, path.join(dir, "t"))).toThrow(/unexpected file/);
  });
});

describe("review regressions (write)", () => {
  const kid = "11111111-2222-3333-4444-555555555555";
  const withKey = (content: string): ControlBundle => {
    const b = bundle();
    b.manifest.dataRoot = ""; // fixture metadata is not a real DB: skip the path remap
    b.files[`keys/${kid}.key`] = Buffer.from(content).toString("base64");
    return b;
  };
  test("a differing existing key: error without --force; moved aside (not destroyed) with it", () => {
    const root = path.join(dir, "r");
    mkdirSync(path.join(root, "keys"), { recursive: true });
    writeFileSync(path.join(root, "keys", `${kid}.key`), "CURRENT-KEY");
    expect(() => writeControlPlane(withKey("BACKUP-KEY"), root)).toThrow(/differs from the backup/);
    expect(existsSync(path.join(root, "metadata.sqlite"))).toBe(false); // nothing written on refusal
    writeControlPlane(withKey("BACKUP-KEY"), root, { force: true });
    expect(readFileSync(path.join(root, "keys", `${kid}.key`), "utf8")).toBe("BACKUP-KEY");
    const aside = readdirSync(path.join(root, "keys")).find((f) => f.includes(".before-restore-"))!;
    expect(readFileSync(path.join(root, "keys", aside), "utf8")).toBe("CURRENT-KEY");
  });
  test("an identical existing key is fine without --force", () => {
    const root = path.join(dir, "same");
    mkdirSync(path.join(root, "keys"), { recursive: true });
    writeFileSync(path.join(root, "keys", `${kid}.key`), "SAME");
    expect(() => writeControlPlane(withKey("SAME"), root)).not.toThrow();
  });
  test("symlinked key file is refused", () => {
    const root = path.join(dir, "sym");
    mkdirSync(path.join(root, "keys"), { recursive: true });
    writeFileSync(path.join(dir, "elsewhere"), "x");
    Bun.spawnSync(["ln", "-s", path.join(dir, "elsewhere"), path.join(root, "keys", `${kid}.key`)]);
    expect(() => writeControlPlane(withKey("K"), root, { force: true })).toThrow(/symlink/);
  });
  test("remap only matches whole path segments", () => {
    const root = path.join(dir, "remap");
    const src = path.join(dir, "old-src");
    mkdirSync(src, { recursive: true });
    const m = openMetadata(path.join(src, "metadata.sqlite"));
    const ws = crypto.randomUUID();
    m.workspaces.create({ id: ws, slug: "w", name: "w", createdAt: 0 });
    m.databases.create({ id: crypto.randomUUID(), workspace_id: ws, slug: "in", name: "in", data_dir: "/data/ws/dbs/in", created_at: 0 });
    m.databases.create({ id: crypto.randomUUID(), workspace_id: ws, slug: "out", name: "out", data_dir: "/data2/ws/dbs/out", created_at: 0 });
    const b = snapshotControlPlane(src, m.db, "t");
    m.db.close();
    b.manifest.dataRoot = "/data";
    expect(writeControlPlane(b, root).remapped).toBe(1);
    const db = new SQLite(path.join(root, "metadata.sqlite"), { readonly: true });
    const dirs = (db.query("SELECT slug, data_dir FROM databases ORDER BY slug").all() as { slug: string; data_dir: string }[]).map((r) => r.data_dir);
    db.close();
    expect(dirs).toEqual([path.join(path.resolve(root), "ws/dbs/in"), "/data2/ws/dbs/out"]);
  });
});

describe("pid file", () => {
  test("detects a live server, ignores stale files", async () => {
    const { runningServerPid } = await import("../../src/util/pidfile.ts");
    expect(runningServerPid(dir)).toBeNull();
    const child = Bun.spawn(["bash", "-c", "exec -a sqlitend-test sleep 5"]);
    writeFileSync(path.join(dir, "sqlitend.pid"), `${child.pid}\n`);
    await Bun.sleep(100);
    expect(runningServerPid(dir)).toBe(child.pid);
    child.kill();
    await child.exited;
    expect(runningServerPid(dir)).toBeNull(); // dead pid → stale
    writeFileSync(path.join(dir, "sqlitend.pid"), `${process.pid}\n`);
    expect(runningServerPid(dir)).toBeNull(); // our own pid (the CLI) is never "the server"
  });
});

describe("ControlBackupService", () => {
  function memS3() {
    const objects = new Map<string, Buffer>();
    const s3: S3Like & { delete(k: string): Promise<void> } = {
      write: async (k, v) => void objects.set(k, Buffer.from(v as unknown as Uint8Array)),
      file: (k) => ({ text: async () => objects.get(k)!.toString(), exists: async () => objects.has(k) }),
      list: async ({ prefix }) => ({ contents: [...objects.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key })) }),
      delete: async (k) => void objects.delete(k),
    };
    return { s3, objects };
  }
  const key = parseBackupKey(generateBackupKey());

  test("uploads encrypted, prunes to keep, tracks status; restart learns the latest", async () => {
    const { s3, objects } = memS3();
    let t = Date.parse("2026-09-25T03:15:00Z");
    const svc = new ControlBackupService({ s3, key, prefix: "server-a", keep: 3, snapshot: bundle, now: () => (t += 1000), log: () => {} });
    for (let i = 0; i < 5; i++) await svc.runNow();
    const keys = [...objects.keys()].sort();
    expect(keys).toHaveLength(3);
    expect(keys.every((k) => k.startsWith("server-a/control/") && k.endsWith(".sqlitend-backup"))).toBe(true);
    expect(decryptBundle(objects.get(keys.at(-1)!)!, key)).toEqual(bundle());
    expect(svc.status()).toMatchObject({ lastKey: keys.at(-1), lastError: null });

    const fresh = new ControlBackupService({ s3, key, prefix: "server-a", snapshot: bundle, log: () => {} });
    await fresh.loadLatest();
    expect(fresh.status().lastKey).toBe(keys.at(-1)!);
    expect(fresh.status().lastOkAt).toBe(parseKeyTime(keys.at(-1)!, "server-a"));
  });

  test("a run requested during an upload queues exactly one more; failures are recorded", async () => {
    const { s3, objects } = memS3();
    let snaps = 0;
    const svc = new ControlBackupService({ s3, key, prefix: "p", snapshot: () => (snaps++, bundle()), log: () => {} });
    await Promise.all([svc.runNow(), svc.runNow(), svc.runNow()]);
    await Bun.sleep(20);
    expect(snaps).toBe(2);
    expect(objects.size).toBeGreaterThanOrEqual(1);
    const broken = new ControlBackupService({ s3: { ...s3, write: async () => { throw new Error("403 AccessDenied"); } }, key, prefix: "p", snapshot: bundle, log: () => {} });
    await expect(broken.runNow()).rejects.toThrow(/403/);
    expect(broken.status().lastError).toContain("403");
  });

  test("a follow-up run that fails does not become an unhandled rejection; callers see the error", async () => {
    let calls = 0;
    const failing: S3Like = {
      write: async () => {
        calls++;
        await Bun.sleep(30);
        throw new Error("503 SlowDown");
      },
      file: () => ({ text: async () => "", exists: async () => false }),
      list: async () => ({ contents: [] }),
    };
    const svc = new ControlBackupService({ s3: failing, key, prefix: "p", snapshot: bundle, log: () => {} });
    const results = await Promise.allSettled([svc.runNow(), svc.runNow(), svc.runNow()]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    await Bun.sleep(100);
    expect(calls).toBe(2); // the in-flight one + exactly one follow-up
  });

  test("prune never deletes the backup just written, even if it sorts oldest (clock jumped back)", async () => {
    const { s3, objects } = memS3();
    for (const d of ["2030-01-01", "2030-01-02", "2030-01-03"]) objects.set(`p/control/${d}T00-00-00-000Z.sqlitend-backup`, Buffer.from("x"));
    const svc = new ControlBackupService({ s3, key, prefix: "p", keep: 3, snapshot: bundle, now: () => Date.parse("2026-01-01T00:00:00Z"), log: () => {} });
    await svc.runNow();
    const keys = [...objects.keys()].sort();
    expect(keys).toHaveLength(3);
    expect(keys).toContain(svc.status().lastKey!);
  });

  test("object keys sort by time and parse back", () => {
    const at = Date.parse("2026-09-25T03:15:07.123Z");
    const k = controlObjectKey("server-a", at);
    expect(k).toBe("server-a/control/2026-09-25T03-15-07-123Z.sqlitend-backup");
    expect(parseKeyTime(k, "server-a")).toBe(at);
    expect(controlObjectKey("s", at + 1) > controlObjectKey("s", at)).toBe(true);
  });
});
