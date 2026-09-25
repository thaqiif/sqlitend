// ---------------------------------------------------------------------------
// Restore — bring a database back from its S3 replica AS A NEW DATABASE.
//
// Never in place: the source (existing or deleted) is untouched, and the new
// database gets its own id, signing key, tokens, DNS name and replica path.
// This covers "I dropped a table", "restore yesterday's state beside prod to
// compare", and "bring back a deleted database" with one safe operation.
//
// Job (runs in the background; the row is visible as status "restoring"):
//   1. litestream restore → <data_dir>.restore/data   (optionally -timestamp)
//   2. verify: PRAGMA integrity_check = ok on the restored file
//   3. move into <data_dir>/db.sqlite/dbs/default/data (sqld's layout)
//   4. auto_start=1, start sqld, sync DNS → "running"; replication starts
//      under the new id on the next replicator tick.
// The row stays auto_start=0 until step 4, so a crash mid-restore can never
// come back up as an EMPTY database (boot marks it failed instead).
//
// Manifests: every replicated database gets <prefix>/db/<id>/sqlitend.json
// (id, slug, name, …) so deleted databases can be listed and restored by name.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { Database as SQLite } from "bun:sqlite";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import type { BackupConfig } from "../config.ts";
import type { DatabaseRow, DatabasesRepo } from "../db/repos/databases.ts";
import { replicaPath, sqldDataFile } from "./replicator.ts";

export const MANIFEST = "sqlitend.json";

export interface ReplicaManifest {
  id: string;
  slug: string;
  name: string;
  workspaceId: string;
  createdAt: number;
  updatedAt: number;
}

export interface ReplicaInfo extends Partial<ReplicaManifest> {
  id: string;
  /** Still present in this server's metadata (false = deleted database). */
  exists: boolean;
}

/** Minimal S3 surface used here (Bun.S3Client satisfies it). */
export interface S3Like {
  write(key: string, data: string, opts?: { type?: string }): Promise<unknown>;
  file(key: string): { text(): Promise<string>; exists(): Promise<boolean> };
  list(opts: { prefix: string; delimiter?: string; maxKeys?: number; continuationToken?: string }): Promise<{
    commonPrefixes?: { prefix: string }[];
    contents?: { key: string }[];
    isTruncated?: boolean;
    nextContinuationToken?: string;
  }>;
}

export function s3ClientFor(cfg: BackupConfig): S3Like {
  return new Bun.S3Client({
    endpoint: cfg.endpoint,
    bucket: cfg.bucket,
    region: cfg.region === "auto" ? "auto" : cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    virtualHostedStyle: !cfg.forcePathStyle,
  }) as unknown as S3Like;
}

/** Litestream replica URL with the connection options it needs outside a config file. */
export function litestreamReplicaUrl(cfg: BackupConfig, dbId: string): string {
  const q = new URLSearchParams({ endpoint: cfg.endpoint, region: cfg.region, "force-path-style": String(cfg.forcePathStyle) });
  return `s3://${cfg.bucket}/${replicaPath(cfg, dbId)}?${q}`;
}

export type RunLitestream = (args: string[], timeoutMs: number) => Promise<{ code: number; output: string }>;

export function realRunLitestream(cfg: BackupConfig): RunLitestream {
  return (args, timeoutMs) =>
    new Promise((resolve) => {
      const child = spawn(cfg.litestreamPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? "/",
          LITESTREAM_ACCESS_KEY_ID: cfg.accessKeyId,
          LITESTREAM_SECRET_ACCESS_KEY: cfg.secretAccessKey,
        },
      });
      let output = "";
      const keep = (b: Buffer) => (output = (output + b.toString()).slice(-4000));
      child.stdout?.on("data", keep);
      child.stderr?.on("data", keep);
      // An unreachable store makes litestream retry forever — always bound it.
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: -1, output: e.message });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code: code ?? (signal ? 137 : -1), output: signal === "SIGKILL" ? `timed out after ${timeoutMs / 1000}s\n${output}` : output });
      });
    });
}

export interface LtxFile {
  level: number;
  min_txid: string;
  max_txid: string;
  timestamp: string;
}

/**
 * Point in time → transaction id. Litestream 0.5.16's own `-timestamp` only
 * accepts times inside the span of existing LTX timestamps ("timestamp does
 * not exist" for a time after the last write — the most natural request), so
 * the time is resolved here and restored with `-txid`.
 *
 * Rule: the highest max_txid of any LTX file (any level) written STRICTLY
 * before `at`. A file written at time C only holds transactions committed by
 * C, so this never includes a change after `at`; LTX timestamps have 1 s
 * resolution, hence strict. Returns the earliest restorable time when `at` is
 * before every file.
 *
 * Verified for compacted levels on 0.5.16: a level-1 file covering txids 4-7
 * (L0 stamps 08:46:31-08:46:38) was stamped 08:47:00, i.e. compaction time,
 * never earlier than its newest content — so the rule holds at every level.
 */
export function resolveTxid(files: LtxFile[], at: Date): { txid: string } | { earliest: string | null } {
  const t = at.getTime();
  let best: string | null = null;
  let earliest: number | null = null;
  for (const f of files) {
    const ts = Date.parse(f.timestamp);
    if (!Number.isFinite(ts)) continue;
    // Strictly-before-at from this file needs at > ts, so the earliest restorable instant is ts + 1 s.
    if (earliest === null || ts < earliest) earliest = ts;
    if (ts < t && (best === null || f.max_txid > best)) best = f.max_txid; // fixed-width hex
  }
  if (best) return { txid: best };
  return { earliest: earliest === null ? null : new Date(earliest + 1000).toISOString() };
}

/**
 * Fast preflight before any `litestream restore`: litestream retries an
 * unreachable store FOREVER (verified: still retrying after 90 s), so a store
 * outage would otherwise hang a restore/verify until its hour-long timeout.
 * Lists the replica prefix with a hard time limit; null = OK, else the reason.
 */
export async function preflightReplica(s3: S3Like, cfg: BackupConfig, dbId: string, timeoutMs = 20_000): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const listing = await Promise.race([
      s3.list({ prefix: `${replicaPath(cfg, dbId)}/`, maxKeys: 2 }),
      new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`no answer within ${timeoutMs / 1000}s`)), timeoutMs))),
    ]);
    const keys = (listing.contents ?? []).map((c) => c.key).filter((k) => !k.endsWith(`/${MANIFEST}`));
    return keys.length === 0 && !listing.isTruncated ? "no replica found for this database in the backup store" : null;
  } catch (err) {
    return `backup store unreachable: ${(err as Error).message.slice(0, 200)}`;
  } finally {
    clearTimeout(timer);
  }
}

/** Open read-only and run integrity_check; returns null when OK, else the problem. */
export function verifySqliteFile(file: string): string | null {
  let db: SQLite | null = null;
  try {
    db = new SQLite(file, { readonly: true });
    const rows = db.query("PRAGMA integrity_check").all() as { integrity_check: string }[];
    const bad = rows.map((r) => r.integrity_check).filter((m) => m !== "ok");
    return bad.length ? `integrity_check: ${bad.slice(0, 3).join("; ")}` : null;
  } catch (err) {
    return `cannot open restored file: ${(err as Error).message}`;
  } finally {
    db?.close();
  }
}

export interface RestoreDeps {
  config: BackupConfig;
  databases: DatabasesRepo;
  s3: S3Like;
  run: RunLitestream;
  verify?: (file: string) => string | null;
  /** Start sqld for the restored row (supervisor.startDatabase). */
  startDatabase: (row: DatabaseRow) => Promise<{ ok: boolean; error?: string }>;
  afterStart?: (row: DatabaseRow) => Promise<void>;
  timeoutMs?: number;
  preflightTimeoutMs?: number;
  log?: (m: string) => void;
}

export class RestoreService {
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly manifestsWritten = new Set<string>();

  constructor(private readonly d: RestoreDeps) {}

  /** Idempotent per process: write the manifest once per database. */
  async ensureManifest(row: DatabaseRow): Promise<void> {
    if (this.manifestsWritten.has(row.id)) return;
    const m: ReplicaManifest = { id: row.id, slug: row.slug, name: row.name, workspaceId: row.workspace_id, createdAt: row.created_at, updatedAt: Date.now() };
    await this.d.s3.write(`${replicaPath(this.d.config, row.id)}/${MANIFEST}`, JSON.stringify(m), { type: "application/json" });
    this.manifestsWritten.add(row.id);
  }

  /** Every replica under this server's prefix, deleted databases included. */
  async listReplicas(): Promise<ReplicaInfo[]> {
    const base = `${this.d.config.prefix}/db/`;
    const ids = new Set<string>();
    let continuationToken: string | undefined;
    // With a delimiter, startAfter would re-roll "<id>/…" keys into the same
    // common prefix; continuation tokens page correctly. Dedupe regardless.
    for (let page = 0; page < 1000; page++) {
      const r = await this.d.s3.list({ prefix: base, delimiter: "/", maxKeys: 1000, ...(continuationToken ? { continuationToken } : {}) });
      for (const p of r.commonPrefixes ?? []) {
        const id = p.prefix.slice(base.length).replace(/\/$/, "");
        if (id) ids.add(id);
      }
      if (!r.isTruncated || !r.nextContinuationToken) break;
      continuationToken = r.nextContinuationToken;
    }
    const known = new Set(this.d.databases.list().map((x) => x.id));
    return Promise.all(
      [...ids].map(async (id) => {
        let manifest: Partial<ReplicaManifest> = {};
        try {
          const f = this.d.s3.file(`${base}${id}/${MANIFEST}`);
          if (await f.exists()) manifest = JSON.parse(await f.text()) as ReplicaManifest;
        } catch {
          /* unreadable manifest: still listable by id */
        }
        return { ...manifest, id, exists: known.has(id) };
      }),
    );
  }

  isRestoring(dbId: string): boolean {
    return this.jobs.has(dbId);
  }

  /** Waits for a running job (tests / shutdown). */
  async settled(dbId: string): Promise<void> {
    await this.jobs.get(dbId);
  }

  /**
   * Start restoring `sourceId`'s replica into the already-created `target`
   * row (status "restoring", auto_start 0). Returns immediately.
   */
  start(sourceId: string, target: DatabaseRow, at?: string): void {
    const job = this.run(sourceId, target, at).finally(() => this.jobs.delete(target.id));
    this.jobs.set(target.id, job);
  }

  private async run(sourceId: string, target: DatabaseRow, at?: string): Promise<void> {
    const log = this.d.log ?? ((m: string) => console.log(m));
    const staging = `${target.data_dir}.restore`;
    const tmpFile = path.join(staging, "data");
    const fail = (why: string) => {
      rmSync(staging, { recursive: true, force: true });
      this.d.databases.updateStatus(target.id, "failed");
      this.d.databases.setFailedReason(target.id, `restore failed: ${why}`.slice(0, 2000));
      log(`[restore] ${target.slug} from ${sourceId}: FAILED: ${why.split("\n")[0]}`);
    };
    try {
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      const url = litestreamReplicaUrl(this.d.config, sourceId);
      const pre = await preflightReplica(this.d.s3, this.d.config, sourceId, this.d.preflightTimeoutMs);
      if (pre) return fail(pre);
      let pin: string[] = [];
      if (at) {
        const ls = await this.d.run(["ltx", "-level", "all", "-json", url], 5 * 60_000);
        if (ls.code !== 0) return fail(`could not list backup files: ${ls.output.trim().slice(-500)}`);
        let files: LtxFile[];
        try {
          files = JSON.parse(ls.output) as LtxFile[];
        } catch {
          return fail(`unexpected litestream ltx output: ${ls.output.slice(0, 200)}`);
        }
        const r = resolveTxid(files, new Date(at));
        if ("earliest" in r) {
          return fail(r.earliest ? `${at} is before the earliest available backup (earliest restorable: ${r.earliest})` : "no backup files found for that database");
        }
        pin = ["-txid", r.txid];
        log(`[restore] ${target.slug} ← ${sourceId} @ ${at} → txid ${r.txid}`);
      }
      const args = ["restore", "-o", tmpFile, ...pin, url];
      log(`[restore] ${target.slug} ← ${sourceId}${at ? ` @ ${at}` : ""}: downloading`);
      const r = await this.d.run(args, this.d.timeoutMs ?? 60 * 60_000);
      if (r.code !== 0) return fail(`litestream restore exited ${r.code}: ${r.output.trim().slice(-800)}`);
      if (!(await Bun.file(tmpFile).exists())) return fail("no replica data found for that database/time");

      const bad = (this.d.verify ?? verifySqliteFile)(tmpFile);
      if (bad) return fail(bad);

      if (!this.d.databases.getById(target.id)) return fail("target database was deleted during restore");
      const finalFile = sqldDataFile(target.data_dir);
      // The data dir is ours alone (fresh slug): anything already there is a
      // leftover of an earlier database — never merge with it (a stale -wal
      // would be replayed onto the restored file).
      if (await Bun.file(finalFile).exists()) return fail(`${target.data_dir} already contains a database file; remove it and retry`);
      mkdirSync(path.dirname(finalFile), { recursive: true, mode: 0o700 });
      rmSync(`${finalFile}-wal`, { force: true });
      rmSync(`${finalFile}-shm`, { force: true });
      renameSync(tmpFile, finalFile);
      rmSync(staging, { recursive: true, force: true });

      this.d.databases.setAutoStart(target.id, 1);
      this.d.databases.updateStatus(target.id, "starting"); // hand the row to the supervisor
      const started = await this.d.startDatabase(this.d.databases.getById(target.id)!);
      if (!started.ok) return fail(`restored and verified, but sqld did not start: ${started.error ?? "unknown"}`);
      // sqld is serving from here on: follow-up failures are logged, never "failed".
      try {
        await this.d.afterStart?.(this.d.databases.getById(target.id)!);
      } catch (err) {
        log(`[restore] ${target.slug}: post-start step failed (database is running): ${(err as Error).message}`);
      }
      log(`[restore] ${target.slug} ← ${sourceId}: done (verified, running)`);
    } catch (err) {
      fail((err as Error).message);
    }
  }
}
