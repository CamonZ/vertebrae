import { useState, useCallback, useRef, useEffect } from 'react';
import type { CodeRef } from '../../bindings';
import { commands } from '../../bindings';
import { Chip } from '../atoms/Chip';
import { Button } from '../atoms/Button';

interface TaskCodeRefsProps {
  codeRefs: CodeRef[];
  taskId: string;
  onCodeRefsChanged?: () => void;
}

interface CodeRefFormData {
  path: string;
  lineStart: string;
  lineEnd: string;
  name: string;
  description: string;
}

/**
 * Format line range for display
 */
function formatLineRange(lineStart: number | null, lineEnd: number | null): string {
  if (lineStart === null) return '';
  if (lineEnd === null || lineEnd === lineStart) return `L${lineStart}`;
  return `L${lineStart}-${lineEnd}`;
}

/**
 * Format full path with line range for copying
 */
function formatFullPath(codeRef: CodeRef): string {
  const lineRange = formatLineRange(codeRef.line_start, codeRef.line_end);
  return lineRange ? `${codeRef.path}:${lineRange}` : codeRef.path;
}

/**
 * Parse a code ref string like "path/to/file.rs:L42" or "path/to/file.rs:L42-50"
 */
function parseCodeRefString(input: string): { path: string; lineStart: number | null; lineEnd: number | null } {
  const lineMatch = input.match(/^(.+):L(\d+)(?:-(\d+))?$/);
  if (lineMatch) {
    return {
      path: lineMatch[1],
      lineStart: parseInt(lineMatch[2], 10),
      lineEnd: lineMatch[3] ? parseInt(lineMatch[3], 10) : null,
    };
  }
  return { path: input, lineStart: null, lineEnd: null };
}

const inputClasses =
  'rounded-[var(--radius-sm)] border border-[var(--color-line)] bg-[var(--color-bg-1)] px-2 py-1.5 text-sm text-[var(--color-fg)] placeholder-[var(--color-fg-faint)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50';

interface CodeRefFormProps {
  initialData?: CodeRef;
  onSave: (data: CodeRefFormData) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
  isDeleting?: boolean;
}

/**
 * Form for adding/editing a code reference
 */
function CodeRefForm({ initialData, onSave, onCancel, onDelete, isDeleting }: CodeRefFormProps) {
  const [formData, setFormData] = useState<CodeRefFormData>({
    path: initialData?.path ?? '',
    lineStart: initialData?.line_start?.toString() ?? '',
    lineEnd: initialData?.line_end?.toString() ?? '',
    name: initialData?.name ?? '',
    description: initialData?.description ?? '',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    pathInputRef.current?.focus();
  }, []);

  const handleChange = useCallback((field: keyof CodeRefFormData, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (error) setError(null);
  }, [error]);

  const handleSubmit = useCallback(async () => {
    if (!formData.path.trim()) {
      setError('Path is required');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await onSave(formData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsSubmitting(false);
    }
  }, [formData, onSave]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }, [onCancel, handleSubmit]);

  const disabled = isSubmitting || isDeleting;

  return (
    <div className="space-y-3 rounded-[var(--radius-md)] bg-[var(--color-bg-2)] p-3" onKeyDown={handleKeyDown}>
      {/* Path input with indicator */}
      <div className="flex items-start gap-2">
        <span className="mt-2.5 h-2 w-2 flex-shrink-0 rounded-full bg-[var(--color-warn)]" />
        <div className="flex-1 space-y-2">
          <input
            ref={pathInputRef}
            type="text"
            value={formData.path}
            onChange={(e) => handleChange('path', e.target.value)}
            placeholder="File path (e.g., src/main.rs or src/main.rs:L42)"
            disabled={disabled}
            className={`w-full ${inputClasses}`}
          />

          {/* Optional fields in a row */}
          <div className="flex gap-2">
            <input
              type="text"
              value={formData.lineStart}
              onChange={(e) => handleChange('lineStart', e.target.value.replace(/\D/g, ''))}
              placeholder="Start line"
              disabled={disabled}
              className={`w-24 ${inputClasses}`}
            />
            <input
              type="text"
              value={formData.lineEnd}
              onChange={(e) => handleChange('lineEnd', e.target.value.replace(/\D/g, ''))}
              placeholder="End line"
              disabled={disabled}
              className={`w-24 ${inputClasses}`}
            />
            <input
              type="text"
              value={formData.name}
              onChange={(e) => handleChange('name', e.target.value)}
              placeholder="Name (optional)"
              disabled={disabled}
              className={`flex-1 ${inputClasses}`}
            />
          </div>

          <input
            type="text"
            value={formData.description}
            onChange={(e) => handleChange('description', e.target.value)}
            placeholder="Description (optional)"
            disabled={disabled}
            className={`w-full ${inputClasses}`}
          />
        </div>
      </div>

      {error && (
        <p className="text-xs text-[var(--color-err)] ml-4">{error}</p>
      )}

      {/* Action buttons */}
      <div className="flex items-center justify-end gap-1 ml-4">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={disabled}
          className="p-1.5 rounded-[var(--radius-sm)] text-[var(--color-warn)] hover:bg-[var(--color-warn-wash)] transition-colors disabled:opacity-50 cursor-pointer"
          title="Save (Ctrl+Enter)"
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
          onClick={onCancel}
          disabled={disabled}
          className="p-1.5 rounded-[var(--radius-sm)] text-[var(--color-fg-mute)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)] transition-colors disabled:opacity-50 cursor-pointer"
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
            disabled={disabled}
            className="p-1.5 rounded-[var(--radius-sm)] text-[var(--color-fg-mute)] hover:bg-[var(--color-err-wash)] hover:text-[var(--color-err)] transition-colors disabled:opacity-50 cursor-pointer"
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
  );
}

interface CodeRefItemProps {
  codeRef: CodeRef;
  onEdit: () => void;
}

/**
 * Individual code reference item with copy functionality and click-to-edit
 */
function CodeRefItem({ codeRef, onEdit }: CodeRefItemProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    const fullPath = formatFullPath(codeRef);
    try {
      await navigator.clipboard.writeText(fullPath);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  }, [codeRef]);

  const lineRange = formatLineRange(codeRef.line_start, codeRef.line_end);

  return (
    <div
      className="group flex cursor-pointer items-start justify-between gap-2 rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-bg-1)] px-3 py-2 transition-[border-color,background-color] duration-[var(--t-base)] ease-[var(--ease-default)] hover:border-[var(--color-line-strong)] hover:bg-[var(--color-bg-2)]"
      onClick={onEdit}
      title="Click to edit"
    >
      <div className="min-w-0 flex-1">
        {codeRef.name && (
          <p className="text-sm font-medium text-[var(--color-fg)]">{codeRef.name}</p>
        )}
        <div className="flex items-center gap-2">
          <code className="truncate font-mono text-xs text-[var(--color-fg-soft)]">
            {codeRef.path}
          </code>
          {lineRange && (
            <Chip variant="static" className="flex-shrink-0 font-mono text-[var(--color-accent)]">
              {lineRange}
            </Chip>
          )}
        </div>
        {codeRef.description && (
          <p className="mt-1 text-xs text-[var(--color-fg-mute)]">{codeRef.description}</p>
        )}
      </div>
      <button
        type="button"
        onClick={handleCopy}
        className="flex-shrink-0 rounded-[var(--radius-sm)] p-1 text-[var(--color-fg-mute)] opacity-0 transition-opacity hover:bg-[var(--color-bg-1)] hover:text-[var(--color-fg)] focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] group-hover:opacity-100 cursor-pointer"
        title="Copy path"
        aria-label={copied ? 'Copied!' : 'Copy path to clipboard'}
      >
        {copied ? (
          <svg className="h-4 w-4 text-[var(--color-ok)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
            />
          </svg>
        )}
      </button>
    </div>
  );
}

/**
 * TaskCodeRefs displays and manages a list of code references.
 * Supports add, edit, and delete operations with consistent inline editing UX.
 */
export function TaskCodeRefs({ codeRefs, taskId, onCodeRefsChanged }: TaskCodeRefsProps) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [deletingIndex, setDeletingIndex] = useState<number | null>(null);

  const handleAdd = useCallback(async (formData: CodeRefFormData) => {
    // Parse path for potential line info
    const parsed = parseCodeRefString(formData.path.trim());

    const result = await commands.addCodeRef(
      taskId,
      parsed.path,
      formData.lineStart ? parseInt(formData.lineStart, 10) : parsed.lineStart,
      formData.lineEnd ? parseInt(formData.lineEnd, 10) : parsed.lineEnd,
      formData.name.trim() || null,
      formData.description.trim() || null
    );

    if (result.status === 'error') {
      throw new Error(result.error.message);
    }

    setIsAdding(false);
    onCodeRefsChanged?.();
  }, [taskId, onCodeRefsChanged]);

  const handleEdit = useCallback(async (index: number, formData: CodeRefFormData) => {
    const parsed = parseCodeRefString(formData.path.trim());

    // Create updated refs array with the modified ref
    const updatedRefs = codeRefs.map((ref, i) => {
      if (i === index) {
        return {
          path: parsed.path,
          line_start: formData.lineStart ? parseInt(formData.lineStart, 10) : parsed.lineStart,
          line_end: formData.lineEnd ? parseInt(formData.lineEnd, 10) : parsed.lineEnd,
          name: formData.name.trim() || null,
          description: formData.description.trim() || null,
        };
      }
      return ref;
    });

    const result = await commands.replaceCodeRefs(taskId, updatedRefs);

    if (result.status === 'error') {
      throw new Error(result.error.message);
    }

    setEditingIndex(null);
    onCodeRefsChanged?.();
  }, [taskId, codeRefs, onCodeRefsChanged]);

  const handleDelete = useCallback(async (index: number) => {
    setDeletingIndex(index);
    try {
      const result = await commands.removeCodeRefs(taskId, [index]);
      if (result.status === 'error') {
        console.error('Failed to delete code ref:', result.error.message);
      } else {
        onCodeRefsChanged?.();
      }
    } catch (err) {
      console.error('Failed to delete code ref:', err);
    } finally {
      setDeletingIndex(null);
      setEditingIndex(null);
    }
  }, [taskId, onCodeRefsChanged]);

  return (
    <div className="flex flex-col h-full">
      {/* Add code ref button */}
      <div className="border-b border-[var(--color-line)] p-4">
        {isAdding ? (
          <CodeRefForm
            onSave={handleAdd}
            onCancel={() => setIsAdding(false)}
          />
        ) : (
          <Button
            variant="secondary"
            fullWidth
            onClick={() => setIsAdding(true)}
            disabled={editingIndex !== null}
            iconLeft={
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            }
          >
            Add Code Reference
          </Button>
        )}
      </div>

      {/* Code refs list */}
      <div className="flex-1 overflow-auto p-4">
        {codeRefs.length === 0 && !isAdding ? (
          <div className="text-center text-sm text-[var(--color-fg-mute)] py-6">
            No code references
          </div>
        ) : (
          <div className="space-y-2">
            {codeRefs.map((codeRef, index) => (
              editingIndex === index ? (
                <CodeRefForm
                  key={`${codeRef.path}-${index}-edit`}
                  initialData={codeRef}
                  onSave={(formData) => handleEdit(index, formData)}
                  onCancel={() => setEditingIndex(null)}
                  onDelete={() => handleDelete(index)}
                  isDeleting={deletingIndex === index}
                />
              ) : (
                <CodeRefItem
                  key={`${codeRef.path}-${index}`}
                  codeRef={codeRef}
                  onEdit={() => setEditingIndex(index)}
                />
              )
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
