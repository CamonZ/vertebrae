import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CommentShortcutHint } from "./CommentShortcutHint";
import { placeCommentCard, type Box } from "./commentCardPlacement";

interface CardSize {
  width: number;
  height: number;
}

/** The card's full size, including any part its max-height clips. */
function naturalSize(card: HTMLElement): CardSize {
  const borders = card.offsetHeight - card.clientHeight;
  return {
    width: card.offsetWidth,
    height: Math.max(card.offsetHeight, card.scrollHeight + borders),
  };
}

/** Grow the textarea with its content; CSS caps it and it scrolls beyond. */
function fitTextarea(textarea: HTMLTextAreaElement) {
  const borders = textarea.offsetHeight - textarea.clientHeight;
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight + borders}px`;
}

interface TranscriptCommentCardProps {
  quote: string;
  /** Where the selection is now, in viewport coordinates. */
  selection: Pick<Box, "top" | "bottom">;
  /** The line where the selection ended. */
  edge: Pick<Box, "left">;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/**
 * The fixed card for commenting on a transcript selection. It measures
 * itself and is placed by placeCommentCard, so it stays inside the window
 * as its content grows and the window resizes.
 */
export function TranscriptCommentCard({
  quote,
  selection,
  edge,
  draft,
  onDraftChange,
  onSubmit,
  onCancel,
}: TranscriptCommentCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [size, setSize] = useState<CardSize | null>(null);

  useLayoutEffect(() => {
    if (textareaRef.current) fitTextarea(textareaRef.current);
  }, [draft]);

  // Esc always cancels, wherever focus is (the card is portaled to the body
  // and focus can sit on the page after a click), and never reaches the
  // handlers that would close the pane behind it.
  const cancelRef = useRef(onCancel);
  useLayoutEffect(() => {
    cancelRef.current = onCancel;
  }, [onCancel]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      cancelRef.current();
      // Drop a stale selection too, so the pill does not come straight back.
      window.getSelection()?.removeAllRanges();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const measure = () => {
      const next = naturalSize(card);
      setSize((current) =>
        current?.width === next.width && current.height === next.height
          ? current
          : next
      );
    };
    measure();
    // A capped card keeps its own size while its content grows, so watch
    // the content as well.
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    for (const child of card.children) observer.observe(child);
    return () => observer.disconnect();
  }, []);

  // Until measured (the layout effect re-renders before paint) the card
  // stays at the origin rather than being placed from a guessed height.
  const placement = size
    ? placeCommentCard({
        viewport: { width: window.innerWidth, height: window.innerHeight },
        selection,
        edge,
        card: size,
      })
    : null;

  return (
    <div
      ref={cardRef}
      className="chat-comment-card chat-comment-card-fixed"
      data-focus-halo="surface"
      data-owns-escape=""
      data-escape-claim=""
      data-placement={placement?.side}
      role="group"
      aria-label="Add a comment to selected text"
      style={
        placement
          ? {
              top: placement.top,
              left: placement.left,
              maxHeight: placement.maxHeight ?? undefined,
            }
          : { top: 0, left: 0 }
      }
    >
      <div className="chat-comment-card-header">
        <span className="chat-comment-card-title">Comment on selection</span>
      </div>
      <blockquote className="chat-comment-quote chat-comment-quote-selection">
        {quote}
      </blockquote>
      <label htmlFor="local-chat-comment-draft" className="sr-only">
        Comment on selected text
      </label>
      <textarea
        ref={textareaRef}
        id="local-chat-comment-draft"
        data-testid="local-chat-comment-draft"
        aria-label="Comment on selected text"
        className="chat-comment-textarea"
        placeholder="Add your comment…"
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey))
            return;
          event.preventDefault();
          onSubmit();
        }}
        autoFocus
        rows={3}
      />
      <div className="chat-comment-card-footer">
        <CommentShortcutHint action="add" />
        <button
          type="button"
          className="chat-comment-button"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="local-chat-save-comment"
          className="chat-comment-button"
          data-primary=""
          disabled={!draft.trim()}
          onClick={onSubmit}
        >
          Add to reply
        </button>
      </div>
    </div>
  );
}
