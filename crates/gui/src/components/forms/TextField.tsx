import {
  type InputHTMLAttributes,
  type ForwardedRef,
  forwardRef,
  useEffect,
  useRef,
  useState,
} from "react";
import { FormField } from "./FormField";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
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
   * Whether to auto-focus the input on mount
   */
  autoFocus?: boolean;
  /**
   * Custom HTML id for the input (for label association)
   * Auto-generated if not provided
   */
  id?: string;
}

/**
 * TextField input component with FormField wrapper.
 *
 * Provides:
 * - Single-line text input with consistent styling
 * - Label, error, help text via FormField wrapper
 * - Min/max length validation with visual feedback
 * - Character count display when maxLength is set
 * - Disabled state with proper styling
 * - Auto-focus support
 * - Forwarded ref to the native input element
 *
 * @example
 * ```tsx
 * <TextField
 *   label="Task Title"
 *   value={title}
 *   onChange={(e) => setTitle(e.target.value)}
 *   placeholder="Enter task title"
 *   required
 *   maxLength={100}
 *   error={titleError}
 * />
 * ```
 */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  (
    {
      label,
      error,
      required = false,
      helpText,
      minLength,
      maxLength,
      autoFocus = false,
      id: propId,
      disabled = false,
      value,
      className = "",
      ...props
    },
    ref
  ) => {
    // Internal ref for auto-focus functionality
    const internalRef = useRef<HTMLInputElement>(null);
    // Merge refs - use forwarded ref if provided, otherwise use internal
    const inputRef = (ref as ForwardedRef<HTMLInputElement>) || internalRef;

    // Generate unique ID if not provided
    const [generatedId] = useState(() =>
      propId || `textfield-${Math.random().toString(36).slice(2, 9)}`
    );
    const inputId = propId || generatedId;

    // Auto-focus on mount
    useEffect(() => {
      if (autoFocus && internalRef.current) {
        internalRef.current.focus();
      }
    }, [autoFocus]);

    // Compute validation error from length constraints
    const currentValue = typeof value === "string" ? value : "";
    const hasLengthError =
      minLength !== undefined && currentValue.length > 0 && currentValue.length < minLength;

    // Combine prop error with validation error
    const displayError = error || (hasLengthError ? `Minimum ${minLength} characters required` : "");

    // Base input classes
    const baseInputClasses = "input w-full";

    // Error state classes
    const errorClasses = displayError
      ? "border-error focus:border-error focus:ring-error/20"
      : "";

    // Disabled state classes
    const disabledClasses = disabled
      ? "opacity-50 cursor-not-allowed"
      : "";

    // Combined classes
    const inputClasses = `${baseInputClasses} ${errorClasses} ${disabledClasses} ${className}`.trim();

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
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            value={value}
            disabled={disabled}
            minLength={minLength}
            maxLength={maxLength}
            className={inputClasses}
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
              className={`absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium ${
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

TextField.displayName = "TextField";
