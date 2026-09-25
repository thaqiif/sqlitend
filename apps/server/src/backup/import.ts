// ---------------------------------------------------------------------------
// Import an existing SQLite file (e.g. a database migrated from another sqld
// host) as a NEW sqlitend database.
//
// The operator drops ONE self-contained file into <dataRoot>/imports/ (made
// with `sqlite3 src ".backup out"`, `VACUUM INTO`, or `litestream restore`),
// owned by the service user. The API names it by basename only, so no request
// can make the server read an arbitrary path.
//
// The import never opens the source with SQLite (the listing only opens it
// read-only): its bytes are copied into the staging dir first, and everything else works on that private copy. A -wal, -shm or
// -journal next to the source is REFUSED rather than merged: nothing ties a
// WAL to its database, so a stale or foreign one would silently replay wrong
// pages. The copy is compacted with `VACUUM INTO` and verified like a restore
// (PRAGMA integrity_check) before sqld ever sees it. After start-up the usual
// hooks run (replication, DNS).
// ---------------------------------------------------------------------------

import { Database as SQLite } from "bun:sqlite";
import { copyFileSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { DatabaseRow, DatabasesRepo } from "../db/repos/databases.ts";
import { sqldDataFile } from "./replicator.ts";
import { verifySqliteFile } from "./restore.ts";

export const IMPORT_DIR = "imports";

/** Basename only: letters, digits, dot, dash, underscore; no leading dot. */
const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,200}$/;
const SIDE_FILES = ["-wal", "-shm", "-journal"];

export interface ImportDeps {
  dataRoot: string;
  databases: DatabasesRepo;
  verify?: (file: string) => string | null;
  startDatabase: (row: DatabaseRow) => Promise<{ ok: boolean; error?: string }>;
  afterStart?: (row: DatabaseRow) => Promise<void>;
  log?: (m: string) => void;
}

export interface ImportFileInfo {
  file: string;
  bytes: number;
  tables: number;
}

export class ImportService {
  private readonly jobs = new Map<string, Promise<void>>();

  constructor(private readonly d: ImportDeps) {}

  get dir(): string {
    return path.join(this.d.dataRoot, IMPORT_DIR);
  }

  /** Create the drop directory (0700, owned by the service user). */
  ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /**
   * Resolve a request's file name to a readable regular file inside the
   * import dir, or return why not. Symlinks are refused (they could point
   * anywhere the service user can read).
   */
  resolve(name: string): { path: string } | { error: string } {
    if (!SAFE_NAME.test(name)) return { error: "file must be a plain file name inside the import directory" };
    if (SIDE_FILES.some((x) => name.endsWith(x))) return { error: "that is a SQLite side file, not a database" };
    const p = path.join(this.dir, name);
    if (path.dirname(p) !== this.dir) return { error: "file must be inside the import directory" };
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return { error: `no such file in ${this.dir}: ${name}` };
    }
    if (st.isSymbolicLink() || !st.isFile()) return { error: "file must be a regular file (no symlinks)" };
    for (const x of SIDE_FILES) {
      if (lstatSafe(p + x)) {
        return { error: `${name}${x} sits next to it: import a self-contained file (sqlite3 src ".backup out", or checkpoint and copy only the main file)` };
      }
    }
    return { path: p };
  }

  /** Files waiting in the import dir that open as SQLite (for the UI/CLI). */
  list(): ImportFileInfo[] {
    if (!existsSync(this.dir)) return [];
    const out: ImportFileInfo[] = [];
    for (const f of new Bun.Glob("*").scanSync({ cwd: this.dir, onlyFiles: true })) {
      if (SIDE_FILES.some((x) => f.endsWith(x))) continue;
      const r = this.resolve(f);
      if ("error" in r) continue;
      let db: SQLite | null = null;
      try {
        db = new SQLite(r.path, { readonly: true });
        const t = db.query("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number };
        out.push({ file: f, bytes: lstatSync(r.path).size, tables: t.n });
      } catch {
        /* not a SQLite file: not offered */
      } finally {
        db?.close();
      }
    }
    return out.sort((a, b) => a.file.localeCompare(b.file));
  }

  isImporting(dbId: string): boolean {
    return this.jobs.has(dbId);
  }

  async settled(dbId: string): Promise<void> {
    await this.jobs.get(dbId);
  }

  /** Import `sourcePath` (already resolved) into `target` (status "restoring", auto_start 0). */
  start(sourcePath: string, target: DatabaseRow): void {
    const job = this.run(sourcePath, target).finally(() => this.jobs.delete(target.id));
    this.jobs.set(target.id, job);
  }

  private async run(sourcePath: string, target: DatabaseRow): Promise<void> {
    const log = this.d.log ?? ((m: string) => console.log(m));
    const src = path.basename(sourcePath);
    const staging = `${target.data_dir}.import`;
    const tmpFile = path.join(staging, "data");
    const fail = (why: string) => {
      rmSync(staging, { recursive: true, force: true });
      this.d.databases.updateStatus(target.id, "failed");
      this.d.databases.setFailedReason(target.id, `import failed: ${why}`.slice(0, 2000));
      log(`[import] ${target.slug} from ${src}: FAILED: ${why.split("\n")[0]}`);
    };
    try {
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      // Re-check at use time (the request-time check could be stale), then copy
      // the bytes: SQLite only ever opens our private copy.
      const again = this.resolve(src);
      if ("error" in again) return fail(again.error);
      const raw = path.join(staging, "source");
      copyFileSync(sourcePath, raw);
      const h = createHash("sha256");
      for await (const chunk of Bun.file(raw).stream()) h.update(chunk);
      const sha256 = h.digest("hex");
      log(`[import] ${target.slug} ← ${src}: ${lstatSync(raw).size} bytes, sha256 ${sha256}`);
      let db: SQLite | null = null;
      try {
        db = new SQLite(raw);
        db.run("VACUUM INTO ?", [tmpFile]);
      } catch (err) {
        return fail(`cannot read ${src} as SQLite: ${(err as Error).message}`);
      } finally {
        db?.close();
      }
      const bad = (this.d.verify ?? verifySqliteFile)(tmpFile);
      if (bad) return fail(bad);

      if (!this.d.databases.getById(target.id)) return fail("target database was deleted during import");
      const finalFile = sqldDataFile(target.data_dir);
      if (existsSync(finalFile)) return fail(`${target.data_dir} already contains a database file; remove it and retry`);
      mkdirSync(path.dirname(finalFile), { recursive: true, mode: 0o700 });
      renameSync(tmpFile, finalFile);
      rmSync(staging, { recursive: true, force: true });

      this.d.databases.setAutoStart(target.id, 1);
      this.d.databases.updateStatus(target.id, "starting");
      const started = await this.d.startDatabase(this.d.databases.getById(target.id)!);
      if (!started.ok) return fail(`imported and verified, but sqld did not start: ${started.error ?? "unknown"}`);
      try {
        await this.d.afterStart?.(this.d.databases.getById(target.id)!);
      } catch (err) {
        log(`[import] ${target.slug}: post-start step failed (database is running): ${(err as Error).message}`);
      }
      log(`[import] ${target.slug} ← ${src}: done (verified, running)`);
    } catch (err) {
      fail((err as Error).message);
    }
  }
}

function lstatSafe(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
