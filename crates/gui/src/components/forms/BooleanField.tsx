import {
  type ButtonHTMLAttributes,
  forwardRef,
} from "react";
import { FormField } from "./FormField";

export interface BooleanFieldProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "value"> {
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
   * Current value of the boolean field
   */
  value: boolean;
  /**
   * Called when the value changes
   */
  onChange: (value: boolean) => void;
  /**
   * Custom HTML id for the input (for label association)
   * Auto-generated if not provided
   */
  id?: string;
  /**
   * Whether the field is disabled
   */
  disabled?: boolean;
  /**
   * Text to display in the toggle when on
   */
  onText?: string;
  /**
   * Text to display in the toggle when off
   */
  offText?: string;
  /**
   * Size of the toggle
   */
  size?: "sm" | "md" | "lg";
  /**
   * Whether to show the toggle as a switch (default) or checkbox
   */
  variant?: "switch" | "checkbox";
}

/**
 * BooleanField component with FormField wrapper for toggle/checkbox input.
 *
 * Provides:
 * - Toggle switch or checkbox with consistent styling
 * - Label, error, help text via FormField wrapper
 * - Click to toggle functionality
 * - Disabled state with proper styling
 * - Custom on/off text
 * - Multiple size variants
 *
 * @example
 * ```tsx
 * <BooleanField
 *   label "Enable notifications"
 *   value={notificationsEnabled}
 *   onChange={setNotificationsEnabled}
 *   onText="On"
 *   offText="Off"
 *   helpText="Receive email notifications for task updates"
 * />
 * ```
 */
export const BooleanField = forwardRef<HTMLButtonElement, BooleanFieldProps>(
  (
    {
      label,
      error,
      required = false,
      helpText,
      value,
      onChange,
      id: propId,
      disabled = false,
      onText = "On",
      offText = "Off",
      size = "md",
      variant = "switch",
      className = "",
      ...props
    },
    ref
  ) => {
    // Generate unique ID if not provided
    const inputId = propId || `booleanfield-${Math.random().toString(36).slice(2, 9)}`;

    // Handle click to toggle
    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      if (!disabled) {
        onChange(!value);
      }
    };

    // Base toggle classes
    const baseClasses = "relative inline-flex items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2";

    // Size classes
    const sizeClasses = {
      sm: "h-6 w-11 text-xs",
      md: "h-8 w-14 text-sm",
      lg: "h-10 w-20 text-base",
    };

    // Toggle switch classes based on value and state
    const toggleClasses = `
      ${baseClasses}
      ${sizeClasses[size]}
      ${value
        ? "bg-primary text-white"
        : "bg-background-tertiary text-text-secondary"}
      ${disabled
        ? "opacity-50 cursor-not-allowed"
        : "cursor-pointer hover:bg-primary/90"}
    `;

    // Hidden checkbox for accessibility (when variant is switch)
    const checkboxClasses = `
      absolute inset-0 w-full h-full opacity-0
      cursor-pointer disabled:cursor-not-allowed
      ${disabled ? "pointer-events-none" : ""}
    `;

    // If variant is checkbox, render a button with checkbox appearance
    if (variant === "checkbox") {
      const checkboxButtonClasses = `
        flex items-center gap-2 px-4 py-2 text-sm font-medium
        border border-border rounded-md
        ${value
          ? "bg-primary text-white border-primary"
          : "bg-background-primary text-text-primary"}
        ${disabled
          ? "opacity-50 cursor-not-allowed bg-background-secondary"
          : "hover:bg-background-tertiary cursor-pointer"}
        transition-colors
        ${className}
      `;

      return (
        <FormField
          label={label}
          error={error}
          required={required}
          helpText={helpText}
          inputId={inputId}
        >
          <div className="flex items-center gap-3">
            <button
              ref={ref}
              type="button"
              onClick={handleClick}
              disabled={disabled}
              className={checkboxButtonClasses}
              id={inputId}
              role="checkbox"
              aria-checked={value}
              aria-disabled={disabled}
              aria-invalid={error ? "true" : undefined}
              {...props}
            >
              <div className="flex items-center gap-2">
                <div
                  className={`
                    inline-flex items-center justify-center w-4 h-4
                    border border-border rounded
                    ${value
                      ? "bg-primary text-white border-primary"
                      : "bg-background-primary text-text-primary"}
                  `}
                >
                  {value && (
                    <svg
                      className="h-3 w-3"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={3}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  )}
                </div>
                <span>{value ? onText : offText}</span>
              </div>
            </button>
          </div>
        </FormField>
      );
    }

    // Default variant: switch
    return (
      <FormField
        label={label}
        error={error}
        required={required}
        helpText={helpText}
        inputId={inputId}
        className={className}
      >
        <div className="flex items-center justify-between">
          <button
            ref={ref}
            type="button"
            onClick={handleClick}
            disabled={disabled}
            className={toggleClasses}
            id={inputId}
            role="switch"
            aria-checked={value}
            aria-disabled={disabled}
            aria-invalid={error ? "true" : undefined}
            {...props}
          >
            {/* Hidden checkbox for accessibility */}
            <input
              type="checkbox"
              className={checkboxClasses}
              id={`${inputId}-checkbox`}
              checked={value}
              onChange={() => {}}
              disabled={disabled}
              aria-hidden="true"
            />

            {/* Toggle knob */}
            <span className="relative inline-block transform transition-transform">
              <div
                className={`
                  inline-flex items-center justify-center rounded-full
                  bg-white shadow-sm
                  ${size === "sm" ? "h-4 w-4" : size === "md" ? "h-5 w-5" : "h-6 w-6"}
                  transform transition-transform
                  ${value ? "translate-x-4 md:translate-x-6 lg:translate-x-8" : "translate-x-0"}
                `}
              >
                {value && (
                  <svg
                    className="h-3 w-3 text-primary"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                )}
              </div>
            </span>
            <span className="ml-2 font-medium">
              {value ? onText : offText}
            </span>
          </button>
        </div>
      </FormField>
    );
  }
);

BooleanField.displayName = "BooleanField";