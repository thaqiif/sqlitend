import { useState } from "react";
import type { TokenIssued } from "@sqlitend/shared";
import { Modal } from "./Modal";

interface Props {
  token: TokenIssued;
  onDismiss: () => void;
}

/**
 * Modal that shows a freshly-issued token exactly once. The raw secret is shown
 * only here and never stored/returned again; the user acknowledges by choosing
 * "I saved it". There is deliberately NO backdrop-click or Escape dismissal
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
      className="token-reveal"
      onClose={onDismiss}
      dismissOnBackdrop={false}
      dismissOnEscape={false}
    >
      <h2 className="modal-title">Token generated</h2>
      <p className="hint">
        This token is shown only once and cannot be retrieved again. Scope{" "}
        <strong>{token.scope}</strong> for <em>{token.dbSlug}</em>. Copy it now.
      </p>
      <pre className="token-box" data-testid="token-secret">{token.token}</pre>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className="btn primary" onClick={onDismiss}>
          I saved it
        </button>
      </div>
    </Modal>
  );
}