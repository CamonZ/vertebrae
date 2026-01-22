import { useState, useCallback } from 'react';
import type { Section } from '../../bindings';
import { commands } from '../../bindings';
import { FormModal } from '../forms/FormModal';
import { FormField } from '../forms/FormField';

interface StepEditorProps {
  /**
   * The task ID this step belongs to
   */
  taskId: string;
  /**
   * The step being edited, or null for new step
   */
  step?: Section;
  /**
   * Whether the modal is open
   */
  isOpen: boolean;
  /**
   * Called when the modal should close
   */
  onClose: () => void;
  /**
   * Called when a step is successfully saved
   */
  onSave?: () => void;
}

/**
 * StepEditor component for editing step sections with done toggle.
 *
 * Features:
 * - Text area for step content
 * - Prominent done toggle checkbox
 * - Validation before submission
 * - Separate done status management
 */
export function StepEditor({
  taskId,
  step,
  isOpen,
  onClose,
  onSave,
}: StepEditorProps) {
  const [content, setContent] = useState(step?.content ?? '');
  const [isDone, setIsDone] = useState(step?.done ?? false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Handle modal close
  const handleClose = useCallback(() => {
    // Reset form when closing
    setContent(step?.content ?? '');
    setIsDone(step?.done ?? false);
    setError(null);
    onClose();
  }, [step, onClose]);

  // Handle submit
  const handleSubmit = useCallback(async () => {
    // Validate input
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      setError('Step content cannot be empty');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      if (step) {
        // Edit existing step
        const result = await commands.editSection(
          taskId,
          'step',
          step.ordinal ?? 0,
          trimmedContent
        );
        if (result.status === 'error') {
          setError(result.error.message);
          setIsSubmitting(false);
          return;
        }

        // Handle done status change if different from original
        if (isDone !== (step.done ?? false)) {
          const doneResult = await commands.markSectionDone(taskId, step.ordinal ?? 0);
          if (doneResult.status === 'error') {
            setError(doneResult.error.message);
            setIsSubmitting(false);
            return;
          }
        }
      } else {
        // Add new step
        const result = await commands.addSection(taskId, 'step', trimmedContent);
        if (result.status === 'error') {
          setError(result.error.message);
          setIsSubmitting(false);
          return;
        }

        // If new step should be marked done, do it now
        if (isDone) {
          // We'd need the ordinal from the response, but for now mark it as index 0 or highest
          // This is a limitation we can improve later
        }
      }

      // Success - reset form and close
      setContent('');
      setIsDone(false);
      onSave?.();
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save step');
    } finally {
      setIsSubmitting(false);
    }
  }, [taskId, step, content, isDone, onSave, handleClose]);

  return (
    <FormModal
      isOpen={isOpen}
      title={`${step ? 'Edit' : 'New'} Step`}
      onClose={handleClose}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      error={error}
      submitButtonText={step ? 'Save' : 'Create'}
    >
      <div className="space-y-4">
        {/* Step content */}
        <FormField
          label="Step Content"
          required
          error={error && !content.trim() ? error : undefined}
        >
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Describe the step..."
            disabled={isSubmitting}
            className="w-full rounded-md border border-border bg-background-tertiary px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:border-primary focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
            rows={5}
          />
        </FormField>

        {/* Done toggle - prominent */}
        <div className="rounded-lg border border-border bg-background-tertiary p-4">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={isDone}
              onChange={(e) => setIsDone(e.target.checked)}
              disabled={isSubmitting}
              className="h-5 w-5 rounded border-border text-primary focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
            />
            <span className="font-medium text-text-primary">
              Mark this step as done
            </span>
            {isDone && (
              <span className="ml-auto inline-flex items-center rounded-full bg-success/10 px-2.5 py-0.5 text-xs font-medium text-success">
                Complete
              </span>
            )}
          </label>
        </div>
      </div>
    </FormModal>
  );
}
