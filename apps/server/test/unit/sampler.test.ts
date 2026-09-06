import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLK_TCK, computeCpuPct, readProcStat, readVmRss, dirBytes, procAlive, Sampler } from "../../src/metrics/sampler.ts";
const skipProc = test.skipIf(process.platform !== "linux");

describe("CPU math", () => {
  test("computeCpuPct: 100% of one core = CLK_TCK ticks per second", () => {
    // 100 ticks over 1000ms at CLK_TCK=100 == a single core fully busy.
    expect(computeCpuPct(100, 1000)).toBeCloseTo(100, 5);
    expect(computeCpuPct(50, 1000)).toBeCloseTo(50, 5);
    expect(computeCpuPct(0, 500)).toBe(0);
    expect(computeCpuPct(100, 0)).toBe(0); // guard: no wallclock delta
  });

  skipProc("readProcStat reads utime/stime at the offset-3 /proc field indices", () => {
    // After comm's closing `)`, idx0=state(field3), idx1=ppid(field4), ... so
    // utime(field14)=idx11 and stime(field15)=idx12. Parse the real line the
    // same offset-3 way and assert they agree. This is the regression test that
    // would have caught the off-by-one (reading stime+cutime instead).
    const pid = process.pid;
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    const s = readProcStat(pid);
    expect(fields[11]).toBeDefined();
    expect(s.utime).toBe(Number(fields[11]));
    expect(s.stime).toBe(Number(fields[12]));
  });

  skipProc("readProcStat never throws for a dead/missing pid", () => {
    expect(readProcStat(1_000_000_000)).toEqual({ utime: 0, stime: 0 });
  });
});

describe("memory / disk", () => {
  skipProc("readVmRss of the current process is positive", () => {
    expect(readVmRss(process.pid)).toBeGreaterThan(0);
  });

  test("dirBytes sums nested files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sqlitend-dirbytes-"));
    try {
      mkdirSync(path.join(dir, "sub"));
      writeFileSync(path.join(dir, "a.bin"), Buffer.alloc(100));
      writeFileSync(path.join(dir, "sub", "b.bin"), Buffer.alloc(200));
      expect(dirBytes(dir)).toBe(300);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  skipProc("procAlive true for self, false for nonexistent pid", () => {
    expect(procAlive(process.pid)).toBe(true);
    expect(procAlive(1_000_000_000)).toBe(false);
  });
});

describe("sampleOne", () => {
  skipProc("live process (self) samples running status with real RSS/disk, null cpu on first sample", async () => {
    const sampler = new Sampler(5000);
    const dir = mkdtempSync(path.join(tmpdir(), "sqlitend-sample-"));
    try {
      const s = sampler.sampleOne({
        dbId: "db1",
        pid: process.pid, // a live process
        startTimeMs: Date.now() - 60_000, // started 60s ago
        dataDir: dir,
        status: "running",
      });
      expect(s.status).toBe("running");
      expect(s.cpuPct).toBeNull(); // first sample: no baseline yet
      expect(s.memoryBytes).toBeGreaterThan(0);
      expect(s.uptimeSec).toBeGreaterThan(50);
      expect(s.diskBytes).toBeGreaterThanOrEqual(0);
      // second sample yields a non-null cpu once at least a wall-clock tick
      // has elapsed (dt>0). Sleep a beat so the process accumulates ticks.
      await new Promise((r) => setTimeout(r, 30));
      const s2 = sampler.sampleOne({
        dbId: "db1", pid: process.pid, startTimeMs: Date.now() - 60_000, dataDir: dir, status: "running",
      });
      expect(s2.cpuPct).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dead/missing pid: metrics zero out but status stays the row's (supervisor owns crash transitions)", () => {
    const sampler = new Sampler(5000);
    const s = sampler.sampleOne({
      dbId: "db2",
      pid: 1_000_000_000, // does not exist
      startTimeMs: Date.now(),
      dataDir: "/nonexistent",
      status: "running",
    });
    // The sampler reports the row's status VERBATIM (single source of truth —
    // /api/metrics can never disagree with /api/databases); the supervisor's
    // exit handler / adopted watcher / reconcile are the only writers of
    // `crashed`. Metrics zero out for the dead process.
    expect(s.status).toBe("running");
    expect(s.uptimeSec).toBe(0);
    expect(s.memoryBytes).toBe(0);
    expect(s.diskBytes).toBe(0);
  });

  skipProc("startTimeMs is honored via procStartEpochMs-compatible epoch ms", () => {
    const sampler = new Sampler(5000);
    const start = Date.now() - 123_000;
    const s = sampler.sampleOne({
      dbId: "db3", pid: process.pid, startTimeMs: start, dataDir: "/tmp", status: "running",
    });
    expect(s.uptimeSec).toBe(Math.floor(123));
  });
});

describe("disk containment (data root)", () => {
  test("sampleOne reports diskBytes=0 when dataDir escapes the data root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sqlitend-sampler-root-"));
    try {
      const sampler = new Sampler(5000, root);
      const outside = mkdtempSync(path.join(tmpdir(), "sqlitend-sampler-outside-"));
      writeFileSync(path.join(outside, "big.bin"), Buffer.alloc(4096));
      const sample = sampler.sampleOne({
        dbId: "x",
        pid: null,
        startTimeMs: Date.now(),
        dataDir: outside,
        status: "running",
      });
      expect(sample.diskBytes).toBe(0); // outside the root -> refuse to walk
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("sampleOne walks dataDir inside the data root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sqlitend-sampler-root-"));
    try {
      const dataDir = path.join(root, "workspaces", "w", "dbs", "d");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(path.join(dataDir, "db.sqlite"), Buffer.alloc(1024));
      const sampler = new Sampler(5000, root);
      const sample = sampler.sampleOne({
        dbId: "x",
        pid: null,
        startTimeMs: Date.now(),
        dataDir,
        status: "running",
      });
      expect(sample.diskBytes).toBe(1024);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
