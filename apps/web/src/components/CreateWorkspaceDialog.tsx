import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button, Input, Label, Modal as HeroModal, TextField } from "@heroui/react";
import { Modal } from "./Modal";
import { ErrorAlert } from "./ErrorAlert";

interface Props {
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}

export function CreateWorkspaceDialog({ open, onClose, onSubmit }: Props) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form each time the dialog is opened.
  useEffect(() => {
    if (open) {
      setName("");
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const value = name.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create workspace");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal ariaLabel="Create workspace" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <HeroModal.Header>
          <HeroModal.Heading>Create workspace</HeroModal.Heading>
        </HeroModal.Header>
        <HeroModal.Body className="flex flex-col gap-3 p-1">
          <TextField fullWidth value={name} onChange={setName} isDisabled={busy} autoFocus>
            <Label>Name</Label>
            <Input placeholder="e.g. Production" className="min-h-11" />
          </TextField>
          {error && <ErrorAlert>{error}</ErrorAlert>}
        </HeroModal.Body>
        <HeroModal.Footer>
          <Button variant="ghost" className="min-h-11" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" className="min-h-11" isDisabled={busy || !name.trim()}>
            Create
          </Button>
        </HeroModal.Footer>
      </form>
    </Modal>
  );
}
