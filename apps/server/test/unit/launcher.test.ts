import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config.ts";
import { bootEpochMs, launchSqld, procStartEpochMs, sqldVersion } from "../../src/supervisor/launcher.ts";

// The launcher's launchSqld failure paths spawn real subprocesses and read
// /proc (procStartEpochMs reads /proc/<pid>/stat). Those are Linux-only.
const isLinux = process.platform === "linux";
const skipIfNotLinux = test.skipIf(!isLinux);

/** Build a temp dir + a "Config" with an overridable sqldPath/readyTimeout. */
function makeConfig(dir: string, sqldPath: string, readyTimeoutMs = 500) {
  return loadConfig(process.env, { sqldPath, readyTimeoutMs, dataRoot: dir });
}

/** A fake "sqld" binary that just prints a version and exits (usable for the
 *  binary-presence guard, but never listens) vs. one that sleeps forever. */
function writeFakeSqld(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o700);
  return p;
}

let dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "sqlitend-launcher-"));
  dirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("proc start-time helpers (Linux /proc)", () => {
  test.skipIf(!isLinux)("procStartEpochMs of self is within 60s of now and > 0", () => {
    const start = procStartEpochMs(process.pid);
    expect(start).toBeGreaterThan(0);
    expect(Math.abs(start - Date.now())).toBeLessThan(60_000);
  });

  test.skipIf(!isLinux)("procStartEpochMs of a huge/nonexistent pid returns 0", () => {
    expect(procStartEpochMs(1_000_000_000)).toBe(0);
  });

  test.skipIf(!isLinux)("bootEpochMs is before now and cached", () => {
    const a = bootEpochMs();
    const b = bootEpochMs();
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThanOrEqual(Date.now());
    expect(b).toBe(a); // cached across calls
  });
});

describe("sqldVersion", () => {
  test("returns empty string for a nonexistent binary", () => {
    expect(sqldVersion("/nonexistent/sqld")).toBe("");
  });
});

describe("launchSqld failure paths", () => {
  skipIfNotLinux("missing binary: returns ok:false, mentions path, no onSpawn", async () => {
    const dir = tmpDir();
    const cfg = makeConfig(dir, "/nonexistent/sqld");
    const res = await launchSqld(
      { config: cfg },
      { dataDir: path.join(dir, "dbs", "x"), port: 25501, grpcPort: 25502, authPubFile: "" },
      { onSpawn: () => { throw new Error("onSpawn must NOT fire for a missing binary"); } },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect(res.error).toContain("/nonexistent/sqld");
    expect(res.child).toBeUndefined(); // no child was ever spawned
  });

  skipIfNotLinux("fake sqld that never listens: ok:false with 'did not become ready', child reaped", async () => {
    const dir = tmpDir();
    // A script that just sleeps — never opens the HTTP port, never becomes ready.
    const fake = writeFakeSqld(dir, "never-listens.sh", "#!/bin/sh\nif [ \"$1\" = --version ]; then echo sqld-fake-0.0.0; exit 0; fi\nexec sleep 30\n");
    const cfg = makeConfig(dir, fake, 500);

    const res = await launchSqld(
      { config: cfg },
      { dataDir: path.join(dir, "dbs", "x"), port: 25511, grpcPort: 25512, authPubFile: "" },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("did not become ready");
    expect(typeof res.stderrTail).toBe("string");
    expect(res.pid).toBeGreaterThan(0);

    // The failed child must be reaped (exitCode set or killed) — poll briefly.
    const child = res.child!;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && child.exitCode == null && !child.killed) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(child.exitCode != null || child.killed).toBe(true);
  });

  skipIfNotLinux("onSpawn fires exactly once, BEFORE the promise resolves", async () => {
    const dir = tmpDir();
    const fake = writeFakeSqld(dir, "never-listens2.sh", "#!/bin/sh\nif [ \"$1\" = --version ]; then echo sqld-fake-0.0.0; exit 0; fi\nexec sleep 30\n");
    const cfg = makeConfig(dir, fake, 500);

    const order: string[] = [];
    let spawnPid = -1;
    const launch = launchSqld(
      { config: cfg },
      { dataDir: path.join(dir, "dbs", "x"), port: 25521, grpcPort: 25522, authPubFile: "" },
      {
        onSpawn: (child, pid) => {
          order.push("onSpawn");
          spawnPid = pid;
          expect(pid).toBeGreaterThan(0);
        },
      },
    ).then((res) => {
      order.push("resolved");
      return res;
    });

    const res = await launch;
    expect(res.ok).toBe(false);
    expect(order).toEqual(["onSpawn", "resolved"]);
    expect(spawnPid).toBeGreaterThan(0);
  });

  skipIfNotLinux("mkdir guard: dataDir outside dataRoot is refused and never created", async () => {
    const dir = tmpDir();
    const fake = writeFakeSqld(dir, "generic.sh", "#!/bin/sh\necho sqld-fake-0.0.0\nexec sleep 30\n");
    const cfg = makeConfig(dir, fake, 500);

    const outsideDir = path.join(dir, "..", `escaped-${Date.now()}`);
    rmSync(outsideDir, { recursive: true, force: true }); // ensure it does not pre-exist
    let rejected = false;
    try {
      await launchSqld(
        { config: cfg },
        { dataDir: outsideDir, port: 25531, grpcPort: 25532, authPubFile: "" },
      );
    } catch (err) {
      rejected = true;
      expect((err as Error).message).toContain("escapes the data root");
    }
    // assertInside throws, so launchSqld rejects rather than returning ok:false.
    expect(rejected).toBe(true);
    // The illegal directory must NOT exist on disk.
    expect(() => statSync(outsideDir)).toThrow();
  });
});
