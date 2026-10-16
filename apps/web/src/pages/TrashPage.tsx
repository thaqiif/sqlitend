import { useEffect, useState } from "react";
import type { TrashItem } from "@sqlitend/shared";
import { api } from "../api/client";
import { fullTime, relTime } from "../format";
import { DangerConfirmDialog } from "../components/DangerConfirmDialog";

interface Props {
  onBack: () => void;
  onRestored: (databaseId: string) => void;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

export function TrashPage({ onBack, onRestored }: Props) {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [purgingItem, setPurgingItem] = useState<TrashItem | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const list = await api.listTrash();
      setItems(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load trash");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleRestore = async (item: TrashItem) => {
    setRestoringId(item.id);
    setError(null);
    try {
      const restored = await api.restoreFromTrash(item.id);
      onRestored(restored.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restore failed");
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <main className="content standalone">
      <div className="detail-nav">
        <button type="button" className="btn ghost small" onClick={onBack}>
          ← Back
        </button>
        <div className="detail-title">
          <h2>Trash ({items.length})</h2>
        </div>
      </div>

      <section className="panel">
        <p className="hint" style={{ marginTop: 0 }}>
          Soft-deleted databases are stopped and moved to <code>&lt;dataRoot&gt;/trash/</code>. They can be restored with a single click or permanently purged before their retention window expires.
        </p>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <div className="skeleton-line" style={{ width: "100%", height: "96px" }} />
        ) : items.length === 0 ? (
          <p className="muted">Trash is empty.</p>
        ) : (
          <div className="table-scroll">
            <table className="token-table">
              <thead>
                <tr>
                  <th>Database</th>
                  <th>Slug</th>
                  <th>Workspace</th>
                  <th>Size</th>
                  <th>Trashed</th>
                  <th>Auto-Purge</th>
                  <th className="cell-end">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.name}</strong>
                    </td>
                    <td>
                      <code>{item.slug}</code>
                    </td>
                    <td>{item.workspaceName}</td>
                    <td>{fmtBytes(item.diskBytes)}</td>
                    <td title={fullTime(item.trashedAt)}>{relTime(item.trashedAt)}</td>
                    <td title={fullTime(item.expiresAt)}>{relTime(item.expiresAt)}</td>
                    <td className="cell-end">
                      <button
                        type="button"
                        className="btn primary small"
                        disabled={restoringId === item.id}
                        onClick={() => void handleRestore(item)}
                      >
                        {restoringId === item.id ? "Restoring…" : "Restore"}
                      </button>{" "}
                      <button
                        type="button"
                        className="btn ghost small danger-text"
                        onClick={() => setPurgingItem(item)}
                      >
                        Purge Forever…
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {purgingItem && (
        <DangerConfirmDialog
          title={`Permanently Purge "${purgingItem.name}"`}
          actionLabel="Purge Forever"
          slug={purgingItem.slug}
          description="This permanently deletes the database files from disk and removes its signing keys. This cannot be undone."
          stats={{ diskBytes: purgingItem.diskBytes }}
          onCancel={() => setPurgingItem(null)}
          onConfirm={async (typedSlug) => {
            await api.purgeFromTrash(purgingItem.id, typedSlug);
            setPurgingItem(null);
            await load();
          }}
        />
      )}
    </main>
  );
}
