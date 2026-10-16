import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { BackupStatus, Database, Metrics, MetricsOverviewResponse, Workspace } from "@sqlitend/shared";
import { api } from "../api/client";
import { shortSqldVersion } from "../format";
import { Button, Card, Label, ListBox, Modal as HeroModal, Select, Skeleton, Switch } from "@heroui/react";
import { ErrorAlert } from "../components/ErrorAlert";
import { StatusChip } from "../components/StatusChip";
import { backupTone, dbStatusTone, stabilityTone, verifyTone } from "../components/status-tones";
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
    <svg width={w} height={h} className="shrink-0" aria-hidden="true">
      <polyline fill="none" style={{ stroke: color }} strokeWidth="1.75" points={pts} />
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
    <div className="flex min-w-0 flex-col">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
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

  const workspaceSelectItems = workspaces.map((w) => (
    <ListBox.Item key={w.id} id={w.id} textValue={w.name}>
      {w.name} ({w.slug})
      <ListBox.ItemIndicator />
    </ListBox.Item>
  ));

  return (
    <div className="grid min-w-0 flex-1 grid-cols-1 md:grid-cols-[16rem_1fr]">
      <aside className="hidden border-r border-separator p-4 md:block" aria-label="Workspaces">
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="text-sm font-semibold">Workspaces</span>
          <Button variant="ghost" size="sm" className="min-h-11" onPress={() => setShowCreateWorkspace(true)}>
            + New
          </Button>
        </div>
        {workspaces.length === 0 ? (
          <div className="flex flex-col items-start gap-2 text-sm text-muted">
            No workspaces yet.
            <Button variant="primary" className="min-h-11" onPress={() => setShowCreateWorkspace(true)}>
              Create one
            </Button>
          </div>
        ) : (
          <nav className="flex flex-col gap-1">
            {workspaces.map((w) => {
              const active = w.id === selectedWorkspaceId;
              return (
                <button
                  key={w.id}
                  type="button"
                  aria-current={active ? "true" : undefined}
                  onClick={() => onSelectWorkspace(w.id)}
                  className={`flex min-h-11 flex-col justify-center rounded-lg px-3 text-left ${
                    active ? "bg-accent-soft text-accent-soft-foreground" : "hover:bg-default"
                  }`}
                >
                  <span className="truncate text-sm font-medium">{w.name}</span>
                  <span className="truncate text-xs text-muted">{w.slug}</span>
                </button>
              );
            })}
          </nav>
        )}
      </aside>

      <main className="flex min-w-0 flex-col gap-4 p-4 md:p-6">
        <div className="flex items-end gap-2 md:hidden">
          {workspaces.length > 0 ? (
            <Select
              fullWidth
              aria-label="Workspace picker"
              value={selectedWorkspaceId}
              onChange={(key) => key && onSelectWorkspace(String(key))}
              className="min-w-0 flex-1"
            >
              <Label>Workspace</Label>
              <Select.Trigger className="min-h-11">
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>{workspaceSelectItems}</ListBox>
              </Select.Popover>
            </Select>
          ) : (
            <span className="flex-1 text-sm text-muted">No workspaces yet.</span>
          )}
          <Button variant="secondary" className="min-h-11" onPress={() => setShowCreateWorkspace(true)}>
            + Workspace
          </Button>
        </div>

        {overview && (
          <section aria-label="System resource overview" className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <OverviewTile label="Instances">
              {overview.totals.runningDbs} running · {overview.totals.stoppedDbs} stopped
              {overview.totals.crashedOrFailedDbs > 0 ? ` · ${overview.totals.crashedOrFailedDbs} faulted` : ""}
            </OverviewTile>
            <OverviewTile label="Total Disk / WAL">
              {fmtBytesCompact(overview.totals.totalDiskBytes)} ({fmtBytesCompact(overview.totals.totalWalBytes)} WAL)
            </OverviewTile>
            <OverviewTile label="Total RSS">{fmtBytesCompact(overview.totals.totalMemoryBytes)}</OverviewTile>
            <OverviewTile label="Queries">
              {overview.totals.totalQueries.toLocaleString()} ({overview.totals.totalErrors} err)
            </OverviewTile>
          </section>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-xl font-semibold">{activeWorkspace?.name ?? "Databases"}</h2>
            {activeWorkspace && (
              <span className="text-xs text-muted">
                slug: <code>{activeWorkspace.slug}</code> ·{" "}
                {activeWorkspace.protected ? "🔒 Protected" : "🔓 Unprotected"}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {activeWorkspace && (
              <Button variant="secondary" className="min-h-11" onPress={() => setShowWorkspaceSettings(true)}>
                Workspace Settings
              </Button>
            )}
            <Button
              variant="primary"
              className="min-h-11"
              isDisabled={!selectedWorkspaceId}
              onPress={() => setShowCreateDatabase(true)}
            >
              + New database
            </Button>
          </div>
        </div>

        {listError && databases.length > 0 && <ErrorAlert>{listError}</ErrorAlert>}

        {loading && databases.length === 0 ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3" aria-label="Loading databases">
            <Skeleton className="h-40 rounded-xl" />
            <Skeleton className="hidden h-40 rounded-xl md:block" />
          </div>
        ) : databases.length === 0 ? (
          listError ? (
            <ErrorAlert>{listError}</ErrorAlert>
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border p-8 text-center">
              <p className="m-0">No databases in this workspace.</p>
              <Button variant="primary" className="min-h-11" onPress={() => setShowCreateDatabase(true)}>
                Create your first database
              </Button>
            </div>
          )
        ) : (
          <section className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3" aria-label="Databases">
            {databases.map((db) => {
              const m = metrics[db.id];
              const summary = overview?.databases[db.id];
              const v = shortSqldVersion(db.sqldVersion);
              return (
                <Card key={db.id} className="min-w-0 gap-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      className="-m-1 min-h-11 min-w-0 flex-1 rounded-lg p-1 text-left"
                      onClick={() => onOpenDatabase(db.id)}
                    >
                      <h3 className="truncate text-base font-semibold">{db.name}</h3>
                      {db.slug !== db.name && <span className="block truncate text-xs text-muted">{db.slug}</span>}
                    </button>
                    <div className="flex flex-wrap justify-end gap-1">
                      {summary && (
                        <StatusChip
                          tone={stabilityTone(summary.stability.level)}
                          title={`${summary.stability.label}: ${summary.stability.rule} (${summary.stability.availabilityPct24h}% 24h avail)`}
                        >
                          {summary.stability.label}
                        </StatusChip>
                      )}
                      <StatusChip tone={dbStatusTone(db.status)}>{db.status}</StatusChip>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted">
                    <span className="min-w-0 truncate font-mono" title={db.publicUrl ?? dbHost(db) ?? undefined}>
                      {db.publicUrl ? db.publicUrl.replace(/^https:\/\//, "") : (dbHost(db) ?? "no port")}
                    </span>
                    {v && <span>sqld {v}</span>}
                  </div>
                  <BackupBadges b={backups[db.id]} />
                  <div className="grid grid-cols-4 gap-2">
                    <MiniMetric label="CPU" value={m == null || m.cpuPct == null ? "—" : `${m.cpuPct.toFixed(1)}%`} />
                    <MiniMetric
                      label="Mem"
                      value={m == null ? "—" : `${Math.max(0, Math.round(m.memoryBytes / 1048576))} MB`}
                    />
                    <MiniMetric label="Disk" value={m == null ? "—" : fmtBytesCompact(m.diskBytes)} />
                    {summary?.latency.p95Ms != null && <MiniMetric label="p95" value={`${summary.latency.p95Ms}ms`} />}
                  </div>
                  {summary && summary.sparkline.memoryBytes.length > 1 && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted">Mem trend</span>
                      <MiniSparkline values={summary.sparkline.memoryBytes} color="var(--success)" />
                    </div>
                  )}
                </Card>
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

      {/* Workspace Settings & Danger Zone. Deleting lives only here, never in list rows. */}
      {showWorkspaceSettings && activeWorkspace && (
        <Modal ariaLabel="Workspace settings" onClose={() => setShowWorkspaceSettings(false)}>
          <HeroModal.Header>
            <HeroModal.Heading>Workspace Settings — {activeWorkspace.name}</HeroModal.Heading>
          </HeroModal.Header>
          <HeroModal.Body className="flex flex-col gap-4 p-1">
            <p className="m-0 text-xs text-muted">
              Slug: <code>{activeWorkspace.slug}</code>
            </p>

            <section className="flex flex-col gap-4 rounded-lg border border-danger/40 p-3" aria-label="Danger zone">
              <h3 className="text-sm font-semibold text-danger">Danger Zone</h3>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <strong className="text-sm">Delete protection</strong>
                  <p className="m-0 mt-1 text-xs text-muted">
                    When enabled, this workspace cannot be deleted via UI or API (`423 protected`).
                  </p>
                </div>
                <Switch
                  isSelected={activeWorkspace.protected}
                  isDisabled={protectionBusy}
                  onChange={(next) => void handleToggleWorkspaceProtection(next)}
                  aria-label="Delete protection"
                  className="min-h-11"
                >
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <Switch.Content>{activeWorkspace.protected ? "Protected" : "Unprotected"}</Switch.Content>
                </Switch>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <strong className="text-sm">Delete workspace</strong>
                  <p className="m-0 mt-1 text-xs text-muted">
                    {databases.length > 0
                      ? `Workspace contains ${databases.length} database(s) — move or purge all databases before deleting.`
                      : activeWorkspace.protected
                        ? "Disable delete protection above to enable workspace deletion."
                        : "Permanently remove this empty workspace."}
                  </p>
                </div>
                <Button
                  variant="danger"
                  className="min-h-11"
                  isDisabled={activeWorkspace.protected || databases.length > 0}
                  onPress={() => {
                    setShowWorkspaceSettings(false);
                    setShowWorkspaceDeleteConfirm(true);
                  }}
                >
                  Delete Workspace…
                </Button>
              </div>
            </section>
          </HeroModal.Body>
          <HeroModal.Footer>
            <Button variant="ghost" className="min-h-11" onPress={() => setShowWorkspaceSettings(false)}>
              Close
            </Button>
          </HeroModal.Footer>
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

function OverviewTile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Card className="gap-0.5 p-3">
      <span className="text-xs text-muted">{label}</span>
      <strong className="text-sm">{children}</strong>
    </Card>
  );
}

/** Backup + restore-verify state at a glance (hidden while loading). */
function BackupBadges({ b }: { b: BackupStatus | undefined }) {
  if (!b) return null;
  if (!b.enabled) {
    return (
      <div className="flex flex-wrap gap-1">
        <StatusChip tone="default">not backed up</StatusChip>
      </div>
    );
  }
  const v = b.verify?.health;
  return (
    <div className="flex flex-wrap gap-1">
      <StatusChip tone={backupTone(b.state)} title={b.lastError ?? undefined}>
        backup {b.state}
      </StatusChip>
      {v && (
        <StatusChip tone={verifyTone(v)} title={b.verify?.lastDetail ?? undefined}>
          verify {v}
        </StatusChip>
      )}
    </div>
  );
}
