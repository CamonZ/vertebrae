import { useContext, useMemo, useState, type ReactNode } from "react";
import { MarkdownContent } from "../shared/MarkdownContent";
import { FileReferenceNavigationContext } from "../shared/FileReferenceNavigationContext";
import {
  ASSISTANT_RESPONSE_SELECTOR,
  lineRangeSuffix,
} from "./assistantTextComments";
import { findQuoteRange, revealCommentAnchor } from "./commentHighlight";
import {
  parseSentComments,
  type SentDiffComment,
  type SentTextComment,
} from "./sentCommentSet";
import "./chatComments.css";

/**
 * Find a sent text comment's quote in the assistant responses above the
 * user turn it was sent in, latest first.
 */
function findSentQuote(
  from: HTMLElement,
  comment: SentTextComment
): Range | null {
  if (!comment.selection.trim()) return null;
  const transcript =
    from.closest<HTMLElement>("[data-transcript-viewport]") ??
    from.ownerDocument.body;
  const responses = [
    ...transcript.querySelectorAll<HTMLElement>(ASSISTANT_RESPONSE_SELECTOR),
  ].filter(
    (response) =>
      response.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING
  );
  for (const response of responses.reverse()) {
    const responseId = response.dataset.localChatAssistantResponseId;
    if (!responseId) continue;
    const range = findQuoteRange(transcript, {
      responseId,
      quote: comment.selection,
      contextBefore: comment.contextBefore,
      contextAfter: comment.contextAfter,
    });
    if (range) return range;
  }
  return null;
}

function TextCommentCard({ comment }: { comment: SentTextComment }) {
  const [missing, setMissing] = useState(false);
  const label = missing
    ? "The quoted text is no longer in the transcript"
    : "Show the quoted text in the transcript";
  return (
    <li className="vtb-comment-card sent-comment" data-kind="text">
      <button
        type="button"
        className="vtb-comment-quote sent-comment-anchor"
        aria-label={`Comment ${comment.number}: ${label}`}
        title={label}
        data-missing={missing ? "" : undefined}
        onClick={(event) => {
          const range = findSentQuote(event.currentTarget, comment);
          setMissing(!range);
          if (range) revealCommentAnchor(range);
        }}
      >
        {comment.lines.map((segments, line) => (
          <span key={line} className="sent-comment-quote-line">
            {segments.map((segment, index) =>
              segment.selected ? (
                <mark key={index}>{segment.text}</mark>
              ) : (
                <span key={index}>{segment.text}</span>
              )
            )}
          </span>
        ))}
      </button>
      {comment.body ? (
        <p className="vtb-comment-body sent-comment-body">{comment.body}</p>
      ) : null}
    </li>
  );
}

/** A GitHub thread sent as a comment reads back as one: its home names it. */
function isGithubThread(comment: SentDiffComment): boolean {
  return /^GitHub thread( from |$)/.test(comment.home);
}

function DiffCommentCard({ comment }: { comment: SentDiffComment }) {
  const navigate = useContext(FileReferenceNavigationContext);
  const location = `${comment.path}${lineRangeSuffix(comment)}`;
  const github = isGithubThread(comment);
  return (
    <li
      className="vtb-comment-card sent-comment"
      data-kind={github ? "github_thread" : "diff"}
    >
      <button
        type="button"
        className="vtb-comment-meta sent-comment-anchor"
        disabled={!navigate}
        aria-label={`Comment ${comment.number}: ${github ? `${comment.home}, ` : ""}open ${location} (${comment.side})`}
        title={`Open ${location}`}
        onClick={() =>
          navigate?.({
            root: null,
            path: comment.path,
            line: comment.startLine,
            column: null,
          })
        }
      >
        {github && <span className="sent-comment-home">{comment.home}</span>}
        <span className="sent-comment-location">{location}</span>
        <span>{comment.side}</span>
        {comment.outdated ? (
          <span className="vtb-comment-outdated">outdated</span>
        ) : null}
      </button>
      {comment.hunk ? (
        <pre className="vtb-comment-quote vtb-comment-quote-code">
          {comment.hunk}
        </pre>
      ) : null}
      {comment.body && github ? (
        // The thread's comments and the private discussion, as written.
        <div className="sent-comment-body sent-comment-markdown">
          <MarkdownContent text={comment.body} />
        </div>
      ) : comment.body ? (
        <p className="vtb-comment-body sent-comment-body">{comment.body}</p>
      ) : null}
    </li>
  );
}

/**
 * A user turn sent with pending comments: a compact quote card per comment,
 * each able to jump back to what it quoted, then the follow-up text. Text
 * that is not a comment set renders as ordinary markdown.
 */
export function SentComments({ text }: { text: string }): ReactNode {
  const set = useMemo(() => parseSentComments(text), [text]);
  if (!set) return <MarkdownContent text={text} />;
  return (
    <div className="sent-comments">
      <ol className="sent-comments-list" aria-label={set.heading}>
        {set.comments.map((comment) =>
          comment.kind === "text" ? (
            <TextCommentCard key={comment.number} comment={comment} />
          ) : (
            <DiffCommentCard key={comment.number} comment={comment} />
          )
        )}
      </ol>
      {set.followUp ? (
        <div className="sent-comments-follow-up">
          <MarkdownContent text={set.followUp} />
        </div>
      ) : null}
    </div>
  );
}
