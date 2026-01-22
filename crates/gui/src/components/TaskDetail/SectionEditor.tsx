import { useState, useCallback } from 'react';
import type { Section, SectionType } from '../../bindings';
import { commands } from '../../bindings';
import { FormModal } from '../forms/FormModal';
import { FormField } from '../forms/FormField';

interface SectionEditorProps {
  /**
   * The task ID this section belongs to
   */
  taskId: string;
  /**
   * The section being edited, or null for new section
   */
  section?: Section;
  /**
   * The section type
   */
  sectionType: SectionType;
  /**
   * Whether the modal is open
   */
  isOpen: boolean;
  /**
   * Called when the modal should close
   */
  onClose: () => void;
  /**
   * Called when a section is successfully saved
   */
  onSave?: () => void;
}

/**
 * SectionEditor component for editing basic text sections (goal, context, constraint, etc.)
 *
 * Provides:
 * - Text area for editing section content
 * - Validation before submission
 * - Loading state during save
 * - Optimistic updates via callback
 */
export function SectionEditor({
  taskId,
  section,
  sectionType,
  isOpen,
  onClose,
  onSave,
}: SectionEditorProps) {
  const [content, setContent] = useState(section?.content ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Format section type for display
  const formatSectionType = (type: SectionType): string => {
    return type.replace(/_/g, ' ').split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  };

  // Handle modal close
  const handleClose = useCallback(() => {
    // Reset form when closing
    setContent(section?.content ?? '');
    setError(null);
    onClose();
  }, [section, onClose]);

  // Handle submit
  const handleSubmit = useCallback(async () => {
    // Validate input
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      setError('Content cannot be empty');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      if (section) {
        // Edit existing section
        const result = await commands.editSection(
          taskId,
          sectionType,
          section.ordinal ?? 0,
          trimmedContent
        );
        if (result.status === 'error') {
          setError(result.error.message);
          return;
        }
      } else {
        // Add new section
        const result = await commands.addSection(taskId, sectionType, trimmedContent);
        if (result.status === 'error') {
          setError(result.error.message);
          return;
        }
      }

      // Success - reset form and close
      setContent('');
      onSave?.();
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save section');
    } finally {
      setIsSubmitting(false);
    }
  }, [taskId, section, sectionType, content, onSave, handleClose]);

  return (
    <FormModal
      isOpen={isOpen}
      title={`${section ? 'Edit' : 'New'} ${formatSectionType(sectionType)}`}
      onClose={handleClose}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      error={error}
      submitButtonText={section ? 'Save' : 'Create'}
    >
      <FormField
        label={formatSectionType(sectionType)}
        required
        error={error && !content.trim() ? error : undefined}
      >
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={`Enter ${formatSectionType(sectionType).toLowerCase()}...`}
          disabled={isSubmitting}
          className="w-full rounded-md border border-border bg-background-tertiary px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:border-primary focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
          rows={6}
        />
      </FormField>
    </FormModal>
  );
}
