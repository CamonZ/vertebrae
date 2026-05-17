import { forwardRef, useCallback } from "react";

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
    },
    ref
  ) {
    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (canSubmit && !disabled) onSubmit();
        }
      },
      [canSubmit, disabled, onSubmit]
    );

    return (
      <div className="relative rounded-lg border border-border bg-bg-primary focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label={ariaLabel}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="block w-full resize-none rounded-lg bg-transparent py-2 pl-3 pr-10 text-sm leading-6 text-text-primary placeholder-text-muted focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={disabled || !canSubmit}
          title={buttonTitle}
          aria-label={buttonAriaLabel}
          className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-muted"
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
      </div>
    );
  }
);
