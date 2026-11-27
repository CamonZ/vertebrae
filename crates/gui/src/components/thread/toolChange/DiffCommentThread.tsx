import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  diffCommentHomeLabel,
  diffCommentLocation,
  type PendingDiffComment,
} from "../../ChatWindow/assistantTextComments";
import { SelectionDiscussionModelContext } from "../../ChatWindow/selectionDiscussionState";
import type { CodeSelection } from "../../ChatWindow/selectionDiscussions";
import {
  DiscussionModelNotice,
  InlineSelectionDiscussion,
} from "../../ChatWindow/SelectionDiscussionThread";
import {
  DIFF_COMPOSER_SEND_SHORTCUT,
  DIFF_COMPOSER_SUBMIT_SHORTCUT,
  shortcutText,
} from "../../ChatWindow/chatShortcuts";
import { EditGlyph, TrashGlyph } from "../../ChatWindow/commentIcons";
import { DiffReviewContext, type DiffReviewFocus } from "./DiffReviewContext";
import { focusKeepProps } from "../../../utils/focusKeep";
import { useKeepFocus } from "../../../hooks/useKeepFocus";

/** Pierre annotation payload: comments (and a composer) at one diff line. */
export interface ReviewAnnotation {
  commentIds: string[];
  threadIds?: string[];
  /** A new comment is being written at this line. */
  draft: boolean;
  /** No comments or draft: the line only carries a label row. */
  labelOnly?: true;
  /** GitHub threads expanded under this line: their marker's key. */
  githubMarker?: string;
  /** The file's outdated GitHub threads are listed here. */
  githubOutdated?: true;
}

/** Whether a line carries Vertebrae comments, discussions or a draft. */
export function hasReviewContent(annotation: ReviewAnnotation): boolean {
  return (
    !annotation.labelOnly &&
    (annotation.draft ||
      annotation.commentIds.length > 0 ||
      (annotation.threadIds?.length ?? 0) > 0)
  );
}

/** Grow the textarea with its text; CSS caps it and it scrolls beyond. */
function fitTextarea(textarea: HTMLTextAreaElement) {
  const borders = textarea.offsetHeight - textarea.clientHeight;
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight + borders}px`;
}

const FOCUS_ATTEMPTS = 30;

/**
 * Focus the input once it is rendered. A diff annotation is slotted into
 * Pierre's shadow tree, which can attach it a frame or two after React
 * mounts it; `autoFocus` alone then focuses a not-yet-rendered element and
 * silently does nothing, so typing after the keyboard shortcut went nowhere.
 * Retry for a few frames while nothing else took focus.
 */
function useFocusOnMount(ref: RefObject<HTMLTextAreaElement | null>) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    let attempts = 0;
    const attempt = () => {
      if (!element.isConnected || document.activeElement === element) return;
      const active = document.activeElement;
      const taken =
        attempts > 0 &&
        (active instanceof HTMLTextAreaElement ||
          active instanceof HTMLInputElement);
      if (taken) return;
      element.focus({ preventScroll: true });
      if (document.activeElement !== element && ++attempts < FOCUS_ATTEMPTS)
        frame = requestAnimationFrame(attempt);
    };
    attempt();
    return () => cancelAnimationFrame(frame);
  }, [ref]);
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
        <div className="diff-comment-main">
          <p
            className="diff-comment-body"
            data-empty={comment.body.trim() ? undefined : ""}
          >
            {comment.body.trim()
              ? comment.body
              : "No comment — attached as context"}
          </p>
          <span className="diff-comment-actions">
            <button
              type="button"
              className="chat-comment-icon-button"
              aria-label="Edit diff comment"
              title="Edit comment"
              onClick={() => {
                setText(comment.body);
                setEditing(true);
              }}
            >
              <EditGlyph />
            </button>
            <button
              type="button"
              className="chat-comment-icon-button"
              data-tone="danger"
              aria-label="Remove diff comment"
              title="Remove comment"
              onClick={() => review?.removeComment(comment.id)}
            >
              <TrashGlyph />
            </button>
          </span>
        </div>
      )}
      <div className="diff-comment-meta">
        <span className="diff-comment-where">
          {diffCommentHomeLabel(comment)} · {diffCommentLocation(comment)} (
          {comment.side})
        </span>
        {comment.outdated ? (
          <span className="diff-comment-outdated">outdated</span>
        ) : null}
      </div>
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useKeepFocus(inputRef);
  useFocusOnMount(inputRef);
  useLayoutEffect(() => {
    if (inputRef.current) fitTextarea(inputRef.current);
  }, [value]);
  return (
    <div className="diff-comment-editor">
      <textarea
        ref={inputRef}
        autoFocus
        {...focusKeepProps}
        aria-label={label}
        placeholder={placeholder}
        data-testid={`${testIdPrefix}-input`}
        value={value}
        rows={2}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey))
            return;
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
  onDiscussionClosed,
}: {
  annotation: ReviewAnnotation;
  onSaveDraft?(body: string): void;
  onCancelDraft(): void;
  onDiscussDraft?(body: string): void;
  onAttachDraft?(body: string): void;
  /** A discussion here closed; return the cursor to its anchor line. */
  onDiscussionClosed?(anchor: CodeSelection): void;
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

    submit?.(body);
  };
  const sendDraftToMain = () => onAttachDraft?.(draft.trim());

  return (
    <div className="diff-comment-thread" data-owns-escape="">
      {annotation.threadIds?.map((id) => (
        <InlineSelectionDiscussion
          key={id}
          threadId={id}
          onClosed={onDiscussionClosed}
        />
      ))}
      {comments.map((comment) => (
        <CommentCard
          key={comment.id}
          comment={comment}
          focus={review?.focus?.commentId === comment.id ? review.focus : null}
        />
      ))}
      {annotation.draft ? (
        <div
          role="dialog"
          aria-label={
            onSaveDraft ? "Comment on selected code" : "Discuss selected code"
          }
        >
          {onDiscussDraft && <DiscussionModelNotice />}
          <CommentEditor
            disabled={!!onDiscussDraft && !!choice?.error}
            label={
              onSaveDraft ? "New diff comment" : "New selection discussion"
            }
            placeholder={
              onDiscussDraft ? "Ask about selected code…" : "Write a comment…"
            }
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
