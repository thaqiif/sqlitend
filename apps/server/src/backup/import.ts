// ---------------------------------------------------------------------------
// Import an existing SQLite file (e.g. a database migrated from another sqld
// host) as a NEW sqlitend database.
//
// The operator drops the file into <dataRoot>/imports/ (root copies it there
// and chowns it to the service user); the API names it by basename only, so
// no request can make the server read an arbitrary path. The copy is taken
// with `VACUUM INTO` — a consistent, WAL-merged, compacted snapshot even if a
// -wal file sits next to the source — then verified exactly like a restore
// (PRAGMA integrity_check) before sqld ever sees it. The source is never
// modified. After start-up the usual hooks run (replication, DNS).
// ---------------------------------------------------------------------------

import { Database as SQLite } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import type { DatabaseRow, DatabasesRepo } from "../db/repos/databases.ts";
import { sqldDataFile } from "./replicator.ts";
import { verifySqliteFile } from "./restore.ts";

export const IMPORT_DIR = "imports";

/** Basename only: letters, digits, dot, dash, underscore; no leading dot. */
const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,200}$/;

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
    const p = path.join(this.dir, name);
    if (path.dirname(p) !== this.dir) return { error: "file must be inside the import directory" };
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return { error: `no such file in ${this.dir}: ${name}` };
    }
    if (st.isSymbolicLink() || !st.isFile()) return { error: "file must be a regular file (no symlinks)" };
    return { path: p };
  }

  /** Files waiting in the import dir that open as SQLite (for the UI/CLI). */
  list(): ImportFileInfo[] {
    if (!existsSync(this.dir)) return [];
    const out: ImportFileInfo[] = [];
    for (const f of new Bun.Glob("*").scanSync({ cwd: this.dir, onlyFiles: true })) {
      if (f.endsWith("-wal") || f.endsWith("-shm") || f.endsWith("-journal")) continue;
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
      log(`[import] ${target.slug} ← ${src}: copying`);
      let db: SQLite | null = null;
      try {
        // Not readonly: SQLite needs write access to the -shm to read a WAL
        // database; VACUUM INTO never changes the source's content.
        db = new SQLite(sourcePath);
        db.run("VACUUM INTO ?", [tmpFile]);
      } catch (err) {
        return fail(`cannot copy ${src}: ${(err as Error).message}`);
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
