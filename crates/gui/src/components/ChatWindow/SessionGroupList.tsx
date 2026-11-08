import { Fragment, type ReactNode } from "react";
import type { LocalChatSessionSummary } from "../../utils/localChatPersistence";

export interface SessionRowState {
  isActive: boolean;
}

interface SessionListGroup {
  id: string;
  sessions: LocalChatSessionSummary[];
}

interface SessionGroupListProps<Group extends SessionListGroup> {
  sessionGroups: Group[];
  activeSessionId: string;
  getChildGroups?: (group: Group) => Group[];
  /** Render a single session row. The list keys rows by session id. */
  renderRow: (
    session: LocalChatSessionSummary,
    state: SessionRowState
  ) => ReactNode;
  /** Wrap a group's rows with its title/section markup. */
  renderGroup: (group: Group, rows: ReactNode[]) => ReactNode;
}

/**
 * Shared iteration over grouped local chat sessions. Computes the
 * active state for each row and delegates section and row markup to consumers.
 * Project history and ticket accordions share stable session keys and the same
 * active/inactive state derivation.
 */
export function SessionGroupList<Group extends SessionListGroup>({
  sessionGroups,
  activeSessionId,
  renderRow,
  renderGroup,
  getChildGroups,
}: SessionGroupListProps<Group>) {
  return (
    <>
      {sessionGroups.map((group) => {
        const rows = group.sessions.map((session) => (
          <Fragment key={session.id}>
            {renderRow(session, {
              isActive: session.id === activeSessionId,
            })}
          </Fragment>
        ));

        const children = getChildGroups?.(group) ?? [];

        if (children.length) {
          rows.unshift(
            <SessionGroupList
              key="child-groups"
              sessionGroups={children}
              activeSessionId={activeSessionId}
              getChildGroups={getChildGroups}
              renderRow={renderRow}
              renderGroup={renderGroup}
            />
          );
        }

        return <Fragment key={group.id}>{renderGroup(group, rows)}</Fragment>;
      })}
    </>
  );
}
