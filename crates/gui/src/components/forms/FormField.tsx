import { type ReactNode, type HTMLAttributes, forwardRef } from "react";

export interface FormFieldProps extends HTMLAttributes<HTMLDivElement> {
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
   * The input component to wrap
   */
  children: ReactNode;
  /**
   * Optional HTML id for the input (for label association)
   */
  inputId?: string;
}

/**
 * FormField wrapper component for consistent form field styling.
 *
 * Provides:
 * - Label positioned above input with required indicator
 * - Optional help text below label
 * - Optional error message below input
 * - Semantic HTML using label and small elements
 *
 * @example
 * ```tsx
 * <FormField label="Task Title" required error="Title is required" inputId="title">
 *   <input id="title" type="text" />
 * </FormField>
 * ```
 */
export const FormField = forwardRef<HTMLDivElement, FormFieldProps>(
  (
    {
      label,
      error,
      required = false,
      helpText,
      children,
      inputId,
      className = "",
      ...props
    },
    ref
  ) => {
    // const hasError = Boolean(error);

    return (
      <div ref={ref} className={`flex flex-col gap-1.5 ${className}`} {...props}>
        {/* Label with required indicator */}
        <label
          htmlFor={inputId}
          className="flex items-baseline gap-1 text-xs font-medium text-text-secondary"
        >
          {label}
          {required && (
            <span className="text-error" aria-label="required">
              *
            </span>
          )}
        </label>

        {/* Optional help text */}
        {helpText && (
          <small className="text-xs text-text-muted">{helpText}</small>
        )}

        {/* The wrapped input component */}
        {/* Clone child and inject error state for styling if needed */}
        {children}

        {/* Error message */}
        {error && (
          <small className="flex items-center gap-1 text-xs text-error" role="alert">
            <svg
              className="h-3 w-3 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <span>{error}</span>
          </small>
        )}
      </div>
    );
  }
);

FormField.displayName = "FormField";
