import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { focusKeepProps } from "../../utils/focusKeep";
import { useKeepFocus } from "../../hooks/useKeepFocus";

const CHAT_INPUT_MIN_HEIGHT = 40;
const CHAT_INPUT_MAX_HEIGHT = 160;

export interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onSteer?: () => void;
  /**
   * Blocks submitting, not typing: the textarea stays editable so a focused
   * composer keeps focus and keystrokes while a turn starts or runs.
   */
  disabled?: boolean;
  canSubmit?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  buttonTitle?: string;
  buttonAriaLabel?: string;
  textareaTestId?: string;
  inputAccessory?: ReactNode;
  footerLeft?: ReactNode;
  footerRight?: ReactNode;
}

/**
 * Reusable chat input: textarea with an embedded send button.
 * Enter submits, Shift+Enter inserts a newline, and Control+Enter steers when available.
 */
export const ChatInput = forwardRef<HTMLTextAreaElement, ChatInputProps>(
  function ChatInput(
    {
      value,
      onChange,
      onSubmit,
      onSteer,
      disabled = false,
      canSubmit = true,
      ariaLabel,
      placeholder,
      buttonTitle = "Send message",
      buttonAriaLabel = "Send message",
      textareaTestId,
      inputAccessory,
      footerLeft,
      footerRight,
    },
    ref
  ) {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    useKeepFocus(textareaRef);
    const [controlHeld, setControlHeld] = useState(false);
    const steeringArmed = !!onSteer && controlHeld && canSubmit && !disabled && !!value.trim();

    useEffect(() => {
      if (!controlHeld) return;
      const resetControl = () => setControlHeld(false);
      window.addEventListener("blur", resetControl);
      return () => window.removeEventListener("blur", resetControl);
    }, [controlHeld]);
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

    const measurementRef = useRef<HTMLTextAreaElement | null>(null);
    const resizeInput = useCallback(() => {
      const textarea = textareaRef.current;
      const measurement = measurementRef.current;
      if (!textarea || !measurement) return;

      // Measure outside layout. Resetting the focused input to "auto" can
      // briefly enlarge the transcript viewport and clamp its scroll position,
      // even on one line when WebKit rounds a fractional line height.
      const contentHeight = measurement.scrollHeight;
      const height = `${Math.min(
        Math.max(contentHeight, CHAT_INPUT_MIN_HEIGHT),
        CHAT_INPUT_MAX_HEIGHT
      )}px`;
      if (textarea.style.height !== height) textarea.style.height = height;
      textarea.style.overflowY =
        contentHeight > CHAT_INPUT_MAX_HEIGHT ? "auto" : "hidden";
    }, []);

    useLayoutEffect(resizeInput, [value, resizeInput]);

    useLayoutEffect(() => {
      const measurement = measurementRef.current;
      if (!measurement || typeof ResizeObserver === "undefined") return;

      // Watch the one-row measurement field for width and line-height changes.
      const observer = new ResizeObserver(resizeInput);
      observer.observe(measurement);
      return () => observer.disconnect();
    }, [resizeInput]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        setControlHeld(e.ctrlKey);

        if (
          e.key !== "Enter" ||
          e.nativeEvent.isComposing ||
          e.shiftKey ||
          e.metaKey ||
          e.altKey ||
          (e.ctrlKey && !onSteer)
        ) return;

        e.preventDefault();
        if (canSubmit && !disabled) {
          if (e.ctrlKey) onSteer?.();
          else onSubmit();
        }
      },
      [canSubmit, disabled, onSteer, onSubmit]
    );

    const sendButton = (
      <button
        type="button"
        onMouseDown={(event) => {
          if (steeringArmed && event.ctrlKey) event.preventDefault();
        }}
        onClick={(event) => {
          if (steeringArmed && event.ctrlKey) onSteer?.();
          else onSubmit();
        }}
        disabled={disabled || !canSubmit}
        title={onSteer ? "Steer (Ctrl+Enter) · Queue (Enter)" : buttonTitle}
        aria-label={steeringArmed ? "Steer active turn" : buttonAriaLabel}
        aria-keyshortcuts={onSteer ? "Control+Enter" : undefined}
        className={
          hasFooter
            ? "action-primary flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
            : "action-primary absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md"
        }
      >
        <svg
          className="h-4 w-4"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d={
              steeringArmed
                ? "M14 5l6 6-6 6M4 19v-2a6 6 0 0 1 6-6h10"
                : "M12 5v14m0-14l-6 6m6-6l6 6"
            }
          />
        </svg>
      </button>
    );

    const textareaClassName = hasFooter
      ? "block w-full resize-none rounded-t-lg bg-transparent px-3 py-2 chat-composer-input text-[var(--color-fg)] placeholder:text-[var(--color-fg-mute)]"
      : "block w-full resize-none rounded-lg bg-transparent py-2 pl-3 pr-10 chat-composer-input text-[var(--color-fg)] placeholder:text-[var(--color-fg-mute)]";

    return (
      <div
        className="chat-input-shell relative rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-bg)]"
        data-testid="chat-input-shell"
        data-focus-halo="within"
      >
        {inputAccessory != null ? (
          <div className="flex items-center gap-1 px-2 pt-2">
            {inputAccessory}
          </div>
        ) : null}
        <textarea
          ref={setRefs}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onKeyUp={(event) => setControlHeld(event.ctrlKey)}
          onBlur={() => setControlHeld(false)}
          aria-label={ariaLabel}
          placeholder={placeholder}
          data-testid={textareaTestId}
          {...focusKeepProps}
          rows={1}
          style={{
            minHeight: CHAT_INPUT_MIN_HEIGHT,
            maxHeight: CHAT_INPUT_MAX_HEIGHT,
          }}
          className={textareaClassName}
        />
        <textarea
          ref={measurementRef}
          value={value || placeholder || ""}
          readOnly
          tabIndex={-1}
          aria-hidden="true"
          rows={1}
          className={textareaClassName}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            minHeight: 0,
            maxHeight: "none",
            overflow: "hidden",
            visibility: "hidden",
            pointerEvents: "none",
          }}
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
