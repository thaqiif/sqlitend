// ---------------------------------------------------------------------------
// Metrics sampler — per-DB process resource readings from /proc.
//
// cpuPct    = Δ(utime+stime) / Δwallclock × 100  (fraction of one core).
//             utime/stime are USER_HZ ticks; scaled with the same CLK_TCK
//             constant used by the launcher/reconcile. null until 2 samples.
// memoryBytes = VmRSS from /proc/<pid>/status.
// diskBytes   = recursive byte-sum of the database data dir.
// uptimeSec   = (now − persisted databases.start_time) / 1000 — survives
//               control-plane restarts for adopted processes, resets on relaunch.
// status      = the metadata row's status, verbatim. The supervisor is the
//             single writer of crashed/failed transitions (exit handler /
//             adopted watcher / reconcile); the sampler never overrides it, so
//             /metrics and /databases can never disagree.
//
// Sampling runs on a 5s interval (config.sampleIntervalMs); the UI polls the
// metrics endpoint at the same cadence ("data refreshes at a 5s cadence").
// ---------------------------------------------------------------------------

import { readFileSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { isInside } from "../util/paths.ts";

/** Unix USER_HZ/CLK_TCK. Must match launcher.CLK_TCK. */
export const CLK_TCK = 100;

export interface RawSample {
  cpuPct: number | null;
  memoryBytes: number;
  diskBytes: number;
  uptimeSec: number;
  status: string;
  sampledAt: number;
}

export interface SamplerRow {
  dbId: string;
  pid: number | null;
  startTimeMs: number | null;
  dataDir: string;
  status: string;
}

interface Prev {
  ticks: number;
  wall: number;
}

export function readProcStat(pid: number): { utime: number; stime: number } {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 1).trim().split(/\s+/);
    // After comm's closing `)`, fields are offset by 3: idx0=state(field 3),
    // idx1=ppid(field 4), … so field 14 (utime) = idx 11, field 15 (stime) =
    // idx 12. (launcher.procStartEpochMs uses the same offset-3 layout.)
    return { utime: Number(fields[11]), stime: Number(fields[12]) };
  } catch {
    return { utime: 0, stime: 0 };
  }
}

export function readVmRss(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

export function dirBytes(dir: string): number {
  let total = 0;
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirBytes(p);
      else total += statSync(p).size;
    } catch {
      /* skip */
    }
  }
  return total;
}

export function procAlive(pid: number): boolean {
  try {
    readFileSync(`/proc/${pid}/stat`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Pure function: compute CPU% from a delta of ticks and wallclock ms. */
export function computeCpuPct(deltaTicks: number, deltaWallMs: number): number {
  if (deltaWallMs <= 0) return 0;
  // ticks are USER_HZ units; 100% of one core = deltaWallMs/1000 * CLK_TCK ticks.
  return (deltaTicks / ((deltaWallMs / 1000) * CLK_TCK)) * 100;
}

export class Sampler {
  /** CPU baselines keyed by dbId (NOT pid — a pid-keyed map leaks entries for
   *  stopped databases and can straddle pid reuse). */
  private prev = new Map<string, Prev>();
  private latest = new Map<string, RawSample>();
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Root that a row's dataDir must live inside before it is walked for
   *  diskBytes (a corrupted metadata row must never turn the recursive read
   *  into an arbitrary-path walk). Empty = containment disabled (tests). */
  private dataRoot: string;

  constructor(intervalMs: number, dataRoot = "") {
    this.intervalMs = intervalMs;
    this.dataRoot = dataRoot;
  }

  /** Sample a single database row. Exported for direct testing. */
  sampleOne(row: SamplerRow): RawSample {
    const now = Date.now();
    let cpuPct: number | null = null;
    let memoryBytes = 0;
    const status = row.status;

    if (row.pid && procAlive(row.pid)) {
      const { utime, stime } = readProcStat(row.pid);
      const ticks = utime + stime;
      const prev = this.prev.get(row.dbId);
      if (prev) {
        const dt = now - prev.wall;
        cpuPct = dt > 0 ? computeCpuPct(ticks - prev.ticks, dt) : null;
      }
      this.prev.set(row.dbId, { ticks, wall: now });
      memoryBytes = readVmRss(row.pid);
    } else {
      // No live process: drop any CPU baseline (a pid recycle must never
      // compute a delta across two different processes).
      this.prev.delete(row.dbId);
    }

    const uptimeSec = row.startTimeMs ? Math.max(0, Math.floor((now - row.startTimeMs) / 1000)) : 0;
    return {
      cpuPct,
      memoryBytes,
      // Only walk a dataDir that lives inside the data root; anything else
      // reports 0 (no disk metric) instead of recursing an arbitrary path.
      diskBytes:
        (!this.dataRoot || isInside(this.dataRoot, row.dataDir)) ? dirBytes(row.dataDir) : 0,
      uptimeSec,
      status,
      sampledAt: now,
    };
  }

  /** Start the periodic sampling loop over a provider of rows. Entries for
   *  databases that leave the provider (deleted rows) are dropped so the
   *  maps never grow without bound. */
  start(provider: () => SamplerRow[]) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const rows = provider();
      const seen = new Set<string>();
      for (const row of rows) {
        seen.add(row.dbId);
        this.latest.set(row.dbId, this.sampleOne(row));
      }
      for (const key of this.latest.keys()) {
        if (!seen.has(key)) {
          this.latest.delete(key);
          this.prev.delete(key);
        }
      }
    }, this.intervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  latestFor(dbId: string): RawSample | undefined {
    return this.latest.get(dbId);
  }

  set(id: string, s: RawSample) {
    this.latest.set(id, s);
  }
}
