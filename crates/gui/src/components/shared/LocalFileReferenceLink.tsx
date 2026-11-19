import type { ReactNode } from "react";
import { useOpenLocalFile } from "../../hooks/useOpenLocalFile";
import type { LocalFileReference } from "./localFileReference";

interface LocalFileReferenceLinkProps {
  reference: LocalFileReference;
  projectRoot: string;
  children: ReactNode;
}

export function LocalFileReferenceLink({
  reference,
  projectRoot,
  children,
}: LocalFileReferenceLinkProps) {
  const { open, opening, error } = useOpenLocalFile(
    projectRoot,
    reference.path,
    reference.line,
    reference.column
  );

  return (
    <>
      <button
        type="button"
        className="inline cursor-pointer rounded-sm bg-[var(--inline-code-bg)] px-1.5 py-0.5 font-mono text-13 text-[var(--inline-code-fg)] underline decoration-current/30 hover:decoration-current"
        data-testid="local-file-reference-link"
        data-actionable-reference="file"
        data-file-path={reference.path}
        data-file-line={reference.line ?? undefined}
        data-file-column={reference.column ?? undefined}
        aria-busy={opening}
        title="Open in external editor"
        onClick={() => void open()}
      >
        <span className="pointer-events-none">{children}</span>
      </button>
      {error && <span role="alert">{error}</span>}
    </>
  );
}
