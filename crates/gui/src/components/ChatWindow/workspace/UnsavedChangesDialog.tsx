import { Modal } from "../../molecules/Modal";
import { Button } from "../../atoms/Button";

export interface UnsavedChangesDialogProps {
  /** Dirty documents the action would leave; the dialog is open when set. */
  paths: readonly string[] | null;
  busy: boolean;
  onSave(): void;
  onDiscard(): void;
  onCancel(): void;
}

/** Ask whether to save, discard or keep editing unsaved documents. */
export function UnsavedChangesDialog({
  paths,
  busy,
  onSave,
  onDiscard,
  onCancel,
}: UnsavedChangesDialogProps) {
  const many = (paths?.length ?? 0) > 1;
  return (
    <Modal
      open={paths != null}
      onClose={onCancel}
      title="Unsaved changes"
      hideClose
      preventClose={busy}
    >
      <p className="text-sm text-[var(--color-fg-mute)]">
        {many
          ? `${paths?.length} files have unsaved changes.`
          : `${paths?.[0] ?? "This file"} has unsaved changes.`}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={onDiscard}
        >
          Discard
        </Button>
        <Button variant="primary" size="sm" loading={busy} onClick={onSave}>
          {many ? "Save all" : "Save"}
        </Button>
      </div>
    </Modal>
  );
}
