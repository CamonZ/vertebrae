import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  diffCommentHomeLabel,
  diffCommentLocation,
  type PendingDiffComment,
} from "../../ChatWindow/assistantTextComments";
import { SelectionDiscussionModelContext } from "../../ChatWindow/selectionDiscussionState";
import {
  DiscussionModelNotice,
  InlineSelectionDiscussion,
} from "../../ChatWindow/SelectionDiscussionContext";
import {
  DIFF_COMPOSER_SEND_SHORTCUT,
  DIFF_COMPOSER_SUBMIT_SHORTCUT,
  shortcutText,
} from "../../ChatWindow/chatShortcuts";
import { DiffReviewContext, type DiffReviewFocus } from "./DiffReviewContext";

/** Pierre annotation payload: comments (and a composer) at one diff line. */
export interface ReviewAnnotation {
  commentIds: string[];
  threadIds?: string[];
  /** A new comment is being written at this line. */
  draft: boolean;
}

function CommentCard({
  comment,
  focus,
}: {
  comment: PendingDiffComment;
  focus: DiffReviewFocus | null;
}): ReactNode {
  const review = useContext(DiffReviewContext);
  const ref = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment.body);
  useEffect(() => {
    if (focus) ref.current?.scrollIntoView?.({ block: "center" });
  }, [focus]);
  return (
    <div
      ref={ref}
      className="diff-comment"
      data-testid="diff-comment"
      data-diff-comment-id={comment.id}
      data-focused={focus ? "" : undefined}
      data-active={review?.activeCommentId === comment.id ? "" : undefined}
    >
      <div className="diff-comment-meta">
        <span className="diff-comment-where">
          {diffCommentHomeLabel(comment)} · {diffCommentLocation(comment)} (
          {comment.side})
        </span>
        {comment.outdated ? (
          <span className="diff-comment-outdated">outdated</span>
        ) : null}
        <span className="diff-comment-actions">
          <button
            type="button"
            aria-label="Edit diff comment"
            onClick={() => {
              setText(comment.body);
              setEditing(true);
            }}
          >
            Edit
          </button>
          <button
            type="button"
            aria-label="Remove diff comment"
            onClick={() => review?.removeComment(comment.id)}
          >
            Remove
          </button>
        </span>
      </div>
      {editing ? (
        <CommentEditor
          label="Edit comment"
          value={text}
          onChange={setText}
          submitLabel="Save"
          testIdPrefix="diff-comment-edit"
          onSubmit={() => {
            review?.updateComment(comment.id, text.trim());
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <p className="diff-comment-body">{comment.body}</p>
      )}
    </div>
  );
}

function CommentEditor({
  label,
  placeholder,
  value,
  onChange,
  submitLabel,
  testIdPrefix,
  onSubmit,
  onCancel,
  onSendToMain,
  disabled,
}: {
  label: string;
  placeholder?: string;
  value: string;
  onChange(value: string): void;
  submitLabel: string;
  testIdPrefix: string;
  onSubmit(): void;
  onCancel(): void;
  onSendToMain?(): void;
  disabled?: boolean;
}): ReactNode {
  const submitKeys = shortcutText(DIFF_COMPOSER_SUBMIT_SHORTCUT);
  const sendKeys = shortcutText(DIFF_COMPOSER_SEND_SHORTCUT);
  const canSubmit = !!value.trim() && !disabled;
  return (
    <div className="diff-comment-editor">
      <textarea
        autoFocus
        aria-label={label}
        placeholder={placeholder}
        data-testid={`${testIdPrefix}-input`}
        value={value}
        rows={3}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          if (event.shiftKey) onSendToMain?.();
          else if (canSubmit) onSubmit();
        }}
      />
      <div className="diff-comment-editor-actions">
        <span className="diff-comment-editor-hint" aria-hidden="true">
          <kbd>{submitKeys}</kbd> {submitLabel.toLowerCase()}
          {onSendToMain && (
            <>
              {" · "}
              <kbd>{sendKeys}</kbd> send to main chat
            </>
          )}
          {" · "}
          <kbd>esc</kbd> cancel
        </span>
        <div className="diff-comment-editor-buttons">
          <button type="button" title="Cancel (Esc)" onClick={onCancel}>
            Cancel
          </button>
          {onSendToMain && (
            <button
              type="button"
              title={`${DIFF_COMPOSER_SEND_SHORTCUT.label} (${sendKeys})`}
              aria-keyshortcuts="Meta+Shift+Enter"
              onClick={onSendToMain}
            >
              Send to main chat
            </button>
          )}
          <button
            type="button"
            data-primary
            data-testid={`${testIdPrefix}-submit`}
            title={`${submitLabel} (${submitKeys})`}
            aria-keyshortcuts="Meta+Enter"
            disabled={!canSubmit}
            onClick={onSubmit}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The comments (and optional composer) drawn at one diff line. */
export function DiffCommentThread({
  annotation,
  onSaveDraft,
  onCancelDraft,
  onDiscussDraft,
  onAttachDraft,
}: {
  annotation: ReviewAnnotation;
  onSaveDraft(body: string): void;
  onCancelDraft(): void;
  onDiscussDraft?(body: string): void;
  onAttachDraft?(body: string): void;
}): ReactNode {
  const review = useContext(DiffReviewContext);
  const choice = useContext(SelectionDiscussionModelContext);
  const [draft, setDraft] = useState("");
  const comments = annotation.commentIds
    .map((id) => review?.comments.find((comment) => comment.id === id))
    .filter((comment): comment is PendingDiffComment => comment != null);
  const submitDraft = () => {
    const body = draft.trim();
    const submit = onDiscussDraft ?? onSaveDraft;

    submit(body);
  };
  const sendDraftToMain = () => onAttachDraft?.(draft.trim());

  return (
    <div className="diff-comment-thread" data-owns-escape="">
      {annotation.threadIds?.map((id) => (
        <InlineSelectionDiscussion key={id} threadId={id} />
      ))}
      {comments.map((comment) => (
        <CommentCard
          key={comment.id}
          comment={comment}
          focus={review?.focus?.commentId === comment.id ? review.focus : null}
        />
      ))}
      {annotation.draft ? (
        <div role="dialog" aria-label="Comment on selected code">
          {onDiscussDraft && <DiscussionModelNotice />}
          <CommentEditor
            disabled={!!onDiscussDraft && !!choice?.error}
            label="New diff comment"
            placeholder={onDiscussDraft ? "Ask about selected code…" : "Write a comment…"}
            value={draft}
            onChange={setDraft}
            submitLabel={onDiscussDraft ? "Discuss inline" : "Add comment"}
            testIdPrefix="diff-comment-draft"
            onSubmit={submitDraft}
            onSendToMain={onAttachDraft ? sendDraftToMain : undefined}
            onCancel={onCancelDraft}
          />
        </div>
      ) : null}
    </div>
  );
}
