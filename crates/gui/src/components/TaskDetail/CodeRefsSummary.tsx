import { useState, useCallback, useEffect, useRef } from "react";
import type { CodeRef } from "../../bindings";
import { useCurrentProject } from "../../hooks/useCurrentProject";
import { LocalFileReferenceLink } from "../shared/LocalFileReferenceLink";
import { parseLocalFileReference } from "../shared/localFileReference";

interface CodeRefsSummaryProps {
  codeRefs: CodeRef[];
  /** Task worktrees take precedence over the globally selected project root. */
  projectRoot?: string | null;
}

function formatLineRange(
  lineStart: number | null,
  lineEnd: number | null
): string | null {
  if (lineStart === null) return null;
  if (lineEnd === null || lineEnd === lineStart) return `L${lineStart}`;
  return `L${lineStart}-${lineEnd}`;
}

function formatFullPath(codeRef: CodeRef): string {
  const lineRange = formatLineRange(codeRef.line_start, codeRef.line_end);
  return lineRange ? `${codeRef.path}:${lineRange}` : codeRef.path;
}

function CodeRefItem({
  codeRef,
  projectRoot,
}: {
  codeRef: CodeRef;
  projectRoot: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const lineRange = formatLineRange(codeRef.line_start, codeRef.line_end);
  const parsedReference = projectRoot
    ? parseLocalFileReference(codeRef.path, projectRoot)
    : null;
  const fileReference = parsedReference
    ? {
        ...parsedReference,
        line: codeRef.line_start ?? parsedReference.line,
      }
    : null;
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      const fullPath = formatFullPath(codeRef);
      try {
        await navigator.clipboard.writeText(fullPath);
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error("Failed to copy:", err);
      }
    },
    [codeRef]
  );

  return (
    <div className="group flex items-center justify-between gap-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-2)] px-2.5 py-1.5">
      <div className="min-w-0 flex-1 flex items-center gap-2">
        <svg
          className="h-3 w-3 flex-shrink-0 text-[var(--color-fg-mute)]"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
          />
        </svg>
        {fileReference && projectRoot ? (
          <LocalFileReferenceLink
            reference={fileReference}
            projectRoot={projectRoot}
          >
            <code className="truncate font-mono text-xs text-[var(--color-fg-soft)]">
              {codeRef.path.split("/").pop() ?? codeRef.path}
            </code>
            {lineRange && (
              <span className="flex-shrink-0 rounded-[var(--radius-sm)] bg-[var(--color-accent-wash)] px-1 py-0.5 font-mono text-2xs text-[var(--color-accent)]">
                {lineRange}
              </span>
            )}
          </LocalFileReferenceLink>
        ) : (
          <>
            <code className="truncate font-mono text-xs text-[var(--color-fg-soft)]">
              {codeRef.path.split("/").pop() ?? codeRef.path}
            </code>
            {lineRange && (
              <span className="flex-shrink-0 rounded-[var(--radius-sm)] bg-[var(--color-accent-wash)] px-1 py-0.5 font-mono text-2xs text-[var(--color-accent)]">
                {lineRange}
              </span>
            )}
          </>
        )}
        {codeRef.name && (
          <span className="truncate text-xs text-[var(--color-fg-mute)]">
            {codeRef.name}
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={handleCopy}
        className="flex-shrink-0 rounded-[var(--radius-sm)] p-1 text-[var(--color-fg-mute)] opacity-0 transition-opacity hover:text-[var(--color-fg)] group-hover:opacity-100 cursor-pointer"
        title="Copy path"
        aria-label={copied ? "Copied!" : "Copy path to clipboard"}
      >
        {copied ? (
          <svg
            className="h-3 w-3 text-[var(--color-ok)]"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 13l4 4L19 7"
            />
          </svg>
        ) : (
          <svg
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
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

export function CodeRefsSummary({ codeRefs, projectRoot }: CodeRefsSummaryProps) {
  const { path: currentProjectRoot } = useCurrentProject();
  const fileRoot = projectRoot ?? currentProjectRoot;

  if (codeRefs.length === 0) {
    return (
      <div className="px-4 py-3">
        <p className="text-sm text-[var(--color-fg-mute)] italic">
          No code references
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 px-4 py-3" data-testid="code-refs-summary">
      {codeRefs.map((ref, index) => (
        <CodeRefItem
          key={`${ref.path}-${index}`}
          codeRef={ref}
          projectRoot={fileRoot}
        />
      ))}
    </div>
  );
}
