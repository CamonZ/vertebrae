import {
  type TextareaHTMLAttributes,
  type ForwardedRef,
  forwardRef,
  useEffect,
  useRef,
  useState,
} from "react";
import { FormField } from "./FormField";

export interface TextareaFieldProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "size"> {
  /**
   * The field label text
   */
  label: string;
  /**
   * Optional error message to display below the input
   */
  error?: string;
  /**
   * Whether the field is required (shows asterisk)
   */
  required?: boolean;
  /**
   * Optional help text to display below the label
   */
  helpText?: string;
  /**
   * Minimum length validation - shows error if under
   */
  minLength?: number;
  /**
   * Maximum length - shows character count when set
   */
  maxLength?: number;
  /**
   * Number of visible text lines
   */
  rows?: number;
  /**
   * How the textarea can be resized
   */
  resize?: "none" | "vertical" | "horizontal" | "both";
  /**
   * Whether to auto-focus the textarea on mount
   */
  autoFocus?: boolean;
  /**
   * Custom HTML id for the textarea (for label association)
   * Auto-generated if not provided
   */
  id?: string;
  /**
   * Whether the textarea should grow to fit content
   */
  autoGrow?: boolean;
  /**
   * Maximum height when autoGrow is enabled (in pixels or CSS units)
   */
  maxHeight?: string;
}

/**
 * TextareaField component with FormField wrapper for multi-line text input.
 *
 * Provides:
 * - Multi-line textarea input with consistent styling
 * - Label, error, help text via FormField wrapper
 * - Min/max length validation with visual feedback
 * - Character count display when maxLength is set
 * - Resize controls (none, vertical, horizontal, both)
 * - Disabled state with proper styling
 * - Auto-focus support
 * - Auto-grow functionality (optional)
 * - Forwarded ref to the native textarea element
 *
 * @example
 * ```tsx
 * <TextareaField
 *   label="Task Description"
 *   value={description}
 *   onChange={(e) => setDescription(e.target.value)}
 *   placeholder="Enter detailed task description..."
 *   rows={6}
 *   maxLength={500}
 *   required
 *   error={descriptionError}
 * />
 * ```
 */
export const TextareaField = forwardRef<HTMLTextAreaElement, TextareaFieldProps>(
  (
    {
      label,
      error,
      required = false,
      helpText,
      minLength,
      maxLength,
      rows = 4,
      resize = "vertical",
      autoFocus = false,
      id: propId,
      disabled = false,
      value,
      className = "",
      autoGrow = false,
      maxHeight,
      ...props
    },
    ref
  ) => {
    // Internal ref for auto-focus functionality
    const internalRef = useRef<HTMLTextAreaElement>(null);
    // Merge refs - use forwarded ref if provided, otherwise use internal
    const textareaRef = (ref as ForwardedRef<HTMLTextAreaElement>) || internalRef;

    // Generate unique ID if not provided
    const [generatedId] = useState(() =>
      propId || `textareafield-${Math.random().toString(36).slice(2, 9)}`
    );
    const inputId = propId || generatedId;

    // Auto-focus on mount
    useEffect(() => {
      if (autoFocus && internalRef.current) {
        internalRef.current.focus();
      }
    }, [autoFocus]);

    // Auto-grow functionality
    useEffect(() => {
      if (autoGrow && internalRef.current) {
        const textarea = internalRef.current;
        const adjustHeight = () => {
          // Reset height to auto to get the correct scroll height
          textarea.style.height = "auto";
          // Set height to scroll height, but respect maxHeight
          const newHeight = Math.min(textarea.scrollHeight, maxHeight ? parseInt(maxHeight) : Infinity);
          textarea.style.height = `${newHeight}px`;
        };

        adjustHeight();

        // Adjust height on resize
        const resizeObserver = new ResizeObserver(adjustHeight);
        resizeObserver.observe(textarea);

        // Clean up
        return () => {
          resizeObserver.disconnect();
        };
      }
    }, [autoGrow, maxHeight, value]);

    // Compute validation error from length constraints
    const currentValue = typeof value === "string" ? value : "";
    const hasLengthError =
      minLength !== undefined && currentValue.length > 0 && currentValue.length < minLength;

    // Combine prop error with validation error
    const displayError = error || (hasLengthError ? `Minimum ${minLength} characters required` : "");

    // Base textarea classes
    const baseTextareaClasses = "input w-full resize-none";

    // Resize classes
    const resizeClasses = {
      none: "resize-none",
      vertical: "resize-y",
      horizontal: "resize-x",
      both: "resize",
    };

    // Error state classes
    const errorClasses = displayError
      ? "border-error focus:border-error focus:ring-error/20"
      : "";

    // Disabled state classes
    const disabledClasses = disabled
      ? "opacity-50 cursor-not-allowed"
      : "";

    // Auto-grow specific classes
    const autoGrowClasses = autoGrow ? "min-h-[80px]" : "";

    // Combined classes
    const textareaClasses = `${baseTextareaClasses} ${resizeClasses[resize]} ${errorClasses} ${disabledClasses} ${autoGrowClasses} ${className}`.trim();

    // Character count display
    const showCharCount = maxLength !== undefined;
    const charCount = currentValue.length;
    const charCountValid = maxLength === undefined || charCount < maxLength;

    return (
      <FormField
        label={label}
        error={displayError}
        required={required}
        helpText={helpText}
        inputId={inputId}
      >
        <div className="relative">
          <textarea
            ref={textareaRef}
            id={inputId}
            value={value}
            disabled={disabled}
            minLength={minLength}
            maxLength={maxLength}
            rows={rows}
            className={textareaClasses}
            aria-invalid={displayError ? "true" : undefined}
            aria-describedby={
              displayError ? `${inputId}-error` : showCharCount ? `${inputId}-charcount` : undefined
            }
            {...props}
          />

          {/* Character count indicator */}
          {showCharCount && (
            <div
              id={`${inputId}-charcount`}
              className={`absolute right-3 bottom-3 text-2xs font-medium ${
                charCountValid ? "text-text-muted" : "text-error"
              }`}
              aria-live="polite"
            >
              {charCount}/{maxLength}
            </div>
          )}
        </div>
      </FormField>
    );
  }
);

TextareaField.displayName = "TextareaField";