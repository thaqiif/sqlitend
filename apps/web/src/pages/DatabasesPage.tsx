import { useCallback, useEffect, useRef, useState } from "react";
import type { BackupStatus, Database, Metrics, MetricsOverviewResponse, Workspace } from "@sqlitend/shared";
import { api } from "../api/client";
import { shortSqldVersion } from "../format";
import { CreateDatabaseDialog } from "../components/CreateDatabaseDialog";
import { CreateWorkspaceDialog } from "../components/CreateWorkspaceDialog";
import { DangerConfirmDialog } from "../components/DangerConfirmDialog";
import { Modal } from "../components/Modal";

const POLL_MS = 5000;

function fmtBytesCompact(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function MiniSparkline({ values, color = "#4f8cff" }: { values: (number | null)[]; color?: string }) {
  const nums = values.map((v) => v ?? 0);
  if (nums.length < 2) return null;
  const max = Math.max(...nums, 1);
  const min = Math.min(...nums, 0);
  const span = Math.max(max - min, 1);
  const w = 110;
  const h = 24;
  const pts = nums
    .map((v, i) => {
      const x = (i / (nums.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} className="sparkline-svg" aria-hidden="true">
      <polyline fill="none" stroke={color} strokeWidth="1.75" points={pts} />
    </svg>
  );
}

interface Props {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onOpenDatabase: (id: string) => void;
  onCreateWorkspace: (name: string) => Promise<void>;
  onDeleteWorkspace: (id: string, confirmSlug: string) => Promise<void>;
  onWorkspacesChanged?: () => Promise<void>;
  publicHost?: string;
  onChanged?: () => void;
}

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
  onWorkspacesChanged,
  publicHost = "127.0.0.1",
  onChanged,
}: Props) {
  const [databases, setDatabases] = useState<Database[]>([]);
  const [metrics, setMetrics] = useState<Record<string, Metrics>>({});
  const [overview, setOverview] = useState<MetricsOverviewResponse | null>(null);
  const [backups, setBackups] = useState<Record<string, BackupStatus>>({});
  const loadBackups = useCallback(
    () =>
      api
        .listBackups()
        .then((rows) => setBackups(Object.fromEntries(rows.map((r) => [r.databaseId, r]))))
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    void loadBackups();
    const t = setInterval(loadBackups, 15_000);
    return () => clearInterval(t);
  }, [loadBackups]);

  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [showCreateDatabase, setShowCreateDatabase] = useState(false);
  const [showWorkspaceSettings, setShowWorkspaceSettings] = useState(false);
  const [showWorkspaceDeleteConfirm, setShowWorkspaceDeleteConfirm] = useState(false);
  const [protectionBusy, setProtectionBusy] = useState(false);

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
        if (workspaceIdRef.current !== wsId) return;
        setDatabases(dbs);
        setListError(null);
        const [entries, ov] = await Promise.all([
          Promise.all(
            dbs.map(async (db) => {
              try {
                return [db.id, await api.getMetrics(db.id)] as const;
              } catch {
                return null;
              }
            }),
          ),
          api.getMetricsOverview().catch(() => null),
        ]);
        if (workspaceIdRef.current !== wsId) return;
        const map: Record<string, Metrics> = {};
        for (const e of entries) {
          if (e) map[e[0]] = e[1];
        }
        setMetrics(map);
        if (ov) setOverview(ov);
      } catch (err) {
        if (workspaceIdRef.current !== wsId) return;
        setListError(err instanceof Error ? err.message : "Failed to load databases");
      } finally {
        if (busyRef.current === wsId) {
          busyRef.current = null;
          setLoading(false);
        }
      }
    },
    [selectedWorkspaceId],
  );

  useEffect(() => {
    setDatabases([]);
    setMetrics({});
    setListError(null);
    setLoading(true);
  }, [selectedWorkspaceId]);

  useEffect(() => {
    load();
    const t = setInterval(() => load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function handleCreateDatabase(name: string) {
    if (!selectedWorkspaceId) throw new Error("Select a workspace first");
    await api.createDatabase(selectedWorkspaceId, { name });
    onChanged?.();
    void loadBackups();
    await load(true);
  }

  const activeWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId) ?? null;

  const handleToggleWorkspaceProtection = async (next: boolean) => {
    if (!activeWorkspace) return;
    setProtectionBusy(true);
    try {
      await api.setWorkspaceProtection(activeWorkspace.id, next);
      await onWorkspacesChanged?.();
    } finally {
      setProtectionBusy(false);
    }
  };

  const dbHost = (db: Database) => (db.port != null ? `${publicHost}:${db.port}` : null);

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
                </div>
              );
            })
          )}
        </nav>
      </aside>

      <main className="content">
        {overview && (
          <section className="system-overview-strip" aria-label="System resource overview">
            <div className="overview-chip">
              <span className="mini-metric-label">Instances</span>
              <strong>
                {overview.totals.runningDbs} running · {overview.totals.stoppedDbs} stopped
                {overview.totals.crashedOrFailedDbs > 0 ? ` · ${overview.totals.crashedOrFailedDbs} faulted` : ""}
              </strong>
            </div>
            <div className="overview-chip">
              <span className="mini-metric-label">Total Disk / WAL</span>
              <strong>
                {fmtBytesCompact(overview.totals.totalDiskBytes)} ({fmtBytesCompact(overview.totals.totalWalBytes)} WAL)
              </strong>
            </div>
            <div className="overview-chip">
              <span className="mini-metric-label">Total RSS</span>
              <strong>{fmtBytesCompact(overview.totals.totalMemoryBytes)}</strong>
            </div>
            <div className="overview-chip">
              <span className="mini-metric-label">Queries</span>
              <strong>
                {overview.totals.totalQueries.toLocaleString()} ({overview.totals.totalErrors} err)
              </strong>
            </div>
          </section>
        )}

        <div className="content-header">
          <div>
            <h2>{activeWorkspace?.name ?? "Databases"}</h2>
            {activeWorkspace && (
              <span className="muted small">
                slug: <code>{activeWorkspace.slug}</code> ·{" "}
                {activeWorkspace.protected ? "🔒 Protected" : "🔓 Unprotected"}
              </span>
            )}
          </div>
          <div className="header-btn-group">
            {activeWorkspace && (
              <button
                type="button"
                className="btn ghost small"
                onClick={() => setShowWorkspaceSettings(true)}
              >
                Workspace Settings
              </button>
            )}
            <button
              type="button"
              className="btn primary"
              disabled={!selectedWorkspaceId}
              onClick={() => setShowCreateDatabase(true)}
            >
              + New database
            </button>
          </div>
        </div>

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
              const summary = overview?.databases[db.id];
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
                        {db.slug !== db.name && <span className="db-slug">{db.slug}</span>}
                      </span>
                    </button>
                    <div className="card-badges-right">
                      {summary && (
                        <span
                          className={`stability-badge stability-pill-${summary.stability.level}`}
                          title={`${summary.stability.label}: ${summary.stability.rule} (${summary.stability.availabilityPct24h}% 24h avail)`}
                        >
                          {summary.stability.label}
                        </span>
                      )}
                      <span className={`status-badge status-${db.status}`}>{db.status}</span>
                    </div>
                  </header>
                  <div className="db-meta">
                    <span className="db-endpoint mono" title={db.publicUrl ?? dbHost(db) ?? undefined}>
                      {db.publicUrl ? db.publicUrl.replace(/^https:\/\//, "") : (dbHost(db) ?? "no port")}
                    </span>
                    {(() => {
                      const v = shortSqldVersion(db.sqldVersion);
                      return v ? <span className="muted">sqld {v}</span> : null;
                    })()}
                  </div>
                  <BackupBadges b={backups[db.id]} />
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
                    <MiniMetric
                      label="Disk"
                      value={m == null ? "—" : fmtBytesCompact(m.diskBytes)}
                    />
                    {summary?.latency.p95Ms != null && (
                      <MiniMetric label="p95" value={`${summary.latency.p95Ms}ms`} />
                    )}
                  </div>
                  {summary && summary.sparkline.memoryBytes.length > 1 && (
                    <div className="card-sparkline-row">
                      <span className="muted small">Mem trend</span>
                      <MiniSparkline values={summary.sparkline.memoryBytes} color="#3fb950" />
                    </div>
                  )}
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

      {/* Workspace Settings & Danger Zone Modal */}
      {showWorkspaceSettings && activeWorkspace && (
        <Modal ariaLabel="Workspace settings" onClose={() => setShowWorkspaceSettings(false)}>
          <h2 className="modal-title">Workspace Settings — {activeWorkspace.name}</h2>
          <p className="muted small">
            Slug: <code>{activeWorkspace.slug}</code>
          </p>

          <div className="danger-zone-box">
            <h3 className="danger-title">Danger Zone</h3>
            <div className="danger-row">
              <div>
                <strong>Delete protection</strong>
                <p className="muted small" style={{ margin: "0.2rem 0 0" }}>
                  When enabled, this workspace cannot be deleted via UI or API (`423 protected`).
                </p>
              </div>
              <label className="write-toggle-chip">
                <input
                  type="checkbox"
                  checked={activeWorkspace.protected}
                  disabled={protectionBusy}
                  onChange={(e) => void handleToggleWorkspaceProtection(e.target.checked)}
                />
                <span>{activeWorkspace.protected ? "Protected" : "Unprotected"}</span>
              </label>
            </div>

            <div className="danger-row" style={{ marginTop: "0.85rem" }}>
              <div>
                <strong>Delete workspace</strong>
                <p className="muted small" style={{ margin: "0.2rem 0 0" }}>
                  {databases.length > 0
                    ? `Workspace contains ${databases.length} database(s) — move or purge all databases before deleting.`
                    : activeWorkspace.protected
                      ? "Disable delete protection above to enable workspace deletion."
                      : "Permanently remove this empty workspace."}
                </p>
              </div>
              <button
                type="button"
                className="btn danger small"
                disabled={activeWorkspace.protected || databases.length > 0}
                onClick={() => {
                  setShowWorkspaceSettings(false);
                  setShowWorkspaceDeleteConfirm(true);
                }}
              >
                Delete Workspace…
              </button>
            </div>
          </div>

          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => setShowWorkspaceSettings(false)}>
              Close
            </button>
          </div>
        </Modal>
      )}

      {showWorkspaceDeleteConfirm && activeWorkspace && (
        <DangerConfirmDialog
          title={`Delete Workspace "${activeWorkspace.name}"`}
          actionLabel="Delete Workspace"
          slug={activeWorkspace.slug}
          description="This permanently deletes the empty workspace."
          onCancel={() => setShowWorkspaceDeleteConfirm(false)}
          onConfirm={async (typedSlug) => {
            await onDeleteWorkspace(activeWorkspace.id, typedSlug);
            setShowWorkspaceDeleteConfirm(false);
          }}
        />
      )}
    </div>
  );
}

/** Backup + restore-verify state at a glance (hidden while loading). */
function BackupBadges({ b }: { b: BackupStatus | undefined }) {
  if (!b) return null;
  if (!b.enabled) return <p className="db-badges"><span className="scope-badge backup-disabled">not backed up</span></p>;
  const v = b.verify?.health;
  return (
    <p className="db-badges">
      <span className={`scope-badge backup-${b.state}`} title={b.lastError ?? undefined}>
        backup {b.state}
      </span>
      {v && (
        <span className={`scope-badge verify-${v}`} title={b.verify?.lastDetail ?? undefined}>
          verify {v}
        </span>
      )}
    </p>
  );
}
