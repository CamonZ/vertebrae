import { useState, useCallback, useMemo } from 'react';
import type { Section, CodeRef } from '../../bindings';
import { commands } from '../../bindings';
import { FormModal } from '../forms/FormModal';
import { FormField } from '../forms/FormField';

interface TestingCriterionEditorProps {
  /**
   * The task ID this criterion belongs to
   */
  taskId: string;
  /**
   * The testing criterion being edited, or null for new criterion
   */
  criterion?: Section;
  /**
   * Whether the modal is open
   */
  isOpen: boolean;
  /**
   * Called when the modal should close
   */
  onClose: () => void;
  /**
   * Called when a criterion is successfully saved
   */
  onSave?: () => void;
}

/**
 * TestingCriterionEditor component for editing testing criteria with code reference management.
 *
 * Features:
 * - Text area for criterion content
 * - Code reference fields (file path, line number, name)
 * - Add/remove code references
 * - Validation before submission
 */
export function TestingCriterionEditor({
  taskId,
  criterion,
  isOpen,
  onClose,
  onSave,
}: TestingCriterionEditorProps) {
  const [content, setContent] = useState(criterion?.content ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Code reference form state
  const [refFilePath, setRefFilePath] = useState('');
  const [refLineNumber, setRefLineNumber] = useState('');
  const [refName, setRefName] = useState('');

  // Get existing code refs for this criterion (from criterion.code_refs if available)
  const existingRefs = useMemo(() => {
    // This would need to be passed in or loaded from the criterion
    // For now, we'll assume empty
    return [] as CodeRef[];
  }, []);

  // Handle modal close
  const handleClose = useCallback(() => {
    // Reset form when closing
    setContent(criterion?.content ?? '');
    setRefFilePath('');
    setRefLineNumber('');
    setRefName('');
    setError(null);
    onClose();
  }, [criterion, onClose]);

  // Handle adding a code reference
  const handleAddCodeRef = useCallback(async () => {
    // Validate ref fields
    const trimmedPath = refFilePath.trim();
    const trimmedName = refName.trim();

    if (!trimmedPath) {
      setError('File path is required');
      return;
    }

    if (!refLineNumber) {
      setError('Line number is required');
      return;
    }

    const lineNum = parseInt(refLineNumber, 10);
    if (isNaN(lineNum) || lineNum < 1) {
      setError('Line number must be a positive integer');
      return;
    }

    try {
      // We need the ordinal of the criterion to add a ref to it
      if (!criterion?.ordinal) {
        setError('Cannot add reference: criterion not yet saved');
        return;
      }

      const result = await commands.addCriterionRef(
        taskId,
        criterion.ordinal,
        trimmedPath,
        lineNum,
        trimmedName || undefined
      );

      if (result.status === 'error') {
        setError(result.error.message);
        return;
      }

      // Clear the ref fields
      setRefFilePath('');
      setRefLineNumber('');
      setRefName('');
      setError(null);

      // Trigger save callback to refetch
      onSave?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add code reference');
    }
  }, [taskId, criterion?.ordinal, refFilePath, refLineNumber, refName, onSave]);

  // Handle submit
  const handleSubmit = useCallback(async () => {
    // Validate input
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      setError('Testing criterion cannot be empty');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      if (criterion) {
        // Edit existing criterion
        const result = await commands.editSection(
          taskId,
          'testing_criterion',
          criterion.ordinal ?? 0,
          trimmedContent
        );
        if (result.status === 'error') {
          setError(result.error.message);
          setIsSubmitting(false);
          return;
        }
      } else {
        // Add new criterion
        const result = await commands.addSection(
          taskId,
          'testing_criterion',
          trimmedContent
        );
        if (result.status === 'error') {
          setError(result.error.message);
          setIsSubmitting(false);
          return;
        }
      }

      // Success - reset form and close
      setContent('');
      onSave?.();
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save testing criterion');
    } finally {
      setIsSubmitting(false);
    }
  }, [taskId, criterion, content, onSave, handleClose]);

  return (
    <FormModal
      isOpen={isOpen}
      title={`${criterion ? 'Edit' : 'New'} Testing Criterion`}
      onClose={handleClose}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      error={error}
      submitButtonText={criterion ? 'Save' : 'Create'}
    >
      <div className="space-y-4">
        {/* Criterion content */}
        <FormField
          label="Criterion"
          required
          error={error && !content.trim() ? error : undefined}
        >
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Describe the testing criterion..."
            disabled={isSubmitting}
            className="w-full rounded-md border border-border bg-background-tertiary px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:border-primary focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
            rows={5}
          />
        </FormField>

        {/* Code references section */}
        {criterion && (
          <div className="rounded-lg border border-border bg-background-tertiary p-4">
            <h4 className="mb-3 font-medium text-text-primary">Code References</h4>

            {/* Existing references */}
            {existingRefs.length > 0 && (
              <div className="mb-4 space-y-2">
                {existingRefs.map((ref, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between rounded bg-background-secondary px-3 py-2"
                  >
                    <div className="text-sm">
                      <p className="font-mono text-text-secondary">
                        {ref.file_path}:{ref.line_number}
                      </p>
                      {ref.name && (
                        <p className="text-xs text-text-muted">{ref.name}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Add new reference form (only if criterion is already saved) */}
            <div className="space-y-2">
              <FormField label="File Path">
                <input
                  type="text"
                  value={refFilePath}
                  onChange={(e) => setRefFilePath(e.target.value)}
                  placeholder="e.g., src/main.rs"
                  disabled={isSubmitting}
                  className="w-full rounded-md border border-border bg-background-secondary px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:border-primary focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                />
              </FormField>

              <FormField label="Line Number">
                <input
                  type="number"
                  value={refLineNumber}
                  onChange={(e) => setRefLineNumber(e.target.value)}
                  placeholder="e.g., 42"
                  min="1"
                  disabled={isSubmitting}
                  className="w-full rounded-md border border-border bg-background-secondary px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:border-primary focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                />
              </FormField>

              <FormField label="Reference Name (optional)">
                <input
                  type="text"
                  value={refName}
                  onChange={(e) => setRefName(e.target.value)}
                  placeholder="e.g., main function"
                  disabled={isSubmitting}
                  className="w-full rounded-md border border-border bg-background-secondary px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:border-primary focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                />
              </FormField>

              <button
                type="button"
                onClick={handleAddCodeRef}
                disabled={isSubmitting || !refFilePath.trim() || !refLineNumber}
                className="w-full rounded-md border border-border bg-background-secondary px-3 py-2 text-sm font-medium text-text-secondary hover:bg-background-tertiary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Add Reference
              </button>
            </div>
          </div>
        )}

        {!criterion && (
          <div className="rounded-lg border border-border bg-background-tertiary p-4">
            <p className="text-xs text-text-muted">
              Save the criterion first to add code references.
            </p>
          </div>
        )}
      </div>
    </FormModal>
  );
}
