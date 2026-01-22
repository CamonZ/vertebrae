import { FormModal } from '../forms/FormModal';
import { BooleanField } from '../forms/BooleanField';

export interface DeleteConfirmationDialogProps {
  /**
   * Whether the dialog is open/visible
   */
  isOpen: boolean;
  /**
   * Called when dialog is closed (via Cancel, backdrop click, or Escape)
   */
  onClose: () => void;
  /**
   * Called when Delete button is clicked
   */
  onConfirm: () => void;
  /**
   * Whether the delete operation is in progress
   */
  isDeleting: boolean;
  /**
   * Error message from delete attempt
   */
  error?: string;
  /**
   * Whether to cascade delete child tasks
   */
  cascade: boolean;
  /**
   * Called when cascade toggle changes
   */
  onCascadeChange: (value: boolean) => void;
  /**
   * Task title for confirmation message
   */
  taskTitle?: string;
  /**
   * Number of child tasks that will be affected
   */
  childCount?: number;
}

/**
 * DeleteConfirmationDialog component for confirming task deletion.
 *
 * Features:
 * - Clear confirmation message showing task name
 * - Toggle option for cascade delete vs orphaning children
 * - Shows the impact of the delete operation
 * - Error handling with user-friendly messages
 * - Loading state during deletion
 * - Prevents accidental deletion with clear buttons
 */
export function DeleteConfirmationDialog({
  isOpen,
  onClose,
  onConfirm,
  isDeleting,
  error,
  cascade,
  onCascadeChange,
  taskTitle = 'the task',
  childCount = 0,
}: DeleteConfirmationDialogProps) {
  return (
    <FormModal
      isOpen={isOpen}
      title="Delete Task"
      onClose={onClose}
      onSubmit={onConfirm}
      isSubmitting={isDeleting}
      error={error}
      preventCloseDuringSubmit={true}
      preventBackdropClickDuringSubmit={true}
      submitButtonText={isDeleting ? 'Deleting...' : 'Delete'}
      cancelButtonText="Cancel"
      contentClassName="min-w-96"
      headerClassName="border-b border-error/30 bg-error/5"
    >
      <div className="space-y-4">
        {/* Confirmation message */}
        <div className="rounded-lg border border-error/20 bg-error/5 p-4">
          <p className="text-sm text-text-primary">
            Are you sure you want to delete <span className="font-semibold">{taskTitle}</span>?
          </p>
          <p className="mt-2 text-xs text-text-secondary">
            This action cannot be undone.
          </p>
        </div>

        {/* Delete options */}
        {childCount > 0 && (
          <div className="space-y-3 rounded-lg border border-border bg-bg-secondary p-4">
            <p className="font-mono text-xs uppercase tracking-wider text-text-muted">
              This task has {childCount} child task{childCount !== 1 ? 's' : ''}
            </p>

            {/* Cascade delete option */}
            <div className="flex items-start gap-3 rounded border border-info/20 bg-info/5 p-3">
              <div className="flex-1">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={cascade}
                    onChange={(e) => onCascadeChange(e.target.checked)}
                    disabled={isDeleting}
                    className="h-4 w-4 rounded border-border accent-primary"
                    aria-label="Cascade delete child tasks"
                  />
                  <span className="text-sm font-medium text-text-primary">
                    Delete all child tasks
                  </span>
                </label>
                <p className="mt-1 ml-6 text-xs text-text-secondary">
                  This will permanently delete all child tasks as well.
                </p>
              </div>
            </div>

            {/* Keep orphaned option */}
            <div className="flex items-start gap-3 rounded border border-warning/20 bg-warning/5 p-3">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!cascade}
                    onChange={(e) => onCascadeChange(!e.target.checked)}
                    disabled={isDeleting}
                    className="h-4 w-4 rounded border-border accent-warning"
                    aria-label="Keep child tasks without parent"
                  />
                  <span className="text-sm font-medium text-text-primary">
                    Keep child tasks without parent
                  </span>
                </div>
                <p className="mt-1 ml-6 text-xs text-text-secondary">
                  Child tasks will be preserved but will lose their parent relationship.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* No children info */}
        {childCount === 0 && (
          <div className="rounded-lg border border-border bg-bg-secondary p-3">
            <p className="text-xs text-text-secondary">
              This task has no child tasks, so it will be deleted directly.
            </p>
          </div>
        )}
      </div>
    </FormModal>
  );
}
