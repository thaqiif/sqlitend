import { useEffect, useState } from "react";
import type { ReplicaInfo, Workspace } from "@sqlitend/shared";
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

  useEffect(() => {
    api
      .listReplicas()
      .then((r) => setRows(r.sort((a, b) => Number(a.exists) - Number(b.exists) || (a.slug ?? a.id).localeCompare(b.slug ?? b.id))))
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
        {!rows ? (
          <p className="muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="muted">No backups in the store yet.</p>
        ) : (
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
                  <td>{r.slug ?? <span className="muted">unknown (no manifest)</span>}</td>
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
        )}
      </section>
      {restoring && (
        <RestoreDialog
          sourceId={restoring.id}
          sourceLabel={restoring.slug ?? restoring.id.slice(0, 8)}
          workspaces={workspaces}
          defaultWorkspaceId={restoring.workspaceId}
          onClose={() => setRestoring(null)}
          onStarted={(db) => onOpenDatabase(db.id)}
        />
      )}
    </main>
  );
}
