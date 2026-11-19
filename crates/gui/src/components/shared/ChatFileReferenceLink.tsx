import { useContext, useId, type ReactNode } from "react";
import { Tooltip } from "../atoms/Tooltip";
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
      <Tooltip
        label={<span className="whitespace-normal">{unavailable}</span>}
        disabled={!unavailable}
        portal
      >
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
          className={`inline cursor-pointer rounded-sm px-1.5 py-0.5 font-mono text-13 underline decoration-current/30 ${
            unavailable
              ? "bg-[var(--warn-wash)] text-[var(--warn)]"
              : "bg-[var(--inline-code-bg)] text-[var(--inline-code-fg)]"
          }`}
          onClick={() => navigate?.(target)}
        >
          <span className="pointer-events-none">{children}</span>
        </button>
      </Tooltip>
      {unavailable && (
        <span id={descriptionId} className="sr-only">
          {unavailable}
        </span>
      )}
    </span>
  );
}
