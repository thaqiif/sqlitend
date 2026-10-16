import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config.ts";
import { openMetadata, type Metadata } from "../../src/db/metadata.ts";
import { Supervisor } from "../../src/supervisor/supervisor.ts";
import { Sampler } from "../../src/metrics/sampler.ts";
import { createRoutes, sweepExpiredTrash } from "../../src/http/routes.ts";
import { CSRF_HEADER } from "../../src/http/auth-routes.ts";

describe("Phase 4: Protection, slug confirmation, soft-delete trash, restore, purge & retention", () => {
  let tmp: string;
  let meta: Metadata;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "sqlitend-trash-test-"));
    meta = openMetadata(path.join(tmp, "metadata.sqlite"));
  });

  afterEach(() => {
    meta.db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function buildApp(trashDays = 7) {
    const config = loadConfig(
      {
        SQLITEND_DATA_ROOT: tmp,
        SQLITEND_HOST: "127.0.0.1",
        SQLITEND_AUTH: "off",
        SQLITEND_TRASH_DAYS: String(trashDays),
      },
      { portRange: { start: 48101, end: 48150 } },
    );
    const supervisor = new Supervisor({ config, databases: meta.databases, metrics: meta.metrics });
    const sampler = new Sampler(60_000, tmp, meta.metrics);
    return createRoutes({
      config,
      workspaces: meta.workspaces,
      databases: meta.databases,
      tokens: meta.tokens,
      supervisor,
      sampler,
      metricsRepo: meta.metrics,
      sqldOk: false,
      sqldVersion: null,
      version: "0.1.4-test",
    });
  }

  async function req(app: ReturnType<typeof buildApp>, method: string, urlPath: string, body?: unknown) {
    return app.request(urlPath, {
      method,
      headers: {
        [CSRF_HEADER]: "1",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  test("new workspaces and databases default to protected=true and return 423 on DELETE", async () => {
    const app = buildApp();
    const wsRes = await req(app, "POST", "/api/workspaces", { name: "Prod" });
    expect(wsRes.status).toBe(201);
    const ws = (await wsRes.json()) as { id: string; slug: string; protected: boolean };
    expect(ws.protected).toBe(true);

    const dataDir = path.join(tmp, "workspaces", ws.slug, "dbs", "dbprod");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, "data.sqlite"), Buffer.alloc(2048));
    const db = meta.databases.create({
      id: "00000000-0000-4000-8000-000000000099",
      workspace_id: ws.id,
      slug: "dbprod",
      name: "Prod DB",
      status: "stopped",
      port: 48101,
      grpc_port: 48102,
      data_dir: dataDir,
      auto_start: 0,
      created_at: Date.now(),
    });

    // Delete preview works
    const prevRes = await req(app, "GET", `/api/databases/${db.id}/delete-preview`);
    expect(prevRes.status).toBe(200);
    const preview = (await prevRes.json()) as { diskBytes: number; protected: boolean; slug: string };
    expect(preview.diskBytes).toBe(2048);
    expect(preview.protected).toBe(true);
    expect(preview.slug).toBe("dbprod");

    // Protected DB refuses delete with 423
    const delProtected = await req(app, "DELETE", `/api/databases/${db.id}`, { confirm: "dbprod" });
    expect(delProtected.status).toBe(423);
    expect(((await delProtected.json()) as { error: { code: string } }).error.code).toBe("protected");

    // Disable protection -> wrong confirm returns 400 -> exact confirm moves to trash
    await req(app, "PATCH", `/api/databases/${db.id}/protection`, { protected: false });
    expect((await req(app, "DELETE", `/api/databases/${db.id}`, { confirm: "wrong-slug" })).status).toBe(400);
    expect((await req(app, "DELETE", `/api/databases/${db.id}`, { confirm: "dbprod" })).status).toBe(204);

    // Data dir moved to <dataRoot>/trash/<id>-<timestamp>
    expect(existsSync(dataDir)).toBe(false);
    const trashedRow = meta.databases.getById(db.id)!;
    expect(trashedRow.status).toBe("trashed");
    expect(trashedRow.trash_path).toContain(path.join(tmp, "trash", `${db.id}-`));
    expect(existsSync(path.join(trashedRow.trash_path!, "data.sqlite"))).toBe(true);

    // Workspace still refuses delete (409 workspace_not_empty) while it has a trashed DB
    await req(app, "PATCH", `/api/workspaces/${ws.id}/protection`, { protected: false });
    expect((await req(app, "DELETE", `/api/workspaces/${ws.id}`, { confirm: ws.slug })).status).toBe(409);

    // Restore from trash -> moves data_dir back and reallocates ports
    const restoreRes = await req(app, "POST", `/api/trash/${db.id}/restore`, {});
    expect(restoreRes.status).toBe(200);
    const restoredDto = (await restoreRes.json()) as { status: string; port: number };
    expect(restoredDto.status).toBe("stopped");
    expect(restoredDto.port).toBeGreaterThanOrEqual(48101);
    expect(existsSync(path.join(dataDir, "data.sqlite"))).toBe(true);

    // Soft-delete again and test retention sweep
    await req(app, "DELETE", `/api/databases/${db.id}`, { confirm: "dbprod" });
    const futureNow = Date.now() + 8 * 86_400_000;
    const sweptCount = await sweepExpiredTrash(tmp, meta.databases, 7, futureNow);
    expect(sweptCount).toBe(1);
    expect(meta.databases.getById(db.id)).toBeNull();

    // Now workspace is completely empty and unprotected -> DELETE succeeds
    expect((await req(app, "DELETE", `/api/workspaces/${ws.id}`, { confirm: ws.slug })).status).toBe(204);
  });
});
