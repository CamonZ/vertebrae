import { useState, useCallback } from 'react';
import type { CodeRef } from '../../bindings';

interface TaskCodeRefsProps {
  codeRefs: CodeRef[];
}

interface CodeRefItemProps {
  codeRef: CodeRef;
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
 * Individual code reference item with copy functionality
 */
function CodeRefItem({ codeRef }: CodeRefItemProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
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
    <div className="group flex items-start justify-between gap-2 rounded-md bg-bg-tertiary px-3 py-2">
      <div className="min-w-0 flex-1">
        {codeRef.name && (
          <p className="text-sm font-medium text-text-primary">{codeRef.name}</p>
        )}
        <div className="flex items-center gap-2">
          <code className="truncate font-mono text-xs text-text-secondary">
            {codeRef.path}
          </code>
          {lineRange && (
            <span className="flex-shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-xs text-primary">
              {lineRange}
            </span>
          )}
        </div>
        {codeRef.description && (
          <p className="mt-1 text-xs text-text-muted">{codeRef.description}</p>
        )}
      </div>
      <button
        type="button"
        onClick={handleCopy}
        className="flex-shrink-0 rounded p-1 text-text-muted opacity-0 transition-opacity hover:bg-bg-secondary hover:text-text-primary focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-border-focus group-hover:opacity-100 cursor-pointer"
        title="Copy path"
        aria-label={copied ? 'Copied!' : 'Copy path to clipboard'}
      >
        {copied ? (
          <svg className="h-4 w-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
 * TaskCodeRefs displays a list of code references with file paths, line numbers,
 * and copy-to-clipboard functionality.
 */
export function TaskCodeRefs({ codeRefs }: TaskCodeRefsProps) {
  if (codeRefs.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-sm text-text-muted">
        No code references
      </div>
    );
  }

  return (
    <div className="space-y-2 p-4">
      {codeRefs.map((codeRef, index) => (
        <CodeRefItem key={`${codeRef.path}-${index}`} codeRef={codeRef} />
      ))}
    </div>
  );
}
