import { Fragment, type ReactNode } from "react";
import type { LocalChatSessionSummary } from "../../utils/localChatPersistence";
import {
  localChatGroupRows,
  type LocalChatRunRow,
} from "../../utils/localChatSessionGroups";

export interface SessionRowState {
  isActive: boolean;
}

interface SessionListGroup {
  id: string;
  sessions: LocalChatSessionSummary[];
  runs?: LocalChatRunRow[];
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
  /** Render a TaskRun row; runs interleave with sessions by recency. */
  renderRunRow?: (run: LocalChatRunRow) => ReactNode;
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
  renderRunRow,
  renderGroup,
  getChildGroups,
}: SessionGroupListProps<Group>) {
  return (
    <>
      {sessionGroups.map((group) => {
        const rows = localChatGroupRows({
          sessions: group.sessions,
          runs: renderRunRow ? group.runs : undefined,
        }).map((row) =>
          row.kind === "session" ? (
            <Fragment key={row.session.id}>
              {renderRow(row.session, {
                isActive: row.session.id === activeSessionId,
              })}
            </Fragment>
          ) : (
            <Fragment key={`run:${row.run.id}`}>
              {renderRunRow!(row.run)}
            </Fragment>
          )
        );

        const children = getChildGroups?.(group) ?? [];

        if (children.length) {
          rows.unshift(
            <SessionGroupList
              key="child-groups"
              sessionGroups={children}
              activeSessionId={activeSessionId}
              getChildGroups={getChildGroups}
              renderRow={renderRow}
              renderRunRow={renderRunRow}
              renderGroup={renderGroup}
            />
          );
        }

        return <Fragment key={group.id}>{renderGroup(group, rows)}</Fragment>;
      })}
    </>
  );
}
