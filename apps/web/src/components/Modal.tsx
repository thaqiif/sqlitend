import type { ReactNode } from "react";
import { Modal as HeroModal } from "@heroui/react";

interface ModalProps {
  ariaLabel: string;
  onClose: () => void;
  /** Backdrop click closes the modal. Default true. */
  dismissOnBackdrop?: boolean;
  /** Escape closes the modal. Default true. */
  dismissOnEscape?: boolean;
  /** Extra classes for the dialog panel. */
  className?: string;
  /** "md" (default) or "lg" for wide content. */
  size?: "sm" | "md" | "lg";
  children: ReactNode;
}

/**
 * Shared modal shell on HeroUI's Modal (react-aria: focus trap, focus restore,
 * scroll lock, Escape). Rendered only while open, so callers keep their
 * `{open && <Modal …/>}` pattern. For show-once secrets (TokenReveal) or
 * destructive confirms pass `dismissOnBackdrop={false}` / `dismissOnEscape={false}`.
 */
export function Modal({
  ariaLabel,
  onClose,
  dismissOnBackdrop = true,
  dismissOnEscape = true,
  className,
  size = "md",
  children,
}: ModalProps) {
  return (
    // Controlled straight on the Backdrop (no Modal.Root): Root is a DialogTrigger, which expects a
    // trigger child and logs "PressResponder was rendered without a pressable child" without one.
    <HeroModal.Backdrop
      isOpen
      onOpenChange={(open) => !open && onClose()}
      isDismissable={dismissOnBackdrop}
      isKeyboardDismissDisabled={!dismissOnEscape}
    >
      <HeroModal.Container size={size} placement="auto" scroll="inside">
        <HeroModal.Dialog aria-label={ariaLabel} className={className}>
          {children}
        </HeroModal.Dialog>
      </HeroModal.Container>
    </HeroModal.Backdrop>
  );
}
