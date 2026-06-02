import type { ReactNode } from "react";
import { EmWord } from "./atoms";

interface DeleteConfirmationProps {
  /** Type of item being deleted (e.g., "Task", "Step") */
  itemType: string;
  /** Name of the item being deleted */
  itemName: string;
  /** Whether delete is in progress */
  isDeleting: boolean;
  /** Error message to display */
  error: string | null;
  /** Callback when confirm is clicked */
  onConfirm: () => void;
  /** Callback when cancel is clicked */
  onCancel: () => void;
  /** Optional additional content (e.g., cascade options) */
  children?: ReactNode;
  /** Stable selector for integration and acceptance tests */
  testId?: string;
}

/**
 * Reusable delete confirmation section with consistent styling.
 * Displays a confirmation prompt with optional additional content.
 */
export function DeleteConfirmation({
  itemType,
  itemName,
  isDeleting,
  error,
  onConfirm,
  onCancel,
  children,
  testId,
}: DeleteConfirmationProps) {
  return (
    <div
      className="m-4 rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-bg-2)] p-3"
      data-testid={testId}
    >
      <div className="space-y-3">
        <div>
          <h4 className="text-sm font-semibold text-err">
            Delete {itemType}?
          </h4>
          <p className="mt-1 text-sm text-fg-soft">
            Are you sure you want to delete <EmWord>{itemName}</EmWord>?
          </p>
        </div>

        {children}

        {error && (
          <p className="text-xs text-err bg-err/10 p-2 rounded">{error}</p>
        )}

        <div className="flex gap-2">
          <button
            onClick={onConfirm}
            disabled={isDeleting}
            className="flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium bg-[var(--color-err-wash)] text-[var(--color-err)] hover:bg-[color-mix(in_oklch,var(--color-err)_25%,transparent)] disabled:opacity-50 cursor-pointer"
          >
            {isDeleting ? (
              <>
                <svg
                  className="h-3.5 w-3.5 animate-spin"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                <span>Deleting...</span>
              </>
            ) : (
              <span>Confirm Delete</span>
            )}
          </button>
          <button
            onClick={onCancel}
            disabled={isDeleting}
            className="flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium bg-[var(--color-bg-3)] text-[var(--color-fg-mute)] hover:bg-[var(--color-bg-4)] hover:text-[var(--color-fg)] disabled:opacity-50 cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
