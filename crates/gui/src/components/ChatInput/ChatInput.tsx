import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";

const CHAT_INPUT_MIN_HEIGHT = 40;
const CHAT_INPUT_MAX_HEIGHT = 160;

export interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  canSubmit?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  buttonTitle?: string;
  buttonAriaLabel?: string;
  textareaTestId?: string;
  footerLeft?: ReactNode;
  footerRight?: ReactNode;
}

/**
 * Reusable chat input: textarea with an embedded send button.
 * Enter submits; Shift+Enter inserts a newline.
 */
export const ChatInput = forwardRef<HTMLTextAreaElement, ChatInputProps>(
  function ChatInput(
    {
      value,
      onChange,
      onSubmit,
      disabled = false,
      canSubmit = true,
      ariaLabel,
      placeholder,
      buttonTitle = "Send message",
      buttonAriaLabel = "Send message",
      textareaTestId,
      footerLeft,
      footerRight,
    },
    ref
  ) {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const hasFooter = footerLeft != null || footerRight != null;
    const setRefs = useCallback(
      (node: HTMLTextAreaElement | null) => {
        textareaRef.current = node;
        if (typeof ref === "function") {
          ref(node);
        } else if (ref) {
          ref.current = node;
        }
      },
      [ref]
    );

    useLayoutEffect(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(
        Math.max(textarea.scrollHeight, CHAT_INPUT_MIN_HEIGHT),
        CHAT_INPUT_MAX_HEIGHT
      )}px`;
      textarea.style.overflowY =
        textarea.scrollHeight > CHAT_INPUT_MAX_HEIGHT ? "auto" : "hidden";
    }, [value]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (canSubmit && !disabled) onSubmit();
        }
      },
      [canSubmit, disabled, onSubmit]
    );

    const sendButton = (
      <button
        type="button"
        onClick={onSubmit}
        disabled={disabled || !canSubmit}
        title={buttonTitle}
        aria-label={buttonAriaLabel}
        className={
          hasFooter
            ? "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--color-fg-mute)] transition-colors hover:bg-[var(--color-bg-1)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--color-fg-mute)]"
            : "absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-[var(--color-fg-mute)] transition-colors hover:bg-[var(--color-bg-1)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--color-fg-mute)]"
        }
      >
        <svg
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 5v14m0-14l-6 6m6-6l6 6"
          />
        </svg>
      </button>
    );

    return (
      <div
        className="chat-input-shell relative rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-bg)]"
        data-testid="chat-input-shell"
      >
        <textarea
          ref={setRefs}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label={ariaLabel}
          placeholder={placeholder}
          data-testid={textareaTestId}
          disabled={disabled}
          rows={1}
          style={{
            minHeight: CHAT_INPUT_MIN_HEIGHT,
            maxHeight: CHAT_INPUT_MAX_HEIGHT,
          }}
          className={
            hasFooter
              ? "block w-full resize-none rounded-t-lg bg-transparent px-3 py-2 text-sm leading-6 text-[var(--color-fg)] placeholder:text-[var(--color-fg-mute)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              : "block w-full resize-none rounded-lg bg-transparent py-2 pl-3 pr-10 text-sm leading-6 text-[var(--color-fg)] placeholder:text-[var(--color-fg-mute)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          }
        />
        {hasFooter ? (
          <div className="flex min-h-9 items-center gap-2 border-t border-[var(--color-line)] px-2 py-1.5">
            <div className="min-w-0 flex-1">{footerLeft}</div>
            <div className="flex min-w-0 items-center justify-end gap-1.5">
              {footerRight}
              {sendButton}
            </div>
          </div>
        ) : (
          sendButton
        )}
      </div>
    );
  }
);
