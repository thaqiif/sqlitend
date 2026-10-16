import { useEffect, useState, type FormEvent } from "react";
import { Button, Input, Label, Modal as HeroModal, TextField } from "@heroui/react";
import { Modal } from "./Modal";
import { ErrorAlert } from "./ErrorAlert";
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
      <form onSubmit={handleSubmit}>
        <HeroModal.Header>
          <HeroModal.Heading className="text-danger">{title}</HeroModal.Heading>
        </HeroModal.Header>
        <HeroModal.Body className="flex flex-col gap-3 p-1">
          <p className="m-0 text-sm text-muted">{description}</p>

          {stats && (
            <dl className="m-0 flex flex-col gap-1 rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm">
              {stats.diskBytes !== undefined && (
                <div className="flex flex-wrap gap-x-2">
                  <dt className="text-muted">Size on disk:</dt>
                  <dd className="m-0 font-semibold">{fmtBytes(stats.diskBytes)}</dd>
                </div>
              )}
              {stats.tableCount !== undefined && (
                <div className="flex flex-wrap gap-x-2">
                  <dt className="text-muted">Tables / Rows:</dt>
                  <dd className="m-0 font-semibold">
                    {stats.tableCount} table(s), {(stats.totalRows ?? 0).toLocaleString()} row(s)
                  </dd>
                </div>
              )}
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-muted">Last write:</dt>
                <dd className="m-0 font-semibold">
                  {stats.lastWriteAt ? (
                    <span title={fullTime(stats.lastWriteAt)}>{relTime(stats.lastWriteAt)}</span>
                  ) : (
                    "none recorded"
                  )}
                </dd>
              </div>
            </dl>
          )}

          <TextField fullWidth value={typed} onChange={setTyped} isDisabled={busy} autoFocus>
            <Label>
              Type the exact slug <code>{slug}</code> to confirm
            </Label>
            <Input placeholder={slug} autoComplete="off" autoCapitalize="none" spellCheck={false} className="min-h-11" />
          </TextField>
          {error && <ErrorAlert>{error}</ErrorAlert>}
        </HeroModal.Body>
        <HeroModal.Footer>
          <Button variant="ghost" className="min-h-11" onPress={onCancel} isDisabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" className="min-h-11" isDisabled={!canSubmit}>
            {busy ? "Working…" : secondsLeft > 0 ? `${actionLabel} (${secondsLeft}s)` : actionLabel}
          </Button>
        </HeroModal.Footer>
      </form>
    </Modal>
  );
}
