import { useState } from "react";
import type { Database, Workspace } from "@sqlitend/shared";
import { api } from "../api/client";
import { Modal } from "./Modal";

/** Restore a replica AS A NEW database (never in place), optionally to a point in time. */
export function RestoreDialog({
  sourceId,
  sourceLabel,
  workspaces,
  defaultWorkspaceId,
  onClose,
  onStarted,
}: {
  sourceId: string;
  sourceLabel: string;
  workspaces: Workspace[];
  defaultWorkspaceId?: string;
  onClose: () => void;
  onStarted: (db: Database) => void;
}) {
  const [name, setName] = useState(`${sourceLabel}-restored`);
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId ?? workspaces[0]?.id ?? "");
  const [at, setAt] = useState(""); // datetime-local, operator's local time
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const db = await api.restoreBackup(sourceId, {
        name: name.trim(),
        workspaceId,
        ...(at ? { at: new Date(at).toISOString() } : {}),
      });
      onStarted(db);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restore failed to start");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal ariaLabel="Restore backup" onClose={onClose}>
      <h2 className="modal-title">Restore as a new database</h2>
      <p className="hint">
        Restores <strong>{sourceLabel}</strong> from its S3 backup into a <em>new</em> database. The original is not
        touched. The restore is checked with <code>integrity_check</code> before it starts. It gets its own tokens and
        hostname.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span className="field-label">New database name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={128} required disabled={busy} autoFocus />
        </label>
        <label className="field">
          <span className="field-label">Workspace</span>
          <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} disabled={busy}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Point in time (optional, your local time)</span>
          <input type="datetime-local" step={1} value={at} onChange={(e) => setAt(e.target.value)} disabled={busy} />
        </label>
        <p className="hint">Blank restores the latest state. A time restores everything committed before it.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim() || !workspaceId}>
            Restore
          </button>
        </div>
      </form>
    </Modal>
  );
}
