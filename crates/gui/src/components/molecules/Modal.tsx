import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "../atoms/Button";

export type ModalVariant = "dialog" | "sheet" | "confirm";

interface BaseModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  variant?: ModalVariant;
  /** Hide the default close icon (auto-hidden for `confirm`). */
  hideClose?: boolean;
  children?: ReactNode;
  className?: string;
}

interface ConfirmModalProps extends Omit<BaseModalProps, "variant" | "children"> {
  variant: "confirm";
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmIntent?: "primary" | "danger";
  onConfirm: () => void;
}

type ModalProps = BaseModalProps | ConfirmModalProps;

const widthClasses: Record<ModalVariant, string> = {
  dialog: "w-[440px]",
  sheet: "w-[640px] max-h-[80vh]",
  confirm: "w-[400px]",
};

function isConfirm(p: ModalProps): p is ConfirmModalProps {
  return p.variant === "confirm";
}

/**
 * Blocking overlay dialog. `confirm` variant collapses the API to a two-button
 * destructive confirmation.
 */
export function Modal(props: ModalProps) {
  const { open, onClose, title, className } = props;
  const variant = props.variant ?? "dialog";
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    containerRef.current?.focus();
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  const showClose = !isConfirm(props) && !props.hideClose;

  const content = (
    <div
      role="presentation"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 animate-fade-in-up"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        className={[
          "relative bg-[var(--color-bg-2)] border border-[var(--color-line-strong)]",
          "rounded-[var(--radius-lg)] shadow-[var(--shadow-3)] overflow-hidden flex flex-col",
          widthClasses[variant],
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {(title || showClose) && (
          <div className="flex items-center justify-between gap-3 border-b border-[var(--color-line)] px-5 py-3.5">
            <div className="min-w-0 flex-1 truncate font-serif text-lg text-[var(--color-fg)]">
              {title}
            </div>
            {showClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-fg-mute)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
              >
                ×
              </button>
            )}
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isConfirm(props) ? (
            <p className="text-sm text-[var(--color-fg-soft)]">
              {props.description}
            </p>
          ) : (
            props.children
          )}
        </div>
        {isConfirm(props) && (
          <div className="flex justify-end gap-2 border-t border-[var(--color-line)] px-5 py-3">
            <Button variant="ghost" onClick={onClose}>
              {props.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              variant={props.confirmIntent === "danger" ? "danger" : "primary"}
              onClick={() => {
                props.onConfirm();
              }}
            >
              {props.confirmLabel ?? "Confirm"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
