import { useEffect, useRef, type ReactNode } from "react";

interface ModalProps {
  ariaLabel: string;
  onClose: () => void;
  /** Backdrop click closes the modal. Default true. */
  dismissOnBackdrop?: boolean;
  /** Escape closes the modal. Default true. */
  dismissOnEscape?: boolean;
  /** Class added to the inner .modal dialog. */
  className?: string;
  children: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Shared modal shell: renders a backdrop + `<div role="dialog">`, focuses the
 * first focusable inside on open, restores focus to the trigger on close, and
 * traps Tab within the dialog. Escape (and optionally a backdrop click) call
 * onClose. For show-once secrets (TokenReveal) or destructive confirms, pass
 * `dismissOnBackdrop={false}` (and optionally `dismissOnEscape={false}`) so the
 * user must take an explicit action to leave.
 */
export function Modal({
  ariaLabel,
  onClose,
  dismissOnBackdrop = true,
  dismissOnEscape = true,
  className,
  children,
}: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<Element | null>(null);

  useEffect(() => {
    trigger.current = document.activeElement;
    const node = ref.current;
    if (node) {
      const first = node.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? node).focus();
    }
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (dismissOnEscape) onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const dialog = ref.current;
      if (!dialog) return;
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, dismissOnEscape]);

  useEffect(() => {
    return () => {
      if (trigger.current instanceof HTMLElement && trigger.current.isConnected) {
        trigger.current.focus();
      }
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={dismissOnBackdrop ? onClose : undefined}
    >
      <div
        ref={ref}
        className={`modal${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}