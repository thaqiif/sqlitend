// ---------------------------------------------------------------------------
// Supervisor — owns the live sqld child processes.
//
// Responsibilities:
//   • pid → dbId registry with child `exit` handlers (mark crashed).
//   • adopted processes are FIRST-CLASS: a control-plane restart cannot hold
//     ChildProcess handles for sqld processes spawned by the previous boot, so
//     reconcile re-parents them into an adoptedPids (dbId → pid) map. Every
//     termination path (stop, delete, shutdown) goes through BOTH maps, so an
//     adopted database is killed before its data dir is removed and before the
//     control plane exits (AC-E5, AC-W4).
//   • boot reconcile against metadata (AC-E3, AC-E9, AC-E10):
//       - a row is ADOPTED iff its pid is alive in /proc AND the process's
//         /proc start time matches the persisted databases.start_time (the
//         pid-reuse guard). Mismatch ⇒ treated as dead. Adoption normalizes
//         stale `starting`/`failed` statuses to `running`.
//       - a dead/mismatched row is relaunched iff auto_start=1 and nothing
//         already binds its port (double-bind guard); auto_start=0 rows are
//         left `stopped` with their data dir intact.
//   • orphan sweep (AC-E4): a process is swept iff ALL of the following hold —
//       its /proc/<pid>/exe resolves to the configured sqld binary, its argv
//       contains `--db-path <path>` with <path> strictly under THIS data root,
//       and its pid is not tracked. Raw substring matching is never used (it
//       could TERM unrelated processes or a second sqlitend instance whose
//       root path is a substring of this one). TERM, 1s grace, then KILL.
//   • graceful shutdown (AC-E5): SIGINT/SIGTERM → TERM all tracked + adopted
//     children, 5s grace, KILL; close the metadata DB.
//   • per-database lifecycle lock: start/stop/delete for one dbId are
//     serialized, so concurrent POST /start cannot double-spawn and DELETE
//     cannot race an in-flight start.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import type { DatabasesRepo } from "../db/repos/databases.ts";
import { launchSqld, procStartEpochMs, livePids, type LaunchResult } from "./launcher.ts";
import { createPortAllocator, portBound } from "./ports.ts";
import { ensureDbKey } from "../auth/tokens.ts";
import { isInside } from "../util/paths.ts";

export type DatabaseStatusValue =
  | "starting"
  | "running"
  | "stopped"
  | "crashed"
  | "failed"
  | "deleting";

export interface SupervisorDeps {
  config: Config;
  databases: DatabasesRepo;
}

const GRACE_MS = 5000;
const SWEEP_TERM_GRACE_MS = 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * True iff the pid is a LIVE process in /proc right now. A zombie (state Z)
 * is NOT alive: if sqlitend ever runs as PID 1 (a container with no reaping
 * init), reparented sqlds become zombies we never waitpid() — treating their
 * /proc presence as alive would keep adopted rows `running` forever, burn the
 * full kill grace, and re-adopt a wedged row at the next boot. Exported for
 * the supervisor test suite.
 */
export function pidAlive(pid: number): boolean {
  let stat = "";
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return false;
  }
  const close = stat.lastIndexOf(")");
  if (close < 0) return false;
  const after = stat.slice(close + 1).trim().split(/\s+/);
  // Field 3 (state) is index 0 after comm's closing `)` (offset-3 convention).
  return after[0] !== "Z";
}

/**
 * Terminate an untracked (adopted / orphan-sweep) pid: SIGTERM, wait up to
 * `graceMs` for /proc disappearance, then SIGKILL and wait up to 1s more.
 */
export async function killPidGracefully(pid: number, graceMs = GRACE_MS): Promise<void> {
  if (!pidAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // already gone
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await sleep(50);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  const killDeadline = Date.now() + 1000;
  while (Date.now() < killDeadline) {
    if (!pidAlive(pid)) return;
    await sleep(50);
  }
}

export interface ReconcileCounts {
  adopted: number;
  relaunched: number;
  leftStopped: number;
  /** Dead/mismatched rows NOT relaunched (failed or stopped), with reasons logged per row. */
  notAdopted: number;
}

export class Supervisor {
  private registry = new Map<number, string>(); // pid -> dbId (spawned + adopted)
  private children = new Map<string, import("node:child_process").ChildProcess>(); // dbId -> child (this boot's spawns)
  /** dbId -> pid for processes adopted at boot (no ChildProcess handle exists). */
  private adoptedPids = new Map<string, number>();
  private locks = new Map<string, Promise<unknown>>(); // dbId -> lifecycle mutex tail
  private shuttingDown = false;
  private deps: SupervisorDeps;
  private allocator: ReturnType<typeof createPortAllocator>;

  constructor(deps: SupervisorDeps) {
    this.deps = deps;
    this.allocator = createPortAllocator(deps.config, {
      persistedInUse: () => {
        const set = new Set<number>();
        for (const db of deps.databases.list()) {
          if (db.port) set.add(db.port);
          if (db.grpc_port) set.add(db.grpc_port);
        }
        return set;
      },
    });
  }

  /** Allocator exposed so the API layer can reserve the pair before create. */
  get portAllocator() {
    return this.allocator;
  }

  /** Serialize start/stop/delete per dbId: lifecycle mutations for one
   *  database can interleave only at well-defined boundaries. */
  private withLock<T>(dbId: string, fn: () => Promise<T>): Promise<T> {
    const run = this.locks.get(dbId)?.then(fn, fn) ?? fn();
    this.locks.set(
      dbId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    // Drop the entry once the tail settles so the map never grows with every
    // dbId ever touched (a database delete leaves no stale lock behind).
    void run.finally(() => {
      if (this.locks.get(dbId) === run) this.locks.delete(dbId);
    });
    return run;
  }

  private persistRuntime(
    dbId: string,
    facts: { pid?: number | null; start_time?: number | null; sqld_version?: string | null; status?: DatabaseStatusValue; port?: number | null; grpc_port?: number | null },
  ) {
    this.deps.databases.updateRuntime(dbId, facts);
  }

  /**
   * Row-status guard for death handlers: a death is only "crashed" if the row
   * still claims a live status. Intentional kills (stop/delete/shutdown) and
   * failed launches must not be downgraded or overwritten by the exit event.
   */
  private markCrashedIfLive(dbId: string) {
    const row = this.deps.databases.getById(dbId);
    if (!row) return;
    if (row.status !== "running" && row.status !== "starting") return;
    // A crashed row must not keep a stale pid/start_time: a recycled pid would
    // otherwise be misattributed to this row by the sampler and the API would
    // expose a dead pid until someone relaunches. The pid-reuse guard at boot
    // still works because start_time goes NULL (mismatch → not adopted).
    this.deps.databases.clearRuntime(dbId);
    this.persistRuntime(dbId, { status: "crashed" });
    console.error(`[crash] db ${row.slug} (${dbId}) sqld exited unexpectedly`);
  }

  /** Attach an exit handler to a freshly spawned child, recording it. */
  adoptChild(dbId: string, child: import("node:child_process").ChildProcess, pid: number) {
    this.registry.set(pid, dbId);
    this.children.set(dbId, child);
    child.on("exit", (code, signal) => {
      this.registry.delete(pid);
      this.children.delete(dbId);
      if (this.shuttingDown) return;
      if (code !== 0 || signal != null) {
        console.error(`[crash] dbId=${dbId} sqld exited code=${code} signal=${signal ?? "none"}`);
      }
      this.markCrashedIfLive(dbId);
    });
  }

  /**
   * Launch (or relaunch) a database's sqld process. Serialized per dbId.
   *
   * The child is registered and its pid/start_time persisted SYNCHRONOUSLY at
   * spawn (via the launcher's onSpawn hook) — before the readiness wait — so
   * a crash mid-launch leaves a tracked, exit-watched process instead of an
   * orphan. Returns alreadyRunning instead of double-spawning.
   */
  async startDatabase(
    dbId: string,
    opts: { port: number; grpcPort: number; dataDir: string },
  ): Promise<{ ok: boolean; error?: string; stderrTail?: string; pid?: number; alreadyRunning?: boolean }> {
    return this.withLock(dbId, async () => this.startDatabaseLocked(dbId, opts));
  }

  private async startDatabaseLocked(
    dbId: string,
    opts: { port: number; grpcPort: number; dataDir: string },
  ): Promise<{ ok: boolean; error?: string; stderrTail?: string; pid?: number; alreadyRunning?: boolean }> {
    const row = this.deps.databases.getById(dbId);
    if (!row) return { ok: false, error: "database row no longer exists" };
    if (row.status === "deleting") return { ok: false, error: "database is being deleted" };

    // Already served by a tracked process (spawned this boot or adopted)?
    const child = this.children.get(dbId);
    if (child && child.exitCode == null) return { ok: true, alreadyRunning: true, pid: child.pid };
    const adoptedPid = this.adoptedPids.get(dbId);
    if (adoptedPid != null && pidAlive(adoptedPid)) return { ok: true, alreadyRunning: true, pid: adoptedPid };
    // (A stale `running` row with neither tracked handle falls through: the
    // launch below self-heals it.)

    if (!isInside(this.deps.config.dataRoot, opts.dataDir)) {
      return { ok: false, error: `data dir ${opts.dataDir} escapes the data root — refusing to launch` };
    }

    // Per-database signing key: this DB's sqld sees ONLY this DB's pub file.
    const { pubFile } = await ensureDbKey(this.deps.config.dataRoot, dbId);

    const res: LaunchResult = await launchSqld(
      { config: this.deps.config },
      { dataDir: opts.dataDir, port: opts.port, grpcPort: opts.grpcPort, authPubFile: pubFile },
      {
        onSpawn: (child2, pid) => {
          // Crash-atomic registration: track + persist BEFORE the readiness
          // wait so the exit handler is always attached and the orphan sweep
          // always recognizes this process as ours.
          this.adoptChild(dbId, child2, pid);
          this.persistRuntime(dbId, {
            pid,
            start_time: procStartEpochMs(pid) || Date.now(),
            status: "starting",
            port: opts.port,
            grpc_port: opts.grpcPort,
          });
        },
      },
    );

    if (!res.ok || !res.pid || !res.child) {
      // The launcher already reaped the failed child (its exit handler fired,
      // removing it from the maps). Persist the failure + the diagnostic tail.
      this.deps.databases.updateStatus(dbId, "failed");
      const reason = [res.error, res.stderrTail?.trim()].filter(Boolean).join(" — stderr: ");
      this.deps.databases.setFailedReason(dbId, reason || "sqld failed to launch");
      this.deps.databases.clearRuntime(dbId);
      console.error(`[start] dbId=${dbId} failed: ${res.error}${res.stderrTail ? ` | stderr: ${res.stderrTail.trim().slice(-400)}` : ""}`);
      return { ok: false, error: res.error, stderrTail: res.stderrTail };
    }

    this.deps.databases.setFailedReason(dbId, null);
    this.persistRuntime(dbId, { status: "running", sqld_version: res.sqldVersionAtLaunch });
    return { ok: true, pid: res.pid };
  }

  /**
   * Stop a database's process (spawned OR adopted), leaving the data dir
   * intact. Serialized per dbId with start/delete.
   */
  async stopDatabase(dbId: string): Promise<void> {
    await this.withLock(dbId, async () => {
      const row = this.deps.databases.getById(dbId);
      if (row?.status === "deleting") return;
      const child = this.children.get(dbId);
      if (child && child.exitCode == null) {
        await terminateGracefully(child, GRACE_MS);
      }
      const adoptedPid = this.adoptedPids.get(dbId);
      if (adoptedPid != null && pidAlive(adoptedPid)) {
        await killPidGracefully(adoptedPid, GRACE_MS);
      }
      this.adoptedPids.delete(dbId);
      this.children.delete(dbId);
      this.persistRuntime(dbId, { status: "stopped" });
      // clear the (coalesced) pid/start_time so a stopped DB exposes no stale pid.
      this.deps.databases.clearRuntime(dbId);
    });
  }

  /**
   * Terminate every process tracking this database — spawned child or adopted
   * pid — and await its death. DELETE routes call this BEFORE rm -rf of the
   * data dir (an adopted process must never be deleting-while-writing).
   * Serialized per dbId with start/stop.
   */
  async killByDbId(dbId: string): Promise<void> {
    await this.withLock(dbId, async () => {
      const child = this.children.get(dbId);
      if (child && child.exitCode == null) {
        await terminateGracefully(child, GRACE_MS);
      }
      const adoptedPid = this.adoptedPids.get(dbId);
      if (adoptedPid != null && pidAlive(adoptedPid)) {
        await killPidGracefully(adoptedPid, GRACE_MS);
      }
      this.registry.delete(adoptedPid ?? -1);
      this.adoptedPids.delete(dbId);
      this.children.delete(dbId);
    });
  }

  /** Boot reconciliation (AC-E3/E9/E10). */
  async reconcile(): Promise<ReconcileCounts> {
    const counts: ReconcileCounts = { adopted: 0, relaunched: 0, leftStopped: 0, notAdopted: 0 };
    const dbRows = this.deps.databases.list();
    const alive = livePids();

    for (const row of dbRows) {
      // Reserve persisted ports in-memory so allocation doesn't collide.
      if (row.port) this.allocator.reserve([row.port]);
      if (row.grpc_port) this.allocator.reserve([row.grpc_port]);

      // A crashed row is treated like failed: it is NOT "as-is" — if its owner
      // set auto_start=1, the operator asked for it to come back, and a crash
      // observed by this control plane is the same dead-process state as one
      // that happened while we were down (which the running/starting branch
      // below already relaunches). stopped/deleting are the only honest
      // leave-as-is states.
      const shouldTrack = row.status === "running" || row.status === "starting" || row.status === "failed" || row.status === "crashed";
      if (!shouldTrack) {
        // stopped / deleting: leave as-is (no spawn, data intact).
        if (row.status === "stopped") counts.leftStopped++;
        continue;
      }

      // pidAlive additionally rejects zombies (state Z), so a reparented zombie
      // is never adopted even for a tick — it falls through to relaunch/stopped.
      if (row.pid && alive.has(row.pid) && row.start_time && pidAlive(row.pid)) {
        // Adopt only if the /proc start time matches the persisted start_time.
        const liveStart = procStartEpochMs(row.pid);
        if (liveStart === row.start_time) {
          // CRITICAL: register the pid BEFORE the orphan sweep runs (it skips
          // registered pids) and before watchAdopted maps death -> dbId.
          this.registry.set(row.pid, row.id);
          this.adoptedPids.set(row.id, row.pid);
          counts.adopted++;
          // Normalize a stale status: a live adopted process IS running.
          if (row.status !== "running") this.persistRuntime(row.id, { status: "running" });
          console.log(`[boot] adopted ${row.slug} pid=${row.pid} port=${row.port ?? "?"}`);
          this.watchAdopted(row.pid, row.id);
          continue;
        }
        console.log(`[boot] ${row.slug}: pid ${row.pid} alive but start_time mismatch (pid reuse) — treating as dead`);
      }

      // Not adoptable: dead, mismatched, or no pid.
      const relaunch = row.auto_start === 1;
      if (relaunch && row.port && row.grpc_port && row.data_dir) {
        // Double-bind guard: if an untracked process still holds the http port
        // (e.g. a sqld orphaned by a crashed prior boot), relaunching would
        // just fail-bind and mark this DB failed while the orphan keeps
        // serving. Report failed with a hint; the sweep below (or a restart)
        // clears the orphan, then `start` succeeds.
        if (await portBound(row.port)) {
          const reason = `port ${row.port} is already bound by an untracked process — it will be swept at boot; press Start once boot completes`;
          this.deps.databases.updateStatus(row.id, "failed");
          this.deps.databases.setFailedReason(row.id, reason);
          console.log(`[boot] ${row.slug}: ${reason}`);
          counts.notAdopted++;
          continue;
        }
        const r = await this.startDatabase(row.id, { port: row.port, grpcPort: row.grpc_port, dataDir: row.data_dir });
        if (r.ok) {
          counts.relaunched++;
          console.log(`[boot] relaunched ${row.slug} pid=${r.pid} port=${row.port}`);
        } else {
          this.deps.databases.updateStatus(row.id, "failed");
          console.log(`[boot] ${row.slug}: relaunch failed: ${r.error}`);
          counts.notAdopted++;
        }
      } else {
        const status: DatabaseStatusValue = row.auto_start === 1 && !row.port ? "failed" : "stopped";
        this.persistRuntime(row.id, { status });
        const why = row.auto_start === 1 && !row.port ? "auto_start but no persisted ports" : "auto_start=0";
        console.log(`[boot] ${row.slug}: not adoptable (${why}) — marked ${status}`);
        counts.notAdopted++;
      }
    }
    return counts;
  }

  /** Watch an adopted (pre-existing, orphaned) sqld process: poll /proc until it
   *  disappears, then mark the DB crashed. No auto-restart in v1. */
  private watchAdopted(pid: number, dbId: string) {
    const timer = setInterval(() => {
      if (this.shuttingDown) {
        clearInterval(timer);
        return;
      }
      if (!pidAlive(pid)) {
        clearInterval(timer);
        this.registry.delete(pid);
        // Only still-watch if this dbId is still the adoptee (stop/delete may
        // have replaced or removed it).
        if (this.adoptedPids.get(dbId) === pid) this.adoptedPids.delete(dbId);
        this.markCrashedIfLive(dbId);
      }
    }, 2000);
    // Keep the timer alive across its own callback.
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Orphan sweep (AC-E4). A process is killed only if EVERY check passes:
   *   1. pid not tracked in the registry (adopted pids are registered before
   *      the sweep runs, so live databases are never swept);
   *   2. /proc/<pid>/exe resolves to the configured sqld binary (no argv
   *      substring guessing — a decoy or an unrelated tool carrying the data
   *      root in its arguments is ignored);
   *   3. its `--db-path` argument value resolves strictly under THIS data root
   *      (a second sqlitend instance whose root path merely contains ours as a
   *      substring is ignored).
   * TERM first, 1s grace, then KILL survivors.
   */
  async sweepOrphans(): Promise<number> {
    const root = path.resolve(this.deps.config.dataRoot);
    let sqldReal = "";
    try {
      sqldReal = realpathSync(this.deps.config.sqldPath);
    } catch {
      return 0; // binary absent — nothing we spawned can be out there
    }

    let entries: string[] = [];
    try {
      entries = readdirSync("/proc");
    } catch {
      return 0;
    }

    const termed: number[] = [];
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (pid === process.pid) continue;
      if (this.registry.has(pid)) continue;

      // exe check (strip the kernel's " (deleted)" suffix).
      let exe = "";
      try {
        exe = readlinkSync(`/proc/${pid}/exe`);
      } catch {
        continue;
      }
      if (exe.replace(/ \(deleted\)$/, "") !== sqldReal) continue;

      // argv check: "--db-path" followed by a path strictly under the root.
      let argv: string[] = [];
      try {
        argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((s) => s.length > 0);
      } catch {
        continue;
      }
      const i = argv.indexOf("--db-path");
      if (i < 0) continue;
      const dbPathArg = argv[i + 1];
      if (dbPathArg === undefined) continue;
      if (!isInside(root, dbPathArg)) continue;

      try {
        process.kill(pid, "SIGTERM");
        termed.push(pid);
      } catch {
        /* already gone */
      }
    }

    if (termed.length === 0) return 0;
    // TERM→KILL escalation: a sqld ignoring TERM must not linger holding a
    // data-dir lock or port.
    await sleep(SWEEP_TERM_GRACE_MS);
    for (const pid of termed) {
      if (pidAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    return termed.length;
  }

  /**
   * Stop every managed process — spawned children AND adopted pids — and await
   * their death (AC-E5: after shutdown no sqld process remains).
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const jobs: Promise<void>[] = [];
    for (const c of this.children.values()) {
      if (c.exitCode == null && c.signalCode == null) jobs.push(terminateGracefully(c, GRACE_MS));
    }
    for (const [dbId, pid] of this.adoptedPids) {
      if (pidAlive(pid)) {
        jobs.push(
          killPidGracefully(pid, GRACE_MS).then(() => {
            console.log(`[shutdown] terminated adopted db ${dbId} (pid ${pid})`);
          }),
        );
      }
    }
    await Promise.all(jobs);
    this.children.clear();
    this.adoptedPids.clear();
    this.registry.clear();
  }

  get trackedDbIds(): string[] {
    return [...new Set([...this.children.keys(), ...this.adoptedPids.keys()])];
  }
  get isShuttingDown() {
    return this.shuttingDown;
  }
}

export async function terminateGracefully(
  child: import("node:child_process").ChildProcess,
  graceMs: number,
): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGTERM");
  const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const timedOut = await Promise.race([
    done.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), graceMs)),
  ]);
  if (timedOut && child.exitCode == null) {
    child.kill("SIGKILL");
    await Promise.race([new Promise<void>((r) => child.once("exit", () => r())), new Promise((r) => setTimeout(r, 1000))]);
  }
}

/** Helper to spawn a decoy for orphan-sweep tests. */
export function spawnDecoy(cmdline: string, dataRootMarker: string): import("node:child_process").ChildProcess {
  // A long-lived process whose argv contains the data root marker. We use
  // `sleep` with a fake arg that won't be interpreted — argv carries the marker.
  return spawn(process.platform === "linux" ? "/bin/sleep" : "sleep", ["300", dataRootMarker], {
    detached: false,
  });
}
