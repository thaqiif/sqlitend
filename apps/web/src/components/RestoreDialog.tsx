import { useState } from "react";
import type { Database, Workspace } from "@sqlitend/shared";
import { api } from "../api/client";
import { Button, Description, Input, Label, ListBox, Modal as HeroModal, Select, TextField } from "@heroui/react";
import { Modal } from "./Modal";
import { ErrorAlert } from "./ErrorAlert";

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
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <HeroModal.Header>
          <HeroModal.Heading>Restore as a new database</HeroModal.Heading>
        </HeroModal.Header>
        <HeroModal.Body className="flex flex-col gap-4 p-1">
          <p className="m-0 text-sm text-muted">
            Restores <strong>{sourceLabel}</strong> from its S3 backup into a <em>new</em> database. The original is
            not touched. The restore is checked with <code>integrity_check</code> before it starts. It gets its own
            tokens and hostname.
          </p>
          <TextField fullWidth value={name} onChange={setName} isRequired isDisabled={busy} autoFocus>
            <Label>New database name</Label>
            <Input maxLength={128} className="min-h-11" />
          </TextField>
          <Select
            fullWidth
            aria-label="Workspace"
            value={workspaceId}
            onChange={(key) => key && setWorkspaceId(String(key))}
            isDisabled={busy}
          >
            <Label>Workspace</Label>
            <Select.Trigger className="min-h-11 items-center">
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {workspaces.map((w) => (
                  <ListBox.Item key={w.id} id={w.id} textValue={w.name}>
                    {w.name}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
          <TextField fullWidth value={at} onChange={setAt} isDisabled={busy}>
            <Label>Point in time (optional, your local time)</Label>
            <Input type="datetime-local" step={1} className="min-h-11" />
            <Description>Blank restores the latest state. A time restores everything committed before it.</Description>
          </TextField>
          {error && <ErrorAlert>{error}</ErrorAlert>}
        </HeroModal.Body>
        <HeroModal.Footer>
          <Button variant="ghost" className="min-h-11" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" className="min-h-11" isDisabled={busy || !name.trim() || !workspaceId}>
            Restore
          </Button>
        </HeroModal.Footer>
      </form>
    </Modal>
  );
}
