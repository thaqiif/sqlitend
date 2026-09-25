import { useEffect, useState } from "react";
import type { ControlBackupStatus, ReplicaInfo, Workspace } from "@sqlitend/shared";
import { api } from "../api/client";
import { RestoreDialog } from "../components/RestoreDialog";

/** Every replica under this server's backup prefix, deleted databases included. */
export function BackupsPage({
  workspaces,
  onBack,
  onOpenDatabase,
}: {
  workspaces: Workspace[];
  onBack: () => void;
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
    <main className="shell">
      <div className="panel-header">
        <button type="button" className="btn ghost small" onClick={onBack}>
          ← Back
        </button>
        <h2 className="panel-title">Backups</h2>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <section className="panel">
        <div className="panel-header">
          <h3 className="panel-title">Control plane (metadata + signing keys, encrypted)</h3>
          {control?.enabled && (
            <button type="button" className="btn ghost small" onClick={() => void backupControlNow()} disabled={controlBusy}>
              {controlBusy ? "Backing up…" : "Back up now"}
            </button>
          )}
        </div>
        {!control ? (
          <p className="muted">Loading…</p>
        ) : !control.enabled ? (
          <p className="error-detail" role="alert">
            Not backed up. Set SQLITEND_CONTROL_BACKUP_KEY (<code>sqlitend gen-backup-key</code>, keep a copy offline).
            Without it, restored databases can't be used after a server loss.
          </p>
        ) : (
          <p className={control.lastError ? "error-detail" : "muted"}>
            Last backup {control.lastOkAt ? new Date(control.lastOkAt).toLocaleString() : "never"}
            {control.lastKey ? <span className="mono"> · {control.lastKey.split("/").pop()}</span> : null}
            {control.lastError ? ` · last attempt failed: ${control.lastError}` : ""}
          </p>
        )}
      </section>
      <section className="panel">
        {!rows ? (
          <p className="muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="muted">No backups in the store yet.</p>
        ) : (
          <div className="table-scroll">
          <table className="token-table">
            <thead>
              <tr>
                <th>Database</th>
                <th>State</th>
                <th>Id</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.name ?? r.slug ?? <span className="muted">unknown (no manifest)</span>}{r.name && r.slug && <span className="db-slug">{r.slug}</span>}</td>
                  <td>
                    <span className={`scope-badge ${r.exists ? "token-active" : "token-expired"}`}>{r.exists ? "live" : "deleted"}</span>
                  </td>
                  <td className="mono">{r.id}</td>
                  <td className="cell-end">
                    <button type="button" className="btn ghost small" onClick={() => setRestoring(r)}>
                      Restore…
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>
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
