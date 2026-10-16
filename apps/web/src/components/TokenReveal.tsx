import { useState } from "react";
import type { TokenIssued } from "@sqlitend/shared";
import { Button, Modal as HeroModal } from "@heroui/react";
import { Modal } from "./Modal";

interface Props {
  token: TokenIssued;
  onDismiss: () => void;
}

/**
 * Modal that shows a freshly-issued token. It can be copied again later from
 * the token list (Copy); the user acknowledges by choosing "I saved it". There is deliberately NO backdrop-click or Escape dismissal
 * here — a stray click must not destroy the only copy of the secret.
 */
export function TokenReveal({ token, onDismiss }: Props) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(token.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context); leave the text for manual copy.
    }
  }

  return (
    <Modal
      ariaLabel="Generated token"
      size="lg"
      onClose={onDismiss}
      dismissOnBackdrop={false}
      dismissOnEscape={false}
    >
      <HeroModal.Header>
        <HeroModal.Heading>Token generated</HeroModal.Heading>
      </HeroModal.Header>
      <HeroModal.Body className="flex flex-col gap-3 p-1">
        <p className="m-0 text-sm text-muted">
          Copy it now, or later with Copy in the token list. Scope <strong>{token.scope}</strong> for{" "}
          <em>{token.dbSlug}</em>.
        </p>
        <pre
          className="m-0 max-h-48 overflow-auto rounded-lg bg-default p-3 font-mono text-xs break-all whitespace-pre-wrap"
          data-testid="token-secret"
        >
          {token.token}
        </pre>
      </HeroModal.Body>
      <HeroModal.Footer>
        <Button variant="ghost" className="min-h-11" onPress={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button variant="primary" className="min-h-11" onPress={onDismiss}>
          I saved it
        </Button>
      </HeroModal.Footer>
    </Modal>
  );
}
