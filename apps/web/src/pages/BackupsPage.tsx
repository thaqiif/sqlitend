import { useEffect, useState } from "react";
import { Button, Card, Skeleton } from "@heroui/react";
import type { ControlBackupStatus, ReplicaInfo, Workspace } from "@sqlitend/shared";
import { api } from "../api/client";
import { RestoreDialog } from "../components/RestoreDialog";
import { ErrorAlert } from "../components/ErrorAlert";
import { StatusChip } from "../components/StatusChip";

/** Every replica under this server's backup prefix, deleted databases included. */
export function BackupsPage({
  workspaces,
  onOpenDatabase,
}: {
  workspaces: Workspace[];
  onOpenDatabase: (id: string) => void;
}) {
  const [rows, setRows] = useState<ReplicaInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<ReplicaInfo | null>(null);
  const [control, setControl] = useState<ControlBackupStatus | null>(null);
  const [controlBusy, setControlBusy] = useState(false);

  useEffect(() => {
    api.getControlBackup().then(setControl).catch(() => {});
  }, []);

  async function backupControlNow() {
    setControlBusy(true);
    try {
      setControl(await api.runControlBackup());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Control-plane backup failed");
    } finally {
      setControlBusy(false);
    }
  }

  useEffect(() => {
    api
      .listReplicas()
      .then((r) => setRows(r.sort((a, b) => Number(a.exists) - Number(b.exists) || (a.name ?? a.slug ?? a.id).localeCompare(b.name ?? b.slug ?? b.id))))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to list backups"));
  }, []);

  return (
    <main className="flex min-w-0 flex-col gap-4 p-4 md:p-6">
      <h2 className="text-xl font-semibold">Backups</h2>
      {error && <ErrorAlert>{error}</ErrorAlert>}

      <Card className="gap-3 p-4">
        <Card.Header className="flex flex-wrap items-center justify-between gap-2">
          <Card.Title className="text-base">Control plane (metadata + signing keys, encrypted)</Card.Title>
          {control?.enabled && (
            <Button variant="secondary" className="min-h-11" onPress={() => void backupControlNow()} isPending={controlBusy}>
              {controlBusy ? "Backing up…" : "Back up now"}
            </Button>
          )}
        </Card.Header>
        <Card.Content>
          {!control ? (
            <Skeleton className="h-5 w-48 rounded" />
          ) : !control.enabled ? (
            <p className="m-0 text-sm text-danger" role="alert">
              Not backed up. Set SQLITEND_CONTROL_BACKUP_KEY (<code>sqlitend gen-backup-key</code>, keep a copy
              offline). Without it, restored databases can't be used after a server loss.
            </p>
          ) : (
            <p className={`m-0 text-sm ${control.lastError ? "text-danger" : "text-muted"}`}>
              Last backup {control.lastOkAt ? new Date(control.lastOkAt).toLocaleString() : "never"}
              {control.lastKey ? <span className="font-mono"> · {control.lastKey.split("/").pop()}</span> : null}
              {control.lastError ? ` · last attempt failed: ${control.lastError}` : ""}
            </p>
          )}
        </Card.Content>
      </Card>

      {!rows ? (
        <Skeleton className="h-24 w-full rounded-xl" />
      ) : rows.length === 0 ? (
        <p className="text-muted">No backups in the store yet.</p>
      ) : (
        <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2" aria-label="Replicas">
          {rows.map((r) => (
            <li key={r.id}>
              <Card className="h-full gap-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">
                      {r.name ?? r.slug ?? <span className="text-muted">unknown (no manifest)</span>}
                    </div>
                    {r.name && r.slug && <div className="truncate text-xs text-muted">{r.slug}</div>}
                  </div>
                  <StatusChip tone={r.exists ? "success" : "default"}>{r.exists ? "live" : "deleted"}</StatusChip>
                </div>
                <div className="font-mono text-xs break-all text-muted">{r.id}</div>
                <div>
                  <Button variant="secondary" className="min-h-11" onPress={() => setRestoring(r)}>
                    Restore…
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {restoring && (
        <RestoreDialog
          sourceId={restoring.id}
          sourceLabel={restoring.name ?? restoring.slug ?? restoring.id.slice(0, 8)}
          workspaces={workspaces}
          defaultWorkspaceId={restoring.workspaceId}
          onClose={() => setRestoring(null)}
          onStarted={(db) => onOpenDatabase(db.id)}
        />
      )}
    </main>
  );
}
