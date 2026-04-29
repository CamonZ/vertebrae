import { useState, useCallback, useRef, useEffect, type KeyboardEvent, type ChangeEvent } from 'react';

export interface InlineEditFieldProps {
  /** Current value */
  value: string;
  /** Placeholder text when empty and not editing */
  placeholder?: string;
  /** Whether to use a textarea instead of input */
  multiline?: boolean;
  /** Number of rows for textarea */
  rows?: number;
  /** Callback when value is saved */
  onSave: (value: string) => Promise<void>;
  /** Optional validation function - returns error message or null */
  validate?: (value: string) => string | null;
  /** Allow saving empty values */
  allowEmpty?: boolean;
  /** Custom className for the display text */
  displayClassName?: string;
  /** Start in edit mode immediately (useful for add forms) */
  startInEditMode?: boolean;
  /** Callback when cancel is clicked (useful for add forms) */
  onCancel?: () => void;
  /** Clear the input after successful save (useful for add forms) */
  clearOnSave?: boolean;
  /** Custom prefix element to show before the input (e.g., step checkbox) */
  prefix?: React.ReactNode;
  /** Compact mode - less padding, used inline in lists */
  compact?: boolean;
  /** Callback when delete is clicked - shows trash icon when provided */
  onDelete?: () => void;
  /** Whether delete is in progress */
  isDeleting?: boolean;
  /** Render the input/textarea (and display text) with a monospace font */
  monospace?: boolean;
  /** Custom renderer for non-empty display mode (e.g. syntax-highlighted prompts).
   *  Empty values still fall back to the muted placeholder. */
  renderDisplay?: (value: string) => React.ReactNode;
}

/**
 * Generic inline edit field with check/cross icons for accept/cancel.
 * Click to edit, Enter to save, Escape to cancel.
 */
export function InlineEditField({
  value,
  placeholder = 'Click to edit',
  multiline = false,
  rows = 4,
  onSave,
  validate,
  allowEmpty = true,
  displayClassName = '',
  startInEditMode = false,
  onCancel,
  clearOnSave = false,
  prefix,
  compact = false,
  onDelete,
  isDeleting = false,
  monospace = false,
  renderDisplay,
}: InlineEditFieldProps) {
  const [isEditing, setIsEditing] = useState(startInEditMode);
  const [editValue, setEditValue] = useState(value);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  // Update edit value when prop changes (e.g., after external update)
  useEffect(() => {
    if (!isEditing) {
      setEditValue(value);
    }
  }, [value, isEditing]);

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      // Select all text (only for edit, not for add)
      if (!startInEditMode && inputRef.current instanceof HTMLInputElement) {
        inputRef.current.select();
      }
    }
  }, [isEditing, startInEditMode]);

  const handleEdit = useCallback(() => {
    setEditValue(value);
    setIsEditing(true);
    setError(null);
  }, [value]);

  const handleCancel = useCallback(() => {
    setIsEditing(false);
    setEditValue(value);
    setError(null);
    onCancel?.();
  }, [value, onCancel]);

  const handleSave = useCallback(async () => {
    const trimmed = editValue.trim();

    // Validation
    if (!allowEmpty && !trimmed) {
      setError('This field cannot be empty');
      return;
    }

    if (validate) {
      const validationError = validate(trimmed);
      if (validationError) {
        setError(validationError);
        return;
      }
    }

    // No change (only skip for edit mode, not add mode)
    if (!startInEditMode && trimmed === value) {
      setIsEditing(false);
      setError(null);
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await onSave(trimmed);
      if (clearOnSave) {
        setEditValue('');
      } else {
        setIsEditing(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsSubmitting(false);
    }
  }, [editValue, value, allowEmpty, validate, onSave, startInEditMode, clearOnSave]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      handleCancel();
    } else if (e.key === 'Enter') {
      // For textarea, require Ctrl+Enter to save
      if (multiline && !e.ctrlKey) {
        return;
      }
      e.preventDefault();
      handleSave();
    }
  }, [handleCancel, handleSave, multiline]);

  const handleChange = useCallback((e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setEditValue(e.target.value);
    // Clear error on change
    if (error) {
      setError(null);
    }
  }, [error]);

  if (isEditing) {
    const inputPadding = compact ? 'px-2 py-1' : 'px-3 py-2';
    const containerGap = compact ? 'gap-2' : 'gap-2';
    const buttonPadding = compact ? 'p-1' : 'p-1.5';
    const buttonMargin = compact ? 'mt-0.5' : 'mt-1.5';
    const dotMargin = compact ? 'mt-1.5' : 'mt-2.5';

    return (
      <div className="flex-1 min-w-0">
        <div className={`flex items-start ${containerGap}`}>
          {/* Status indicator dot */}
          <span className={`${dotMargin} h-2 w-2 flex-shrink-0 rounded-full bg-warning`} />

          {/* Optional prefix (e.g., step checkbox) */}
          {prefix}

          {multiline ? (
            <textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              value={editValue}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              disabled={isSubmitting || isDeleting}
              placeholder={placeholder}
              rows={rows}
              className={`flex-1 bg-bg-secondary border border-border rounded ${inputPadding} text-sm ${monospace ? 'font-mono' : ''} text-text-primary placeholder-text-muted focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 disabled:opacity-50 resize-none`}
            />
          ) : (
            <input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              type="text"
              value={editValue}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              disabled={isSubmitting || isDeleting}
              placeholder={placeholder}
              className={`flex-1 bg-bg-secondary border border-border rounded ${inputPadding} text-sm ${monospace ? 'font-mono' : ''} text-text-primary placeholder-text-muted focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 disabled:opacity-50`}
            />
          )}

          {/* Action buttons */}
          <div className={`flex-shrink-0 flex items-center gap-1 ${buttonMargin}`}>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSubmitting || isDeleting}
              className={`${buttonPadding} rounded text-warning hover:bg-warning/10 transition-colors disabled:opacity-50 cursor-pointer`}
              title="Save (Enter)"
              aria-label="Save"
            >
              {isSubmitting ? (
                <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              ) : (
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={isSubmitting || isDeleting}
              className={`${buttonPadding} rounded text-text-muted hover:bg-bg-tertiary hover:text-text-primary transition-colors disabled:opacity-50 cursor-pointer`}
              title="Cancel (Esc)"
              aria-label="Cancel"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                disabled={isSubmitting || isDeleting}
                className={`${buttonPadding} rounded text-text-muted hover:bg-error/10 hover:text-error transition-colors disabled:opacity-50 cursor-pointer`}
                title="Delete"
                aria-label="Delete"
              >
                {isDeleting ? (
                  <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                )}
              </button>
            )}
          </div>
        </div>
        {error && (
          <p className="text-xs text-error ml-4 mt-1">{error}</p>
        )}
      </div>
    );
  }

  // Display mode
  const isEmpty = !value;
  const displayText = value || placeholder;

  return (
    <div
      onClick={handleEdit}
      className={`cursor-pointer rounded p-2 hover:bg-bg-hover transition-colors ${displayClassName}`}
      title="Click to edit"
    >
      {!isEmpty && renderDisplay ? (
        renderDisplay(value)
      ) : (
        <p className={`text-sm ${monospace && !isEmpty ? 'font-mono' : ''} ${isEmpty ? 'text-text-muted italic' : 'text-text-secondary whitespace-pre-wrap leading-relaxed'}`}>
          {displayText}
        </p>
      )}
    </div>
  );
}
