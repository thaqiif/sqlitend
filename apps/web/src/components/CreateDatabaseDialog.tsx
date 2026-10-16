import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button, Description, Input, Label, Modal as HeroModal, TextField } from "@heroui/react";
import { Modal } from "./Modal";
import { ErrorAlert } from "./ErrorAlert";

interface Props {
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}

export function CreateDatabaseDialog({ open, onClose, onSubmit }: Props) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setError(err instanceof Error ? err.message : "Failed to create database");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal ariaLabel="Create database" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <HeroModal.Header>
          <HeroModal.Heading>Create database</HeroModal.Heading>
        </HeroModal.Header>
        <HeroModal.Body className="flex flex-col gap-3 p-1">
          <TextField fullWidth value={name} onChange={setName} isDisabled={busy} autoFocus>
            <Label>Name</Label>
            <Input placeholder="e.g. analytics" className="min-h-11" />
            <Description>
              Names are unique within a workspace. The public hostname uses a random ID, not the name.
            </Description>
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
