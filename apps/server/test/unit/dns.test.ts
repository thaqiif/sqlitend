import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../../src/db/metadata.ts";
import { DatabasesRepo } from "../../src/db/repos/databases.ts";
import { WorkspacesRepo } from "../../src/db/repos/workspaces.ts";
import { CloudflareDns, DnsConflictError, type DnsRecord } from "../../src/dns/cloudflare.ts";
import { DnsManager } from "../../src/dns/manager.ts";
import { parseHostTemplate } from "../../src/gateway/gateway.ts";
import { loadConfig } from "../../src/config.ts";

// --- fake Cloudflare API v4 (just the dns_records surface) -----------------
let cfServer: Server<undefined>;
let records: DnsRecord[] = [];
let failNext = 0;
let dupOnPost = false;
let postDelayMs = 0;
const calls: string[] = [];
const ZONE = "zone123";
const TOKEN = "cf-token";

beforeAll(() => {
  cfServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      calls.push(`${req.method} ${u.pathname.replace(`/zones/${ZONE}`, "")}`);
      const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
      const err = (status: number, code: number, message: string) =>
        Response.json({ success: false, errors: [{ code, message }], result: null }, { status });
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return err(403, 10000, "Authentication error");
      if (!u.pathname.startsWith(`/zones/${ZONE}/dns_records`)) return err(404, 7003, "no route");
      if (failNext > 0) { failNext--; return err(500, 1000, "boom"); }
      const id = u.pathname.split("/dns_records/")[1];
      if (req.method === "GET" && !id) return ok(records.filter((r) => r.name === u.searchParams.get("name")));
      if (req.method === "POST") {
        if (postDelayMs) await Bun.sleep(postDelayMs);
        const body = (await req.json()) as object;
        if (dupOnPost) {
          dupOnPost = false;
          records.push({ id: "raced", ...body } as DnsRecord);
          return err(400, 81057, "Record already exists.");
        }
        const rec = { id: crypto.randomUUID().replace(/-/g, ""), ...body } as DnsRecord;
        records.push(rec);
        return ok(rec);
      }
      const i = records.findIndex((r) => r.id === id);
      if (i === -1) return err(404, 81044, "Record does not exist.");
      if (req.method === "GET") return ok(records[i]);
      if (req.method === "PATCH") { records[i] = { ...records[i], ...((await req.json()) as object) } as DnsRecord; return ok(records[i]); }
      if (req.method === "DELETE") { records.splice(i, 1); return ok({ id }); }
      return err(405, 0, "method");
    },
  });
});
afterAll(() => cfServer.stop(true));

let dir: string;
let db: Database;
let databases: DatabasesRepo;
let workspaceId: string;
const TARGET = "11111111-2222-3333-4444-555555555555.cfargotunnel.com";
const tpl = parseHostTemplate("{db}-libsql.cloudsby.me");
const cf = () => new CloudflareDns({ apiToken: TOKEN, zoneId: ZONE, apiBase: `http://127.0.0.1:${cfServer.port}` });
const manager = () => new DnsManager({ cf: cf(), template: tpl, target: TARGET, databases });

beforeEach(() => {
  records = [];
  failNext = 0;
  dupOnPost = false;
  postDelayMs = 0;
  calls.length = 0;
  dir = mkdtempSync(path.join(tmpdir(), "sqlitend-dns-"));
  db = openDb(path.join(dir, "metadata.sqlite"));
  migrate(db);
  databases = new DatabasesRepo(db);
  workspaceId = new WorkspacesRepo(db).create({ id: crypto.randomUUID(), slug: "ws", name: "ws", createdAt: 0 }).id;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const mkDb = (slug: string) =>
  databases.create({ id: crypto.randomUUID(), workspace_id: workspaceId, slug, name: slug, data_dir: path.join(dir, slug), created_at: 0 });

describe("CloudflareDns.ensureCname", () => {
  test("creates once, then is a no-op; repairs drift on a managed record", async () => {
    const c = cf();
    const a = await c.ensureCname("x-libsql.cloudsby.me", TARGET, "managed-by:sqlitend db:1");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: "CNAME", content: TARGET, proxied: true });
    calls.length = 0;
    const b = await c.ensureCname("x-libsql.cloudsby.me", TARGET, "managed-by:sqlitend db:1");
    expect(b.id).toBe(a.id);
    expect(calls).toEqual(["GET /dns_records"]);
    records[0]!.content = "elsewhere.example.com";
    await c.ensureCname("x-libsql.cloudsby.me", TARGET, "managed-by:sqlitend db:1");
    expect(records[0]!.content).toBe(TARGET);
    expect(records).toHaveLength(1);
  });

  test("never touches an unmanaged record", async () => {
    records.push({ id: "foreign", type: "A", name: "x-libsql.cloudsby.me", content: "1.2.3.4", comment: null });
    await expect(cf().ensureCname("x-libsql.cloudsby.me", TARGET, "managed-by:sqlitend db:1")).rejects.toBeInstanceOf(DnsConflictError);
    expect(records).toEqual([{ id: "foreign", type: "A", name: "x-libsql.cloudsby.me", content: "1.2.3.4", comment: null }]);
  });

  test("deleteOwned: deletes ours, ignores missing, refuses foreign and other sqlitend dbs", async () => {
    const c = cf();
    const r = await c.ensureCname("x-libsql.cloudsby.me", TARGET, "managed-by:sqlitend db:1");
    await c.deleteOwned(r.id, "managed-by:sqlitend db:1");
    expect(records).toHaveLength(0);
    await c.deleteOwned(r.id, "managed-by:sqlitend db:1"); // already gone → no-op
    records.push({ id: "foreign", type: "CNAME", name: "y", content: "z", comment: "hand-made" });
    records.push({ id: "other", type: "CNAME", name: "w", content: "z", comment: "managed-by:sqlitend db:2" });
    await expect(c.deleteOwned("foreign", "managed-by:sqlitend db:1")).rejects.toBeInstanceOf(DnsConflictError);
    await expect(c.deleteOwned("other", "managed-by:sqlitend db:1")).rejects.toBeInstanceOf(DnsConflictError);
    expect(records).toHaveLength(2);
  });

  test("a record owned by another sqlitend database is a conflict, never PATCHed", async () => {
    records.push({ id: "o", type: "CNAME", name: "x-libsql.cloudsby.me", content: "other-tunnel.cfargotunnel.com", proxied: true, comment: "managed-by:sqlitend db:OTHER" });
    await expect(cf().ensureCname("x-libsql.cloudsby.me", TARGET, "managed-by:sqlitend db:1")).rejects.toBeInstanceOf(DnsConflictError);
    expect(records[0]!.content).toBe("other-tunnel.cfargotunnel.com");
    expect(calls.filter((x) => x.startsWith("PATCH"))).toEqual([]);
  });

  test("a zone/route 404 is an error, not 'already deleted'", async () => {
    const wrongZone = new CloudflareDns({ apiToken: TOKEN, zoneId: "nope", apiBase: `http://127.0.0.1:${cfServer.port}` });
    await expect(wrongZone.deleteOwned("abc", "managed-by:sqlitend db:1")).rejects.toThrow(/7003/);
  });

  test("concurrent create converges when Cloudflare says the record already exists", async () => {
    dupOnPost = true; // the fake inserts the record, then answers 81057
    const r = await cf().ensureCname("x-libsql.cloudsby.me", TARGET, "managed-by:sqlitend db:1");
    expect(r.name).toBe("x-libsql.cloudsby.me");
    expect(records).toHaveLength(1);
  });

  test("API errors surface the Cloudflare message", async () => {
    const bad = new CloudflareDns({ apiToken: "wrong", zoneId: ZONE, apiBase: `http://127.0.0.1:${cfServer.port}` });
    await expect(bad.findByName("x")).rejects.toThrow(/10000: Authentication error/);
  });
});

describe("DnsManager", () => {
  test("sync records active state; failure is recorded, not thrown; retry recovers", async () => {
    const row = mkDb("bots-prod");
    failNext = 1;
    await manager().sync(row);
    let fresh = databases.getById(row.id)!;
    expect(fresh.dns_status).toBe("error");
    expect(fresh.dns_hostname).toBe("bots-prod-libsql.cloudsby.me");
    expect(fresh.dns_error).toMatch(/boom/);

    await manager().sync(fresh);
    fresh = databases.getById(row.id)!;
    expect(fresh.dns_status).toBe("active");
    expect(fresh.dns_error).toBeNull();
    expect(fresh.dns_record_id).toBe(records[0]!.id);
    expect(records[0]!.comment).toBe(`managed-by:sqlitend db:${row.id}`);
  });

  test("conflict status when the name is taken by a foreign record", async () => {
    const row = mkDb("taken");
    records.push({ id: "f", type: "A", name: "taken-libsql.cloudsby.me", content: "1.1.1.1", comment: null });
    await manager().sync(row);
    expect(databases.getById(row.id)!.dns_status).toBe("conflict");
  });

  test("remove deletes the record and never throws", async () => {
    const row = mkDb("gone");
    await manager().sync(row);
    await manager().remove(databases.getById(row.id)!);
    expect(records).toHaveLength(0);
    failNext = 5;
    await manager().remove({ ...databases.getById(row.id)!, dns_record_id: "whatever" }); // must not throw
  });

  test("delete while a sync is in flight leaves no record behind", async () => {
    const row = mkDb("racy");
    postDelayMs = 100;
    const m = manager();
    const syncing = m.sync(row);
    await Bun.sleep(20);
    // Route order on DELETE: status=deleting, kill, remove(), then row delete.
    databases.updateStatus(row.id, "deleting");
    await m.remove(databases.getById(row.id)!);
    databases.delete(row.id);
    await syncing;
    expect(records).toHaveLength(0);
  });

  test("sync that finds its row deleted cleans up the record it just created", async () => {
    const row = mkDb("vanish");
    postDelayMs = 100;
    const syncing = manager().sync(row);
    await Bun.sleep(20);
    databases.delete(row.id); // bypasses the lock on purpose
    await syncing;
    expect(records).toHaveLength(0);
  });

  test("remove without a saved record id finds our record by exact comment", async () => {
    const row = mkDb("lost");
    await manager().sync(row);
    const foreign: DnsRecord = { id: "hand", type: "TXT", name: "lost-libsql.cloudsby.me", content: "x", comment: "hand-made" };
    records.push(foreign);
    databases.setDns(row.id, { hostname: "lost-libsql.cloudsby.me", recordId: null, status: "error", error: "timeout" });
    await manager().remove(databases.getById(row.id)!);
    expect(records).toEqual([foreign]);
  });

  test("reconcileAll syncs only rows that are not active", async () => {
    const a = mkDb("a");
    mkDb("b");
    await manager().sync(a);
    calls.length = 0;
    const r = await manager().reconcileAll();
    expect(r).toEqual({ synced: 1, failed: 0 });
    expect(records.map((x) => x.name).sort()).toEqual(["a-libsql.cloudsby.me", "b-libsql.cloudsby.me"]);
  });
});

describe("config", () => {
  const gw = { SQLITEND_GATEWAY_PORT: "6080", SQLITEND_GATEWAY_HOST_TEMPLATE: "{db}-libsql.cloudsby.me" };
  const cfEnv = { SQLITEND_CF_API_TOKEN: "t", SQLITEND_CF_ZONE_ID: "z", SQLITEND_CF_TUNNEL_ID: "11111111-2222-3333-4444-555555555555" };
  test("off by default, all-or-nothing, requires gateway, validates tunnel id", () => {
    expect(loadConfig({}).cloudflareDns).toBeNull();
    expect(loadConfig({ ...gw, ...cfEnv }).cloudflareDns?.tunnelId).toBe(cfEnv.SQLITEND_CF_TUNNEL_ID);
    expect(() => loadConfig({ ...gw, SQLITEND_CF_API_TOKEN: "t" })).toThrow(/needs all/);
    expect(() => loadConfig({ ...cfEnv })).toThrow(/requires the gateway/);
    expect(() => loadConfig({ SQLITEND_GATEWAY_PORT: "6080", ...cfEnv })).toThrow(/TEMPLATE/);
    expect(() => loadConfig({ ...gw, ...cfEnv, SQLITEND_CF_TUNNEL_ID: "nope" })).toThrow(/TUNNEL_ID/);
  });
});
