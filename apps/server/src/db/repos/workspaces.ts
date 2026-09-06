import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

/** A row from the `workspaces` table (snake_case columns as stored). */
export interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  created_at: number;
}

export interface CreateWorkspaceInput {
  id: string;
  slug: string;
  name: string;
  createdAt: number;
}

export class WorkspacesRepo {
  constructor(private readonly db: Database) {}

  list(): WorkspaceRow[] {
    return this.db.query("SELECT id, slug, name, created_at FROM workspaces ORDER BY created_at").all() as WorkspaceRow[];
  }

  getById(id: string): WorkspaceRow | null {
    const row = this.db.query("SELECT id, slug, name, created_at FROM workspaces WHERE id = ?").get(id);
    return (row as WorkspaceRow | undefined) ?? null;
  }

  getBySlug(slug: string): WorkspaceRow | null {
    const row = this.db.query("SELECT id, slug, name, created_at FROM workspaces WHERE slug = ?").get(slug);
    return (row as WorkspaceRow | undefined) ?? null;
  }

  /** Insert a workspace. Throws if the slug already exists. */
  create(input: CreateWorkspaceInput): WorkspaceRow {
    const { id, slug, name, createdAt } = input;
    try {
      this.db
        .query("INSERT INTO workspaces(id, slug, name, created_at) VALUES (?, ?, ?, ?)")
        .run(id, slug, name, createdAt);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new Error(`workspace slug "${slug}" already exists`);
      }
      throw err;
    }
    return { id, slug, name, created_at: createdAt };
  }

  delete(id: string): void {
    this.db.query("DELETE FROM workspaces WHERE id = ?").run(id);
  }

  get count(): number {
    const row = this.db.query("SELECT COUNT(*) AS n FROM workspaces").get() as { n: number };
    return Number(row.n);
  }
}

/** Matches bun:sqlite's SQLITE_CONSTRAINT_UNIQUE error without depending on
 *  error metadata shape — the message includes the failing index. */
function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg);
}