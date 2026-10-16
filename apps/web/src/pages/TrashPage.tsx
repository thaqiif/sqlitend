import { useEffect, useState } from "react";
import type { TrashItem } from "@sqlitend/shared";
import { api } from "../api/client";
import { fullTime, relTime } from "../format";
import { Button, Card, Skeleton } from "@heroui/react";
import { ErrorAlert } from "../components/ErrorAlert";
import { DangerConfirmDialog } from "../components/DangerConfirmDialog";

interface Props {
  onRestored: (databaseId: string) => void;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

export function TrashPage({ onRestored }: Props) {
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
    <main className="flex min-w-0 flex-col gap-4 p-4 md:p-6">
      <h2 className="text-xl font-semibold">Trash ({items.length})</h2>
      <p className="m-0 text-sm text-muted">
        Soft-deleted databases are stopped and moved to <code>&lt;dataRoot&gt;/trash/</code>. They can be restored with
        a single click or permanently purged before their retention window expires.
      </p>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      {loading ? (
        <Skeleton className="h-24 w-full rounded-xl" />
      ) : items.length === 0 ? (
        <p className="text-muted">Trash is empty.</p>
      ) : (
        <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2" aria-label="Trashed databases">
          {items.map((item) => (
            <li key={item.id}>
              <Card className="h-full gap-3 p-4">
                <div>
                  <div className="font-semibold">{item.name}</div>
                  <code className="text-xs text-muted">{item.slug}</code>
                </div>
                <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  <dt className="text-muted">Workspace</dt>
                  <dd className="m-0">{item.workspaceName}</dd>
                  <dt className="text-muted">Size</dt>
                  <dd className="m-0">{fmtBytes(item.diskBytes)}</dd>
                  <dt className="text-muted">Trashed</dt>
                  <dd className="m-0" title={fullTime(item.trashedAt)}>{relTime(item.trashedAt)}</dd>
                  <dt className="text-muted">Auto-purge</dt>
                  <dd className="m-0" title={fullTime(item.expiresAt)}>{relTime(item.expiresAt)}</dd>
                </dl>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    className="min-h-11"
                    isPending={restoringId === item.id}
                    onPress={() => void handleRestore(item)}
                  >
                    {restoringId === item.id ? "Restoring…" : "Restore"}
                  </Button>
                  <Button variant="danger-soft" className="min-h-11" onPress={() => setPurgingItem(item)}>
                    Purge Forever…
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

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
