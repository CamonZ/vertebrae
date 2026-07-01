import { Fragment, type ReactNode } from "react";
import type { LocalChatSessionGroup } from "../../utils/localChatSessionGroups";
import type { LocalChatSessionSummary } from "../../utils/localChatPersistence";

export interface SessionRowState {
  isActive: boolean;
  isDeleting: boolean;
}

interface SessionGroupListProps {
  sessionGroups: LocalChatSessionGroup[];
  activeSessionId: string;
  deletingSessionId: string | null;
  /** Render a single session row. The list keys rows by session id. */
  renderRow: (
    session: LocalChatSessionSummary,
    state: SessionRowState
  ) => ReactNode;
  /** Wrap a group's rows with its title/section markup. */
  renderGroup: (
    group: LocalChatSessionGroup,
    rows: ReactNode[]
  ) => ReactNode;
}

/**
 * Shared iteration over project-grouped local chat sessions. Computes the
 * active/deleting state for each row and delegates rendering to consumers,
 * which supply their own group-section and row markup. The two history views
 * (mini panel + drawer) render nearly identical session-group data with
 * different row styling; this component holds the shared iteration and
 * active/inactive state derivation.
 */
export function SessionGroupList({
  sessionGroups,
  activeSessionId,
  deletingSessionId,
  renderRow,
  renderGroup,
}: SessionGroupListProps) {
  return (
    <>
      {sessionGroups.map((group) => {
        const rows = group.sessions.map((session) => (
          <Fragment key={session.id}>
            {renderRow(session, {
              isActive: session.id === activeSessionId,
              isDeleting: session.id === deletingSessionId,
            })}
          </Fragment>
        ));
        return <Fragment key={group.id}>{renderGroup(group, rows)}</Fragment>;
      })}
    </>
  );
}
