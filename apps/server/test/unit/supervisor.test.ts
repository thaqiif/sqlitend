import { afterAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../../src/config.ts";
import { openMetadata } from "../../src/db/metadata.ts";
import { DatabasesRepo } from "../../src/db/repos/databases.ts";
import { WorkspacesRepo } from "../../src/db/repos/workspaces.ts";
import { procStartEpochMs } from "../../src/supervisor/launcher.ts";
import { killPidGracefully, pidAlive, Supervisor } from "../../src/supervisor/supervisor.ts";

const isLinux = process.platform === "linux";
const skipIfNotLinux = test.skipIf(!isLinux);

const roots: string[] = [];
const children: ChildProcess[] = [];

function rootDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "sqlitend-supervisor-"));
  roots.push(root);
  return root;
}

function configFor(root: string, readyTimeoutMs = 800): Config {
  // A tiny C "sqld" compiled at test time: prints a version on `--version`
  // (satisfying launchSqld's binary guard) then sleeps forever, ignoring every
  // other argument. Its argv/exe survive intact, so orphan-sweep decoys can be
  // spawned from the SAME binary and be recognised by /proc — GNU coreutils
  // `yes` would reject `--db-path` and exit immediately.
  return loadConfig({}, {
    dataRoot: root,
    sqldPath: fakeSqld(root),
    readyTimeoutMs,
    portRange: { start: 29101, end: 29200 },
  });
}

/** Write + compile a C "sqld" inside `root`; returns its path. */
function fakeSqld(root: string): string {
  const src = path.join(root, "fakesqld.c");
  const bin = path.join(root, "fakesqld");
  writeFileSync(
    src,
    '#include <stdio.h>\n#include <string.h>\n#include <unistd.h>\n' +
      'int main(int argc, char **argv) {' +
      '  int i; for (i = 1; i < argc; i++) if (strcmp(argv[i], "--version") == 0) { printf("sqld-fake 9.9.9\\n"); return 0; }' +
      '  for (;;) sleep(60); return 0;' +
      '}\n',
  );
  const built = Bun.spawnSync(["gcc", "-O1", "-o", bin, src], { stderr: "pipe" });
  if (built.exitCode !== 0) throw new Error(`failed to build fake sqld: ${built.stderr.toString()}`);
  return bin;
}

function sleepChild(): ChildProcess {
  const child = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
  children.push(child);
  return child;
}

function waitForPid(child: ChildProcess): number {
  if (!child.pid) throw new Error("child did not receive a pid");
  return child.pid;
}

function waitForExit(child: ChildProcess, timeoutMs = 3000): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pid ${child.pid} did not exit`)), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function makeRow(
  databases: DatabasesRepo,
  root: string,
  over: Partial<Parameters<DatabasesRepo["create"]>[0]> = {},
) {
  return databases.create({
    id: crypto.randomUUID(),
    workspace_id: "ws", // parent created in withSupervisor
    slug: `db-${crypto.randomUUID().slice(0, 8)}`,
    name: "Supervisor test database",
    data_dir: path.join(root, "workspaces", "ws", "db"),
    created_at: Date.now(),
    ...over,
  });
}

/** Temp metadata DB + supervisor; closes both when the callback settles. */
async function withSupervisor(
  fn: (ctx: {
    root: string;
    config: Config;
    supervisor: Supervisor;
    databases: DatabasesRepo;
    workspaces: WorkspacesRepo;
    close: () => void;
  }) => Promise<void>,
): Promise<void> {
  const root = rootDir();
  const metadata = openMetadata(path.join(root, "metadata.sqlite"));
  // Create the FK parent workspace so database rows can reference it.
  metadata.workspaces.create({ id: "ws", slug: "supervisor-tests", name: "supervisor", createdAt: Date.now() });
  const config = configFor(root);
  const supervisor = new Supervisor({ config, databases: metadata.databases });
  try {
    await fn({ root, config, supervisor, databases: metadata.databases, workspaces: metadata.workspaces, close: () => metadata.db.close() });
  } finally {
    await supervisor.shutdown();
    metadata.db.close();
  }
}

async function killAndReap(child: ChildProcess): Promise<void> {
  if (child.exitCode == null && child.signalCode == null && child.pid) await killPidGracefully(child.pid, 100);
  await waitForExit(child).catch(() => {});
}

afterAll(async () => {
  for (const child of children) await killAndReap(child);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("supervisor reconciliation", () => {
  skipIfNotLinux("adopts a live row only when pid start time matches", async () => {
    await withSupervisor(async ({ supervisor, databases, root }) => {
      const child = sleepChild();
      const pid = waitForPid(child);
      const row = makeRow(databases, root, {
        status: "running",
        pid,
        start_time: procStartEpochMs(pid),
        auto_start: 0,
      });

      const result = await supervisor.reconcile();
      expect(result.adopted).toBe(1);
      expect(supervisor.trackedDbIds).toContain(row.id);
      expect(databases.getById(row.id)?.status).toBe("running");
    });
  });

  skipIfNotLinux("rejects a reused pid and attempts auto-start relaunch", async () => {
    await withSupervisor(async ({ supervisor, databases, root }) => {
      const child = sleepChild();
      const pid = waitForPid(child);
      const row = makeRow(databases, root, {
        status: "running",
        pid,
        start_time: procStartEpochMs(pid) + 1000,
        port: 29101,
        grpc_port: 29102,
        auto_start: 1,
      });

      const result = await supervisor.reconcile();
      expect(result.adopted).toBe(0);
      expect(result.notAdopted).toBe(1);
      // `/usr/bin/yes` never serves /health: the mismatch fell through to a
      // relaunch attempt (which failed) rather than adoption.
      expect(databases.getById(row.id)?.status).toBe("failed");
      expect(databases.getById(row.id)?.failed_reason).toContain("did not become ready");
      expect(supervisor.trackedDbIds).not.toContain(row.id);
    });
  });

  skipIfNotLinux("marks a reused pid stopped when auto-start is disabled", async () => {
    await withSupervisor(async ({ supervisor, databases, root }) => {
      const child = sleepChild();
      const pid = waitForPid(child);
      const row = makeRow(databases, root, {
        status: "running",
        pid,
        start_time: procStartEpochMs(pid) + 1000,
        auto_start: 0,
      });

      const result = await supervisor.reconcile();
      expect(result.adopted).toBe(0);
      expect(result.notAdopted).toBe(1);
      expect(databases.getById(row.id)?.status).toBe("stopped");
    });
  });

  skipIfNotLinux("does not spawn a failed auto-start row without persisted ports", async () => {
    await withSupervisor(async ({ supervisor, databases, root }) => {
      const row = makeRow(databases, root, { status: "failed", auto_start: 1 });
      const result = await supervisor.reconcile();
      expect(result.adopted).toBe(0);
      expect(result.relaunched).toBe(0);
      expect(result.notAdopted).toBe(1);
      expect(databases.getById(row.id)?.status).toBe("failed");
      expect(supervisor.trackedDbIds).toEqual([]);
    });
  });

  skipIfNotLinux("leaves stopped rows and their data directory untouched", async () => {
    await withSupervisor(async ({ supervisor, databases, root }) => {
      const dataDir = path.join(root, "workspaces", "ws", "db");
      mkdirSync(dataDir, { recursive: true });
      const marker = path.join(dataDir, "marker.txt");
      writeFileSync(marker, "keep me");
      const row = makeRow(databases, root, { status: "stopped", data_dir: dataDir, auto_start: 1 });

      const result = await supervisor.reconcile();
      expect(result.leftStopped).toBe(1);
      expect(databases.getById(row.id)?.status).toBe("stopped");
      expect(existsSync(marker)).toBe(true);
    });
  });

  skipIfNotLinux("relaunches a crashed auto-start row at boot (like failed rows)", async () => {
    await withSupervisor(async ({ supervisor, databases, root }) => {
      const row = makeRow(databases, root, { status: "crashed", port: 29105, grpc_port: 29106, auto_start: 1 });
      const result = await supervisor.reconcile();
      // The fake sqld never listens, so the relaunch attempt fails; the row
      // ends `failed` with the captured reason, exactly like the pid-mismatch
      // auto-start relaunch path above.
      expect(result.relaunched).toBe(0);
      expect(result.notAdopted).toBe(1);
      expect(databases.getById(row.id)?.status).toBe("failed");
      expect(databases.getById(row.id)?.failed_reason).toContain("did not become ready");
    });
  });

  skipIfNotLinux("clears pid/start_time when an adopted process is observed crashed", async () => {
    await withSupervisor(async ({ supervisor, databases, root }) => {
      const child = sleepChild();
      const pid = waitForPid(child);
      const row = makeRow(databases, root, {
        status: "running",
        pid,
        start_time: procStartEpochMs(pid),
        auto_start: 0,
      });
      expect((await supervisor.reconcile()).adopted).toBe(1);

      await killPidGracefully(pid, 300); // TERM → KILL
      await waitForExit(child);

      // watchAdopted polls /proc every 2s — give it time to notice the death.
      const deadline = Date.now() + 6000;
      let status = databases.getById(row.id)?.status;
      while (status !== "crashed" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        status = databases.getById(row.id)?.status;
      }
      expect(status).toBe("crashed");
      // A crashed row must not keep a stale pid/start_time: a recycled pid
      // would otherwise be misattributed to this row by the sampler, and the
      // API would keep exposing a dead pid.
      const after = databases.getById(row.id)!;
      expect(after.pid).toBeNull();
      expect(after.start_time).toBeNull();
    });
  });

  skipIfNotLinux("killByDbId terminates a live adopted process before returning", async () => {
    await withSupervisor(async ({ supervisor, databases, root }) => {
      const child = sleepChild();
      const pid = waitForPid(child);
      const row = makeRow(databases, root, {
        status: "running",
        pid,
        start_time: procStartEpochMs(pid),
        auto_start: 0,
      });
      expect((await supervisor.reconcile()).adopted).toBe(1);

      await supervisor.killByDbId(row.id);
      // The adopted process must be DEAD before killByDbId resolves — this is
      // what DELETE's "kill before rm" ordering depends on (there is no ChildProcess
      // handle; death is detected via /proc).
      await waitForExit(child).catch(() => {});
      expect(pidAlive(pid)).toBe(false);
      expect(supervisor.trackedDbIds).not.toContain(row.id);
    });
  });

  skipIfNotLinux("concurrent double-start returns alreadyRunning with a single surviving process", async () => {
    await withSupervisor(async ({ supervisor, databases, root }) => {
      const child = sleepChild();
      const pid = waitForPid(child);
      const row = makeRow(databases, root, {
        status: "running",
        pid,
        start_time: procStartEpochMs(pid),
        auto_start: 0,
      });
      expect((await supervisor.reconcile()).adopted).toBe(1);

      // Two concurrent starts against a live adopted process must BOTH see
      // alreadyRunning (serialized per dbId) and leave exactly one live pid.
      const [a, b] = await Promise.all([
        supervisor.startDatabase(row.id, { port: 29107, grpcPort: 29108, dataDir: row.data_dir }),
        supervisor.startDatabase(row.id, { port: 29107, grpcPort: 29108, dataDir: row.data_dir }),
      ]);
      expect(a.ok && a.alreadyRunning).toBe(true);
      expect(b.ok && b.alreadyRunning).toBe(true);
      expect(a.pid).toBe(pid);
      expect(b.pid).toBe(pid);
      expect(pidAlive(pid)).toBe(true); // single surviving process
    });
  });
});

describe("supervisor orphan safety", () => {
  skipIfNotLinux("sweeps only matching untracked sqld argv and preserves decoys", async () => {
    await withSupervisor(async ({ supervisor, config, root }) => {
      const inRoot = path.join(root, "workspaces", "ws", "db");
      mkdirSync(inRoot, { recursive: true });
      // Decoy that LOOKS like a sqld import (argv has --db-path under the root,
      // exe resolves to the configured sqldPath binary) -> swept.
      const swept = spawn(config.sqldPath, ["--db-path", path.join(inRoot, "db.sqlite")], { stdio: "ignore" });
      // Decoy carrying the data root in argv but NO --db-path -> must survive.
      const rootOnly = spawn(config.sqldPath, [root], { stdio: "ignore" });
      // Unrelated command line -> must survive.
      const unrelated = spawn(config.sqldPath, ["unrelated"], { stdio: "ignore" });
      children.push(swept, rootOnly, unrelated);
      const sweptPid = waitForPid(swept);

      const count = await supervisor.sweepOrphans();
      expect(count).toBe(1);
      await waitForExit(swept);
      expect(procStartEpochMs(sweptPid)).toBe(0);
      expect(rootOnly.exitCode == null && rootOnly.signalCode == null).toBe(true);
      expect(unrelated.exitCode == null && unrelated.signalCode == null).toBe(true);
      await killAndReap(rootOnly);
      await killAndReap(unrelated);
    });
  });
});

describe("supervisor termination", () => {
  skipIfNotLinux("killPidGracefully terminates a child", async () => {
    const child = sleepChild();
    const pid = waitForPid(child);
    await killPidGracefully(pid, 100);
    await waitForExit(child);
    expect(procStartEpochMs(pid)).toBe(0);
  });

  skipIfNotLinux("shutdown terminates adopted children without marking rows crashed", async () => {
    await withSupervisor(async ({ supervisor, databases, root }) => {
      const first = sleepChild();
      const second = sleepChild();
      const thePid = waitForPid(first);
      const secondPid = waitForPid(second);
      const firstRow = makeRow(databases, root, { status: "running", pid: thePid, start_time: procStartEpochMs(thePid), auto_start: 0 });
      const secondRow = makeRow(databases, root, { status: "running", pid: secondPid, start_time: procStartEpochMs(secondPid), auto_start: 0 });

      const result = await supervisor.reconcile();
      expect(result.adopted).toBe(2);
      await supervisor.shutdown();
      await waitForExit(first);
      await waitForExit(second);
      expect(supervisor.trackedDbIds).toEqual([]);
      expect(databases.getById(firstRow.id)?.status).toBe("running");
      expect(databases.getById(secondRow.id)?.status).toBe("running");
    });
  });
});
