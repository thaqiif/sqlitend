import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "./Modal";
import { fullTime, relTime } from "../format";

interface Props {
  title: string;
  actionLabel: string;
  slug: string;
  description: string;
  stats?: {
    diskBytes?: number;
    tableCount?: number;
    totalRows?: number;
    lastWriteAt?: number | null;
  } | null;
  onCancel: () => void;
  onConfirm: (typedSlug: string) => Promise<void>;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

export function DangerConfirmDialog({
  title,
  actionLabel,
  slug,
  description,
  stats,
  onCancel,
  onConfirm,
}: Props) {
  const [typed, setTyped] = useState("");
  const [secondsLeft, setSecondsLeft] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSecondsLeft(5);
    const t = setInterval(() => {
      setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(t);
  }, [slug]);

  const match = typed === slug;
  const canSubmit = match && secondsLeft === 0 && !busy;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(typed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal ariaLabel={title} onClose={onCancel}>
      <h2 className="modal-title danger-title">{title}</h2>
      <p className="hint">{description}</p>

      {stats && (
        <div className="danger-stats-box">
          {stats.diskBytes !== undefined && (
            <div>
              <span className="muted small">Size on disk:</span>{" "}
              <strong>{fmtBytes(stats.diskBytes)}</strong>
            </div>
          )}
          {stats.tableCount !== undefined && (
            <div>
              <span className="muted small">Tables / Rows:</span>{" "}
              <strong>
                {stats.tableCount} table(s), {(stats.totalRows ?? 0).toLocaleString()} row(s)
              </strong>
            </div>
          )}
          <div>
            <span className="muted small">Last write:</span>{" "}
            <strong>
              {stats.lastWriteAt ? (
                <span title={fullTime(stats.lastWriteAt)}>{relTime(stats.lastWriteAt)}</span>
              ) : (
                "none recorded"
              )}
            </strong>
          </div>
        </div>
      )}

      <p className="hint">
        Type the exact slug <code>{slug}</code> to confirm:
      </p>

      <form onSubmit={handleSubmit}>
        <label className="field">
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={slug}
            disabled={busy}
            autoFocus
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn danger" disabled={!canSubmit}>
            {busy
              ? "Working…"
              : secondsLeft > 0
                ? `${actionLabel} (${secondsLeft}s)`
                : actionLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
