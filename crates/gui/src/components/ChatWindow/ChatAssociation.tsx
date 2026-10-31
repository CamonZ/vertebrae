import { useRef, useState } from "react";
import type { AssociationRecord } from "../../hooks/useChatAssociation";
import { Icon } from "../atoms/Icon";
import "./chatAssociation.css";

export function ChatAssociation({
  record,
  diagnostic,
  onCorrect,
}: {
  record: AssociationRecord;
  diagnostic: string | null;
  onCorrect: (ticketId: string) => void;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const [ticket, setTicket] = useState("");
  const [error, setError] = useState<string | null>(null);
  const label = record.ticketId ? record.ticketId.slice(0, 8) : "No ticket";
  return (
    <details
      className="chat-association"
      ref={details}
      onKeyDown={(event) => {
        if (event.key === "Escape" && details.current?.open) {
          details.current.open = false;
          summary.current?.focus();
        }
      }}
    >
      <summary
        ref={summary}
        aria-label={`Conversation context: ${label}`}
        title="Conversation details and ticket correction"
      >
        <Icon size="sm">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v6m0-10v1" />
        </Icon>
      </summary>
      <div className="association-popover">
        {record.ticketId ? (
          <a href={`vtb://ticket/${record.ticketId}`}>
            {record.ticketTitle} · {record.ticketId}
          </a>
        ) : (
          <p>No active ticket established yet.</p>
        )}
        <p className="association-path">
          {record.worktreePath
            ? `${record.worktreePath}${record.branch ? ` (${record.branch})` : ""}`
            : record.awaitingWorktree
              ? "Waiting for the requested worktree to be created."
              : "Worktree not yet identified from tool activity."}
        </p>
        {diagnostic && <p role="status">{diagnostic}</p>}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            try {
              onCorrect(ticket);
              setError(null);
            } catch (reason) {
              setError(
                reason instanceof Error ? reason.message : String(reason)
              );
            }
          }}
        >
          <label>
            Ticket ID
            <input
              className="input"
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
              placeholder="Full or short ID; blank clears"
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <button type="submit" className="btn btn--ghost">
            Set ticket
          </button>
        </form>
      </div>
    </details>
  );
}
