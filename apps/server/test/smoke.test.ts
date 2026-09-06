import { describe, expect, test } from "bun:test";
import {
  ConnectionSchema,
  CreateTokenSchema,
  DatabaseSchema,
  DatabaseStatusSchema,
  MetricsSchema,
  TokenIssuedSchema,
  WorkspaceSchema,
} from "@sqlitend/shared";

describe("shared typed contract (US-001)", () => {
  test("status enum includes running and failed", () => {
    expect(DatabaseStatusSchema.options).toContain("running");
    expect(DatabaseStatusSchema.options).toContain("failed");
    expect(DatabaseStatusSchema.options).toContain("deleting");
  });

  test("Database DTO parses a valid row with persisted ports + start_time", () => {
    const db = DatabaseSchema.parse({
      id: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      slug: "demo",
      name: "demo",
      status: "running",
      pid: 1234,
      port: 6101,
      grpcPort: 6102,
      dataDir: "/x/ws/dbs/demo",
      autoStart: true,
      sqldVersion: "v0.24.0",
      failedReason: null,
      createdAt: Date.now(),
    });
    expect(db.status).toBe("running");
    expect(db.grpcPort).toBe(6102);
    expect(db.failedReason).toBeNull();
  });

  test("Connection carries all three URLs", () => {
    const conn = ConnectionSchema.parse({
      httpUrl: "http://127.0.0.1:6101",
      hranaUrl: "ws://127.0.0.1:6101",
      grpcUrl: "http://127.0.0.1:6102",
      dbName: "demo",
    });
    expect(conn.grpcUrl.includes("6102")).toBe(true);
  });

  test("CreateTokenSchema: omitted scope means full; anything else is rejected (strict)", () => {
    expect(CreateTokenSchema.parse({}).scope).toBeUndefined(); // minting defaults to full
    expect(CreateTokenSchema.parse({ scope: "full" }).scope).toBe("full");
    // SECURITY REGRESSION GUARDS — a "read-only" request must be a 400 at the
    // API layer, never silently minted as full access.
    expect(() => CreateTokenSchema.parse({ scope: "ro" })).toThrow();
    expect(() => CreateTokenSchema.parse({ scope: "readonly" })).toThrow();
    expect(() => CreateTokenSchema.parse({ scope: "full", bogus: 1 })).toThrow(); // strict: unknown keys
    expect(() => CreateTokenSchema.parse({ expiresInHours: -5 })).toThrow();
    expect(() => CreateTokenSchema.parse({ expiresInHours: 99999 })).toThrow();
    const issued = TokenIssuedSchema.parse({
      jti: crypto.randomUUID(),
      databaseId: crypto.randomUUID(),
      scope: "full",
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 3600 * 1000,
      token: "abc",
      dbSlug: "demo",
    });
    expect(issued.scope).toBe("full");
  });
});

describe("sanity: other DTOs compile", () => {
  test("Workspace and Metrics parse", () => {
    expect(
      WorkspaceSchema.parse({
        id: crypto.randomUUID(),
        slug: "main",
        name: "Main",
        createdAt: 1,
      }).slug,
    ).toBe("main");
    expect(
      MetricsSchema.parse({
        cpuPct: null,
        memoryBytes: 10,
        diskBytes: 20,
        uptimeSec: 5,
        status: "running",
        sampledAt: 1,
      }).status,
    ).toBe("running");
  });
});
