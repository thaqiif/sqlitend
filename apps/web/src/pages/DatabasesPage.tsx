import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Database, Metrics, Workspace } from "@sqlitend/shared";
import { api } from "../api/client";
import { CreateDatabaseDialog } from "../components/CreateDatabaseDialog";
import { CreateWorkspaceDialog } from "../components/CreateWorkspaceDialog";
import { Modal } from "../components/Modal";

const POLL_MS = 5000;

interface Props {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onOpenDatabase: (id: string) => void;
  onCreateWorkspace: (name: string) => Promise<void>;
  onDeleteWorkspace: (id: string) => Promise<void>;
}

type PendingDelete =
  | { kind: "workspace"; id: string; name: string }
  | { kind: "database"; id: string; name: string };

interface MiniMetricProps {
  label: string;
  value: string;
}

function MiniMetric({ label, value }: MiniMetricProps) {
  return (
    <div className="mini-metric">
      <span className="mini-metric-label">{label}</span>
      <span className="mini-metric-value">{value}</span>
    </div>
  );
}

export function DatabasesPage({
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  onOpenDatabase,
  onCreateWorkspace,
  onDeleteWorkspace,
}: Props) {
  const [databases, setDatabases] = useState<Database[]>([]);
  const [metrics, setMetrics] = useState<Record<string, Metrics>>({});
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [showCreateDatabase, setShowCreateDatabase] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  // The live workspace selection, read by the async `load` after each await so a
  // stale poll (started for workspace A) never renders into workspace B's heading.
  // busyRef is the workspace id currently being polled (null = idle): only the
  // SAME workspace's in-flight poll is skipped, so a workspace switch mid-poll
  // proceeds immediately instead of starving under the stale request.
  const busyRef = useRef<string | null>(null);
  const workspaceIdRef = useRef(selectedWorkspaceId);
  useEffect(() => {
    workspaceIdRef.current = selectedWorkspaceId;
  }, [selectedWorkspaceId]);

  const load = useCallback(
    async (force = false) => {
      const wsId = selectedWorkspaceId;
      if (!wsId) {
        setDatabases([]);
        setMetrics({});
        setLoading(false);
        return;
      }
      if (busyRef.current === wsId && !force) return;
      busyRef.current = wsId;
      try {
        const dbs = await api.listDatabases(wsId);
        if (workspaceIdRef.current !== wsId) return; // stale — a newer load owns the UI
        setDatabases(dbs);
        setListError(null);
        // Fetch live per-database metrics for the inline CPU/memory chips.
        const entries = await Promise.all(
          dbs.map(async (db) => {
            try {
              return [db.id, await api.getMetrics(db.id)] as const;
            } catch {
              return null;
            }
          }),
        );
        if (workspaceIdRef.current !== wsId) return;
        const map: Record<string, Metrics> = {};
        for (const e of entries) {
          if (e) map[e[0]] = e[1];
        }
        setMetrics(map);
      } catch (err) {
        if (workspaceIdRef.current !== wsId) return;
        setListError(err instanceof Error ? err.message : "Failed to load databases");
      } finally {
        // Only the poll that OWNS the current workspace may clear the flag and
        // `loading` — a stale poll's finally must not flip the UI to the empty
        // state (or a stuck loader) under the new workspace's heading.
        if (busyRef.current === wsId) {
          busyRef.current = null;
          setLoading(false);
        }
      }
    },
    [selectedWorkspaceId],
  );

  // Reset local card state whenever the active workspace changes.
  useEffect(() => {
    setDatabases([]);
    setMetrics({});
    setListError(null);
    setLoading(true);
  }, [selectedWorkspaceId]);

  // Initial load + 5s list/metrics polling.
  useEffect(() => {
    load();
    const t = setInterval(() => load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function handleCreateDatabase(name: string) {
    if (!selectedWorkspaceId) throw new Error("Select a workspace first");
    await api.createDatabase(selectedWorkspaceId, { name });
    await load(true);
  }

  async function handleDeleteDatabase(id: string) {
    await api.deleteDatabase(id);
    setPendingDelete(null);
    try {
      await load(true);
    } catch (err) {
      // The modal is already closed; surface a refresh failure via the banner so
      // it isn't silently swallowed (the deleted DB would otherwise linger).
      setListError(err instanceof Error ? err.message : "Failed to refresh after delete");
    }
  }

  async function handleConfirmDelete() {
    if (!pendingDelete) return;
    if (pendingDelete.kind === "workspace") {
      await onDeleteWorkspace(pendingDelete.id);
      setPendingDelete(null);
    } else {
      await handleDeleteDatabase(pendingDelete.id);
    }
  }

  // The backend binds sqlitend to 127.0.0.1 and exposes 127.0.0.1 URLs; show the
  // same host on cards so the value always matches what the client will use.
  const dbHost = (db: Database) => (db.port != null ? `127.0.0.1:${db.port}` : null);

  return (
    <div className="page-layout">
      <aside className="sidebar" aria-label="Workspaces">
        <div className="sidebar-header">
          <span className="sidebar-title">Workspaces</span>
          <button
            type="button"
            className="btn ghost small"
            aria-label="Create workspace"
            onClick={() => setShowCreateWorkspace(true)}
          >
            + New
          </button>
        </div>
        <nav className="workspace-list">
          {workspaces.length === 0 ? (
            <p className="muted sidebar-empty">
              No workspaces yet.
              <button
                type="button"
                className="btn primary small"
                onClick={() => setShowCreateWorkspace(true)}
              >
                Create one
              </button>
            </p>
          ) : (
            workspaces.map((w) => {
              const active = w.id === selectedWorkspaceId;
              return (
                <div key={w.id} className={`workspace-row${active ? " active" : ""}`}>
                  <button
                    type="button"
                    className="workspace-btn"
                    onClick={() => onSelectWorkspace(w.id)}
                  >
                    <span className="workspace-name">{w.name}</span>
                    <span className="workspace-slug">{w.slug}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    aria-label={`Delete workspace ${w.name}`}
                    onClick={() =>
                      setPendingDelete({ kind: "workspace", id: w.id, name: w.name })
                    }
                  >
                    ×
                  </button>
                </div>
              );
            })
          )}
        </nav>
      </aside>

      <main className="content">
        <div className="content-header">
          <h2>
            {workspaces.find((w) => w.id === selectedWorkspaceId)?.name ?? "Databases"}
          </h2>
          <button
            type="button"
            className="btn primary"
            disabled={!selectedWorkspaceId}
            onClick={() => setShowCreateDatabase(true)}
          >
            + New database
          </button>
        </div>

        {/* A transient poll failure must not hide the databases we already have;
            keep it as a banner above the grid, not a replacement for it. */}
        {listError && databases.length > 0 && (
          <p className="list-banner error" role="alert">{listError}</p>
        )}

        {loading && databases.length === 0 ? (
          <p className="muted">Loading databases…</p>
        ) : databases.length === 0 ? (
          listError ? (
            <p className="error" role="alert">{listError}</p>
          ) : (
            <div className="empty">
              <p>No databases in this workspace.</p>
              <button
                type="button"
                className="btn primary"
                onClick={() => setShowCreateDatabase(true)}
              >
                Create your first database
              </button>
            </div>
          )
        ) : (
          <section className="db-grid" aria-label="Databases">
            {databases.map((db) => {
              const m = metrics[db.id];
              return (
                <article key={db.id} className="db-card">
                  <header className="db-card-header">
                    <button
                      type="button"
                      className="db-card-link"
                      onClick={() => onOpenDatabase(db.id)}
                    >
                      <span className="db-card-title">
                        <h3>{db.name}</h3>
                        <span className="db-slug">{db.slug}</span>
                      </span>
                    </button>
                    <span className={`status-badge status-${db.status}`}>{db.status}</span>
                  </header>
                  <div className="db-meta">
                    <span>{dbHost(db) ?? "no port"}</span>
                    <span>{db.sqldVersion ? `sqld ${db.sqldVersion}` : "—"}</span>
                  </div>
                  <div className="db-card-metrics">
                    <MiniMetric
                      label="CPU"
                      value={
                        m == null || m.cpuPct == null ? "—" : `${m.cpuPct.toFixed(1)}%`
                      }
                    />
                    <MiniMetric
                      label="Mem"
                      value={
                        m == null
                          ? "—"
                          : `${Math.max(0, Math.round(m.memoryBytes / 1048576))} MB`
                      }
                    />
                  </div>
                  <button
                    type="button"
                    className="icon-btn danger db-delete"
                    aria-label={`Delete database ${db.name}`}
                    onClick={() =>
                      setPendingDelete({ kind: "database", id: db.id, name: db.name })
                    }
                  >
                    ×
                  </button>
                </article>
              );
            })}
          </section>
        )}
      </main>

      <CreateWorkspaceDialog
        open={showCreateWorkspace}
        onClose={() => setShowCreateWorkspace(false)}
        onSubmit={onCreateWorkspace}
      />
      <CreateDatabaseDialog
        open={showCreateDatabase}
        onClose={() => setShowCreateDatabase(false)}
        onSubmit={handleCreateDatabase}
      />
      <ConfirmDeleteDialog
        pending={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}

function ConfirmDeleteDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingDelete | null;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!pending) return null;

  const match = typed.trim() === pending.name;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!match || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal ariaLabel="Confirm delete" onClose={onCancel}>
      <h2 className="modal-title danger-title">
        Delete {pending.kind} “{pending.name}”
      </h2>
      {pending.kind === "workspace" && (
        <p className="hint">A workspace with databases cannot be deleted — remove its databases first.</p>
      )}
      <p className="hint">
        This cannot be undone. Type the exact name <strong>{pending.name}</strong> to
        confirm.
      </p>
      <form onSubmit={handleSubmit}>
        <label className="field">
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={pending.name}
            disabled={busy}
          />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn danger" disabled={busy || !match}>
            Delete
          </button>
        </div>
      </form>
    </Modal>
  );
}