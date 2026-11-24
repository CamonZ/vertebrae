import type { ReactNode } from "react";
import { EmptyState } from "../molecules/EmptyState";

/**
 * A side-column section with nothing to list: a centred muted icon, a small
 * title, and optionally a muted hint (use `<kbd className="chat-comment-kbd">`).
 * The same `EmptyState` hierarchy as Artifacts and Daemons.
 */
export function SideEmptyState({
  icon,
  message,
  hint,
}: {
  icon: ReactNode;
  message: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <EmptyState
      className="side-empty-state"
      icon={icon}
      title={message}
      description={hint && <span className="side-empty-hint">{hint}</span>}
    />
  );
}
