import { useChatStore } from "../../stores/chatStore";
import { readRecord } from "../../hooks/useChatAssociation";
import type { LocalChatSessionSummary } from "../../utils/localChatPersistence";
import { Icon } from "../atoms/Icon";
import { Tooltip } from "../atoms/Tooltip";
import "./chatAssociation.css";

/** Read each row's own live record; history snapshots can lag corrections. */
export function ConversationAssociations({
  session,
}: {
  session: LocalChatSessionSummary;
}) {
  const liveSession = useChatStore(
    (state) => state.localSessionSummaries[session.id]
  );
  const record = readRecord((liveSession ?? session).association);
  const ticket = record.ticketId
    ? `Ticket: ${record.ticketId}${record.ticketTitle ? ` · ${record.ticketTitle}` : ""}`
    : null;
  const worktree = record.worktreePath
    ? `Worktree: ${record.worktreePath}${record.branch ? ` (${record.branch})` : ""}`
    : null;
  return (
    <div
      className="conversation-associations"
      aria-label="Conversation associations"
    >
      {ticket && (
        <Tooltip
          portal
          label={<span className="association-tooltip-text">{ticket}</span>}
          placement="right"
        >
          <span tabIndex={0} role="img" aria-label={ticket}>
            <Icon size="xs">
              <path d="M4 5h16v5a2 2 0 000 4v5H4v-5a2 2 0 000-4V5Z" />
              <path d="M9 5v14" />
            </Icon>
          </span>
        </Tooltip>
      )}
      {worktree && (
        <Tooltip
          portal
          label={<span className="association-tooltip-text">{worktree}</span>}
          placement="right"
        >
          <span tabIndex={0} role="img" aria-label={worktree}>
            <Icon size="xs">
              <circle cx="6" cy="5" r="2" />
              <circle cx="6" cy="19" r="2" />
              <circle cx="18" cy="5" r="2" />
              <path d="M6 7v10m12-10a6 6 0 01-6 6H6" />
            </Icon>
          </span>
        </Tooltip>
      )}
    </div>
  );
}
