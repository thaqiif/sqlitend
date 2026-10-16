import { describe, expect, test } from "bun:test";
import { api } from "../src/api/client";
import { mockFetch } from "./fetch-mock";

type Case = [name: string, run: () => Promise<unknown>, method: string, url: string, body?: unknown];

const cases: Case[] = [
  ["listWorkspaces", () => api.listWorkspaces(), "GET", "/api/workspaces"],
  ["createWorkspace", () => api.createWorkspace({ name: "P" }), "POST", "/api/workspaces", { name: "P" }],
  ["setWorkspaceProtection", () => api.setWorkspaceProtection("w", true), "PATCH", "/api/workspaces/w/protection", { protected: true }],
  ["deleteWorkspace", () => api.deleteWorkspace("w", "slug"), "DELETE", "/api/workspaces/w", { confirm: "slug" }],
  ["listDatabases", () => api.listDatabases("w"), "GET", "/api/databases?workspaceId=w"],
  ["getDatabase", () => api.getDatabase("d"), "GET", "/api/databases/d"],
  ["createDatabase", () => api.createDatabase("w", { name: "n" }), "POST", "/api/workspaces/w/databases", { name: "n" }],
  ["startDatabase", () => api.startDatabase("d"), "POST", "/api/databases/d/start"],
  ["stopDatabase", () => api.stopDatabase("d"), "POST", "/api/databases/d/stop"],
  ["syncDns", () => api.syncDns("d"), "POST", "/api/databases/d/dns/sync"],
  ["setDatabaseProtection", () => api.setDatabaseProtection("d", false), "PATCH", "/api/databases/d/protection"],
  ["getDeletePreview", () => api.getDeletePreview("d"), "GET", "/api/databases/d/delete-preview"],
  ["deleteDatabase", () => api.deleteDatabase("d", "slug"), "DELETE", "/api/databases/d", { confirm: "slug" }],
  ["listTrash", () => api.listTrash(), "GET", "/api/trash"],
  ["restoreFromTrash", () => api.restoreFromTrash("t"), "POST", "/api/trash/t/restore"],
  ["purgeFromTrash", () => api.purgeFromTrash("t", "slug"), "DELETE", "/api/trash/t", { confirm: "slug" }],
  ["getConnection", () => api.getConnection("d"), "GET", "/api/databases/d/connection"],
  ["listTokens", () => api.listTokens("d"), "GET", "/api/databases/d/tokens"],
  ["getMetrics", () => api.getMetrics("d"), "GET", "/api/databases/d/metrics"],
  ["getStorageStats", () => api.getStorageStats("d"), "GET", "/api/databases/d/storage"],
  ["getMetricsOverview", () => api.getMetricsOverview(), "GET", "/api/metrics/overview"],
  ["getSystemInfo", () => api.getSystemInfo(), "GET", "/api/system"],
  ["getSchema", () => api.getSchema("d"), "GET", "/api/databases/d/schema"],
  ["getControlBackup", () => api.getControlBackup(), "GET", "/api/backups/control"],
  ["runControlBackup", () => api.runControlBackup(), "POST", "/api/backups/control"],
  ["listBackups", () => api.listBackups(), "GET", "/api/backups"],
  ["listReplicas", () => api.listReplicas(), "GET", "/api/backups/replicas"],
  ["verifyBackup", () => api.verifyBackup("d"), "POST", "/api/databases/d/backup/verify"],
  ["getBackup", () => api.getBackup("d"), "GET", "/api/databases/d/backup"],
  ["listAudit", () => api.listAudit(), "GET", "/api/audit?limit=100"],
  ["listAudit before", () => api.listAudit(50, 7), "GET", "/api/audit?limit=50&before=7"],
];

describe("api endpoint wrappers", () => {
  for (const [name, run, method, url, body] of cases) {
    test(`${name} -> ${method} ${url}`, async () => {
      const { calls } = mockFetch(() => ({ json: {} }));
      await run();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe(method);
      expect(calls[0]!.url).toBe(url);
      expect(calls[0]!.headers["x-sqlitend-csrf"]).toBe("1");
      if (body !== undefined) expect(calls[0]!.body).toEqual(body);
    });
  }

  test("table rows: query string carries paging, sort and JSON filters; mutations use the right verbs", async () => {
    const { calls } = mockFetch(() => ({ json: {} }));
    await api.getTableRows("d", "t x", { limit: 10, offset: 20, sort: "id", dir: "desc", filters: [{ column: "a", op: "eq", value: 1 } as never] });
    const u = new URL(calls[0]!.url, "http://x");
    expect(u.pathname).toBe("/api/databases/d/tables/t%20x/rows");
    expect(u.searchParams.get("limit")).toBe("10");
    expect(u.searchParams.get("offset")).toBe("20");
    expect(u.searchParams.get("sort")).toBe("id");
    expect(u.searchParams.get("dir")).toBe("desc");
    expect(JSON.parse(u.searchParams.get("filters")!)).toEqual([{ column: "a", op: "eq", value: 1 }]);
    await api.getTableRows("d", "t");
    expect(calls[1]!.url).toBe("/api/databases/d/tables/t/rows");
    await api.insertTableRows("d", "t", {} as never);
    await api.updateTableRows("d", "t", {} as never);
    await api.deleteTableRows("d", "t", {} as never);
    expect(calls.slice(2).map((c) => c.method)).toEqual(["POST", "PATCH", "DELETE"]);
  });

  test("query, tokens, history and restore", async () => {
    const { calls } = mockFetch(() => ({ json: {} }));
    await api.runQuery("d", { sql: "select 1" } as never);
    await api.generateToken("d", { scope: "read-only" } as never);
    await api.revealToken("d", "j1");
    await api.revokeToken("d", "j1");
    await api.getMetricsHistory("d");
    await api.restoreBackup("src", { name: "n", workspaceId: "w" } as never);
    await api.loginWithToken("tok");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/databases/d/query",
      "POST /api/databases/d/tokens",
      expect.stringContaining("/api/databases/d/tokens/j1"),
      expect.stringContaining("/api/databases/d/tokens/j1"),
      expect.stringContaining("/api/databases/d/metrics/history"),
      "POST /api/backups/src/restore",
      "POST /api/auth/login",
    ]);
    expect(calls[6]!.body).toEqual({ token: "tok" });
  });
});
