/** "⌘↵ to add · esc to cancel" in a comment editor's footer. */
export function CommentShortcutHint({ action }: { action: "add" | "save" }) {
  return (
    <span className="chat-comment-hint" aria-hidden="true">
      <kbd className="chat-comment-kbd">⌘↵</kbd>
      {`to ${action}`}
      <span>·</span>
      <kbd className="chat-comment-kbd">esc</kbd>
      to cancel
    </span>
  );
}
