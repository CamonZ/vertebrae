import { useContext, useId, type ReactNode } from "react";
import {
  FileReferenceNavigationContext,
  type FileTarget,
} from "./FileReferenceNavigationContext";

/** Navigation does not persist timing, discover worktrees, or substitute files. */
export function ChatFileReferenceLink({
  target,
  unavailable,
  children,
}: {
  target: FileTarget;
  unavailable?: string;
  children: ReactNode;
}) {
  const descriptionId = useId();
  const navigate = useContext(FileReferenceNavigationContext);
  return (
    <span>
      <button
        data-testid="local-file-reference-link"
        data-actionable-reference="file"
        data-file-path={target.path}
        data-file-reference-id={JSON.stringify([
          target.history?.sessionId,
          target.history?.turnId,
          target.root,
          target.path,
          target.line,
          target.column,
        ])}
        data-file-line={target.line ?? undefined}
        data-file-column={target.column ?? undefined}
        aria-describedby={unavailable ? descriptionId : undefined}
        type="button"
        className="inline cursor-pointer rounded-sm bg-[var(--inline-code-bg)] px-1.5 py-0.5 font-mono text-13 text-[var(--inline-code-fg)] underline decoration-current/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onClick={() => navigate?.(target)}
      >
        <span className="pointer-events-none">{children}</span>
      </button>
      {unavailable && (
        <span id={descriptionId} className="text-13">
          {" "}
          {unavailable}
        </span>
      )}
    </span>
  );
}
